/**
 * Hook — polls a job's status until it reaches a terminal state.
 * Automatically starts polling when jobId becomes non-null.
 *
 * Grace period for "failed": the agent runner may retry a failed job and
 * eventually succeed. We keep polling for 2 minutes after the first
 * "failed" sighting before declaring the job truly failed. If the status
 * recovers (e.g. changes back to "refined" → "complete"), polling continues
 * normally until "complete" or "delivered".
 */

import { useState, useEffect, useCallback, useRef } from "react";

export type PollingState = "idle" | "polling" | "complete" | "error" | "paused";

const FAILED_GRACE_PERIOD_MS = 2 * 60 * 1000; // 2 minutes

export function useJobStatus(jobId: string | null, fetcher: (id: string) => Promise<any>) {
  const [data, setData] = useState<any>(null);
  const [state, setState] = useState<PollingState>("idle");
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const firstFailedAt = useRef<number | null>(null);

  // Only truly terminal statuses — "transcribed", "ready_for_agent", "refined",
  // "summarized", and "analyzed" are intermediate ML/LLM pipeline stages that
  // the agent runner transitions through. The job is only fully done when the
  // agent runner explicitly marks it "complete" (success) or "delivered".
  // "failed" is terminal ONLY after a grace period allows the agent runner
  // to retry and potentially succeed.
  const successStatuses = useRef(new Set(["complete", "delivered"])).current;
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
    firstFailedAt.current = null;

    const startedAt = Date.now();

    const poll = async () => {
      try {
        const result = await fetcherRef.current(jobId);
        setData(result);

        // Safety timeout — if we've been polling too long, the pipeline is hung.
        // Report an error instead of pretending the job completed, so the user
        // sees a clear message and can retry.
        if (Date.now() - startedAt > POLLING_TIMEOUT_MS) {
          const timeoutErr = "Job processing timed out — the pipeline may be hung. Check the backend logs for details.";
          console.log(`[useJobStatus] Polling timeout for ${jobId} — reporting as error`);
          setState("error");
          setError(timeoutErr);
          stopPolling();
          return;
        }

        // ── Paused for labeling — notify the UI to show the labeling modal ──
        // This is NOT a terminal state. The pipeline is waiting for the user
        // to manually label speakers. Keep polling so we detect when the
        // user submits labels and the job resumes.
        if (result.status === "paused_for_labeling") {
          setState("paused");
          // Keep polling — don't stop. The user may take a while to label.
          return;
        }

        // ── Graceful "failed" handling ──
        // The agent runner may retry a failed job (re-enqueues a "failed"
        // event which gets processed again). If the status was "failed"
        // but recovers to any other status, reset the grace timer and
        // keep polling. Only declare terminal failure after the grace
        // period elapses with no recovery.
        if (result.status === "failed") {
          if (firstFailedAt.current === null) {
            firstFailedAt.current = Date.now();
            console.log(`[useJobStatus] ${jobId} → failed, grace period started`);
          } else if (Date.now() - firstFailedAt.current > FAILED_GRACE_PERIOD_MS) {
            console.log(`[useJobStatus] ${jobId} — grace period expired, declaring failed`);
            setState("error");
            setError(result.error || "Processing failed");
            stopPolling();
          }
          // Still polling within grace period — don't stop
          return;
        }

        // Status recovered from "failed" → reset grace timer
        if (firstFailedAt.current !== null) {
          console.log(`[useJobStatus] ${jobId} recovered from failed → ${result.status}, resetting grace`);
          firstFailedAt.current = null;
        }

        // If we were paused and now the status changed, resume polling normally
        if (state === "paused" && result.status !== "paused_for_labeling") {
          setState("polling");
        }

        if (successStatuses.has(result.status)) {
          setState("complete");
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
  }, [jobId, stopPolling, successStatuses]);

  return { data, state, error, startPolling: () => {}, stopPolling };
}
