/**
 * useForeignJobs — detects jobs created outside the UI (e.g., by test-bot.mjs).
 *
 * Polls test-bot-log.jsonl via IPC (bot-created job IDs) and for each
 * discovered job polls its full status via the bridge to catch agent-runner
 * stages (transcribed → analyzed) that aren't reflected in status.json.
 *
 * Exposes:
 *   foreignJobIds          — Set<string> of detected foreign job IDs
 *   hasForeignRunningJobs  — true if any foreign job has a non-terminal status
 *   foreignJobsStatus      — Map<jobId, { status, progress, title }>
 *
 * NOTE: Does NOT poll /transcribe/active — that endpoint returns ALL pipeline
 * jobs including UI-created ones, which would cause false positives.
 */

import { useState, useEffect, useCallback, useRef } from "react";

/** Statuses that mean a job is still alive and being processed */
const NON_TERMINAL_STATUSES = new Set([
  "uploaded",
  "initializing",
  "processing_diarization",
  "matching_voiceprints",
  "paused_for_labeling",
  "resuming",
  "processing_transcription",
  "aligning",
  "transcribed",
  "ready_for_agent",
  "labeling_needed",
  "refined",
  "summarized",
  "analyzed",
]);

const POLL_INTERVAL_MS = 5000;
const MAX_CONCURRENT_STATUS_CHECKS = 3;

interface ForeignJobInfo {
  status: string;
  progress: number;
  title: string;
}

export function useForeignJobs() {
  const [foreignJobIds, setForeignJobIds] = useState<Set<string>>(new Set());
  const [foreignJobsStatus, setForeignJobsStatus] = useState<Map<string, ForeignJobInfo>>(new Map());
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hasForeignRunningJobs = foreignJobIds.size > 0;

  /** Check a single job's status via the bridge */
  const checkJobStatus = useCallback(async (jobId: string) => {
    try {
      const res = await fetch("http://127.0.0.1:5010/tools/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "transcribe_status", args: { jobId } }),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return {
        jobId,
        status: data.status as string,
        progress: (data.progress as number) ?? 0,
        title: (data.title as string) || (data.metadata?.title as string) || "Untitled",
      };
    } catch {
      return null;
    }
  }, []);

  /** Poll all sources for foreign jobs */
  const poll = useCallback(async () => {
    const discovered = new Set<string>();

    // Source: test-bot-log.jsonl via IPC (bot-created job IDs)
    // NOTE: We intentionally do NOT poll /transcribe/active here — that endpoint
    // returns ALL pipeline jobs including UI-created ones, causing false positives.
    // The IPC handler already reads job status from disk and filters terminal ones.
    try {
      const botJobs: Array<{ job_id: string; status: string }> =
        await window.electronAPI?.getRunningBotJobs() ?? [];
      for (const job of botJobs) {
        if (NON_TERMINAL_STATUSES.has(job.status)) {
          discovered.add(job.job_id);
        }
      }
    } catch {
      // IPC handler not available or file missing — skip gracefully
    }

    // For each discovered foreign job, poll full status via the bridge to
    // catch agent-runner stages (transcribed → analyzed) which aren't reflected
    // in the status.json file that the IPC handler reads.
    if (discovered.size > 0) {
      const statusUpdates = new Map<string, ForeignJobInfo>();
      const chunks: string[][] = [];
      const ids = Array.from(discovered);
      for (let i = 0; i < ids.length; i += MAX_CONCURRENT_STATUS_CHECKS) {
        chunks.push(ids.slice(i, i + MAX_CONCURRENT_STATUS_CHECKS));
      }
      for (const chunk of chunks) {
        const results = await Promise.all(chunk.map(checkJobStatus));
        for (const r of results) {
          if (r) {
            statusUpdates.set(r.jobId, { status: r.status, progress: r.progress, title: r.title });
            // If terminal, remove from foreign set
            if (!NON_TERMINAL_STATUSES.has(r.status)) {
              discovered.delete(r.jobId);
            }
          }
        }
      }
      setForeignJobsStatus(statusUpdates);
    } else {
      // No non-terminal bot jobs — clear stale status map
      setForeignJobsStatus(new Map());
    }

    // Always update the set: when all jobs are done, discovered is empty
    // and foreignJobIds becomes empty too, clearing the "Bot Job Running" state.
    setForeignJobIds(new Set(discovered));
  }, [checkJobStatus]);

  // Start polling on mount
  useEffect(() => {
    poll(); // immediate first check
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [poll]);

  return { foreignJobIds, hasForeignRunningJobs, foreignJobsStatus };
}
