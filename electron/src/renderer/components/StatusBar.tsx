/**
 * Status Bar — shows individual Python, Bridge, and Agent status
 * with a manual "Check Servers" button that auto-recovers on timeout.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";

type ServiceStatus = boolean | null; // null = unknown/checking

export default function StatusBar() {
  const [python, setPython] = useState<ServiceStatus>(null);
  const [bridge, setBridge] = useState<ServiceStatus>(null);
  const [agent, setAgent] = useState<ServiceStatus>(null);
  const [version, setVersion] = useState("1.0.0");
  const [checking, setChecking] = useState(false);
  const checkTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const allReady = python && bridge && agent;

  // Poll all three services via IPC every 5 seconds
  const pollStatus = useCallback(async () => {
    if (window.electronAPI) {
      try {
        const status = await window.electronAPI.getBackendStatus();
        setPython(status.python);
        setBridge(status.bridge);
        setAgent(status.agent);
      } catch {
        // IPC failed — likely Electron API not available
      }
    } else {
      // Fallback: direct bridge health check only
      try {
        const res = await fetch("http://127.0.0.1:5010/health");
        setBridge(res.ok);
      } catch {
        setBridge(false);
      }
    }
  }, []);

  useEffect(() => {
    pollStatus();
    const interval = setInterval(pollStatus, 5000);
    return () => clearInterval(interval);
  }, [pollStatus]);

  useEffect(() => {
    window.electronAPI
      ?.getAppVersion()
      .then(setVersion)
      .catch(() => {});
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (checkTimeoutRef.current) clearTimeout(checkTimeoutRef.current);
    };
  }, []);

  const handleCheckServers = useCallback(async () => {
    setChecking(true);
    setPython(null);
    setBridge(null);
    setAgent(null);

    // Safety timeout — reset after 5s if IPC hangs
    checkTimeoutRef.current = setTimeout(() => {
      setChecking(false);
      // Re-run poll to get actual current state
      pollStatus();
    }, 5000);

    try {
      if (window.electronAPI) {
        const status = await window.electronAPI.checkServers();
        setPython(status.python);
        setBridge(status.bridge);
        setAgent(status.agent);
      } else {
        // Fallback: direct bridge check
        try {
          const res = await fetch("http://127.0.0.1:5010/health");
          setBridge(res.ok);
        } catch {
          setBridge(false);
        }
      }
    } catch {
      // Error handled by safety timeout
    } finally {
      if (checkTimeoutRef.current) {
        clearTimeout(checkTimeoutRef.current);
        checkTimeoutRef.current = null;
      }
      setChecking(false);
    }
  }, [pollStatus]);

  return (
    <div className="status-bar">
      <div className="status-item-group">
        <span className="status-item">
          <span className={`status-dot ${python === null ? "unknown" : python ? "online" : "offline"}`} />
          Python
        </span>
        <span className="status-item">
          <span className={`status-dot ${bridge === null ? "unknown" : bridge ? "online" : "offline"}`} />
          Bridge
        </span>
        <span className="status-item">
          <span className={`status-dot ${agent === null ? "unknown" : agent ? "online" : "offline"}`} />
          Agent
        </span>
        {!allReady && (
          <button className="retry-btn" onClick={handleCheckServers} disabled={checking} title="Check if servers are running">
            {checking ? "Checking…" : "Check Servers"}
          </button>
        )}
      </div>
      <span className="status-item version">v{version}</span>
    </div>
  );
}
