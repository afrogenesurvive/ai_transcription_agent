/**
 * Hook — polls a job's status until it reaches a terminal state.
 * Automatically starts polling when jobId becomes non-null.
 */

import { useState, useEffect, useCallback, useRef } from "react";

type PollingState = "idle" | "polling" | "complete" | "error";

export function useJobStatus(jobId: string | null, fetcher: (id: string) => Promise<any>) {
  const [data, setData] = useState<any>(null);
  const [state, setState] = useState<PollingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const terminalStatuses = useRef(new Set(["transcribed", "ready_for_agent", "refined", "summarized", "delivered", "failed"])).current;

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  // Auto-start polling whenever jobId becomes non-null
  useEffect(() => {
    if (!jobId) return;

    setState("polling");
    setError(null);
    setData(null);

    const poll = async () => {
      try {
        const result = await fetcherRef.current(jobId);
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
    intervalRef.current = setInterval(poll, 10000);

    return () => stopPolling();
  }, [jobId, stopPolling, terminalStatuses]);

  return { data, state, error, startPolling: () => {}, stopPolling };
}
