/**
 * GateReviewModal — overlay modal for Gate 1 (Raw Transcript Review) and
 * Gate 2 (Delivery Review). Extracted from ProgressPanel.tsx into a reusable
 * centered overlay so the review panels appear as modal dialogs rather than
 * inline sections.
 */

import React, { useState, useEffect, useRef } from "react";
import Icon from "./Icon";
import LoadingModal from "./LoadingModal";
import RichTextEditor from "./RichTextEditor";
import RichTextView from "./RichTextView";
import type { TranscriptionSegment, SummaryData, AnalysisData } from "../types";
import { pickRich, pickRichList, plainToHtml } from "../utils/richText";

interface Props {
  /** Show or hide the modal */
  visible: boolean;
  /** Which gate to display */
  gate: "gate1" | "gate2";
  /** Job ID — needed for fetching transcript/summary/analysis data */
  jobId?: string;
  /** Gate 1 (Raw Transcript Review) handlers */
  onApproveGate1?: (body: { action: string; editedTranscript?: any[] }) => Promise<void>;
  onRejectGate1?: (action: "cancel" | "retry") => Promise<void>;
  /** Gate 2 (Delivery Review) handlers */
  onApproveGate2?: (body: {
    action: string;
    editedTranscript?: any[];
    editedSummary?: any;
    editedAnalysis?: any;
    deliveryOptions?: { recipients?: string[]; destinations?: string[] };
    feedback?: string;
  }) => Promise<void>;
  onRejectGate2?: (action: "cancel" | "retry", feedback?: string) => Promise<void>;
}

/** Compact rich-text list editor used inside the Gate 2 review modal. */
function RichListEditor({
  title,
  items,
  htmlItems,
  onChange,
  placeholder,
}: {
  title: string;
  items: string[];
  htmlItems: string[];
  onChange: (items: string[], htmlItems: string[]) => void;
  placeholder?: string;
}) {
  const add = () => onChange([...items, ""], [...htmlItems, ""]);
  const remove = (i: number) => onChange(items.filter((_, idx) => idx !== i), htmlItems.filter((_, idx) => idx !== i));
  return (
    <div style={{ marginTop: 8 }}>
      <div className="pp-gate-section-title" style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {title}
        <button type="button" className="pp-gate-edit-add" onClick={add}>
          + Add
        </button>
      </div>
      {items.map((p, i) => (
        <div key={i} className="pp-gate-edit-list-row">
          <RichTextEditor
            compact
            value={pickRich(htmlItems[i], p)}
            onChange={(html, text) => {
              const nextItems = [...items];
              const nextHtml = [...htmlItems];
              nextItems[i] = text;
              nextHtml[i] = html;
              onChange(nextItems, nextHtml);
            }}
            placeholder={placeholder}
          />
          <button className="pp-gate-edit-remove" onClick={() => remove(i)}>
            ✕
          </button>
        </div>
      ))}
      {items.length === 0 && <div className="pp-gate-muted">No items yet.</div>}
    </div>
  );
}

