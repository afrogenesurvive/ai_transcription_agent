/**
 * Status Bar — shows backend status and app version at the bottom.
 */

import React, { useState, useEffect } from "react";

export default function StatusBar() {
  const [backendReady, setBackendReady] = useState(false);
  const [version, setVersion] = useState("1.0.0");

  useEffect(() => {
    const check = async () => {
      try {
        const res = await fetch("http://127.0.0.1:5010/health");
        setBackendReady(res.ok);
      } catch {
        setBackendReady(false);
      }
    };
    check();
    const interval = setInterval(check, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    window.electronAPI
      ?.getAppVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  return (
    <div className="status-bar">
      <span className="status-item">
        <span className={`status-dot ${backendReady ? "online" : "offline"}`} />
        Backend {backendReady ? "Online" : "Offline"}
      </span>
      <span className="status-item version">v{version}</span>
    </div>
  );
}
