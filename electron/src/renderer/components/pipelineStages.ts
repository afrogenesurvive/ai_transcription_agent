/**
 * pipelineStages.ts — single source of truth for the pipeline progress stepper.
 *
 * Shared by ProgressPanel (live stepper) and ResultsViewer (history/results
 * stepper) so the two views can never drift apart.
 *
 * Purely presentational: maps backend status strings → stage/sub-step state.
 * Nothing here changes backend statuses or pipeline behavior.
 */

import { useEffect, useRef } from "react";

export interface StageDef {
  key: string;
  icon: string;
  label: string;
  description: string;
  /** One or more backend status values that map to this stage */
  matches: string[];
  /** Nested sub-steps rendered under this stage (e.g. AI Processing phases) */
  subSteps?: StageDef[];
}

export type StageState = "done" | "active" | "pending" | "error" | "skipped";

/**
 * Ordered pipeline stages. The array order MUST match the temporal order in
 * which the backend emits statuses, so the stepper only ever moves forward:
 *
 *   uploaded → initializing → processing_diarization → matching_voiceprints
 *   → paused_for_labeling / resuming → processing_transcription → aligning
 *   → transcribed → pending_raw_review (Gate 1) → enqueued / ready_for_agent
 *   → refined → summarized → analyzed → pending_delivery_review (Gate 2)
 *   → delivery_approved → saving_memory → delivered / complete
 */
export const PIPELINE: StageDef[] = [
  {
    key: "uploaded",
    icon: "upload_file",
    label: "Uploading",
    description: "Receiving your audio file",
    matches: ["uploaded"],
  },
  {
    key: "initializing",
    icon: "build",
    label: "Getting Ready",
    description: "Preparing the transcription system",
    matches: ["initializing"],
  },
  {
    key: "diarization",
    icon: "group",
    label: "Identifying Speakers",
    description: "Detecting who speaks and when",
    matches: ["processing_diarization"],
  },
  {
    key: "voiceprints",
    icon: "badge",
    label: "Matching Voices",
    description: "Identifying and labeling each speaker",
    matches: ["matching_voiceprints", "paused_for_labeling", "resuming"],
  },
  {
    key: "transcription",
    icon: "mic",
    label: "Transcribing Speech",
    description: "Converting speech to text",
    matches: ["processing_transcription"],
  },
  {
    key: "aligning",
    icon: "link",
    label: "Building Transcript",
    description: "Matching words to each speaker",
    // `transcribed` is emitted BEFORE the Gate 1 pause, so it must live here
    // (before `review`) — not under `agent` — otherwise the stepper lights
    // "AI Processing", jumps back to "Review Transcript", then forward again.
    matches: ["aligning", "transcribed"],
  },
  {
    key: "review",
    icon: "rate_review",
    label: "Review Transcript",
    description: "Reviewing the raw transcript",
    matches: ["pending_raw_review"],
  },
  {
    key: "agent",
    icon: "smart_toy",
    label: "AI Processing",
    description: "Refining, summarizing & analyzing",
    // Parent matches must be a SUPERSET of its sub-steps' statuses so the
    // header + ordering logic and getStageState resolve to the right stage.
    matches: ["ready_for_agent", "labeling_needed", "enqueued", "refined", "summarized", "analyzed"],
    subSteps: [
      {
        key: "agent_refine",
        icon: "auto_fix_high",
        label: "Refining Transcript",
        description: "Cleaning up the transcript",
        matches: ["refined"],
      },
      {
        key: "agent_summarize",
        icon: "summarize",
        label: "Summarizing",
        description: "Writing the meeting summary",
        matches: ["summarized"],
      },
      {
        key: "agent_analyze",
        icon: "insights",
        label: "Analyzing Content",
        description: "Topics, sentiment & key items",
        matches: ["analyzed"],
      },
    ],
  },
  {
    key: "delivery_review",
    icon: "fact_check",
    label: "Review Deliverable",
    description: "Reviewing the deliverable package",
    matches: ["pending_delivery_review"],
  },
  // `delivery_approved` fires BEFORE `saving_memory`, so it gets its own step here.
  {
    key: "delivery_prep",
    icon: "inventory_2",
    label: "Preparing Delivery",
    description: "Packing results for delivery",
    matches: ["delivery_approved"],
  },
  {
    key: "saving_memory",
    icon: "memory",
    label: "Saving to Memory",
    description: "Storing meeting context",
    matches: ["saving_memory"],
  },
  {
    key: "delivery",
    icon: "mail",
    label: "Delivering Results",
    description: "Sending via email, Trello & Drive",
    matches: ["delivered"],
  },
];

/** Statuses that mean "waiting on the user or the model" rather than actively working. */
export const WAITING_LABEL: Record<string, string> = {
  pending_raw_review: "Review needed",
  pending_delivery_review: "Review needed",
  paused_for_labeling: "Waiting for labels",
  enqueued: "Queued",
  ready_for_agent: "Waiting for model",
};

