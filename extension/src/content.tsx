import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Agentation } from "agentation";

const ROOT_ID = "agentation-extension-root";

function App() {
  const [endpoint, setEndpoint] = useState<string | undefined>();
  const [isEnabled, setIsEnabled] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const siteDomain = window.location.hostname;
    const DEFAULT_DOMAIN = "localhost";
    const DEFAULT_PORT = "4747";

    const constructUrl = (domain?: string, port?: string) => {
      if (!domain && !port) return undefined;
      const d = domain || DEFAULT_DOMAIN;
      const p = port || DEFAULT_PORT;
      return `http://${d}:${p}`;
    };

    // Load settings from chrome storage
    chrome.storage.local.get(["globalDomain", "globalPort", siteDomain], (result) => {
      const siteSettings = result[siteDomain] || {};
      
      const domain = siteSettings.domain || result.globalDomain || DEFAULT_DOMAIN;
      const port = siteSettings.port || result.globalPort || DEFAULT_PORT;
      
      setEndpoint(`http://${domain}:${port}`);
      setIsEnabled(siteSettings.enabled === true);
      setIsLoaded(true);
    });

    // Listen for changes to settings
    const listener = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      chrome.storage.local.get(["globalDomain", "globalPort", siteDomain], (res) => {
        const siteSettings = res[siteDomain] || {};
        const domain = siteSettings.domain || res.globalDomain || DEFAULT_DOMAIN;
        const port = siteSettings.port || res.globalPort || DEFAULT_PORT;
        
        setEndpoint(`http://${domain}:${port}`);
        setIsEnabled(siteSettings.enabled === true);
      });
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

function init() {
  if (document.getElementById(ROOT_ID)) return;

  const rootElement = document.createElement("div");
  rootElement.id = ROOT_ID;
  document.body.appendChild(rootElement);

  const root = createRoot(rootElement);
  root.render(<App />);
}

if (document.readyState === "complete" || document.readyState === "interactive") {
  init();
} else {
  window.addEventListener("DOMContentLoaded", init);
}
