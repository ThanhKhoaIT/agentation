/**
 * Side panel: feedback that still needs work on the site in the active tab,
 * grouped by page. All server data is rendered with textContent (never innerHTML).
 */

import {
  ApiError,
  KEYS,
  NotConfiguredError,
  apiFetch,
  findAllowedDomain,
  getBranding,
  getCachedAllowlist,
  getConfig,
  isHostAllowed,
  readProfileEmail,
  type Branding,
} from "./config";

type ThreadMessage = { role: "human" | "agent"; content: string; timestamp: number };

type Status = "pending" | "acknowledged";

type Feedback = {
  id: string;
  comment: string;
  element: string;
  elementPath: string;
  fullPath?: string;
  url?: string;
  y?: number;
  isFixed?: boolean;
  status?: Status;
  authorId?: string;
  createdAt?: string;
  thread?: ThreadMessage[];
};

// Fallback polling, only while the live stream is not connected
const POLL_MS = 20_000;
const STREAM_RETRY_MIN_MS = 2_000;
const STREAM_RETRY_MAX_MS = 30_000;
const RELOAD_DEBOUNCE_MS = 300;
const SVG_NS = "http://www.w3.org/2000/svg";
// Only feedback that still needs work; fixed and closed ones are not listed
const OPEN_STATUSES = "pending,acknowledged";
const STATUS_LABELS: Record<Status, string> = { pending: "New", acknowledged: "In progress" };
const FOCUS_ATTEMPTS = 8;
const FOCUS_RETRY_MS = 400;
const EXPAND_ANIMATION_MS = 200;
const COPY_CONFIRM_MS = 1500;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const faviconEl = document.getElementById("favicon") as HTMLDivElement;
const siteNameEl = document.getElementById("site-name") as HTMLHeadingElement;
const subtitleEl = document.getElementById("page-title") as HTMLDivElement;
const refreshButton = document.getElementById("refresh") as HTMLButtonElement;
const controlsEl = document.getElementById("controls") as HTMLDivElement;
const copyButton = document.getElementById("copy") as HTMLButtonElement;
const filterAll = document.getElementById("filter-all") as HTMLButtonElement;
const filterMine = document.getElementById("filter-mine") as HTMLButtonElement;
const listEl = document.getElementById("list") as HTMLElement;

let branding: Branding | undefined;
let currentTab: chrome.tabs.Tab | undefined;
let currentHost = "";
let currentProject: string | undefined;
let feedbacks: Feedback[] = [];
let onlyMine = false;
let myEmail: string | undefined;
// Ids seen on the previous load of this host, to highlight new arrivals
let knownIds: Set<string> | undefined;
let newIds = new Set<string>();
// Feedback to scroll to once the tab finishes loading its page
let pendingFocus: { tabId: number; path: string; feedback: Feedback } | undefined;
// The one feedback shown in full; kept across reloads
let expandedId: string | undefined;
// Page groups in the order first shown for this site. Kept stable so the list
// doesn't jump when the user opens a feedback (which may change the tab's page).
let groupOrder: string[] = [];
// Live updates for the current site (server-sent events)
let stream: { host: string; controller: AbortController } | undefined;
let streamConnected = false;
let streamRetryMs = STREAM_RETRY_MIN_MS;
let streamRetryTimer: ReturnType<typeof setTimeout> | undefined;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

// -----------------------------------------------------------------------------
// DOM helpers
// -----------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name: string, className = "icon"): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

function showState(
  iconName: string,
  text: string,
  options: { error?: boolean; action?: { label: string; run: () => void } } = {}
): void {
  controlsEl.classList.add("hidden");
  copyButton.disabled = true;
  const state = el("div", options.error ? "state error" : "state");
  state.append(icon(iconName), el("p", undefined, text));
  if (options.action) {
    const button = el("button", undefined, options.action.label);
    button.addEventListener("click", options.action.run);
    state.append(button);
  }
  listEl.replaceChildren(state);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------

function timeAgo(iso?: string): string {
  if (!iso) return "";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleDateString();
}

function pagePath(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.pathname + parsed.search;
  } catch {
    return undefined;
  }
}

