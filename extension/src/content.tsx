import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Agentation } from "agentation";
import { KEYS, getCachedAllowlist, getConfig, getSiteSettings, isSiteEnabled } from "./config";

const ROOT_ID = "agentation-extension-root";
const NOTIFY_DEBOUNCE_MS = 300;

// Endpoint the toolbar currently syncs to (read by the fetch watcher)
let activeEndpoint: string | undefined;

type FocusMessage = {
  type: "agentation:focus";
  annotation: { fullPath?: string; elementPath?: string; y?: number; isFixed?: boolean };
  /** Scroll to the saved position when the element is not found (default true) */
  fallback?: boolean;
};

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
    return () => chrome.storage.onChanged.removeListener(listener);
  }, []);

  if (!isLoaded || !isEnabled) return null;

  return (
    <React.StrictMode>
      <Agentation endpoint={endpoint} />
    </React.StrictMode>
  );
}

let notifyTimer: ReturnType<typeof setTimeout> | undefined;

function notifyFeedbacksChanged(): void {
  // Debounced: "clear all" sends one DELETE per annotation
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
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

function findElement(paths: Array<string | undefined>): Element | null {
  for (const path of paths) {
    if (!path) continue;
    const selector = path.replace(/⟨shadow⟩\s*/g, "");
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch {
      // Paths are human-readable and not always valid CSS selectors
    }
  }
  return null;
}

function flash(el: HTMLElement): void {
  const { outline, outlineOffset } = el.style;
  el.style.outline = "3px solid #0088FF";
  el.style.outlineOffset = "2px";
  setTimeout(() => {
    el.style.outline = outline;
    el.style.outlineOffset = outlineOffset;
  }, 1500);
}

/**
 * Side panel → page: scroll to the annotated element.
 */
function handleFocus(message: FocusMessage): { found: boolean } {
  const { fullPath, elementPath, y, isFixed } = message.annotation;
  const el = findElement([fullPath, elementPath]);
  if (el instanceof HTMLElement) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    flash(el);
    return { found: true };
  }
  if (message.fallback !== false && typeof y === "number" && !isFixed) {
    window.scrollTo({ top: Math.max(0, y - window.innerHeight / 3), behavior: "smooth" });
  }
  return { found: false };
}

function init() {
  if (document.getElementById(ROOT_ID)) return;

  const rootElement = document.createElement("div");
  rootElement.id = ROOT_ID;
  document.body.appendChild(rootElement);

  watchServerWrites();

  const root = createRoot(rootElement);
  root.render(<App />);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "agentation:focus") {
      sendResponse(handleFocus(message as FocusMessage));
    }
  });
}

if (document.readyState === "complete" || document.readyState === "interactive") {
  init();
} else {
  window.addEventListener("DOMContentLoaded", init);
}
