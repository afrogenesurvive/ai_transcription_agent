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

  // Only truly terminal statuses — "transcribed", "ready_for_agent", "refined",
  // "summarized", and "analyzed" are intermediate ML/LLM pipeline stages that
  // the agent runner transitions through. The job is only fully done when the
  // agent runner explicitly marks it "complete" (success) or "delivered", or
  // the backend marks it "failed".
  const terminalStatuses = useRef(new Set(["complete", "delivered", "failed"])).current;
  // Safety timeout: if the job hasn't reached a terminal state within 10 minutes,
  // force-complete to prevent infinite polling (e.g. if the agent runner crashed).
  const POLLING_TIMEOUT_MS = 10 * 60 * 1000;

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

    const startedAt = Date.now();

    const poll = async () => {
      try {
        const result = await fetcherRef.current(jobId);
        setData(result);

        // Safety timeout — if we've been polling too long, treat it as complete
        // so the user can see whatever data exists (transcript, partial results)
        if (Date.now() - startedAt > POLLING_TIMEOUT_MS) {
          console.log(`[useJobStatus] Polling timeout for ${jobId} — forcing complete`);
          setState("complete");
          stopPolling();
          return;
        }

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
