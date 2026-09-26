/**
 * Shared extension config: server endpoint, ingest credential, domain allowlist.
 *
 * Endpoint and credential come from Google Workspace managed policy
 * (chrome.storage.managed) when present, otherwise from manual settings
 * in the popup (chrome.storage.local). Nothing is hardcoded in the build:
 * until an endpoint is configured the extension stays inactive.
 */

export type ExtensionConfig = {
  /** Undefined until configured by policy or in the popup */
  endpoint?: string;
  ingestAuth?: string;
  /** True when set by the organization's managed policy (read-only in the popup) */
  managed: boolean;
};

export type AllowedDomain = { domain: string; project: string };

export type Allowlist = {
  /** false = server runs without auth (local dev), every site may be used */
  restricted: boolean;
  domains: AllowedDomain[];
  fetchedAt: number;
  /** Server is the public npm agentation-mcp without allowlist support (local only) */
  legacy?: boolean;
};

export type SiteSettings = Record<string, { enabled: boolean }>;

// chrome.storage.local keys
export const KEYS = {
  endpoint: "endpoint",
  ingestAuth: "ingestAuth",
  allowlist: "allowlist",
  sites: "sites",
  reporterEmail: "reporterEmail",
} as const;

export function normalizeEndpoint(value: string): string | undefined {
  let endpoint = value.trim().replace(/\/+$/, "");
  if (!endpoint) return undefined;
  if (!/^https?:\/\//i.test(endpoint)) {
    const isLocal = /^(localhost|127\.0\.0\.1)(:|$)/i.test(endpoint);
    endpoint = `${isLocal ? "http" : "https"}://${endpoint}`;
  }
  return endpoint;
}

type ManagedPolicy = {
  endpoint?: string;
  ingestAuth?: string;
  brandName?: string;
  brandSlogan?: string;
};

async function readManaged(): Promise<ManagedPolicy> {
  try {
    return (await chrome.storage.managed.get(["endpoint", "ingestAuth", "brandName", "brandSlogan"])) as ManagedPolicy;
  } catch (err) {
    // Not managed (no policy set) — fall back to local settings
    console.debug("[Agentation] No managed config:", err);
    return {};
  }
}

/**
 * False once the extension was reloaded or updated while this page stayed
 * open: the old content script is orphaned and every chrome.* call throws
 * "Extension context invalidated".
 */
