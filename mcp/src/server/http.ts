/**
 * HTTP server for the Agentation API.
 * Uses native Node.js http module - no frameworks.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS, handleTool, registerProjectDomains, error as toolError, type ToolScope } from "./mcp.js";
import {
  createSession,
  getSession,
  getSessionWithAnnotations,
  addAnnotation,
  updateAnnotation,
  getAnnotation,
  deleteAnnotation,
  listSessions,
  getPendingAnnotations,
  addThreadMessage,
  getEventsSince,
  listAnnotationsByDomain,
  registerDomains,
  listDomains,
  getDomain,
  disableDomain,
  enableDomain,
} from "./store.js";
import { eventBus } from "./events.js";
import { authenticate, isAuthEnabled, type Role } from "./auth.js";
import { domainOfUrl, normalizeDomain, parseDomainList } from "./domains.js";
import type { Annotation, AnnotationStatus, AFSEvent, ActionRequest, Session } from "../types.js";

const ANNOTATION_STATUSES: AnnotationStatus[] = ["pending", "acknowledged", "resolved", "dismissed"];

/**
 * Log to stderr so diagnostic output never corrupts the MCP stdio channel.
 * When `server` runs without --mcp-only, both the HTTP server and MCP stdio
 * server share the same process. stdout is reserved for JSON-RPC messages,
 * so all logging must go to stderr.
 */
function log(message: string): void {
  process.stderr.write(message + "\n");
}

// Cloud API configuration
let cloudApiKey: string | undefined;
const CLOUD_API_URL = "https://agentation-mcp-cloud.vercel.app/api";

/**
 * Set the API key for cloud storage mode.
 * When set, the HTTP server proxies requests to the cloud API.
 */
export function setCloudApiKey(key: string | undefined): void {
  cloudApiKey = key;
}

/**
 * Check if we're in cloud mode (API key is set).
 */
function isCloudMode(): boolean {
  return !!cloudApiKey;
}

// Track active SSE connections for cleanup
const sseConnections = new Set<ServerResponse>();
// Track agent SSE connections separately (for accurate delivery status)
// These are connections from MCP tools (e.g. watch_annotations), not browser toolbars
const agentConnections = new Set<ServerResponse>();

// -----------------------------------------------------------------------------
// MCP HTTP Transport
// -----------------------------------------------------------------------------

// Store transports by session ID for stateful sessions
const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

/**
 * Project scope for an HTTP MCP session, from the client's config headers:
 * X-Agentation-Project and X-Agentation-Domains (comma-separated).
 */
function mcpScopeFromHeaders(req: IncomingMessage): ToolScope {
  const projectHeader = req.headers["x-agentation-project"];
  const domainsHeader = req.headers["x-agentation-domains"];
  const project = typeof projectHeader === "string" ? projectHeader.trim().slice(0, 100) : "";
  return {
    project: project || undefined,
    domains: parseDomainList(typeof domainsHeader === "string" ? domainsHeader : undefined),
  };
}

/**
 * Initialize a new MCP server with HTTP transport for a session.
 */
function createMcpSession(scope: ToolScope): { server: Server; transport: StreamableHTTPServerTransport } {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  const server = new Server(
    { name: "agentation", version: "0.0.1" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await handleTool(req.params.name, req.params.arguments, scope);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return toolError(message);
    }
  });

  server.connect(transport);
  return { server, transport };
}

// -----------------------------------------------------------------------------
// Webhook Support
// -----------------------------------------------------------------------------

/**
 * Get configured webhook URLs from environment variables.
 *
 * Supports:
 * - AGENTATION_WEBHOOK_URL: Single webhook URL
 * - AGENTATION_WEBHOOKS: Comma-separated list of webhook URLs
 */
function getWebhookUrls(): string[] {
  const urls: string[] = [];

  // Single webhook URL
  const singleUrl = process.env.AGENTATION_WEBHOOK_URL;
  if (singleUrl) {
    urls.push(singleUrl.trim());
  }

  // Multiple webhook URLs (comma-separated)
  const multipleUrls = process.env.AGENTATION_WEBHOOKS;
  if (multipleUrls) {
    const parsed = multipleUrls
      .split(",")
      .map((url) => url.trim())
      .filter((url) => url.length > 0);
    urls.push(...parsed);
  }

  return urls;
}

/**
 * Send webhook notification for an action request.
 * Fire-and-forget: doesn't wait for response, logs errors but doesn't throw.
 */