const PATH_MAX_CHARS = 28;
const PATH_HEAD_CHARS = 14;
const PATH_TAIL_CHARS = 8;

/**
 * Readable page label: "Homepage" for "/", long paths shortened in the middle
 * ("/thong-bao-qua…77177.chn") so both the start and the file-like end show.
 */
function formatPath(path: string): string {
  if (path === "/") return "Homepage";
  if (path.length <= PATH_MAX_CHARS) return path;
  return `${path.slice(0, PATH_HEAD_CHARS)}…${path.slice(-PATH_TAIL_CHARS)}`;
}

function statusOf(feedback: Feedback): Status {
  return feedback.status === "acknowledged" ? "acknowledged" : "pending";
}

function isOnCurrentPage(feedback: Feedback): boolean {
  const path = pagePath(feedback.url);
  if (!path || !currentTab?.url) return true;
  return path === pagePath(currentTab.url);
}

// -----------------------------------------------------------------------------
// Header: favicon + project name + slogan
// -----------------------------------------------------------------------------

function renderHeader(projectName?: string): void {
  const title = currentTab?.title?.trim();
  siteNameEl.textContent = projectName || title || "This site";
  subtitleEl.textContent = branding?.slogan ?? "";

  const favIconUrl = currentTab?.favIconUrl;
  if (favIconUrl && !favIconUrl.startsWith("chrome://")) {
    const img = el("img");
    img.alt = "";
    img.src = favIconUrl;
    img.addEventListener("error", () => faviconEl.replaceChildren(icon("globe")));
    faviconEl.replaceChildren(img);
  } else {
    faviconEl.replaceChildren(icon("globe"));
  }
}

// -----------------------------------------------------------------------------
// Going to feedback
// -----------------------------------------------------------------------------

/**
 * Ask the page to scroll to the feedback's element. Retries while the page
 * (or a late-rendering element) is still loading; only the last attempt
 * falls back to the saved scroll position.
 */
async function focusOnPage(feedback: Feedback, attempts = 1): Promise<void> {
  const tabId = currentTab?.id;
  if (tabId === undefined) return;
  for (let i = 0; i < attempts; i++) {
    const isLast = i === attempts - 1;
    try {
      const response = (await chrome.tabs.sendMessage(tabId, {
        type: "agentation:focus",
        annotation: {
          fullPath: feedback.fullPath,
          elementPath: feedback.elementPath,
          y: feedback.y,
          isFixed: feedback.isFixed,
        },
        fallback: isLast,
      })) as { found?: boolean } | undefined;
      if (response?.found) return;
    } catch (err) {
      // Content script not ready yet
      if (isLast) console.warn("[Agentation] Could not show feedback on page:", err);
    }
    if (!isLast) await sleep(FOCUS_RETRY_MS);
  }
}

function goToFeedback(feedback: Feedback): void {
  if (isOnCurrentPage(feedback)) {
    focusOnPage(feedback);
    return;
  }
  const path = pagePath(feedback.url);
  if (currentTab?.id === undefined || !feedback.url || !path) return;
  pendingFocus = { tabId: currentTab.id, path, feedback };
  chrome.tabs.update(currentTab.id, { url: feedback.url });
}

function openGroupPage(url: string): void {
  if (currentTab?.id !== undefined) chrome.tabs.update(currentTab.id, { url });
}

// -----------------------------------------------------------------------------
// List
// -----------------------------------------------------------------------------

function renderAuthor(authorId?: string): HTMLElement {
  if (!authorId) return el("span", "author", "Unknown");
  const author = el("span", "author", authorId === myEmail ? "You" : authorId.split("@")[0]);
  author.title = authorId;
  return author;
}

function findItem(id: string | undefined): HTMLElement | null {
  if (!id) return null;
  return listEl.querySelector<HTMLElement>(`.feedback[data-id="${CSS.escape(id)}"]`);
}

/**
 * Open/close an item in place (no re-render) and animate its height change.
 */
