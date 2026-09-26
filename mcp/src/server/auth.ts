/**
 * Basic auth for self-hosted deployments.
 *
 * Credentials come from the environment only ("user:password"):
 * - AGENTATION_AGENT_AUTH:  Claude Code / MCP clients (full access)
 * - AGENTATION_INGEST_AUTH: browser extension (submit + read feedback of allowed domains)
 *
 * When neither is set, auth is disabled and the server behaves as before
 * (local development on localhost).
 */

import type { IncomingMessage } from "http";
import { createHash, timingSafeEqual } from "crypto";

export type Role = "agent" | "ingest";

function readCredential(name: string): string | undefined {
  const value = process.env[name]?.trim();
  if (!value) return undefined;
  if (!value.includes(":")) {
    process.stderr.write(`[Auth] ${name} must be in "user:password" format — ignoring it\n`);
    return undefined;
  }
  return value;
}

const agentCredential = readCredential("AGENTATION_AGENT_AUTH");
const ingestCredential = readCredential("AGENTATION_INGEST_AUTH");

export function isAuthEnabled(): boolean {
  return !!agentCredential || !!ingestCredential;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function matches(candidate: string, expected: string | undefined): boolean {
  if (!expected) return false;
  return timingSafeEqual(digest(candidate), digest(expected));
}

/**
 * Resolve the caller's role from the Authorization header.
 * Returns undefined when auth is enabled and credentials are missing or wrong.
 */
export function authenticate(req: IncomingMessage): Role | undefined {
  if (!isAuthEnabled()) return "agent";

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Basic ")) return undefined;

  const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf-8");
  // Check both so timing does not reveal which credential matched
  const isAgent = matches(decoded, agentCredential);
  const isIngest = matches(decoded, ingestCredential);
  if (isAgent) return "agent";
  if (isIngest) return "ingest";
  return undefined;
}

/**
 * Build an Authorization header value for outgoing requests.
 */
export function basicAuthHeader(credential: string): string {
  return `Basic ${Buffer.from(credential, "utf-8").toString("base64")}`;
}
