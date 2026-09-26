/**
 * Background service worker.
 *
 * - Keeps the domain allowlist fresh (install, browser startup, config change).
 * - Injects the ingest credential and reporter email into requests that the
 *   toolbar (content script) sends to the feedback server. The toolbar's
 *   fetch/EventSource cannot set headers themselves, so this is done with a
 *   declarativeNetRequest rule limited to allowlisted initiator sites.
 * - Disables the side panel on tabs whose site is not supported.
 * - Injects the toolbar bundle into a page when loader.ts asks for it.
 */

import {
  KEYS,
  basicAuth,
  fetchAllowlist,
  getBranding,
  getCachedAllowlist,
  getConfig,
  isHostAllowed,
  NotConfiguredError,
  readProfileEmail,
  type Allowlist,
} from "./config";

const HEADER_RULE_ID = 1;

async function refreshReporterEmail(): Promise<void> {
  const email = await readProfileEmail();
  await chrome.storage.local.set({ [KEYS.reporterEmail]: email ?? "" });
}

async function refreshAllowlist(): Promise<void> {
  try {
    await fetchAllowlist();
  } catch (err) {
    if (err instanceof NotConfiguredError) return;
    console.warn("[Agentation] Could not refresh allowlist:", (err as Error).message);
  }
}

async function syncHeaderRule(): Promise<void> {
  const config = await getConfig();
  if (!config.endpoint) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [HEADER_RULE_ID] });
    return;
  }
  const allowlist = await getCachedAllowlist();
  const { [KEYS.reporterEmail]: email } = await chrome.storage.local.get(KEYS.reporterEmail);

  const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];
  if (config.ingestAuth) {
    requestHeaders.push({
      header: "Authorization",
      operation: chrome.declarativeNetRequest.HeaderOperation.SET,
      value: basicAuth(config.ingestAuth),
    });
  }
  if (email) {
    requestHeaders.push({
      header: "X-Agentation-Reporter",
      operation: chrome.declarativeNetRequest.HeaderOperation.SET,
      value: email as string,
    });
  }

  const addRules: chrome.declarativeNetRequest.Rule[] = [];
  const condition: chrome.declarativeNetRequest.RuleCondition = {
    urlFilter: `|${config.endpoint}/`,
  };

  let canAddRule = requestHeaders.length > 0;
  if (allowlist?.restricted !== false) {
    // Only pages on allowlisted domains get credentials attached.
    // initiatorDomains takes hostnames (no port) and also matches subdomains.
    const hostnames = [...new Set((allowlist?.domains ?? []).map((d) => d.domain.replace(/:\d+$/, "")))];
    if (hostnames.length === 0) canAddRule = false;
    condition.initiatorDomains = hostnames;
  }

  if (canAddRule) {
    addRules.push({
      id: HEADER_RULE_ID,
      priority: 1,
      action: { type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS, requestHeaders },
      condition,
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [HEADER_RULE_ID],
    addRules,
  });
}

function hostOf(url: string | undefined): string {
  try {
    const parsed = new URL(url || "");
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.host : "";
  } catch {
    return "";
  }
}

async function syncSidePanelForTab(tabId: number, url: string | undefined, allowlist?: Allowlist): Promise<void> {
  const list = allowlist ?? (await getCachedAllowlist());
  const enabled = isHostAllowed(list, hostOf(url));
  await chrome.sidePanel.setOptions(
    enabled ? { tabId, path: "sidepanel.html", enabled: true } : { tabId, enabled: false }
  );
}

async function syncSidePanelAllTabs(): Promise<void> {
  const allowlist = await getCachedAllowlist();
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs.map((tab) =>
      tab.id === undefined
        ? undefined
        : syncSidePanelForTab(tab.id, tab.url, allowlist).catch((err) =>
            console.warn(`[Agentation] Side panel sync failed for tab ${tab.id}:`, err)
          )
    )
  );
}

async function syncActionTitle(): Promise<void> {
  const { name } = await getBranding();
  await chrome.action.setTitle({ title: name });
}

async function refreshAll(): Promise<void> {
  await syncActionTitle();
  await refreshReporterEmail();
  await refreshAllowlist();
  await syncHeaderRule();
  await syncSidePanelAllTabs();
}

// loader.ts (our own content script) asks for the toolbar once the site is enabled
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "agentation:inject-toolbar") return;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  chrome.scripting
    .executeScript({ target: { tabId, frameIds: [sender.frameId ?? 0] }, files: ["content.js"] })
    .then(() => sendResponse({ ok: true }))
    .catch((err) => {
      console.error(`[Agentation] Toolbar injection failed for tab ${tabId}:`, err);
      sendResponse({ ok: false });
    });
  return true; // respond asynchronously
});

chrome.runtime.onInstalled.addListener(() => {
  refreshAll().catch((err) => console.error("[Agentation] Init failed:", err));
});

chrome.runtime.onStartup.addListener(() => {
  refreshAll().catch((err) => console.error("[Agentation] Startup refresh failed:", err));
});

chrome.identity.onSignInChanged.addListener(() => {
  refreshReporterEmail()
    .then(syncHeaderRule)
    .catch((err) => console.error("[Agentation] Sign-in refresh failed:", err));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  syncSidePanelForTab(tabId, changeInfo.url).catch((err) =>
    console.warn(`[Agentation] Side panel sync failed for tab ${tabId}:`, err)
  );
});

chrome.storage.onChanged.addListener((changes, area) => {
  const configChanged =
    area === "managed" || (area === "local" && (KEYS.endpoint in changes || KEYS.ingestAuth in changes));

  if (area === "managed") {
    syncActionTitle().catch((err) => console.error("[Agentation] Action title sync failed:", err));
  }

  if (configChanged) {
    // New server or credential: reload the allowlist (which re-syncs the rule below)
    refreshAllowlist().then(syncHeaderRule).catch((err) => console.error("[Agentation] Config refresh failed:", err));
    return;
  }
  if (area === "local" && (KEYS.allowlist in changes || KEYS.reporterEmail in changes)) {
    syncHeaderRule().catch((err) => console.error("[Agentation] Header rule sync failed:", err));
  }
  if (area === "local" && KEYS.allowlist in changes) {
    syncSidePanelAllTabs().catch((err) => console.error("[Agentation] Side panel sync failed:", err));
  }
});
