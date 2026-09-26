/**
 * Feedback toolbar (React + Agentation). Not a declared content script:
 * loader.ts asks the background worker to inject it only on enabled sites.
 */

import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Agentation, type Annotation, type ToolbarAction, type ToolbarFeatures } from "agentation";
import {
  KEYS,
  getCachedAllowlist,
  getConfig,
  getSiteSettings,
  isExtensionContextValid,
  isSiteEnabled,
} from "./config";

const ROOT_ID = "agentation-extension-root";

// Business users mostly leave comments: hide developer tools
const TOOLBAR_FEATURES: Partial<ToolbarFeatures> = {
  pause: false,
  layout: false,
  send: false,
  clear: false,
  elementStyles: false,
  reactComponents: false,
  version: false,
  webhooks: false,
};

const PanelIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="5" width="16" height="14" rx="2" />
    <path d="M14.5 5v14" />
  </svg>
);

const TOOLBAR_ACTIONS: ToolbarAction[] = [
  {
    id: "toggle-panel",
    label: "Open/close panel",
    icon: <PanelIcon />,
    onClick: () => {
      if (!isExtensionContextValid()) {
        console.info("[Agentation] The extension was updated. Reload this page to use the panel.");
        return;
      }
      chrome.runtime
        .sendMessage({ type: "agentation:toggle-panel" })
        .catch((err) => console.error("[Agentation] Could not toggle the feedback panel:", err));
    },
  },
];
const NOTIFY_DEBOUNCE_MS = 300;
const SHARED_REFRESH_DEBOUNCE_MS = 300;
// While the live stream is down: refresh this often, then try the stream again
const SHARED_RETRY_MS = 30_000;

// Endpoint the toolbar currently syncs to (read by the fetch watcher)
let activeEndpoint: string | undefined;

/**
 * Open feedback from everyone on this site, kept current over the server's
 * event stream. Shown on the page as read-only markers next to your own.
 * Requests get credentials from the background's declarativeNetRequest rule.
 */
function useSharedAnnotations(endpoint: string | undefined, enabled: boolean): Annotation[] {
  const [shared, setShared] = useState<Annotation[]>([]);

  useEffect(() => {
    if (!enabled || !endpoint) {
      setShared([]);
      return;
    }
    const domain = encodeURIComponent(window.location.host);
    const controller = new AbortController();
    const { signal } = controller;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const refresh = async () => {
      try {
        const res = await fetch(`${endpoint}/feedbacks?domain=${domain}&status=pending,acknowledged&limit=500`, { signal });
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        const data = (await res.json()) as { annotations?: Annotation[] };
        setShared(data.annotations ?? []);
      } catch (err) {
        if (!signal.aborted) console.debug("[Agentation] Could not load team feedback:", err);
      }
    };

    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, SHARED_REFRESH_DEBOUNCE_MS);
    };

    const stream = async () => {
      try {
        const res = await fetch(`${endpoint}/events?domains=${domain}`, {
          signal,
          headers: { Accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) throw new Error(`Stream returned ${res.status}`);
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
            if (type.startsWith("annotation.") || type === "thread.message") scheduleRefresh();
          }
        }
        throw new Error("Stream closed by server");
      } catch (err) {
        if (signal.aborted) return;
        // Stream unavailable (e.g. older server): refresh now and retry later
        console.debug("[Agentation] Team feedback stream unavailable, retrying later:", err);
        retryTimer = setTimeout(() => {
          refresh();
          stream();
        }, SHARED_RETRY_MS);
      }
    };

    refresh();
    stream();
    return () => {
      controller.abort();
      if (refreshTimer) clearTimeout(refreshTimer);
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [endpoint, enabled]);

  return shared;
}

function App() {
  const [endpoint, setEndpoint] = useState<string | undefined>();
  const [isEnabled, setIsEnabled] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const host = window.location.host;

    const load = async () => {
      const [config, allowlist, sites] = await Promise.all([getConfig(), getCachedAllowlist(), getSiteSettings()]);
      activeEndpoint = config.endpoint;
      setEndpoint(config.endpoint);
      setIsEnabled(!!config.endpoint && isSiteEnabled(allowlist, sites, host));
      setIsLoaded(true);
    };

    load().catch((err) => console.error("[Agentation] Failed to load settings:", err));

    const listener = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      const relevant =
        area === "managed" ||
        KEYS.endpoint in changes ||
        KEYS.allowlist in changes ||
        KEYS.sites in changes;
      if (relevant) {
        load().catch((err) => console.error("[Agentation] Failed to reload settings:", err));
      }
    };

    chrome.storage.onChanged.addListener(listener);
    return () => {
      if (isExtensionContextValid()) chrome.storage.onChanged.removeListener(listener);
    };
  }, []);

  const sharedAnnotations = useSharedAnnotations(endpoint, isLoaded && isEnabled);

  if (!isLoaded || !isEnabled) return null;

  return (
    <React.StrictMode>
      <Agentation
        endpoint={endpoint}
        sharedAnnotations={sharedAnnotations}
        features={TOOLBAR_FEATURES}
        actions={TOOLBAR_ACTIONS}
        markerStyle="gradient"
        markerPulse
      />
    </React.StrictMode>
  );
}

let notifyTimer: ReturnType<typeof setTimeout> | undefined;

function notifyFeedbacksChanged(): void {
  // Debounced: "clear all" sends one DELETE per annotation
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    // Extension reloaded since this page opened: nobody to notify
    if (!isExtensionContextValid()) return;
    chrome.runtime
      .sendMessage({ type: "agentation:feedbacks-changed", host: window.location.host })
      .catch(() => {
        // Expected when the side panel is closed (no receiver)
      });
  }, NOTIFY_DEBOUNCE_MS);
}

/**
 * Notify the side panel after the toolbar successfully writes to the server
 * (add/update/delete). The toolbar's own callbacks fire before its server
 * sync, so completed requests are observed instead. This patches fetch in
 * the extension's isolated world only; the page's fetch is untouched.
 */
function watchServerWrites(): void {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await originalFetch(input, init);
    try {
      const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (response.ok && method !== "GET" && activeEndpoint && url.startsWith(activeEndpoint)) {
        notifyFeedbacksChanged();
      }
    } catch (err) {
      console.warn("[Agentation] Could not inspect toolbar request:", err);
    }
    return response;
  };
}

function init() {
  // Guard against a second injection into the same page
  if (document.getElementById(ROOT_ID)) return;

  const rootElement = document.createElement("div");
  rootElement.id = ROOT_ID;
  document.body.appendChild(rootElement);

  watchServerWrites();

  const root = createRoot(rootElement);
  root.render(<App />);
}

if (document.readyState === "complete" || document.readyState === "interactive") {
  init();
} else {
  window.addEventListener("DOMContentLoaded", init);
}
