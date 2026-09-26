/**
 * Lightweight content script that runs on every page.
 *
 * The toolbar bundle (content.js: React + Agentation) is large, so it is only
 * injected — by the background worker — on sites where feedback is enabled.
 * This script also handles "show on page" requests from the side panel, which
 * work whether or not the toolbar is loaded.
 */

import {
  KEYS,
  getCachedAllowlist,
  getConfig,
  getSiteSettings,
  isExtensionContextValid,
  isSiteEnabled,
} from "./config";

type FocusMessage = {
  type: "agentation:focus";
  annotation: { fullPath?: string; elementPath?: string; y?: number; isFixed?: boolean };
  /** Scroll to the saved position when the element is not found (default true) */
  fallback?: boolean;
};

let toolbarRequested = false;

/**
 * Ask the background worker to inject the toolbar once the site is enabled.
 * Turning a site off later is handled by the toolbar itself (it hides).
 */
async function loadToolbarIfEnabled(): Promise<void> {
  if (toolbarRequested || !isExtensionContextValid()) return;
  const [config, allowlist, sites] = await Promise.all([getConfig(), getCachedAllowlist(), getSiteSettings()]);
  if (!config.endpoint || !isSiteEnabled(allowlist, sites, window.location.host)) return;

  toolbarRequested = true;
  try {
    await chrome.runtime.sendMessage({ type: "agentation:inject-toolbar" });
  } catch (err) {
    toolbarRequested = false;
    console.error("[Agentation] Could not load the feedback toolbar:", err);
  }
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "agentation:focus") {
    sendResponse(handleFocus(message as FocusMessage));
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  const relevant = area === "managed" || KEYS.endpoint in changes || KEYS.allowlist in changes || KEYS.sites in changes;
  if (relevant) {
    loadToolbarIfEnabled().catch((err) => console.error("[Agentation] Failed to check site settings:", err));
  }
});

loadToolbarIfEnabled().catch((err) => console.error("[Agentation] Failed to check site settings:", err));
