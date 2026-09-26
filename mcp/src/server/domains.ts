/**
 * Domain helpers shared by the HTTP server, stores, and MCP client.
 *
 * A "domain" is a URL host: hostname plus port when non-default
 * (e.g. "your-domain.com", "staging.your-domain.com", "localhost:3000").
 */

/**
 * Normalize user input ("https://Foo.com/path", "foo.com", "localhost:3000")
 * to a URL host. Returns undefined for anything that is not a plain host.
 */
export function normalizeDomain(input: string): string | undefined {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || /\s/.test(trimmed)) return undefined;
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return url.host || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Get the domain of a full page URL.
 */
export function domainOfUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.host.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse a comma-separated domain list, dropping invalid entries and duplicates.
 */
export function parseDomainList(value: string | null | undefined): string[] {
  if (!value) return [];
  const domains = value
    .split(",")
    .map((d) => normalizeDomain(d))
    .filter((d): d is string => !!d);
  return [...new Set(domains)];
}