function setItemExpanded(item: HTMLElement, expanded: boolean): void {
  const from = item.offsetHeight;
  item.classList.toggle("expanded", expanded);
  item.setAttribute("aria-expanded", String(expanded));
  if (reducedMotion.matches) return;

  const to = item.offsetHeight;
  item.getAnimations().forEach((animation) => animation.cancel());
  item.animate([{ height: `${from}px` }, { height: `${to}px` }], {
    duration: EXPAND_ANIMATION_MS,
    easing: "ease-out",
  });
  if (expanded) {
    item.querySelector(".details")?.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: EXPAND_ANIMATION_MS,
      easing: "ease-out",
    });
  }
}

function toggleExpanded(feedback: Feedback): void {
  const expanding = expandedId !== feedback.id;
  const previous = findItem(expandedId);
  expandedId = expanding ? feedback.id : undefined;

  if (previous) setItemExpanded(previous, false);
  if (expanding) {
    const item = findItem(feedback.id);
    if (item) setItemExpanded(item, true);
    // Opening a feedback also takes the user to it on the page
    goToFeedback(feedback);
  }
}

function renderItem(feedback: Feedback): HTMLElement {
  const status = statusOf(feedback);
  const expanded = expandedId === feedback.id;
  const item = el("article", `feedback ${status}`);
  if (expanded) item.classList.add("expanded");
  if (newIds.has(feedback.id)) item.classList.add("is-new");
  item.dataset.id = feedback.id;
  item.tabIndex = 0;
  item.setAttribute("aria-expanded", String(expanded));

  // Left column: go to the feedback on the page, colored by status
  const pin = el("button", `pin ${status}`);
  pin.title = "Show on page";
  pin.setAttribute("aria-label", `Show on page (${STATUS_LABELS[status]})`);
  pin.append(icon("locate"));
  pin.addEventListener("click", (event) => {
    event.stopPropagation();
    goToFeedback(feedback);
  });
  item.append(pin);

  const body = el("div", "body");
  body.append(el("p", "comment", feedback.comment));

  const hasAgentReply = !!feedback.thread?.some((m) => m.role === "agent");
  const byline = el("div", "byline");
  byline.append(renderAuthor(feedback.authorId), el("span", "when", timeAgo(feedback.createdAt)));
  if (status === "acknowledged") byline.append(el("span", "tag", STATUS_LABELS.acknowledged));
  if (hasAgentReply) {
    const replied = el("span", "replied");
    replied.append(icon("agent"), el("span", undefined, "Tech team replied"));
    byline.append(replied);
  }
  body.append(byline);

  // Always rendered; hidden by CSS until the item is expanded
  const details = el("div", "details");
  const target = el("div", "target");
  target.append(el("span", "target-name", `On ${feedback.element}`));
  details.append(target);

  if (feedback.thread && feedback.thread.length > 0) {
    const thread = el("div", "thread");
    for (const message of feedback.thread) {
      const reply = el("div", `reply ${message.role}`);
      const text = el("p");
      text.append(el("strong", undefined, message.role === "agent" ? "Tech team" : "Reply"));
      text.append(document.createTextNode(message.content));
      reply.append(icon(message.role === "agent" ? "agent" : "reply"), text);
      thread.append(reply);
    }
    details.append(thread);
  }

  body.append(details);
  item.append(body);
  bindItemEvents(item, feedback);
  return item;
}

function bindItemEvents(item: HTMLElement, feedback: Feedback): void {
  item.addEventListener("click", () => toggleExpanded(feedback));
  item.addEventListener("keydown", (event) => {
    if (event.target !== item || (event.key !== "Enter" && event.key !== " ")) return;
    event.preventDefault();
    toggleExpanded(feedback);
  });
}

function renderGroup(path: string, url: string | undefined, items: Feedback[], isCurrent: boolean): HTMLElement {
  const group = el("section", "group");
  const head = el("div", "group-head");
  if (isCurrent) {
    const here = el("span", "group-here", formatPath(path));
    here.title = `This page: ${url ?? path}`;
    head.append(icon("here"), here);
  } else {
    head.append(icon("external"));
    const link = el("button", "group-link", formatPath(path));
    link.title = url ?? path;
    if (url) link.addEventListener("click", () => openGroupPage(url));
    head.append(link);
  }
  head.append(el("span", "group-count", String(items.length)));
  group.append(head, ...items.map(renderItem));
  return group;
}