function sendWebhooks(actionRequest: ActionRequest): void {
  const webhookUrls = getWebhookUrls();

  if (webhookUrls.length === 0) {
    return;
  }

  const payload = JSON.stringify(actionRequest);

  for (const url of webhookUrls) {
    // Fire and forget - use .then().catch() instead of await
    fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Agentation-Webhook/1.0",
      },
      body: payload,
    })
      .then((res) => {
        log(
          `[Webhook] POST ${url} -> ${res.status} ${res.statusText}`
        );
      })
      .catch((err) => {
        console.error(`[Webhook] POST ${url} failed:`, (err as Error).message);
      });
  }

  log(
    `[Webhook] Fired ${webhookUrls.length} webhook(s) for session ${actionRequest.sessionId}`
  );
}

// -----------------------------------------------------------------------------
// Request Helpers
// -----------------------------------------------------------------------------

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Parse JSON body from request.
 */
async function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Send JSON response.
 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Send error response.
 */
function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/**
 * Set CORS headers for every response.
 *
 * Without auth (local dev) any origin is allowed. With auth enabled, only
 * pages on an active allowlisted domain may call the API from the browser.
 * Extension pages (popup, side panel) use host_permissions and bypass CORS.
 */
function applyCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin;
  if (!isAuthEnabled()) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && isDomainAllowed(domainOfUrl(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization, Mcp-Session-Id, Last-Event-ID, X-Agentation-Reporter, X-Agentation-Auth, X-Agentation-Project, X-Agentation-Domains"
  );
  res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");
}

/**
 * Handle CORS preflight.
 */
function handleCors(res: ServerResponse): void {
  res.writeHead(204, { "Access-Control-Max-Age": "86400" });
  res.end();
}

// -----------------------------------------------------------------------------
// Domain Allowlist
// -----------------------------------------------------------------------------

/**
 * Whether a domain may submit feedback. Without auth every domain is allowed.
 */
function isDomainAllowed(domain: string | undefined): boolean {
  if (!isAuthEnabled()) return true;
  if (!domain) return false;
  return getDomain(domain)?.status === "active";
}

/**
 * Read the ?domains= (or legacy ?domain=) filter.
 * Returns undefined when no filter was requested.
 */
function getDomainFilter(url: URL): string[] | undefined {
  const raw = [url.searchParams.get("domains"), url.searchParams.get("domain")]
    .filter((v): v is string => v !== null);
  if (raw.length === 0) return undefined;
  return parseDomainList(raw.join(","));
}

function listSessionsFor(filter: string[] | undefined): Session[] {
  if (filter === undefined) return listSessions();
  // A filter with no valid domains matches nothing (never "everything")
  if (filter.length === 0) return [];
  return listSessions(filter);
}

function sessionDomain(session: Session): string | undefined {
  return session.domain ?? domainOfUrl(session.url);
}

const REPORTER_HEADER = "x-agentation-reporter";

/**
 * Read the reporter email injected by the browser extension.
 */
function readReporter(req: IncomingMessage): string | undefined {
  const value = req.headers[REPORTER_HEADER];
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) return undefined;
  return email;
}

// -----------------------------------------------------------------------------
// Cloud Proxy
// -----------------------------------------------------------------------------

/**
 * Proxy a request to the cloud API.
 */
async function proxyToCloud(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<void> {
  const method = req.method || "GET";
  const cloudUrl = `${CLOUD_API_URL}${pathname}`;

  const headers: Record<string, string> = {
    "x-api-key": cloudApiKey!,
  };

  // Forward content-type for requests with body
  if (req.headers["content-type"]) {
    headers["Content-Type"] = req.headers["content-type"];
  }

  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await new Promise<string>((resolve, reject) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }

  try {
    const cloudRes = await fetch(cloudUrl, {
      method,
      headers,
      body,
    });

    // Handle SSE responses
    if (cloudRes.headers.get("content-type")?.includes("text/event-stream")) {
      res.writeHead(cloudRes.status, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });

      const reader = cloudRes.body?.getReader();
      if (reader) {
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        };
        pump().catch(() => res.end());

        req.on("close", () => {
          reader.cancel();
        });
      }
      return;
    }

    // Handle regular JSON responses
    const data = await cloudRes.text();
    res.writeHead(cloudRes.status, {
      "Content-Type": cloudRes.headers.get("content-type") || "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end(data);
  } catch (err) {
    console.error("[Cloud Proxy] Error:", err);
    sendError(res, 502, `Cloud proxy error: ${(err as Error).message}`);
  }
}

// -----------------------------------------------------------------------------
// Route Handlers
// -----------------------------------------------------------------------------

type RouteContext = { role: Role };

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
  ctx: RouteContext
) => Promise<void>;

