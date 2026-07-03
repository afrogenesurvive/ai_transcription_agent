/**
 * useServerStatus — polls backend service health + diarization model + Ollama status.
 *
 * Exposes:
 *   services        — { python, bridge, agent } boolean | null
 *   diarizationOk   — boolean | null
 *   diarizationError — string | null
 *   ollamaOk        — boolean | null
 *   allReady        — true when all services + diarization are confirmed online
 *   checking        — true during a manual check
 *   checkServers()  — manual re-check
 *   restartService(name) — restart a single service via IPC
 *   restartAll()    — restart all services via IPC
 */

import { useState, useEffect, useCallback, useRef } from "react";

type ServiceName = "python" | "bridge" | "agent";
type ServiceStatus = boolean | null; // null = unknown/checking

const SERVICES: ServiceName[] = ["python", "bridge", "agent"];

const SERVICE_LABELS: Record<ServiceName, string> = {
  python: "Python Backend",
  bridge: "Bridge Server",
  agent: "Agent Runner",
};

export type { ServiceName, ServiceStatus };
export { SERVICES, SERVICE_LABELS };

export function useServerStatus() {
  const [services, setServices] = useState<Record<ServiceName, ServiceStatus>>({
    python: null,
    bridge: null,
    agent: null,
  });
  const [diarizationOk, setDiarizationOk] = useState<boolean | null>(null);
  const [diarizationError, setDiarizationError] = useState<string | null>(null);
  const [ollamaOk, setOllamaOk] = useState<boolean | null>(null);
  const [checking, setChecking] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** All services online + diarization model available */
  const allReady = SERVICES.every((s) => services[s] === true) && diarizationOk === true;

  /** Poll IPC for backend status */
  const pollStatus = useCallback(async () => {
    if (window.electronAPI) {
      try {
        const s = await window.electronAPI.getBackendStatus();
        setServices({ python: s.python, bridge: s.bridge, agent: s.agent });
      } catch {
        // IPC failed
      }
    } else {
      // Fallback: check bridge directly
      try {
        const res = await fetch("http://127.0.0.1:5010/health");
        setServices((prev) => ({ ...prev, bridge: res.ok }));
      } catch {
        setServices((prev) => ({ ...prev, bridge: false }));
      }
    }
  }, []);

  /** Poll diarization model status via bridge */
  const pollDiarization = useCallback(async () => {
    try {
      const res = await fetch("http://127.0.0.1:5010/tools/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "transcribe_models_status", args: {} }),
      });
      if (res.ok) {
        const data = await res.json();
        setDiarizationOk(data.diarization_available);
        setDiarizationError(data.diarization_error);
      }
    } catch {
      // Backend not reachable
    }
  }, []);

  /** Poll Ollama health */
  const pollOllama = useCallback(async () => {
    try {
      const result = await window.electronAPI?.checkOllamaHealth();
      setOllamaOk(result?.healthy ?? false);
    } catch {
      setOllamaOk(false);
    }
  }, []);

  // Poll on mount and every 5s
  useEffect(() => {
    pollStatus();
    pollDiarization();
    pollOllama();
    intervalRef.current = setInterval(() => {
      pollStatus();
      pollDiarization();
      pollOllama();
    }, 5000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [pollStatus, pollDiarization, pollOllama]);

  /** Manual re-check with loading state */
  const checkServers = useCallback(async () => {
    setChecking(true);
    setServices({ python: null, bridge: null, agent: null });
    try {
      if (window.electronAPI) {
        const s = await window.electronAPI.checkServers();
        setServices({ python: s.python, bridge: s.bridge, agent: s.agent });
      }
      await pollDiarization();
    } catch {
      // ignore
    } finally {
      setChecking(false);
    }
  }, [pollDiarization]);

  /** Restart a single service via IPC */
  const restartService = useCallback(
    async (name: ServiceName): Promise<boolean> => {
      try {
        if (window.electronAPI) {
          await window.electronAPI.restartService(name);
          // Small delay so the process has time to start before re-poll
          await new Promise((r) => setTimeout(r, 1000));
          await pollStatus();
          await pollDiarization();
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [pollStatus, pollDiarization],
  );

  /** Restart all services */
  const restartAll = useCallback(async (): Promise<boolean> => {
    try {
      if (window.electronAPI) {
        await window.electronAPI.restartServices();
        await new Promise((r) => setTimeout(r, 2000));
        await pollStatus();
        await pollDiarization();
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }, [pollStatus, pollDiarization]);

  /** Start Ollama server */
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

  return {
    services,
    diarizationOk,
    diarizationError,
    ollamaOk,
    allReady,
    checking,
    checkServers,
    restartService,
    restartAll,
    startOllama,
    pollOllama,
  };
}
