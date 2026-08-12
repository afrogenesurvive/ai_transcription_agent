/**
 * serviceStatusContext — shared React context for backend service health.
 *
 * Centralizes all polling so both StatusBar (bottom bar) and ServerStatusBanner
 * ("Setting Up…" overlay) read from the same source of truth with the same
 * intervals. Eliminates the desync caused by the old approach where each
 * component polled independently at different rates....
 */

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from "react";

// ── Types ──

export type ServiceName = "python" | "bridge" | "agent";
export type ServiceStatus = boolean | null; // null = unknown/checking

export const SERVICES: ServiceName[] = ["python", "bridge", "agent"];

export const SERVICE_LABELS: Record<ServiceName, string> = {
  python: "Python Backend",
  bridge: "Bridge Server",
  agent: "Agent Runner",
};

export interface ServiceStatusValue {
  services: Record<ServiceName, ServiceStatus>;
  diarizationOk: boolean | null;
  diarizationError: string | null;
  diarizationModel: string | null;
  hfTokenConfigured: boolean | null;
  diarizationStatus: string | null;
  diarizationProgress: number | null;
  ollamaOk: boolean | null;
  ollamaProvider: boolean;
  allReady: boolean;
  checking: boolean;
  checkServers: () => Promise<Record<ServiceName, boolean>>;
  restartService: (name: ServiceName) => Promise<boolean>;
  restartAll: () => Promise<boolean>;
  startOllama: () => Promise<boolean>;
  stopOllama: () => Promise<boolean>;
  pollOllama: () => Promise<void>;
}

interface ProviderProps {
  children: ReactNode;
  ollamaRequired: boolean;
}

// ── Context ──

const ServiceStatusContext = createContext<ServiceStatusValue | null>(null);

/**
 * Hook for consuming the shared service status context.
 * Must be used inside a <ServiceStatusProvider>.
 */
export function useServiceStatus(): ServiceStatusValue {
  const ctx = useContext(ServiceStatusContext);
  if (!ctx) {
    throw new Error("useServiceStatus must be used within a ServiceStatusProvider");
  }
  return ctx;
}

// ── Provider ──

export function ServiceStatusProvider({ children, ollamaRequired }: ProviderProps) {
  const [services, setServices] = useState<Record<ServiceName, ServiceStatus>>({
    python: null,
    bridge: null,
    agent: null,
  });
  const [diarizationOk, setDiarizationOk] = useState<boolean | null>(null);
  const [diarizationError, setDiarizationError] = useState<string | null>(null);
  const [diarizationModel, setDiarizationModel] = useState<string | null>(null);
  const [hfTokenConfigured, setHfTokenConfigured] = useState<boolean | null>(null);
  const [diarizationStatus, setDiarizationStatus] = useState<string | null>(null);
  const [diarizationProgress, setDiarizationProgress] = useState<number | null>(null);
  const [ollamaOk, setOllamaOk] = useState<boolean | null>(null);
  const [ollamaProvider, setOllamaProvider] = useState(false);
  const [checking, setChecking] = useState(false);

  const allReady = SERVICES.every((s) => services[s] === true) && diarizationOk === true && (!ollamaRequired || ollamaOk === true);

  // ── Poll: backend status (every 5s) ──

  const pollStatus = useCallback(async () => {
    if (window.electronAPI) {
      try {
        const s = await window.electronAPI.getBackendStatus();
        setServices({ python: s.python, bridge: s.bridge, agent: s.agent });
        setDiarizationOk(s.diarizationAvailable);
        setDiarizationError(s.diarizationError);
        setDiarizationModel(s.diarizationModel);
        setHfTokenConfigured(s.hfTokenConfigured);
        setDiarizationStatus(s.diarizationStatus);
        setDiarizationProgress(s.diarizationProgress);
      } catch {
        // IPC failed
      }
    } else {
      try {
        const res = await fetch("http://127.0.0.1:5010/health");
        setServices((prev) => ({ ...prev, bridge: res.ok }));
      } catch {
        setServices((prev) => ({ ...prev, bridge: false }));
      }
    }
  }, []);

  useEffect(() => {
    pollStatus();
    const interval = setInterval(pollStatus, 5000);
    return () => clearInterval(interval);
  }, [pollStatus]);

  // ── Poll: Ollama health (every 15s) ──

  const pollOllama = useCallback(async () => {
    try {
      const result = await window.electronAPI?.checkOllamaHealth();
      setOllamaOk(result?.healthy ?? false);
    } catch {
      setOllamaOk(false);
    }
  }, []);

  useEffect(() => {
    pollOllama();
    const interval = setInterval(pollOllama, 15000);
    return () => clearInterval(interval);
  }, [pollOllama]);

  // ── Poll: LLM provider from config (every 30s) ──

  const checkProvider = useCallback(async () => {
    try {
      const cfg = await window.electronAPI?.getConfig();
      setOllamaProvider(cfg?.LLM_PROVIDER === "ollama");
    } catch {
      setOllamaProvider(false);
    }
  }, []);

  useEffect(() => {
    checkProvider();
    const interval = setInterval(checkProvider, 30000);
    return () => clearInterval(interval);
  }, [checkProvider]);

  // ── Actions ──

  const checkServers = useCallback(async (): Promise<Record<ServiceName, boolean>> => {
    setChecking(true);
    setServices({ python: null, bridge: null, agent: null });
    let result: Record<ServiceName, boolean> = { python: false, bridge: false, agent: false };
    try {
      if (window.electronAPI) {
        const s = await window.electronAPI.checkServers();
        setServices({ python: s.python, bridge: s.bridge, agent: s.agent });
        setDiarizationOk(s.diarizationAvailable);
        setDiarizationError(s.diarizationError);
        setDiarizationModel(s.diarizationModel);
        setHfTokenConfigured(s.hfTokenConfigured);
        setDiarizationStatus(s.diarizationStatus);
        setDiarizationProgress(s.diarizationProgress);
        result = s;
      }
    } catch {
      // ignore
    } finally {
      setChecking(false);
    }
    return result;
  }, []);

  const restartService = useCallback(
    async (name: ServiceName): Promise<boolean> => {
      try {
        if (window.electronAPI) {
          await window.electronAPI.restartService(name);
          await new Promise((r) => setTimeout(r, 1000));
          await pollStatus();
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [pollStatus],
  );

  const restartAll = useCallback(async (): Promise<boolean> => {
    try {
      if (window.electronAPI) {
        await window.electronAPI.restartServices();
        await new Promise((r) => setTimeout(r, 2000));
        await pollStatus();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [pollStatus]);

  const startOllama = useCallback(async (): Promise<boolean> => {
    try {
      const result = await window.electronAPI?.startOllamaServer();
      if (result?.success) {
        await new Promise((r) => setTimeout(r, 2000));
        await pollOllama();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [pollOllama]);

  const stopOllama = useCallback(async (): Promise<boolean> => {
    try {
      const result = await window.electronAPI?.stopOllamaServer();
      if (result?.success) {
        setOllamaOk(false);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, []);

  const value: ServiceStatusValue = {
    services,
    diarizationOk,
    diarizationError,
    diarizationModel,
    hfTokenConfigured,
    diarizationStatus,
    diarizationProgress,
    ollamaOk,
    ollamaProvider,
    allReady,
    checking,
    checkServers,
    restartService,
    restartAll,
    startOllama,
    stopOllama,
    pollOllama,
  };

  return <ServiceStatusContext.Provider value={value}>{children}</ServiceStatusContext.Provider>;
}