export function isExtensionContextValid(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

export async function getConfig(): Promise<ExtensionConfig> {
  const managed = await readManaged();
  if (managed.endpoint) {
    return {
      endpoint: normalizeEndpoint(managed.endpoint),
      ingestAuth: managed.ingestAuth || undefined,
      managed: true,
    };
  }
  const local = await chrome.storage.local.get([KEYS.endpoint, KEYS.ingestAuth]);
  return {
    endpoint: normalizeEndpoint((local[KEYS.endpoint] as string) || ""),
    ingestAuth: (local[KEYS.ingestAuth] as string) || undefined,
    managed: false,
  };
}

export const DEFAULT_BRAND_NAME = "Agentation";
export const DEFAULT_BRAND_SLOGAN = "Click to add feedbacks";

export type Branding = { name: string; slogan: string };

/**
 * Name and slogan shown in the extension UI, set by managed policy.
 */
export async function getBranding(): Promise<Branding> {
  const managed = await readManaged();
  return {
    name: managed.brandName?.trim() || DEFAULT_BRAND_NAME,
    slogan: managed.brandSlogan?.trim() || DEFAULT_BRAND_SLOGAN,
  };
}

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

export function basicAuth(credential: string): string {
  return `Basic ${toBase64(credential)}`;
}

/**
 * fetch() against the feedback server from extension pages (popup, side panel,
 * background). Content-script requests get the same headers via declarativeNetRequest.
 */
export async function apiFetch(config: ExtensionConfig, path: string, init: RequestInit = {}): Promise<Response> {
  if (!config.endpoint) throw new NotConfiguredError();
  const headers = new Headers(init.headers);
  if (config.ingestAuth) {
    headers.set("Authorization", basicAuth(config.ingestAuth));
  }
  return fetch(`${config.endpoint}${path}`, { ...init, headers });
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export class NotConfiguredError extends Error {
  constructor() {
    super("Feedback server is not configured");
  }
}

/** Server responded but does not know the route: an older agentation-mcp */
export class IncompatibleServerError extends Error {
  constructor() {
    super("Server does not support the domain allowlist — update agentation-mcp on the server");
  }
}

export function isLocalEndpoint(endpoint: string): boolean {
  try {
    const { hostname } = new URL(endpoint);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/**
 * Load the latest allowlist from the server and cache it.
 */
export async function fetchAllowlist(config?: ExtensionConfig): Promise<Allowlist> {
  const cfg = config ?? (await getConfig());
  if (!cfg.endpoint) {
    // Drop an allowlist cached from a previously configured server
    await chrome.storage.local.remove(KEYS.allowlist);
    throw new NotConfiguredError();
  }
  const res = await apiFetch(cfg, "/extension");
  if (res.status === 404) {
    if (!isLocalEndpoint(cfg.endpoint)) throw new IncompatibleServerError();
    // Local npm agentation-mcp (no allowlist support): behave like local mode
    const legacy: Allowlist = { restricted: false, domains: [], fetchedAt: Date.now(), legacy: true };
    await chrome.storage.local.set({ [KEYS.allowlist]: legacy });
    return legacy;
  }
  if (!res.ok) {
    throw new ApiError(res.status, `Server returned ${res.status}`);
  }
  const data = (await res.json()) as { restricted?: boolean; domains?: AllowedDomain[] };
  const allowlist: Allowlist = {
    restricted: data.restricted !== false,
    domains: data.domains ?? [],
    fetchedAt: Date.now(),
  };
  await chrome.storage.local.set({ [KEYS.allowlist]: allowlist });
  return allowlist;
}

export async function getCachedAllowlist(): Promise<Allowlist | undefined> {
  const result = await chrome.storage.local.get(KEYS.allowlist);
  return result[KEYS.allowlist] as Allowlist | undefined;
}

export function findAllowedDomain(allowlist: Allowlist | undefined, host: string): AllowedDomain | undefined {
  return allowlist?.domains.find((d) => d.domain === host.toLowerCase());
}

export function isHostAllowed(allowlist: Allowlist | undefined, host: string): boolean {
  if (!allowlist || !host) return false;
  return !allowlist.restricted || !!findAllowedDomain(allowlist, host);
}

export async function getSiteSettings(): Promise<SiteSettings> {
  const result = await chrome.storage.local.get(KEYS.sites);
  return (result[KEYS.sites] as SiteSettings) ?? {};
}

/**
 * Whether the toolbar shows on a site. Allowlisted sites are on by default;
 * in unrestricted (local dev) mode a site must be switched on explicitly.
 */
export function isSiteEnabled(allowlist: Allowlist | undefined, sites: SiteSettings, host: string): boolean {
  if (!isHostAllowed(allowlist, host)) return false;
  const explicit = sites[host.toLowerCase()]?.enabled;
  if (explicit !== undefined) return explicit;
  return !!allowlist?.restricted;
}

export async function setSiteEnabled(host: string, enabled: boolean): Promise<void> {
  const sites = await getSiteSettings();
  sites[host.toLowerCase()] = { enabled };
  await chrome.storage.local.set({ [KEYS.sites]: sites });
}

/**
 * Email of the Chrome profile (Google Workspace account). Extension pages only.
 */
export async function readProfileEmail(): Promise<string | undefined> {
  try {
    const info = await chrome.identity.getProfileUserInfo({
      accountStatus: chrome.identity.AccountStatus.ANY,
    });
    return info.email || undefined;
  } catch (err) {
    console.warn("[Agentation] Could not read profile email:", err);
    return undefined;
  }
}
