/**
 * Hook — polls a job's status until it reaches a terminal state.
 * Automatically starts polling when jobId becomes non-null.
 *
 * Grace period for "failed": the agent runner may retry a failed job and
 * eventually succeed. We keep polling for 2 minutes after the first
 * "failed" sighting before declaring the job truly failed. If the status
 * recovers (e.g. changes back to "refined" -> "complete"), polling continues
 * normally until "complete" or "delivered".
 *
 * Backend-down resilience: when `backendHealthy` is false (Python server
 * unreachable), the rolling timeout counter pauses. Polling continues
 * silently with a "backend_down" state so the cancel button remains
 * available. When the backend comes back, normal polling resumes.
 */

import { useState, useEffect, useCallback, useRef } from "react";

export type PollingState = "idle" | "polling" | "complete" | "error" | "paused" | "backend_down";

const FAILED_GRACE_PERIOD_MS = 2 * 60 * 1000; // 2 minutes

export function useJobStatus(jobId: string | null, fetcher: (id: string) => Promise<any>, backendHealthy: boolean = true) {
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
  // Safety timeout: if the job hasn't reached a terminal state within 30 minutes,
  // force-complete to prevent infinite polling (e.g. if the agent runner crashed).
  // Increased from 10 min to 30 min to accommodate longer meetings — a 21-minute
  // meeting produces a large transcript that can take >10 min to process through
  // the full LLM pipeline (refine, summarize, analyze, save context, deliver).
  const POLLING_TIMEOUT_MS = 30 * 60 * 1000;

  // Track when the backend was last seen as healthy - used to pause the
  // rolling timeout counter when the backend goes down.
  const backendDownStart = useRef<number | null>(null);
  const totalBackendDownMs = useRef(0);

  const stopPolling = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    // Use functional updater to avoid React 18 batching override:
    // when called after setState("complete")/setState("error") in the poll
    // function, preserve the terminal state instead of wiping it to "idle".
    setState((prev) => {
      if (prev === "complete" || prev === "error") return prev;
      return "idle";
    });
    setError(null);
  }, []);

  // Auto-start polling whenever jobId becomes non-null
  useEffect(() => {
    if (!jobId) return;

    setState("polling");
    setError(null);
    setData(null);
    firstFailedAt.current = null;
    backendDownStart.current = null;
    totalBackendDownMs.current = 0;

    const startedAt = Date.now();

    const poll = async () => {
      // Backend health check - skip fetch if backend is down
      if (!backendHealthy) {
        if (backendDownStart.current === null) {
          backendDownStart.current = Date.now();
          console.log("[useJobStatus] " + jobId + " -> backend went down, pausing timeout counter");
          setState("backend_down");
          setError("Backend services are down - polling paused. Cancel the job or wait for recovery.");
        }
        return;
      }

      // Backend recovered - track downtime and resume
      if (backendDownStart.current !== null) {
        const downDuration = Date.now() - backendDownStart.current;
        totalBackendDownMs.current += downDuration;
        backendDownStart.current = null;
        console.log("[useJobStatus] " + jobId + " -> backend recovered (was down " + (downDuration / 1000).toFixed(0) + "s), resuming");
        if (state === "backend_down") {
          setState("polling");
          setError(null);
        }
      }

      try {
        const result = await fetcherRef.current(jobId);
        setData(result);

        // Safety timeout - only counts time when backend was healthy
        const elapsedActive = Date.now() - startedAt - totalBackendDownMs.current;
        if (elapsedActive > POLLING_TIMEOUT_MS) {
          const timeoutErr = "Job processing timed out - the pipeline may be hung. Check the backend logs for details.";
          console.log("[useJobStatus] Polling timeout for " + jobId + " - reporting as error");
          setState("error");
          setError(timeoutErr);
          stopPolling();
          return;
        }

        // Paused for labeling, raw transcript review, or delivery review
        if (result.status === "paused_for_labeling" || result.status === "pending_raw_review" || result.status === "pending_delivery_review") {
          setState("paused");
          return;
        }

        // Graceful "failed" handling
        if (result.status === "failed") {
          if (firstFailedAt.current === null) {
            firstFailedAt.current = Date.now();
            console.log("[useJobStatus] " + jobId + " -> failed, grace period started");
          } else if (Date.now() - firstFailedAt.current > FAILED_GRACE_PERIOD_MS) {
            console.log("[useJobStatus] " + jobId + " - grace period expired, declaring failed");
            setState("error");
            setError(result.error || "Processing failed");
            stopPolling();
          }
          return;
        }

        // Status recovered from "failed"
        if (firstFailedAt.current !== null) {
          console.log("[useJobStatus] " + jobId + " recovered from failed -> " + result.status + ", resetting grace");
          firstFailedAt.current = null;
        }

        // If we were paused and now the status changed
        if (
          state === "paused" &&
          result.status !== "paused_for_labeling" &&
          result.status !== "pending_raw_review" &&
          result.status !== "pending_delivery_review"
        ) {
          setState("polling");
        }

        if (successStatuses.has(result.status)) {
          setState("complete");
          stopPolling();
        }
      } catch (err: any) {
        // Network error - if backend is down, keep polling silently
        if (!backendHealthy) {
          if (backendDownStart.current === null) {
            backendDownStart.current = Date.now();
          }
          setState("backend_down");
          setError("Backend is unreachable - will retry automatically when services recover.");
          return;
        }
        setError(err.message);
        setState("error");
        stopPolling();
      }
    };

    poll(); // immediate first call
    intervalRef.current = setInterval(poll, 10000);

    return () => stopPolling();
  }, [jobId, stopPolling, successStatuses, backendHealthy]);

  return { data, state, error, stopPolling };
}