/**
 * POST /sessions - Create a new session.
 */
const createSessionHandler: RouteHandler = async (req, res) => {
  try {
    const body = await parseBody<{ url: string; projectId?: string }>(req);

    if (!body.url) {
      return sendError(res, 400, "url is required");
    }

    if (isAuthEnabled()) {
      const domain = domainOfUrl(body.url);
      if (!isDomainAllowed(domain)) {
        return sendError(res, 403, `Domain is not allowed: ${domain ?? "invalid url"}`);
      }
      const origin = req.headers.origin;
      const originDomain = origin?.startsWith("http") ? domainOfUrl(origin) : undefined;
      if (originDomain && originDomain !== domain) {
        return sendError(res, 403, "Origin does not match session url");
      }
    }

    const session = createSession(body.url, body.projectId);
    sendJson(res, 201, session);
  } catch (err) {
    sendError(res, 400, (err as Error).message);
  }
};

/**
 * GET /sessions - List all sessions.
 */
const listSessionsHandler: RouteHandler = async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const sessions = listSessionsFor(getDomainFilter(url));
  sendJson(res, 200, sessions);
};

/**
 * GET /sessions/:id - Get a session with annotations.
 */
const getSessionHandler: RouteHandler = async (_req, res, params) => {
  const session = getSessionWithAnnotations(params.id);

  if (!session) {
    return sendError(res, 404, "Session not found");
  }

  sendJson(res, 200, session);
};

/**
 * POST /sessions/:id/annotations - Add annotation to session.
 */
const addAnnotationHandler: RouteHandler = async (req, res, params) => {
  try {
    const body = await parseBody<Omit<Annotation, "id" | "sessionId" | "status" | "createdAt">>(req);

    if (!body.comment || !body.element || !body.elementPath) {
      return sendError(res, 400, "comment, element, and elementPath are required");
    }

    // With auth enabled, the author always comes from the extension-injected
    // header, never from the request body.
    const data = isAuthEnabled() ? { ...body, authorId: readReporter(req) } : body;
    const annotation = addAnnotation(params.id, data);

    if (!annotation) {
      return sendError(res, 404, "Session not found");
    }

    sendJson(res, 201, annotation);
  } catch (err) {
    sendError(res, 400, (err as Error).message);
  }
};

/**
 * PATCH /annotations/:id - Update an annotation.
 */
const updateAnnotationHandler: RouteHandler = async (req, res, params) => {
  try {
    const body = await parseBody<Partial<Annotation>>(req);

    // Check if annotation exists
    const existing = getAnnotation(params.id);
    if (!existing) {
      return sendError(res, 404, "Annotation not found");
    }

    const annotation = updateAnnotation(params.id, body);
    sendJson(res, 200, annotation);
  } catch (err) {
    sendError(res, 400, (err as Error).message);
  }
};

/**
 * GET /annotations/:id - Get an annotation.
 */
const getAnnotationHandler: RouteHandler = async (_req, res, params) => {
  const annotation = getAnnotation(params.id);

  if (!annotation) {
    return sendError(res, 404, "Annotation not found");
  }

  sendJson(res, 200, annotation);
};

/**
 * DELETE /annotations/:id - Delete an annotation.
 */
const deleteAnnotationHandler: RouteHandler = async (_req, res, params) => {
  const annotation = deleteAnnotation(params.id);

  if (!annotation) {
    return sendError(res, 404, "Annotation not found");
  }

  sendJson(res, 200, { deleted: true, annotationId: params.id });
};

/**
 * GET /sessions/:id/pending - Get pending annotations for a session.
 */
const getPendingHandler: RouteHandler = async (_req, res, params) => {
  const pending = getPendingAnnotations(params.id);
  sendJson(res, 200, { count: pending.length, annotations: pending });
};

/**
 * GET /pending - Get all pending annotations across all sessions.
 */
const getAllPendingHandler: RouteHandler = async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  const sessions = listSessionsFor(getDomainFilter(url));
  const allPending = sessions.flatMap((session) => getPendingAnnotations(session.id));
  sendJson(res, 200, { count: allPending.length, annotations: allPending });
};

