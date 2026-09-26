import {
  ApiError,
  IncompatibleServerError,
  KEYS,
  NotConfiguredError,
  apiFetch,
  fetchAllowlist,
  findAllowedDomain,
  getBranding,
  getConfig,
  getSiteSettings,
  isHostAllowed,
  isSiteEnabled,
  normalizeEndpoint,
  setSiteEnabled,
  type Allowlist,
  type ExtensionConfig,
} from "./config";

type StatusKind = "loading" | "on" | "paused" | "blocked" | "problem";

const SVG_NS = "http://www.w3.org/2000/svg";

function $(id: string): HTMLElement {
  return document.getElementById(id) as HTMLElement;
}

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

document.addEventListener("DOMContentLoaded", async () => {
  const statusEl = $("status");
  const statusGlyph = $("status-glyph").querySelector("use") as SVGUseElement;
  const statusTitle = $("status-title");
  const statusText = $("status-text");
  const switchEl = $("switch");
  const enabledCheckbox = $("enabled") as HTMLInputElement;
  const openPanelButton = $("open-panel") as HTMLButtonElement;
  const openCount = $("open-count");
  const retryButton = $("retry") as HTMLButtonElement;
  const gearButton = $("gear") as HTMLButtonElement;
  const settingsEl = $("settings");
  const endpointInput = $("endpoint") as HTMLInputElement;
  const authInput = $("ingest-auth") as HTMLInputElement;
  const saveButton = $("save") as HTMLButtonElement;
  const savedEl = $("saved");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try {
    const url = new URL(tab?.url || "");
    if (url.protocol === "http:" || url.protocol === "https:") host = url.host;
  } catch {
    // chrome:// or empty tab
  }

  let config: ExtensionConfig = await getConfig();
  let allowlist: Allowlist | undefined;

  const branding = await getBranding();
  document.title = branding.name;

  // --- Identity: favicon + project name + slogan (no raw domain)
  const renderPage = () => {
    const title = tab?.title?.trim();
    const project = findAllowedDomain(allowlist, host)?.project;
    $("page-name").textContent = project || title || "This page";
    $("page-title").textContent = branding.slogan;

    const favicon = $("favicon");
    if (tab?.favIconUrl && !tab.favIconUrl.startsWith("chrome://")) {
      const img = document.createElement("img");
      img.alt = "";
      img.src = tab.favIconUrl;
      img.addEventListener("error", () => favicon.replaceChildren(icon("globe")));
      favicon.replaceChildren(img);
    } else {
      favicon.replaceChildren(icon("globe"));
    }
  };

  const setStatus = (kind: StatusKind, title: string, text = "") => {
    statusEl.className = `status ${kind}`;
    statusGlyph.setAttribute("href", `#i-${kind}`);
    statusTitle.textContent = title;
    statusText.textContent = text;
  };

  const hideActions = () => {
    switchEl.classList.add("hidden");
    openPanelButton.classList.add("hidden");
    retryButton.classList.add("hidden");
  };

  const openSettings = (open: boolean) => {
    settingsEl.classList.toggle("hidden", !open);
    gearButton.setAttribute("aria-expanded", String(open));
  };

  const loadOpenCount = async () => {
    openCount.classList.add("hidden");
    try {
      const res = await apiFetch(
        config,
        `/feedbacks?domain=${encodeURIComponent(host)}&status=pending,acknowledged&limit=500`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { count?: number };
      const open = data.count ?? 0;
      if (open > 0) {
        openCount.textContent = String(open);
        openCount.title = `${open} to fix`;
        openCount.classList.remove("hidden");
      }
    } catch (err) {
      // The count is a hint only; the side panel shows the full list and errors
      console.warn("[Agentation] Could not load feedback count:", err);
    }
  };

  const renderSite = async () => {
    hideActions();
    renderPage();

    if (!host) {
      setStatus("blocked", "Feedback isn't available here", "Open a website to leave feedback.");
      return;
    }
    if (!isHostAllowed(allowlist, host)) {
      setStatus("blocked", "Feedback isn't set up for this site", "Ask your tech team to add this site.");
      return;
    }

    const sites = await getSiteSettings();
    const enabled = isSiteEnabled(allowlist, sites, host);
    enabledCheckbox.checked = enabled;
    switchEl.classList.remove("hidden");
    if (enabled) {
      setStatus(
        "on",
        "Feedback is on",
        "Click the feedback button in the bottom-right corner of the page, then click what you want to comment on."
      );
    } else {
      setStatus("paused", "Feedback is paused", "Turn it on to show the feedback button on this site.");
    }

    // Older local servers have no feedback list
    if (!allowlist?.legacy) {
      openPanelButton.classList.remove("hidden");
      loadOpenCount();
    }
  };

  // Always load the latest list of supported sites when the popup opens
  const refresh = async () => {
    hideActions();
    setStatus("loading", "Checking this site…");
    config = await getConfig();
    try {
      allowlist = await fetchAllowlist(config);
      await renderSite();
    } catch (err) {
      allowlist = undefined;
      renderPage();
      if (err instanceof NotConfiguredError) {
        setStatus(
          "problem",
          "Setup needed",
          config.managed
            ? "Your organization hasn't finished setting this up. Let your tech team know."
            : "Add the feedback service address below. Your tech team can give it to you."
        );
        if (!config.managed) openSettings(true);
      } else if (err instanceof IncompatibleServerError) {
        setStatus("problem", "The feedback service needs an update", "Let your tech team know.");
      } else if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        setStatus("problem", "Access was not accepted", "Let your tech team know so they can check your access key.");
      } else {
        setStatus("problem", "Can't connect right now", "Check your internet connection and try again.");
        retryButton.classList.remove("hidden");
      }
      console.warn("[Agentation] Allowlist refresh failed:", err);
    }
  };

  // --- Settings (hidden entirely when managed by the organization)
  endpointInput.value = config.endpoint ?? "";
  authInput.value = config.ingestAuth ?? "";
  if (!config.managed) gearButton.classList.remove("hidden");

  gearButton.addEventListener("click", () => {
    openSettings(settingsEl.classList.contains("hidden"));
  });

  saveButton.addEventListener("click", async () => {
    const endpoint = normalizeEndpoint(endpointInput.value) ?? "";
    await chrome.storage.local.set({
      [KEYS.endpoint]: endpoint,
      [KEYS.ingestAuth]: authInput.value.trim(),
    });
    endpointInput.value = endpoint;
    savedEl.classList.add("visible");
    setTimeout(() => savedEl.classList.remove("visible"), 2000);
    await refresh();
  });

  enabledCheckbox.addEventListener("change", async () => {
    if (!host) return;
    await setSiteEnabled(host, enabledCheckbox.checked);
    await renderSite();
  });

  openPanelButton.addEventListener("click", async () => {
    if (!tab?.windowId || !isHostAllowed(allowlist, host)) return;
    try {
      await chrome.sidePanel.open({ windowId: tab.windowId });
      window.close();
    } catch (err) {
      console.error("[Agentation] Could not open side panel:", err);
    }
  });

  retryButton.addEventListener("click", refresh);

  await refresh();
});
