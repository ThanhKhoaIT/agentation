document.addEventListener("DOMContentLoaded", async () => {
  const domainInput = document.getElementById("endpoint-domain") as HTMLInputElement;
  const portInput = document.getElementById("endpoint-port") as HTMLInputElement;
  const globalDomainInput = document.getElementById("global-endpoint-domain") as HTMLInputElement;
  const globalPortInput = document.getElementById("global-endpoint-port") as HTMLInputElement;
  
  const enabledCheckbox = document.getElementById("enabled") as HTMLInputElement;
  const saveButton = document.getElementById("save");
  const saveGlobalButton = document.getElementById("save-global");
  const status = document.getElementById("status");
  const domainDisplay = document.getElementById("current-domain");
  const connectionIndicator = document.getElementById("connection-indicator");
  const connectionText = document.getElementById("connection-text");

  // Get current tab domain
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = new URL(tab.url || "");
  const currentSiteDomain = url.hostname;

  if (domainDisplay) {
    domainDisplay.textContent = `Site: ${currentSiteDomain}`;
  }

  const DEFAULT_DOMAIN = "localhost";
  const DEFAULT_PORT = "4747";

  const updateConnectionStatus = async (domain: string, port: string) => {
    if (!connectionIndicator || !connectionText) return;
    
    connectionIndicator.style.background = "#ffcc00"; // yellow while checking
    connectionText.textContent = "Connecting...";

    const endpoint = `http://${domain || DEFAULT_DOMAIN}:${port || DEFAULT_PORT}`;
    
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      
      const response = await fetch(`${endpoint}/health`, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.ok) {
        connectionIndicator.style.background = "#34c759"; // green
        connectionText.textContent = "Connected";
      } else {
        connectionIndicator.style.background = "#ff3b30"; // red
        connectionText.textContent = "Error";
      }
    } catch (e) {
      connectionIndicator.style.background = "#ff3b30"; // red
      connectionText.textContent = "Disconnected";
    }
  };

  // Load current values
  chrome.storage.local.get(["globalDomain", "globalPort", currentSiteDomain], (result) => {
    const globalDomain = result.globalDomain || DEFAULT_DOMAIN;
    const globalPort = result.globalPort || DEFAULT_PORT;
    
    globalDomainInput.value = globalDomain;
    globalPortInput.value = globalPort;
    
    const siteSettings = result[currentSiteDomain] || {};
    if (siteSettings.domain) domainInput.value = siteSettings.domain;
    if (siteSettings.port) portInput.value = siteSettings.port;
    
    enabledCheckbox.checked = siteSettings.enabled === true;

    // Initial connection check
    const effectiveDomain = siteSettings.domain || globalDomain;
    const effectivePort = siteSettings.port || globalPort;
    updateConnectionStatus(effectiveDomain, effectivePort);
  });

  const showStatus = () => {
    if (status) {
      status.style.display = "block";
      setTimeout(() => {
        status.style.display = "none";
      }, 2000);
    }
  };

  // Save site-specific values
  saveButton?.addEventListener("click", () => {
    const domain = domainInput.value;
    const port = portInput.value;
    const enabled = enabledCheckbox.checked;

    chrome.storage.local.set({ 
      [currentSiteDomain]: { domain, port, enabled } 
    }, showStatus);
  });

  // Save global values
  saveGlobalButton?.addEventListener("click", () => {
    const globalDomain = globalDomainInput.value;
    const globalPort = globalPortInput.value;
    chrome.storage.local.set({ globalDomain, globalPort }, showStatus);
  });
});