/**
 * POST /sessions/:id/action - Request agent action on annotations.
 *
 * Emits an action.requested event via SSE with the current annotations
 * and formatted output. The agent can listen for this event to know
 * when the user wants action taken.
 *
 * Also sends webhooks to configured URLs (via AGENTATION_WEBHOOK_URL or
 * AGENTATION_WEBHOOKS environment variables).
 */
const requestActionHandler: RouteHandler = async (req, res, params) => {
  try {
    const sessionId = params.id;
    const body = await parseBody<{ output: string }>(req);

    // Verify session exists
    const session = getSessionWithAnnotations(sessionId);
    if (!session) {
      return sendError(res, 404, "Session not found");
    }

    if (!body.output) {
      return sendError(res, 400, "output is required");
    }

    // Build action request payload
    const actionRequest: ActionRequest = {
      sessionId,
      annotations: session.annotations,
      output: body.output,
      timestamp: new Date().toISOString(),
    };

    // Emit event (will be sent to all SSE subscribers)
    eventBus.emit("action.requested", sessionId, actionRequest);

    // Send webhooks (fire and forget, non-blocking)
    const webhookUrls = getWebhookUrls();
    sendWebhooks(actionRequest);

    // Return delivery info so client knows if anyone received it
    // Only count agent connections (with ?agent=true), not browser toolbar connections
    const agentListeners = agentConnections.size;
    const webhooks = webhookUrls.length;

    sendJson(res, 200, {
      success: true,
      annotationCount: session.annotations.length,
      delivered: {
        sseListeners: agentListeners,
        webhooks: webhooks,
        total: agentListeners + webhooks,
      },
    });
  } catch (err) {
    sendError(res, 400, (err as Error).message);
  }
};

/**
 * POST /annotations/:id/thread - Add a thread message.
 */
const addThreadHandler: RouteHandler = async (req, res, params) => {
  try {
    const body = await parseBody<{ role: "human" | "agent"; content: string }>(req);

    if (!body.role || !body.content) {
      return sendError(res, 400, "role and content are required");
    }

    const annotation = addThreadMessage(params.id, body.role, body.content);

    if (!annotation) {
      return sendError(res, 404, "Annotation not found");
    }

    sendJson(res, 201, annotation);
  } catch (err) {
    sendError(res, 400, (err as Error).message);
  }
};

/**
 * GET /sessions/:id/events - SSE stream of events for a session.
 *
 * Supports reconnection via Last-Event-ID header.
 * Events are streamed in real-time as they occur.
 */
const sseHandler: RouteHandler = async (req, res, params) => {
  const sessionId = params.id;
  const url = new URL(req.url || "/", "http://localhost");
  const isAgent = url.searchParams.get("agent") === "true";

  // Verify session exists
  const session = getSessionWithAnnotations(sessionId);
  if (!session) {
    return sendError(res, 404, "Session not found");
  }

  // Set up SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Track this connection
  sseConnections.add(res);
  if (isAgent) {
    agentConnections.add(res);
  }

  // Send initial comment to establish connection
  res.write(": connected\n\n");

  // Check for Last-Event-ID for replay
  const lastEventId = req.headers["last-event-id"];
  if (lastEventId) {
    const lastSequence = parseInt(lastEventId as string, 10);
    if (!isNaN(lastSequence)) {
      // Replay missed events
      const missedEvents = getEventsSince(sessionId, lastSequence);
      for (const event of missedEvents) {
        sendSSEEvent(res, event);
      }
    }
  }

  // Subscribe to new events
  const unsubscribe = eventBus.subscribeToSession(sessionId, (event: AFSEvent) => {
    sendSSEEvent(res, event);
  });

  // Keep connection alive with periodic comments
  const keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 30000);

  // Clean up on disconnect
  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
    sseConnections.delete(res);
    agentConnections.delete(res);
  });
};

/**
 * Send an SSE event to a response stream.
 */