function render(): void {
  if (feedbacks.length === 0) {
    showState("inbox", "Nothing to fix on this site. Use the feedback button on the page to add a note.");
    return;
  }

  const visible = feedbacks.filter((f) => !onlyMine || (!!myEmail && f.authorId === myEmail));
  controlsEl.classList.remove("hidden");
  copyButton.disabled = false;
  filterAll.setAttribute("aria-pressed", String(!onlyMine));
  filterMine.setAttribute("aria-pressed", String(onlyMine));

  if (visible.length === 0) {
    const state = el("div", "state");
    state.append(icon("user"), el("p", undefined, "You have no open feedback on this site."));
    const showAll = el("button", undefined, "Show everyone's");
    showAll.addEventListener("click", () => {
      onlyMine = false;
      render();
    });
    state.append(showAll);
    listEl.replaceChildren(state);
    return;
  }

  const currentPath = pagePath(currentTab?.url);
  const scrollTop = listEl.scrollTop;
  listEl.replaceChildren(
    ...groupByPage(visible).map(([path, group]) => renderGroup(path, group.url, group.items, path === currentPath))
  );
  listEl.scrollTop = scrollTop;
}

type PageGroup = { url?: string; items: Feedback[] };

/**
 * Group feedback by page path, in a stable order (see groupOrder).
 */
function groupByPage(list: Feedback[]): Array<readonly [string, PageGroup]> {
  // Newest-first order from the server decides the initial group order
  const groups = new Map<string, PageGroup>();
  for (const feedback of list) {
    const path = pagePath(feedback.url) ?? "/";
    const group = groups.get(path) ?? { url: feedback.url, items: [] };
    group.items.push(feedback);
    groups.set(path, group);
  }

  const currentPath = pagePath(currentTab?.url);
  if (groupOrder.length === 0) {
    // First render for this site: the page the user is on comes first
    groupOrder = [...groups.keys()].sort((a, b) => Number(b === currentPath) - Number(a === currentPath));
  } else {
    // Pages that got feedback since then go to the end
    for (const path of groups.keys()) {
      if (!groupOrder.includes(path)) groupOrder.push(path);
    }
  }
  return groupOrder.filter((path) => groups.has(path)).map((path) => [path, groups.get(path)!] as const);
}

// -----------------------------------------------------------------------------
// Copy
// -----------------------------------------------------------------------------

function indent(text: string): string {
  return text.replace(/\n/g, "\n   ");
}

/**
 * All open feedback of the site as plain text (ignores the Everyone/Mine filter).
 */
