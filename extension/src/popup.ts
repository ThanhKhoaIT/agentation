document.addEventListener("DOMContentLoaded", async () => {
  const customEndpointInput = document.getElementById("custom-endpoint") as HTMLInputElement;
  const customContainer = document.getElementById("custom-container") as HTMLDivElement;
  const modeDefault = document.getElementById("mode-default") as HTMLInputElement;
  const modeCustom = document.getElementById("mode-custom") as HTMLInputElement;
  
  const enabledCheckbox = document.getElementById("enabled") as HTMLInputElement;
  const saveButton = document.getElementById("save");
  const statusMsg = document.getElementById("status");
  const domainDisplay = document.getElementById("current-domain");
  const connectionIndicator = document.getElementById("connection-indicator");
  const connectionText = document.getElementById("connection-text");

  // Get current tab domain
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = new URL(tab.url || "");
  const currentSiteDomain = url.hostname;

  if (domainDisplay) {
    domainDisplay.textContent = currentSiteDomain;
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

  const toggleCustomInput = () => {
    if (modeCustom.checked) {
      customContainer.classList.remove("hidden");
    } else {
      customContainer.classList.add("hidden");
    }
  };

  modeDefault.addEventListener("change", toggleCustomInput);
  modeCustom.addEventListener("change", toggleCustomInput);

  // Load current values
  chrome.storage.local.get(["globalDomain", "globalPort", currentSiteDomain], (result) => {
    const globalDomain = result.globalDomain || DEFAULT_DOMAIN;
    const globalPort = result.globalPort || DEFAULT_PORT;
    
    const siteSettings = result[currentSiteDomain] || {};
    
    if (siteSettings.domain && (siteSettings.domain !== DEFAULT_DOMAIN || siteSettings.port !== DEFAULT_PORT)) {
      modeCustom.checked = true;
      customEndpointInput.value = `${siteSettings.domain}${siteSettings.port ? ":" + siteSettings.port : ""}`;
      customContainer.classList.remove("hidden");
    } else {
      modeDefault.checked = true;
      customContainer.classList.add("hidden");
    }
    
    enabledCheckbox.checked = siteSettings.enabled === true;

    // Initial connection check
    const effectiveDomain = siteSettings.domain || globalDomain;
    const effectivePort = siteSettings.port || globalPort;
    updateConnectionStatus(effectiveDomain, effectivePort);
  });

  const showStatus = () => {
    if (statusMsg) {
      statusMsg.classList.add("visible");
      setTimeout(() => {
        statusMsg.classList.remove("visible");
      }, 2000);
    }
  };

  const saveSettings = () => {
    let domain = DEFAULT_DOMAIN;
    let port = DEFAULT_PORT;

    if (modeCustom.checked) {
      const parts = customEndpointInput.value.split(":");
      domain = parts[0] || DEFAULT_DOMAIN;
      port = parts[1] || DEFAULT_PORT;
    }

    const enabled = enabledCheckbox.checked;

    chrome.storage.local.set({ 
      [currentSiteDomain]: { domain, port, enabled } 
    }, () => {
      showStatus();
      updateConnectionStatus(domain, port);
    });
  };

  // Save site-specific values
  saveButton?.addEventListener("click", saveSettings);

  // Live update for the switch
  enabledCheckbox.addEventListener("change", saveSettings);
});