export default function GateReviewModal({ visible, gate, jobId, onApproveGate1, onRejectGate1, onApproveGate2, onRejectGate2 }: Props) {
  const isGate1 = gate === "gate1";
  const isGate2 = gate === "gate2";

  if (!visible) return null;

  // ── Gate 1 state ──
  const [gate1Loading, setGate1Loading] = useState(false);
  const [gate1Transcript, setGate1Transcript] = useState<any[] | null>(null);
  const [gate1RawText, setGate1RawText] = useState<string>("");
  const [gate1EditMode, setGate1EditMode] = useState(false);
  const [gate1SegmentsDraft, setGate1SegmentsDraft] = useState<TranscriptionSegment[] | null>(null);
  const [gate1Submitting, setGate1Submitting] = useState(false);
  const [gate1Error, setGate1Error] = useState<string | null>(null);
  const [showGate1RejectConfirm, setShowGate1RejectConfirm] = useState(false);
  const [gate1RejectAction, setGate1RejectAction] = useState<"cancel" | "retry">("cancel");
  const [gate1VoiceConflict, setGate1VoiceConflict] = useState<any | null>(null);

  // ── Gate 2 state ──
  const [gate2Loading, setGate2Loading] = useState(false);
  const [gate2Summary, setGate2Summary] = useState<any | null>(null);
  const [gate2Analysis, setGate2Analysis] = useState<any | null>(null);
  const [gate2Transcript, setGate2Transcript] = useState<any[] | null>(null);
  const [gate2EditMode, setGate2EditMode] = useState(false);
  const [gate2SummaryDraft, setGate2SummaryDraft] = useState<SummaryData>({});
  const [gate2AnalysisDraft, setGate2AnalysisDraft] = useState<AnalysisData>({});
  const [gate2TranscriptDraft, setGate2TranscriptDraft] = useState<TranscriptionSegment[]>([]);
  const [gate2Submitting, setGate2Submitting] = useState(false);
  const [gate2Error, setGate2Error] = useState<string | null>(null);
  const [showGate2RejectConfirm, setShowGate2RejectConfirm] = useState(false);
  const [gate2RejectAction, setGate2RejectAction] = useState<"cancel" | "retry">("cancel");
  const [gate2Feedback, setGate2Feedback] = useState("");

  // ── Dynamic overlay message based on current phase ──
  const submitMessage =
    gate1Submitting || gate2Submitting
      ? isGate1
        ? gate1EditMode
          ? "Saving edits and approving transcript…"
          : "Approving transcript — starting agent pipeline…"
        : gate2EditMode
          ? "Saving edits and approving deliverable…"
          : "Approving deliverable — starting delivery…"
      : undefined;

  // ── Gate 1 transcript draft helpers ──
  const updateGate1Segment = (index: number, field: "speaker" | "text", value: string) => {
    setGate1SegmentsDraft((prev) => {
      if (!prev) return prev;
      return prev.map((s, i) => (i === index ? { ...s, [field]: value } : s));
    });
  };

  // ── Gate 2 draft helpers (plain field + parallel _html twin) ──
  const updateGate2SummaryRich = (field: string, html: string, text: string) => {
    setGate2SummaryDraft((prev) => ({ ...prev, [field]: text, [`${field}_html`]: html }));
  };

  const updateGate2AnalysisRich = (field: string, html: string, text: string) => {
    setGate2AnalysisDraft((prev) => ({ ...prev, [field]: text, [`${field}_html`]: html }));
  };

  const updateGate2ActionItem = (index: number, html: string, text: string) => {
    setGate2SummaryDraft((prev) => {
      const items = [...(prev.action_items || [])];
      items[index] = { ...items[index], description: text, description_html: html };
      return { ...prev, action_items: items };
    });
  };

  const updateGate2ActionItemMeta = (index: number, field: "assignee" | "deadline", value: string) => {
    setGate2SummaryDraft((prev) => {
      const items = [...(prev.action_items || [])];
      items[index] = { ...items[index], [field]: value };
      return { ...prev, action_items: items };
    });
  };

  const addGate2ActionItem = () => {
    setGate2SummaryDraft((prev) => ({
      ...prev,
      action_items: [...(prev.action_items || []), { description: "", assignee: "", deadline: "" }],
    }));
  };

  const removeGate2ActionItem = (index: number) => {
    setGate2SummaryDraft((prev) => ({
      ...prev,
      action_items: (prev.action_items || []).filter((_, i) => i !== index),
    }));
  };

  const updateGate2TranscriptSegment = (index: number, field: "speaker" | "text", value: string) => {
    setGate2TranscriptDraft((prev) => prev.map((s, i) => (i === index ? { ...s, [field]: value } : s)));
  };

  // ── Reset all state when modal hides (prevents stale data across jobs) ──
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (wasVisibleRef.current && !visible) {
      setGate1Submitting(false);
      setGate2Submitting(false);
      setGate1Error(null);
      setGate2Error(null);
      setGate1VoiceConflict(null);
      setGate2Feedback("");
      setShowGate1RejectConfirm(false);
      setShowGate2RejectConfirm(false);
      // Reset Gate 1 fetched data
      setGate1Transcript(null);
      setGate1RawText("");
      setGate1SegmentsDraft(null);
      setGate1EditMode(false);
      // Reset Gate 2 fetched data
      setGate2Summary(null);
      setGate2Analysis(null);
      setGate2Transcript(null);
      setGate2SummaryDraft({});
      setGate2AnalysisDraft({});
      setGate2TranscriptDraft([]);
      setGate2EditMode(false);
    }
    wasVisibleRef.current = visible;
  }, [visible]);

  // ── Fetch data when Gate 1 panel opens ──
  useEffect(() => {
    if (!isGate1 || !jobId || gate1Transcript) return;
    let cancelled = false;
    const fetchData = async () => {
      setGate1Loading(true);
      setGate1Error(null);
      try {
        const [transcriptRes, rawRes] = await Promise.all([
          fetch(`http://127.0.0.1:5010/tools/call`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "transcribe_get_transcript", args: { jobId } }),
          }),
          fetch(`http://127.0.0.1:5010/tools/call`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "transcribe_get_raw_transcript", args: { jobId } }),
          }),
        ]);
        if (cancelled) return;
        const tData = await transcriptRes.json().catch(() => null);
        const rData = await rawRes.json().catch(() => null);
        if (cancelled) return;
        if (!transcriptRes.ok) {
          setGate1Error(tData?.error || tData?.detail || `Transcript fetch failed (${transcriptRes.status})`);
          setGate1Loading(false);
          return;
        }
        if (!rawRes.ok) {
          setGate1Error(rData?.error || rData?.detail || `Raw transcript fetch failed (${rawRes.status})`);
          setGate1Loading(false);
          return;
        }
        if (!cancelled) {
          setGate1Transcript(tData?.transcript || []);
          setGate1RawText(rData?.text || "");
        }
      } catch (err: any) {
        if (!cancelled) setGate1Error(err.message || "Failed to load transcript");
      } finally {
        if (!cancelled) setGate1Loading(false);
      }
    };
    fetchData();
    return () => {
      cancelled = true;
    };
  }, [isGate1, jobId, gate1Transcript]);

  // ── Fetch data when Gate 2 panel opens ──
  useEffect(() => {
    if (!isGate2 || !jobId || gate2Summary) return;
    let cancelled = false;
    const FETCH_TIMEOUT = 15000; // 15s timeout for each fetch
    const fetchData = async () => {
      setGate2Loading(true);
      setGate2Error(null);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
      try {
        const [summaryRes, analysisRes, transcriptRes] = await Promise.all([
          fetch(`http://127.0.0.1:5010/tools/call`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "transcribe_get_summary", args: { jobId } }),
            signal: controller.signal,
          }),
          fetch(`http://127.0.0.1:5010/tools/call`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "transcribe_get_analysis", args: { jobId } }),
            signal: controller.signal,
          }),
          fetch(`http://127.0.0.1:5010/tools/call`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "transcribe_get_transcript", args: { jobId, format: "json" } }),
            signal: controller.signal,
          }),
        ]);
        if (cancelled) return;
        const sData = await summaryRes.json().catch(() => null);
        const aData = await analysisRes.json().catch(() => null);
        const tData = await transcriptRes.json().catch(() => null);
        if (cancelled) return;
        if (!summaryRes.ok) {
          setGate2Error(sData?.error || sData?.detail || `Summary fetch failed (${summaryRes.status})`);
          setGate2Loading(false);
          return;
        }
        if (!analysisRes.ok) {
          setGate2Error(aData?.error || aData?.detail || `Analysis fetch failed (${analysisRes.status})`);
          setGate2Loading(false);
          return;
        }
        if (!transcriptRes.ok) {
          setGate2Error(tData?.error || tData?.detail || `Transcript fetch failed (${transcriptRes.status})`);
          setGate2Loading(false);
          return;
        }
        if (!cancelled) {
          setGate2Summary(sData || null);
          setGate2Analysis(aData || null);
          setGate2Transcript(tData?.transcript || null);
        }
      } catch (err: any) {
        if (!cancelled) {
          if (err.name === "AbortError") {
            setGate2Error("Timed out loading delivery data — check that the backend is running");
          } else {
            setGate2Error(err.message || "Failed to load delivery data");
          }
        }
      } finally {
        clearTimeout(timeoutId);
        if (!cancelled) setGate2Loading(false);
      }
    };
    fetchData();
    return () => {
      cancelled = true;
    };
  }, [isGate2, jobId, gate2Summary]);

  return (
    <div className="pp-gate-modal-overlay">
      <div className="pp-gate-modal-dialog" onClick={(e) => e.stopPropagation()}>
        {/* ═══════════════════════════════════════════════
            Gate 1 — Raw Transcript Review Panel
            ═══════════════════════════════════════════════ */}
        {isGate1 && (
          <>
            {gate1Loading && (
              <div className="pp-gate-loading">
                <Icon name="hourglass_top" size="14" /> Loading transcript…
              </div>
            )}

            {gate1Error && !gate1Loading && (
              <div className="pp-gate-error">
                <Icon name="error" size="14" /> {gate1Error}
              </div>
            )}

            {gate1VoiceConflict && (
              <div className="pp-gate-conflict-banner">
                <strong>Voice match conflict detected</strong>
                <p>{gate1VoiceConflict.message}</p>
                {gate1VoiceConflict.conflicts?.length > 0 && (
                  <div className="pp-gate-conflict-details" style={{ marginTop: 8 }}>
                    {gate1VoiceConflict.conflicts.map((c: any, i: number) => (
                      <div key={i} className="pp-gate-conflict-detail-row" style={{ marginBottom: 4, fontSize: "var(--fs-10)" }}>
                        <Icon name="person" size="13" color="muted" />
                        <span>
                          Already registered: <strong>{c.matched_name}</strong>
                          {c.matched_email ? <> &lt;{c.matched_email}&gt;</> : ""}
                          {" · "}You labeled: <strong>{c.assigned_name}</strong>
                          {c.assigned_email ? <> &lt;{c.assigned_email}&gt;</> : ""}
                          {" · "}
                          {(c.similarity * 100).toFixed(0)}% match
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {!gate1Loading && !gate1Error && gate1Transcript && (
              <div className="pp-gate-panel-inner">
                <div className="pp-gate-header">
                  <Icon name="rate_review" size="16" /> Review Raw Transcript
                </div>

                <div className="pp-gate-body">
                  {!gate1EditMode ? (
                    <>
                      <div className="pp-gate-section">
                        <div className="pp-gate-section-title">Speaker-Labeled Transcript</div>
                        {gate1Transcript.slice(0, 50).map((seg: any, i: number) => (
                          <div key={i} className="pp-gate-transcript-line">
                            <span className="pp-gate-transcript-time">[{typeof seg.start === "number" ? seg.start.toFixed(1) : "?"}s]</span>
                            <span className="pp-gate-transcript-speaker">{seg.speaker}:</span> {seg.text}
                          </div>
                        ))}
                        {gate1Transcript.length > 50 && (
                          <div className="pp-gate-transcript-line" style={{ color: "var(--text-muted)", fontStyle: "italic" }}>
                            … and {gate1Transcript.length - 50} more segments
                          </div>
                        )}
                      </div>
                      {gate1RawText && (
                        <div className="pp-gate-section">
                          <div className="pp-gate-section-title">Raw ASR Text (unrefined)</div>
                          <div className="pp-gate-summary-block" style={{ maxHeight: 120, overflowY: "auto" }}>
                            {gate1RawText.length > 1000 ? gate1RawText.slice(0, 1000) + `… (${gate1RawText.length - 1000} more chars)` : gate1RawText}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <>
                      <div className="pp-gate-section">
                        <div className="pp-gate-section-title">Edit Transcript</div>
                        <div className="pp-gate-edit-segments">
                          {(gate1SegmentsDraft || []).map((seg, i) => (
                            <div key={i} className="pp-gate-edit-segment">
                              <span className="pp-gate-transcript-time">
                                [{typeof seg.start === "number" ? seg.start.toFixed(1) : "?"}s]
                              </span>
                              <input
                                className="pp-gate-edit-speaker"
                                value={seg.speaker}
                                onChange={(e) => updateGate1Segment(i, "speaker", e.target.value)}
                                title="Speaker name"
                              />
                              <RichTextEditor
                                compact
                                className="pp-gate-edit-text"
                                value={plainToHtml(seg.text)}
                                onChange={(_html, text) => updateGate1Segment(i, "text", text)}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div className="pp-gate-actions">
                  {!gate1EditMode ? (
                    <>
                      <button
                        className="pp-gate-btn pp-gate-btn--secondary"
                        disabled={gate1Submitting}
                        onClick={() => {
                          setGate1EditMode(true);
                          setGate1SegmentsDraft((gate1Transcript || []).map((s) => ({ ...s })));
                        }}>
                        <Icon name="edit" size="14" /> Edit
                      </button>
                      <button
                        className="pp-gate-btn pp-gate-btn--approve"
                        disabled={gate1Submitting}
                        onClick={async () => {
                          setGate1Submitting(true);
                          setGate1Error(null);
                          setGate1VoiceConflict(null);
                          try {
                            await onApproveGate1?.({ action: "approve" });
                            // Success — keep overlay visible until parent
                            // detects the status change.  The useEffect above
                            // will reset submitting when visible → false.
                          } catch (err: any) {
                            // Error — reset so user can retry
                            setGate1Submitting(false);
                            if (err.message?.includes("voice_match_conflict")) {
                              // Try to extract structured conflict data from the error message
                              let conflictData: any = { message: err.message };
                              try {
                                const parsed = JSON.parse(err.message);
                                if (parsed?.conflicts?.length) {
                                  conflictData = {
                                    message: parsed.message || err.message,
                                    conflicts: parsed.conflicts,
                                  };
                                }
                              } catch {
                                /* stay with string fallback */
                              }
                              setGate1VoiceConflict(conflictData);
                            } else {
                              setGate1Error(err.message || "Failed to approve");
                            }
                          }
                        }}>
                        <Icon name="check" size="14" /> {gate1Submitting ? "Approving…" : "Approve & Continue"}
                      </button>
                      {onRejectGate1 && (
                        <>
                          <button
                            className="pp-gate-btn pp-gate-btn--reject"
                            disabled={false}
                            title="Reject & Cancel"
                            onClick={() => {
                              setGate1RejectAction("cancel");
                              setShowGate1RejectConfirm(true);
                            }}>
                            <Icon name="close" size="14" /> Reject & Cancel
                          </button>
                          <button
                            className="pp-gate-btn pp-gate-btn--reject pp-gate-btn--reject-disabled"
                            disabled={true}
                            title="Reject is temporarily disabled">
                            <Icon name="refresh" size="14" /> Reject & Retry
                          </button>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        className="pp-gate-btn pp-gate-btn--approve"
                        disabled={gate1Submitting}
                        onClick={async () => {
                          setGate1Submitting(true);
                          setGate1Error(null);
                          try {
                            const editedTranscript = (gate1SegmentsDraft || []).map((s) => ({
                              speaker: s.speaker,
                              text: s.text,
                              start: s.start,
                              end: s.end,
                            }));
                            await onApproveGate1?.({ action: "approve_with_edits", editedTranscript });
                            // Success — keep overlay visible until parent
                            // detects the status change.
                          } catch (err: any) {
                            // Error — reset so user can retry
                            setGate1Submitting(false);
                            setGate1Error(err.message || "Failed to approve with edits");
                          }
                        }}>
                        <Icon name="check" size="14" /> {gate1Submitting ? "Saving…" : "Save Edits & Approve"}
                      </button>
                      <button className="pp-gate-btn pp-gate-btn--secondary" onClick={() => setGate1EditMode(false)}>
                        Cancel Edit
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Gate 1 reject confirm dialog */}
            {showGate1RejectConfirm && (
              <div className="pp-confirm-overlay" onClick={() => setShowGate1RejectConfirm(false)}>
                <div className="pp-confirm-dialog" onClick={(e) => e.stopPropagation()}>
                  <div className="pp-confirm-header">
                    <Icon name="warning" size="16" color="red" /> Reject Raw Transcript?
                  </div>
                  <p className="pp-confirm-body">
                    {gate1RejectAction === "cancel"
                      ? "This will permanently cancel the job. All progress will be lost."
                      : "This will re-run the ML pipeline (ASR + alignment) to generate a new transcript."}
                  </p>
                  <div className="pp-confirm-actions">
                    <button className="pp-confirm-cancel-btn" onClick={() => setShowGate1RejectConfirm(false)}>
                      Go Back
                    </button>
                    <button
                      className="pp-confirm-stop-btn"
                      onClick={async () => {
                        setShowGate1RejectConfirm(false);
                        setGate1Submitting(true);
                        try {
                          await onRejectGate1?.(gate1RejectAction);
                        } catch (err: any) {
                          setGate1Error(err.message || "Failed to reject");
                        } finally {
                          setGate1Submitting(false);
                        }
                      }}>
                      Yes, {gate1RejectAction === "cancel" ? "Cancel Job" : "Retry Pipeline"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* ═══════════════════════════════════════════════
            Gate 2 — Delivery Review Panel
            ═══════════════════════════════════════════════ */}
        {isGate2 && (
          <>
            {gate2Loading && (
              <div className="pp-gate-loading">
                <Icon name="hourglass_top" size="14" /> Loading deliverable data…
              </div>
            )}

            {gate2Error && !gate2Loading && (
              <div className="pp-gate-error">
                <Icon name="error" size="14" /> {gate2Error}
                <div style={{ marginTop: 8 }}>
                  <button
                    className="pp-gate-btn pp-gate-btn--secondary"
                    onClick={() => {
                      // Reset gate2Summary so the useEffect refetches
                      setGate2Summary(null);
                    }}>
                    <Icon name="refresh" size="14" /> Retry
                  </button>
                </div>
              </div>
            )}

            {/* Gate 2 loaded OK — show deliverable */}
            {!gate2Loading && !gate2Error && gate2Summary && (
              <div className="pp-gate-panel-inner">
                <div className="pp-gate-header">
                  <Icon name="fact_check" size="16" /> Review Deliverable Package
                </div>

                <div className="pp-gate-body">
                  {/* Summary */}
                  <div className="pp-gate-section">
                    <div className="pp-gate-section-title">Meeting Summary</div>
                    {!gate2EditMode ? (
                      <RichTextView
                        className="pp-gate-summary-block pp-gate-rich"
                        html={gate2Summary.executive_summary_html}
                        text={typeof gate2Summary.executive_summary === "string" ? gate2Summary.executive_summary : undefined}
                      />
                    ) : (
                      <div className="pp-gate-edit-stack">
                        <RichTextEditor
                          value={pickRich(gate2SummaryDraft.executive_summary_html, gate2SummaryDraft.executive_summary)}
                          onChange={(html, text) => updateGate2SummaryRich("executive_summary", html, text)}
                          placeholder="Executive summary…"
                          minHeight={110}
                        />
                        <RichListEditor
                          title="Discussion Points"
                          items={gate2SummaryDraft.discussion_points || []}
                          htmlItems={gate2SummaryDraft.discussion_points_html || []}
                          onChange={(items, htmlItems) =>
                            setGate2SummaryDraft((prev) => ({ ...prev, discussion_points: items, discussion_points_html: htmlItems }))
                          }
                        />
                        <RichListEditor
                          title="Key Decisions"
                          items={gate2SummaryDraft.key_decisions || []}
                          htmlItems={gate2SummaryDraft.key_decisions_html || []}
                          onChange={(items, htmlItems) =>
                            setGate2SummaryDraft((prev) => ({ ...prev, key_decisions: items, key_decisions_html: htmlItems }))
                          }
                        />
                        <div className="pp-gate-section-title" style={{ marginTop: 8 }}>
                          Action Items
                        </div>
                        {(gate2SummaryDraft.action_items || []).map((a, i) => (
                          <div key={i} className="pp-gate-edit-action">
                            <RichTextEditor
                              compact
                              value={pickRich(a.description_html, a.description)}
                              onChange={(html, text) => updateGate2ActionItem(i, html, text)}
                            />
                            <div className="pp-gate-edit-action-meta">
                              <input
                                className="pp-gate-edit-input"
                                value={a.assignee || ""}
                                onChange={(e) => updateGate2ActionItemMeta(i, "assignee", e.target.value)}
                                placeholder="Assignee"
                              />
                              <input
                                className="pp-gate-edit-input"
                                value={a.deadline || ""}
                                onChange={(e) => updateGate2ActionItemMeta(i, "deadline", e.target.value)}
                                placeholder="Deadline"
                              />
                              <button className="pp-gate-edit-remove" onClick={() => removeGate2ActionItem(i)}>
                                ✕
                              </button>
                            </div>
                          </div>
                        ))}
                        <button className="pp-gate-edit-add" onClick={addGate2ActionItem}>
                          + Add action item
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Action Items (read-only preview) */}
                  {!gate2EditMode && Array.isArray(gate2Summary.action_items) && gate2Summary.action_items.length > 0 && (
                    <div className="pp-gate-section">
                      <div className="pp-gate-section-title">Action Items</div>
                      <ul className="pp-gate-item-list">
                        {gate2Summary.action_items.map((item: any, i: number) => (
                          <li key={i}>
                            <strong>{item.assignee || "?"}:</strong> {item.description || item.action || ""}
                            {item.deadline ? ` (by ${item.deadline})` : ""}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Analysis */}
                  {gate2Analysis && (
                    <div className="pp-gate-section">
                      <div className="pp-gate-section-title">Meeting Analysis</div>
                      {!gate2EditMode ? (
                        <div className="pp-gate-summary-block pp-gate-rich" style={{ maxHeight: 160, overflowY: "auto" }}>
                          {gate2Analysis.topics?.length ? <div>Topics: {gate2Analysis.topics.join(", ")}</div> : null}
                          {(gate2Analysis.sentiment || gate2Analysis.sentiment_html) && (
                            <RichTextView className="pp-gate-rich" html={gate2Analysis.sentiment_html} text={gate2Analysis.sentiment} />
                          )}
                          {(gate2Analysis.effectiveness || gate2Analysis.effectiveness_html) && (
                            <RichTextView className="pp-gate-rich" html={gate2Analysis.effectiveness_html} text={gate2Analysis.effectiveness} />
                          )}
                          {!gate2Analysis.topics &&
                            !gate2Analysis.sentiment &&
                            !gate2Analysis.effectiveness &&
                            !gate2Analysis.sentiment_html &&
                            !gate2Analysis.effectiveness_html &&
                            JSON.stringify(gate2Analysis, null, 2)}
                        </div>
                      ) : (
                        <div className="pp-gate-edit-stack">
                          <RichTextEditor
                            value={pickRich(gate2AnalysisDraft.sentiment_html, gate2AnalysisDraft.sentiment)}
                            onChange={(html, text) => updateGate2AnalysisRich("sentiment", html, text)}
                            placeholder="Meeting sentiment…"
                            minHeight={70}
                          />
                          <RichTextEditor
                            value={pickRich(gate2AnalysisDraft.effectiveness_html, gate2AnalysisDraft.effectiveness)}
                            onChange={(html, text) => updateGate2AnalysisRich("effectiveness", html, text)}
                            placeholder="Meeting effectiveness…"
                            minHeight={70}
                          />
                          <RichListEditor
                            title="Follow-Ups"
                            items={gate2AnalysisDraft.follow_ups || []}
                            htmlItems={gate2AnalysisDraft.follow_ups_html || []}
                            onChange={(items, htmlItems) =>
                              setGate2AnalysisDraft((prev) => ({ ...prev, follow_ups: items, follow_ups_html: htmlItems }))
                            }
                          />
                          <div className="pp-gate-edit-tags">
                            <input
                              className="pp-gate-edit-input"
                              value={(gate2AnalysisDraft.topics || []).join(", ")}
                              onChange={(e) =>
                                setGate2AnalysisDraft((prev) => ({
                                  ...prev,
                                  topics: e.target.value.split(",").map((t) => t.trim()).filter(Boolean),
                                }))
                              }
                              placeholder="Topics (comma-separated)"
                            />
                            <input
                              className="pp-gate-edit-input"
                              value={(gate2AnalysisDraft.key_entities || []).join(", ")}
                              onChange={(e) =>
                                setGate2AnalysisDraft((prev) => ({
                                  ...prev,
                                  key_entities: e.target.value.split(",").map((t) => t.trim()).filter(Boolean),
                                }))
                              }
                              placeholder="Key entities (comma-separated)"
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Delivery options info */}
                  <div className="pp-gate-section">
                    <div className="pp-gate-section-title">Delivery Destinations</div>
                    <div className="pp-gate-delivery-options">
                      <span className="pp-gate-delivery-chip">
                        <Icon name="mail" size="12" /> Email
                      </span>
                      <span className="pp-gate-delivery-chip">
                        <Icon name="cloud" size="12" /> Google Drive
                      </span>
                      <span className="pp-gate-delivery-chip">
                        <Icon name="checklist" size="12" /> Trello
                      </span>
                    </div>
                  </div>

                  {/* Edit mode extras */}
                  {gate2EditMode && (
                    <div className="pp-gate-section">
                      <div className="pp-gate-section-title">Edit Transcript (optional)</div>
                      <div className="pp-gate-edit-segments">
                        {gate2TranscriptDraft.map((seg, i) => (
                          <div key={i} className="pp-gate-edit-segment">
                            <span className="pp-gate-transcript-time">
                              [{typeof seg.start === "number" ? seg.start.toFixed(1) : "?"}s]
                            </span>
                            <input
                              className="pp-gate-edit-speaker"
                              value={seg.speaker}
                              onChange={(e) => updateGate2TranscriptSegment(i, "speaker", e.target.value)}
                              title="Speaker name"
                            />
                            <RichTextEditor
                              compact
                              className="pp-gate-edit-text"
                              value={plainToHtml(seg.text)}
                              onChange={(_html, text) => updateGate2TranscriptSegment(i, "text", text)}
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Feedback for retry */}
                  {showGate2RejectConfirm && gate2RejectAction === "retry" && (
                    <div className="pp-gate-section" style={{ marginTop: 10 }}>
                      <div className="pp-gate-section-title">Feedback for retry (optional)</div>
                      <textarea
                        className="pp-gate-feedback-input"
                        value={gate2Feedback}
                        onChange={(e) => setGate2Feedback(e.target.value)}
                        placeholder="Describe what needs to change…"
                      />
                    </div>
                  )}
                </div>

                <div className="pp-gate-actions">
                  {!showGate2RejectConfirm ? (
                    <>
                      {!gate2EditMode ? (
                        <button
                          className="pp-gate-btn pp-gate-btn--secondary"
                          disabled={gate2Submitting}
                          onClick={() => {
                            setGate2EditMode(true);
                          setGate2SummaryDraft({ ...(gate2Summary || {}) });
                          setGate2AnalysisDraft({ ...(gate2Analysis || {}) });
                          setGate2TranscriptDraft((gate2Transcript || []).map((s) => ({ ...s })));
                          }}>
                          <Icon name="edit" size="14" /> Edit
                        </button>
                      ) : (
                        <button className="pp-gate-btn pp-gate-btn--secondary" onClick={() => setGate2EditMode(false)}>
                          <Icon name="close" size="14" /> Cancel Edit
                        </button>
                      )}
                      <button
                        className="pp-gate-btn pp-gate-btn--approve"
                        disabled={gate2Submitting}
                        onClick={async () => {
                          setGate2Submitting(true);
                          setGate2Error(null);
                          try {
                            let editedSummary = undefined;
                            let editedAnalysis = undefined;
                            let editedTranscript = undefined;
                            if (gate2EditMode) {
                              editedSummary = { ...gate2SummaryDraft };
                              editedAnalysis = Object.keys(gate2AnalysisDraft).length ? { ...gate2AnalysisDraft } : undefined;
                              editedTranscript = gate2TranscriptDraft.length
                                ? gate2TranscriptDraft.map((s) => ({ speaker: s.speaker, text: s.text, start: s.start, end: s.end }))
                                : undefined;
                            }
                            await onApproveGate2?.({
                              action: gate2EditMode ? "approve_with_edits" : "approve",
                              editedTranscript,
                              editedSummary,
                              editedAnalysis,
                            });
                            // Success — keep overlay visible until parent
                            // detects the status change.
                          } catch (err: any) {
                            // Error — reset so user can retry
                            setGate2Submitting(false);
                            setGate2Error(err.message || "Failed to approve delivery");
                          }
                        }}>
                        <Icon name="check" size="14" />{" "}
                        {gate2Submitting ? "Approving…" : gate2EditMode ? "Save Edits & Deliver" : "Approve & Deliver"}
                      </button>
                      {onRejectGate2 && (
                        <>
                          <button
                            className="pp-gate-btn pp-gate-btn--reject"
                            disabled={false}
                            title="Reject & Cancel"
                            onClick={() => {
                              setGate2RejectAction("cancel");
                              setShowGate2RejectConfirm(true);
                            }}>
                            <Icon name="close" size="14" /> Reject & Cancel
                          </button>
                          <button
                            className="pp-gate-btn pp-gate-btn--reject pp-gate-btn--reject-disabled"
                            disabled={true}
                            title="Reject is temporarily disabled">
                            <Icon name="refresh" size="14" /> Reject & Retry
                          </button>
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      <button
                        className="pp-gate-btn pp-gate-btn--reject"
                        disabled={gate2Submitting}
                        onClick={async () => {
                          setGate2Submitting(true);
                          setGate2Error(null);
                          try {
                            if (gate2RejectAction === "cancel") {
                              await onRejectGate2?.("cancel");
                            } else {
                              await onRejectGate2?.("retry", gate2Feedback);
                            }
                          } catch (err: any) {
                            setGate2Error(err.message || "Failed");
                          } finally {
                            setGate2Submitting(false);
                            setShowGate2RejectConfirm(false);
                          }
                        }}>
                        <Icon name="check" size="14" /> Confirm {gate2RejectAction === "cancel" ? "Cancel" : "Retry"}
                      </button>
                      <button
                        className="pp-gate-btn pp-gate-btn--secondary"
                        onClick={() => {
                          setShowGate2RejectConfirm(false);
                          setGate2Feedback("");
                        }}>
                        Go Back
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Gate 2: no data, no error — unexpected gap case */}
            {!gate2Loading && !gate2Error && !gate2Summary && (
              <div className="pp-gate-error">
                <Icon name="error" size="14" /> No deliverable data available yet.
                <div style={{ marginTop: 8 }}>
                  <button
                    className="pp-gate-btn pp-gate-btn--secondary"
                    onClick={() => {
                      setGate2Summary(null);
                    }}>
                    <Icon name="refresh" size="14" /> Retry
                  </button>
                </div>
              </div>
            )}

            {/* Gate 2 reject confirm dialog */}
            {showGate2RejectConfirm && (
              <div className="pp-confirm-overlay" onClick={() => setShowGate2RejectConfirm(false)}>
                <div className="pp-confirm-dialog" onClick={(e) => e.stopPropagation()}>
                  <div className="pp-confirm-header">
                    <Icon name="warning" size="16" color="red" /> Reject Deliverable Package?
                  </div>
                  <p className="pp-confirm-body">
                    {gate2RejectAction === "cancel"
                      ? "This will permanently cancel the job and stop delivery."
                      : "This will re-run the AI pipeline (summary + analysis) to generate new content."}
                  </p>
                  <div className="pp-confirm-actions">
                    <button className="pp-confirm-cancel-btn" onClick={() => setShowGate2RejectConfirm(false)}>
                      Go Back
                    </button>
                    <button
                      className="pp-confirm-stop-btn"
                      onClick={async () => {
                        setShowGate2RejectConfirm(false);
                        setGate2Submitting(true);
                        try {
                          if (gate2RejectAction === "cancel") {
                            await onRejectGate2?.("cancel");
                          } else {
                            await onRejectGate2?.("retry", gate2Feedback);
                          }
                        } catch (err: any) {
                          setGate2Error(err.message || "Failed to reject");
                        } finally {
                          setGate2Submitting(false);
                        }
                      }}>
                      Yes, {gate2RejectAction === "cancel" ? "Cancel Job" : "Retry Pipeline"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        {/* ── Loading overlay during save/submit (visible for both gates) ── */}
        <LoadingModal visible={gate1Submitting || gate2Submitting} message={submitMessage} />
      </div>
    </div>
  );
}