function buildCopyText(): string {
  const siteName = currentProject || currentTab?.title?.trim() || currentHost;
  const lines = [`${siteName}: ${feedbacks.length} feedback to fix`, ""];
  for (const [path, group] of groupByPage(feedbacks)) {
    lines.push(group.url ?? path);
    group.items.forEach((feedback, index) => {
      lines.push(`${index + 1}. ${indent(feedback.comment)}`);
      lines.push(`   On ${feedback.element}`);
      const author = feedback.authorId ? feedback.authorId.split("@")[0] : "Unknown";
      const status = statusOf(feedback) === "acknowledged" ? ` (${STATUS_LABELS.acknowledged})` : "";
      lines.push(`   By ${author}, ${timeAgo(feedback.createdAt)}${status}`);
      for (const message of feedback.thread ?? []) {
        lines.push(`   ${message.role === "agent" ? "Tech team" : "Reply"}: ${indent(message.content)}`);
      }
    });
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

async function copyAll(): Promise<void> {
  if (feedbacks.length === 0) return;
  const use = copyButton.querySelector("use");
  try {
    await navigator.clipboard.writeText(buildCopyText());
    copyButton.classList.add("done");
    copyButton.title = "Copied";
    copyButton.setAttribute("aria-label", "Copied");
    use?.setAttribute("href", "#i-check");
  } catch (err) {
    console.error("[Agentation] Could not copy feedback:", err);
    copyButton.title = "Couldn't copy. Try again.";
    return;
  }
  setTimeout(() => {
    copyButton.classList.remove("done");
    copyButton.title = "Copy all feedback";
    copyButton.setAttribute("aria-label", "Copy all feedback");
    use?.setAttribute("href", "#i-copy");
  }, COPY_CONFIRM_MS);
}

// -----------------------------------------------------------------------------
// Live updates
// -----------------------------------------------------------------------------

function scheduleReload(): void {
  // Coalesce bursts (e.g. "clear all" emits one event per feedback)
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(reload, RELOAD_DEBOUNCE_MS);
}

function stopStream(): void {
  if (streamRetryTimer) clearTimeout(streamRetryTimer);
  streamRetryTimer = undefined;
  stream?.controller.abort();
  stream = undefined;
  streamConnected = false;
  streamRetryMs = STREAM_RETRY_MIN_MS;
}

/**
 * Stream feedback changes for a site from everyone (other members, the tech
 * team). Uses fetch instead of EventSource so the access key can be sent.
 */
async function startStream(host: string): Promise<void> {
  if (stream?.host === host) return;
  const isRetry = streamRetryMs > STREAM_RETRY_MIN_MS;
  if (streamRetryTimer) clearTimeout(streamRetryTimer);
  stream?.controller.abort();

  const controller = new AbortController();
  stream = { host, controller };
  try {
    const config = await getConfig();
    const res = await apiFetch(config, `/events?domains=${encodeURIComponent(host)}`, {
      signal: controller.signal,
      headers: { Accept: "text/event-stream" },
    });
    if (!res.ok || !res.body) throw new ApiError(res.status, `Stream returned ${res.status}`);

    streamConnected = true;
    streamRetryMs = STREAM_RETRY_MIN_MS;
    // Catch up on anything missed while disconnected
    if (isRetry) scheduleReload();

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("event: ")) continue;
        const type = line.slice(7).trim();
        if (type.startsWith("annotation.") || type === "thread.message") scheduleReload();
      }
    }
    throw new Error("Stream closed by server");
  } catch (err) {
    if (controller.signal.aborted) return;
    streamConnected = false;
    // Polling keeps the list in sync while the stream is down, so this is not an error
    if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
      // Server without live updates for this key (e.g. older version): polling only.
      // `stream` stays set so later loads of this site don't reconnect.
      console.debug(`[Agentation] Live updates unavailable (${err.status}), using polling`);
      return;
    }
    stream = undefined;
    console.debug(`[Agentation] Live updates disconnected, retrying in ${streamRetryMs / 1000}s:`, err);
    streamRetryTimer = setTimeout(() => {
      if (currentHost === host) startStream(host);
    }, streamRetryMs);
    streamRetryMs = Math.min(streamRetryMs * 2, STREAM_RETRY_MAX_MS);
  }
}

// -----------------------------------------------------------------------------
// Loading
// -----------------------------------------------------------------------------

async function load(): Promise<void> {
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try {
    const url = new URL(currentTab?.url || "");
    if (url.protocol === "http:" || url.protocol === "https:") host = url.host;
  } catch {
    // chrome:// or empty tab
  }
  if (host !== currentHost) {
    currentHost = host;
    knownIds = undefined;
    groupOrder = [];
    expandedId = undefined;
    stopStream();
  }

  const allowlist = await getCachedAllowlist();
  currentProject = findAllowedDomain(allowlist, currentHost)?.project;
  renderHeader(currentProject);

  if (!currentHost) {
    feedbacks = [];
    stopStream();
    showState("globe", "Open a website to see its feedback.");
    return;
  }
  if (allowlist?.legacy) {
    feedbacks = [];
    stopStream();
    showState("alert", "The feedback list isn't available yet. Let your tech team know the feedback service needs an update.", { error: true });
    return;
  }
  if (!isHostAllowed(allowlist, currentHost)) {
    feedbacks = [];
    stopStream();
    showState("lock", "Feedback isn't set up for this site. Ask your tech team to add it.");
    return;
  }

  try {
    const config = await getConfig();
    const res = await apiFetch(
      config,
      `/feedbacks?domain=${encodeURIComponent(currentHost)}&status=${OPEN_STATUSES}&limit=200`
    );
    if (!res.ok) throw new ApiError(res.status, `Server returned ${res.status}`);
    const data = (await res.json()) as { annotations: Feedback[] };
    feedbacks = data.annotations ?? [];

    const ids = new Set(feedbacks.map((f) => f.id));
    newIds = knownIds ? new Set([...ids].filter((id) => !knownIds!.has(id))) : new Set();
    knownIds = ids;

    render();
    startStream(currentHost);
  } catch (err) {
    feedbacks = [];
    let message = "Can't connect right now. Check your internet connection and try again.";
    let iconName = "alert";
    if (err instanceof NotConfiguredError) {
      message = "Setup isn't finished yet. Open the extension from the toolbar to see what's needed.";
    } else if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      message = "Access was not accepted. Let your tech team know so they can check it.";
      iconName = "lock";
    } else if (err instanceof ApiError && err.status === 404) {
      message = "The feedback list isn't available yet. Let your tech team know the feedback service needs an update.";
    }
    showState(iconName, message, { error: true, action: { label: "Try again", run: reload } });
    console.warn("[Agentation] Failed to load feedbacks:", err);
  }
}