/** Friendly labels so the header never falls back to a raw backend status string. */
export const STATUS_FRIENDLY: Record<string, string> = {
  uploaded: "Uploading",
  initializing: "Getting Ready",
  processing_diarization: "Identifying Speakers",
  matching_voiceprints: "Matching Voices",
  paused_for_labeling: "Waiting for speaker labels",
  resuming: "Resuming pipeline",
  processing_transcription: "Transcribing Speech",
  aligning: "Building Transcript",
  transcribed: "Transcript ready",
  pending_raw_review: "Awaiting transcript review",
  ready_for_agent: "AI Processing",
  labeling_needed: "Speaker labeling needed",
  enqueued: "Queued for AI processing",
  refined: "Refining Transcript",
  summarized: "Summarizing",
  analyzed: "Analyzing Content",
  pending_delivery_review: "Awaiting delivery review",
  delivery_approved: "Preparing Delivery",
  saving_memory: "Saving to Memory",
  delivered: "Delivered",
  complete: "Complete",
  complete_with_warning: "Completed with warning",
  reprocessing: "Re-running pipeline",
  labeled: "Labels applied",
  failed: "Failed",
};

/** Find the stage (and optional sub-step) that a status currently activates. */
export function findActiveStage(currentStatus: string): { stage: StageDef; sub?: StageDef } | null {
  for (const stage of PIPELINE) {
    if (stage.matches.includes(currentStatus)) return { stage };
    for (const sub of stage.subSteps ?? []) {
      if (sub.matches.includes(currentStatus)) return { stage, sub };
    }
  }
  return null;
}

/**
 * Determine a stage's state.
 *
 * `maxReachedIdx` is the index of the furthest stage ever reached for this
 * job (see useMaxReachedStage) — anything strictly behind it renders "done"
 * so the stepper never visually regresses.
 */
export function getStageState(
  stage: StageDef,
  currentStatus: string,
  isFailed: boolean,
  isComplete: boolean,
  maxReachedIdx: number,
  skippedSteps?: Set<string>,
): StageState {
  if (skippedSteps?.has(stage.key)) return "skipped";
  const stageIdx = PIPELINE.indexOf(stage);
  if (isComplete) return "done";
  if (isFailed) {
    if (stage.matches.includes(currentStatus)) return "error";
    return "done";
  }
  if (stageIdx < maxReachedIdx) return "done";
  if (stage.matches.includes(currentStatus)) return "active";
  const currentIdx = PIPELINE.findIndex((s) => s.matches.includes(currentStatus));
  if (stageIdx < currentIdx) return "done";
  return "pending";
}

/** State for a sub-step, scoped to its parent so it can't jump across phases. */
export function getSubStepState(
  parent: StageDef,
  sub: StageDef,
  currentStatus: string,
  isFailed: boolean,
  isComplete: boolean,
): StageState {
  if (isComplete) return "done";
  if (sub.matches.includes(currentStatus)) return isFailed ? "error" : "active";
  const subs = parent.subSteps!;
  const currentSubIdx = subs.findIndex((s) => s.matches.includes(currentStatus));
  if (currentSubIdx < 0) return "pending";
  return subs.indexOf(sub) < currentSubIdx ? "done" : "pending";
}

/**
 * Tracks the furthest stage index reached for a job.
 * Resets on: a new job (jobId change), failure, or a Gate-1 retry ("reprocessing").
 */
export function useMaxReachedStage(status: string, isFailed: boolean, jobId?: string): number {
  const maxReachedRef = useRef(-1);
  const jobIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (jobIdRef.current !== jobId) {
      jobIdRef.current = jobId;
      maxReachedRef.current = -1;
    }
    if (isFailed || status === "reprocessing") {
      maxReachedRef.current = -1;
      return;
    }
    const active = findActiveStage(status);
    if (active) {
      const idx = PIPELINE.indexOf(active.stage);
      if (idx > maxReachedRef.current) maxReachedRef.current = idx;
    }
  }, [status, isFailed, jobId]);
  return maxReachedRef.current;
}

/** Backend status → perf stage key (for Performance-tab markers). */
export const STATUS_TO_STAGE: Record<string, string> = {
  uploaded: "uploaded",
  initializing: "initializing",
  processing_diarization: "diarization",
  matching_voiceprints: "voiceprints",
  processing_transcription: "transcription",
  aligning: "aligning",
  transcribed: "aligning",
  pending_raw_review: "review",
  ready_for_agent: "agent",
  labeling_needed: "agent",
  enqueued: "agent",
  refined: "agent",
  summarized: "agent",
  analyzed: "agent",
  pending_delivery_review: "delivery_review",
  delivery_approved: "delivery_prep",
  saving_memory: "saving_memory",
  delivered: "delivery",
};