function sendSSEEvent(res: ServerResponse, event: AFSEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`id: ${event.sequence}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * GET /events - Global SSE stream.
 *
 * Optionally filter by domain: GET /events?domain=example.com
 * Without domain, streams ALL events across all sessions.
 * Useful for agents that need to track feedback across page navigations.
 */
const globalSseHandler: RouteHandler = async (req, res, _params, ctx) => {
  const url = new URL(req.url || "/", "http://localhost");
  const domainFilter = getDomainFilter(url);

  // The extension (side panel) may only stream active allowlisted domains
  if (ctx.role === "ingest") {
    if (!domainFilter || domainFilter.length === 0) {
      return sendError(res, 400, "domains is required");
    }
    const blocked = domainFilter.filter((d) => !isDomainAllowed(d));
    if (blocked.length > 0) {
      return sendError(res, 403, `Domain is not allowed: ${blocked.join(", ")}`);
    }
  }

  const domain = domainFilter?.join(",");
  const matchesFilter = (session: Session) => {
    if (domainFilter === undefined) return true;
    const d = sessionDomain(session);
    return !!d && domainFilter.includes(d);
  };
  // Only agent credentials count as agent listeners (delivery status, initial sync)
  const isAgent = ctx.role === "agent" && url.searchParams.get("agent") === "true";

  // Set up SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Track this connection
  sseConnections.add(res);
  if (isAgent) {
    agentConnections.add(res);
  }

  // Send initial comment to establish connection
  res.write(`: connected${domain ? ` to domain ${domain}` : ""}\n\n`);

  // Send all pending annotations on connect (initial sync for agents)
  if (isAgent) {
    let syncCount = 0;
    const sessions = listSessionsFor(domainFilter);
    for (const session of sessions) {
      try {
        const pending = getPendingAnnotations(session.id);
        for (const annotation of pending) {
          // Send as annotation.created events so agents see existing annotations
          // Use sequence 0 for initial sync events (they're historical, not new)
          sendSSEEvent(res, {
            type: "annotation.created",
            sessionId: session.id,
            timestamp: annotation.createdAt || new Date().toISOString(),
            sequence: 0,
            payload: annotation,
          });
          syncCount++;
        }
      } catch {
        // Invalid URL, skip
      }
    }
    // Send a sync.complete event so agents know initial sync is done
    res.write(`event: sync.complete\ndata: ${JSON.stringify({ domain: domain ?? "all", count: syncCount, timestamp: new Date().toISOString() })}\n\n`);
  }

  // Subscribe to all events, optionally filter by domain
  const unsubscribe = eventBus.subscribe((event: AFSEvent) => {
    if (domainFilter === undefined) {
      // No domain filter -- stream all events
      sendSSEEvent(res, event);
      return;
    }
    const session = getSession(event.sessionId);
    if (session && matchesFilter(session)) {
      sendSSEEvent(res, event);
    }
  });

  // Keep connection alive with periodic comments
  const keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 30000);

  // Clean up on disconnect
  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
    sseConnections.delete(res);
    agentConnections.delete(res);
  });
};

/**
 * GET /extension - Config for the browser extension (active domains).
 */
const extensionConfigHandler: RouteHandler = async (_req, res) => {
  const domains = listDomains()
    .filter((d) => d.status === "active")
    .map((d) => ({ domain: d.domain, project: d.project }));
  // restricted=false means no auth/allowlist (local dev): every site may be used
  sendJson(res, 200, { restricted: isAuthEnabled(), domains });
};

/**
 * GET /feedbacks?domain=x.com[&limit=100][&status=pending,acknowledged]
 * Annotations of a domain, newest first. Used by the extension.
 */
const listFeedbacksHandler: RouteHandler = async (req, res, _params, ctx) => {
  const url = new URL(req.url || "/", "http://localhost");
  const domain = normalizeDomain(url.searchParams.get("domain") ?? "");
  if (!domain) {
    return sendError(res, 400, "domain is required");
  }
  if (ctx.role === "ingest" && !isDomainAllowed(domain)) {
    return sendError(res, 403, `Domain is not allowed: ${domain}`);
  }
  const limitParam = parseInt(url.searchParams.get("limit") || "100", 10);
  const limit = Math.min(500, Math.max(1, isNaN(limitParam) ? 100 : limitParam));
  const statuses = (url.searchParams.get("status") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is AnnotationStatus => ANNOTATION_STATUSES.includes(s as AnnotationStatus));
  const annotations = listAnnotationsByDomain(domain, limit, statuses);
  sendJson(res, 200, { domain, count: annotations.length, annotations });
};

/**
 * PUT /domains - Register a project's domains (called by MCP on startup).
 * Idempotent. Disabled domains stay disabled.
 */
const registerDomainsHandler: RouteHandler = async (req, res) => {
  try {
    const body = await parseBody<{ project?: unknown; domains?: unknown }>(req);
    const project = typeof body.project === "string" ? body.project.trim() : "";
    if (!project || project.length > 100) {
      return sendError(res, 400, "project is required (max 100 chars)");
    }
    if (!Array.isArray(body.domains) || body.domains.length === 0) {
      return sendError(res, 400, "domains must be a non-empty array");
    }

    const valid: string[] = [];
    const invalid: string[] = [];
    for (const raw of body.domains) {
      const domain = typeof raw === "string" ? normalizeDomain(raw) : undefined;
      if (domain) valid.push(domain);
      else invalid.push(String(raw));
    }
    if (valid.length === 0) {
      return sendError(res, 400, `No valid domains: ${invalid.join(", ")}`);
    }

    const result = registerDomains(project, [...new Set(valid)]);
    log(`[Domains] ${project}: registered ${result.registered.length}, disabled ${result.disabled.length}`);
    sendJson(res, 200, { project, ...result, invalid });
  } catch (err) {
    sendError(res, 400, (err as Error).message);
  }
};

/**
 * GET /domains - List all registered domains.
 */
const listDomainsHandler: RouteHandler = async (_req, res) => {
  sendJson(res, 200, { domains: listDomains() });
};

function parseDomainParam(raw: string): string | undefined {
  try {
    return normalizeDomain(decodeURIComponent(raw));
  } catch {
    return undefined;
  }
}

/**
 * DELETE /domains/:domain - Disable a domain. Existing feedback is kept.
 */
const disableDomainHandler: RouteHandler = async (_req, res, params) => {
  const domain = parseDomainParam(params.domain);
  if (!domain) {
    return sendError(res, 400, "Invalid domain");
  }
  const disabled = disableDomain(domain);
  if (!disabled) {
    return sendError(res, 404, `Domain not found: ${domain}`);
  }
  log(`[Domains] Disabled ${domain}`);
  sendJson(res, 200, disabled);
};

/**
 * POST /domains/:domain/enable - Re-enable a disabled domain.
 */
const enableDomainHandler: RouteHandler = async (_req, res, params) => {
  const domain = parseDomainParam(params.domain);
  if (!domain) {
    return sendError(res, 400, "Invalid domain");
  }
  const enabled = enableDomain(domain);
  if (!enabled) {
    return sendError(res, 404, `Domain not found: ${domain}`);
  }
  log(`[Domains] Enabled ${domain}`);
  sendJson(res, 200, enabled);
};

/**
 * Handle MCP protocol requests at /mcp endpoint.
 * Supports POST (requests), GET (SSE stream), and DELETE (session cleanup).
 */
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method || "GET";
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  // POST: Handle JSON-RPC requests
  if (method === "POST") {
    let transport: StreamableHTTPServerTransport;

    if (sessionId) {
      // Session ID provided - must exist in our map
      if (!mcpTransports.has(sessionId)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session not found. Please re-initialize." },
          id: null
        }));
        return;
      }
      transport = mcpTransports.get(sessionId)!;
    } else {
      // No session ID - this should be an initialize request, create new session
      const scope = mcpScopeFromHeaders(req);
      const { transport: newTransport } = createMcpSession(scope);
      transport = newTransport;
      // Register the project's domains right away; tool calls retry if this fails
      registerProjectDomains(scope).catch((err) =>
        log(`[MCP HTTP] Domain registration failed: ${(err as Error).message}`)
      );
    }

    try {
      // Read the request body
      const body = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => (data += chunk));
        req.on("end", () => resolve(data));
        req.on("error", reject);
      });

      const parsedBody = body ? JSON.parse(body) : undefined;

      // Handle the request through the transport (it writes directly to res)
      await transport.handleRequest(req, res, parsedBody);

      // Store the transport with its session ID after the request is handled (for new sessions)
      const newSessionId = transport.sessionId;
      if (newSessionId && !mcpTransports.has(newSessionId)) {
        mcpTransports.set(newSessionId, transport);
        log(`[MCP HTTP] New session created: ${newSessionId}`);
      }
    } catch (err) {
      console.error("[MCP HTTP] Error handling request:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
    return;
  }

  // GET: SSE stream for notifications
  if (method === "GET") {
    if (!sessionId || !mcpTransports.has(sessionId)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing or invalid Mcp-Session-Id" }));
      return;
    }

    const transport = mcpTransports.get(sessionId)!;

    try {
      // Handle the SSE request (transport writes directly to res)
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[MCP HTTP] Error handling SSE:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
    return;
  }

  // DELETE: Session cleanup
  if (method === "DELETE") {
    if (sessionId && mcpTransports.has(sessionId)) {
      const transport = mcpTransports.get(sessionId)!;
      await transport.close();
      mcpTransports.delete(sessionId);
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
    }
    return;
  }

  // Method not allowed
  res.writeHead(405, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Method not allowed" }));
}

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------

type Route = {
  method: string;
  pattern: RegExp;
  handler: RouteHandler;
  paramNames: string[];
  /** Roles allowed to call this route (default: agent only) */
  roles?: Role[];
  /**
   * For ingest callers: which resource `params.id` refers to. The resource's
   * session must belong to an active allowlisted domain.
   */
  scope?: "session" | "annotation";
};

const ANY_ROLE: Role[] = ["agent", "ingest"];

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/extension$/,
    handler: extensionConfigHandler,
    paramNames: [],
    roles: ANY_ROLE,
  },
  {
    method: "GET",
    pattern: /^\/feedbacks$/,
    handler: listFeedbacksHandler,
    paramNames: [],
    roles: ANY_ROLE,
  },
  {
    method: "GET",
    pattern: /^\/domains$/,
    handler: listDomainsHandler,
    paramNames: [],
  },
  {
    method: "PUT",
    pattern: /^\/domains$/,
    handler: registerDomainsHandler,
    paramNames: [],
  },
  {
    method: "DELETE",
    pattern: /^\/domains\/([^/]+)$/,
    handler: disableDomainHandler,
    paramNames: ["domain"],
  },
  {
    method: "POST",
    pattern: /^\/domains\/([^/]+)\/enable$/,
    handler: enableDomainHandler,
    paramNames: ["domain"],
  },
  {
    method: "GET",
    pattern: /^\/events$/,
    handler: globalSseHandler,
    paramNames: [],
    roles: ANY_ROLE,
  },
  {
    method: "GET",
    pattern: /^\/pending$/,
    handler: getAllPendingHandler,
    paramNames: [],
  },
  {
    method: "GET",
    pattern: /^\/sessions$/,
    handler: listSessionsHandler,
    paramNames: [],
  },
  {
    method: "POST",
    pattern: /^\/sessions$/,
    handler: createSessionHandler,
    paramNames: [],
    roles: ANY_ROLE,
  },
  {
    method: "GET",
    pattern: /^\/sessions\/([^/]+)$/,
    handler: getSessionHandler,
    paramNames: ["id"],
    roles: ANY_ROLE,
    scope: "session",
  },
  {
    method: "GET",
    pattern: /^\/sessions\/([^/]+)\/events$/,
    handler: sseHandler,
    paramNames: ["id"],
    roles: ANY_ROLE,
    scope: "session",
  },
  {
    method: "GET",
    pattern: /^\/sessions\/([^/]+)\/pending$/,
    handler: getPendingHandler,
    paramNames: ["id"],
    roles: ANY_ROLE,
    scope: "session",
  },
  {
    method: "POST",
    pattern: /^\/sessions\/([^/]+)\/action$/,
    handler: requestActionHandler,
    paramNames: ["id"],
    roles: ANY_ROLE,
    scope: "session",
  },
  {
    method: "POST",
    pattern: /^\/sessions\/([^/]+)\/annotations$/,
    handler: addAnnotationHandler,
    paramNames: ["id"],
    roles: ANY_ROLE,
    scope: "session",
  },
  {
    method: "PATCH",
    pattern: /^\/annotations\/([^/]+)$/,
    handler: updateAnnotationHandler,
    paramNames: ["id"],
    roles: ANY_ROLE,
    scope: "annotation",
  },
  {
    method: "GET",
    pattern: /^\/annotations\/([^/]+)$/,
    handler: getAnnotationHandler,
    paramNames: ["id"],
    roles: ANY_ROLE,
    scope: "annotation",
  },
  {
    method: "DELETE",
    pattern: /^\/annotations\/([^/]+)$/,
    handler: deleteAnnotationHandler,
    paramNames: ["id"],
    roles: ANY_ROLE,
    scope: "annotation",
  },
  {
    method: "POST",
    pattern: /^\/annotations\/([^/]+)\/thread$/,
    handler: addThreadHandler,
    paramNames: ["id"],
    roles: ANY_ROLE,
    scope: "annotation",
  },
];

/**
 * Match a request to a route.
 */
function matchRoute(
  method: string,
  pathname: string
): { route: Route; handler: RouteHandler; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;

    const match = pathname.match(route.pattern);
    if (match) {
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = match[i + 1];
      });
      return { route, handler: route.handler, params };
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Server
// -----------------------------------------------------------------------------

/**
 * Create and start the HTTP server.
 * @param port - Port to listen on
 * @param apiKey - Optional API key for cloud storage mode
 */
export function startHttpServer(port: number, apiKey?: string): void {
  // Set cloud mode if API key provided
  if (apiKey) {
    setCloudApiKey(apiKey);
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://localhost:${port}`);
    const pathname = url.pathname;
    const method = req.method || "GET";

    // Log all requests for debugging
    if (method !== "OPTIONS" && pathname !== "/health") {
      log(`[HTTP] ${method} ${pathname}`);
    }

    applyCors(req, res);

    // Handle CORS preflight
    if (method === "OPTIONS") {
      return handleCors(res);
    }

    // Health check (always local, no auth)
    if (pathname === "/health" && method === "GET") {
      return sendJson(res, 200, { status: "ok", mode: isCloudMode() ? "cloud" : "local" });
    }

    // No OAuth here. Answer discovery/registration with 404 so MCP clients
    // (e.g. Claude Code) use the configured headers instead of starting OAuth.
    if (pathname.startsWith("/.well-known/") || pathname === "/register" || pathname === "/authorize" || pathname === "/token") {
      return sendError(res, 404, "This server doesn't use OAuth. Send X-Agentation-Auth: user:password (or HTTP Basic auth).");
    }

    // Everything else requires credentials when auth is enabled.
    // No WWW-Authenticate header: it would make browsers show a login dialog.
    const role = authenticate(req);
    if (!role) {
      return sendError(res, 401, "Unauthorized: send X-Agentation-Auth: user:password (or HTTP Basic auth)");
    }

    // Status endpoint (always local)
    if (pathname === "/status" && method === "GET") {
      const webhookUrls = getWebhookUrls();
      return sendJson(res, 200, {
        mode: isCloudMode() ? "cloud" : "local",
        webhooksConfigured: webhookUrls.length > 0,
        webhookCount: webhookUrls.length,
        activeListeners: sseConnections.size,
        agentListeners: agentConnections.size,
      });
    }

    // MCP protocol endpoint (always local - allows Claude Code to connect)
    if (pathname === "/mcp") {
      if (role !== "agent") {
        return sendError(res, 403, "Forbidden");
      }
      return handleMcp(req, res);
    }

    // Cloud mode: proxy all other requests to cloud API
    if (isCloudMode()) {
      return proxyToCloud(req, res, pathname + url.search);
    }

    // Local mode: use local store
    const match = matchRoute(method, pathname);
    if (!match) {
      return sendError(res, 404, "Not found");
    }

    const allowedRoles = match.route.roles ?? ["agent"];
    if (!allowedRoles.includes(role)) {
      return sendError(res, 403, "Forbidden");
    }

    // Browser pages may only use the ingest credential from an allowed domain.
    // Extension pages send a chrome-extension:// origin and are not checked.
    if (role === "ingest") {
      const origin = req.headers.origin;
      if (origin?.startsWith("http") && !isDomainAllowed(domainOfUrl(origin))) {
        return sendError(res, 403, "Origin is not allowed");
      }
    }

    if (role === "ingest" && match.route.scope) {
      const sessionId =
        match.route.scope === "session" ? match.params.id : getAnnotation(match.params.id)?.sessionId;
      const session = sessionId ? getSession(sessionId) : undefined;
      if (!session) {
        return sendError(res, 404, match.route.scope === "session" ? "Session not found" : "Annotation not found");
      }
      if (!isDomainAllowed(sessionDomain(session))) {
        return sendError(res, 403, "Domain is not allowed");
      }
    }

    try {
      await match.handler(req, res, match.params, { role });
    } catch (err) {
      console.error("Request error:", err);
      sendError(res, 500, "Internal server error");
    }
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log(`[HTTP] Port ${port} already in use — skipping HTTP server (MCP stdio still active)`);
    } else {
      log(`[HTTP] Server error: ${err.message}`);
    }
  });

  server.listen(port, () => {
    if (isCloudMode()) {
      log(`[HTTP] Agentation server listening on http://localhost:${port} (cloud mode)`);
    } else {
      log(`[HTTP] Agentation server listening on http://localhost:${port}`);
    }
  });
}
