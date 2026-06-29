/**
 * Hook — polls a job's status until it reaches a terminal state.
 */

import { useState, useEffect, useCallback, useRef } from "react";

type PollingState = "idle" | "polling" | "complete" | "error";

export function useJobStatus(jobId: string | null, fetcher: (id: string) => Promise<any>) {
  const [data, setData] = useState<any>(null);
  const [state, setState] = useState<PollingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const terminalStatuses = new Set(["transcribed", "ready_for_agent", "refined", "summarized", "delivered", "failed"]);

  const startPolling = useCallback(() => {
    if (!jobId) return;
    setState("polling");
    setError(null);

    const poll = async () => {
      try {
        const result = await fetcher(jobId);
        setData(result);

        if (terminalStatuses.has(result.status)) {
          setState(result.status === "failed" ? "error" : "complete");
          stopPolling();
        }
      } catch (err: any) {
        setError(err.message);
        setState("error");
        stopPolling();
      }
    };

    poll(); // immediate first call
    intervalRef.current = setInterval(poll, 1500);
  }, [jobId, fetcher]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopPolling();
  }, [stopPolling]);

  return { data, state, error, startPolling, stopPolling };
}