function reload(): void {
  refreshButton.classList.add("spinning");
  load()
    .catch((err) => {
      console.error("[Agentation] Side panel load failed:", err);
      showState("alert", "Loading feedback failed. Try again.", {
        error: true,
        action: { label: "Try again", run: reload },
      });
    })
    .finally(() => refreshButton.classList.remove("spinning"));
}

async function initIdentity(): Promise<void> {
  const cached = await chrome.storage.local.get(KEYS.reporterEmail);
  myEmail = ((cached[KEYS.reporterEmail] as string) || (await readProfileEmail()))?.toLowerCase();
  if (!myEmail) {
    filterMine.disabled = true;
    filterMine.title = "Sign in to Chrome with your work account to use this filter";
  }
}

async function initBranding(): Promise<void> {
  branding = await getBranding();
  document.title = `${branding.name} feedbacks`;
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

filterAll.addEventListener("click", () => {
  onlyMine = false;
  render();
});

filterMine.addEventListener("click", () => {
  onlyMine = true;
  render();
});

refreshButton.addEventListener("click", reload);
copyButton.addEventListener("click", copyAll);

chrome.tabs.onActivated.addListener(() => {
  pendingFocus = undefined;
  reload();
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (pendingFocus && tabId === pendingFocus.tabId && changeInfo.status === "complete") {
    const { path, feedback } = pendingFocus;
    pendingFocus = undefined;
    // Only scroll if the tab actually landed on the feedback's page
    if (pagePath(tab.url) === path) focusOnPage(feedback, FOCUS_ATTEMPTS);
  }
  if (tabId === currentTab?.id && (changeInfo.url || changeInfo.status === "complete" || changeInfo.favIconUrl)) {
    reload();
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && KEYS.allowlist in changes) reload();
});
// Instant update for the user's own changes on the current tab
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "agentation:feedbacks-changed" && message.host === currentHost) scheduleReload();
});

setInterval(() => {
  if (document.visibilityState === "visible" && !streamConnected) reload();
}, POLL_MS);

// Let the background know this window's panel is open, so the toolbar's
// "Open/close panel" button can close it. Pings keep the worker (and its
// record of open panels) alive while the panel stays open.
const PANEL_PING_MS = 25_000;
const PANEL_RECONNECT_MS = 1_000;

function registerPanel(windowId: number): void {
  const port = chrome.runtime.connect({ name: `sidepanel:${windowId}` });
  const ping = setInterval(() => port.postMessage({ type: "agentation:ping" }), PANEL_PING_MS);
  port.onMessage.addListener((message) => {
    if (message?.type === "agentation:close-panel") window.close();
  });
  // The worker restarted: register again so the toggle keeps working
  port.onDisconnect.addListener(() => {
    clearInterval(ping);
    setTimeout(() => registerPanel(windowId), PANEL_RECONNECT_MS);
  });
}

chrome.windows
  .getCurrent()
  .then((win) => {
    if (win.id !== undefined) registerPanel(win.id);
  })
  .catch((err) => console.error("[Agentation] Could not register the side panel:", err));

Promise.all([
  initBranding().catch((err) => console.error("[Agentation] Branding failed:", err)),
  initIdentity(),
]).finally(reload);
