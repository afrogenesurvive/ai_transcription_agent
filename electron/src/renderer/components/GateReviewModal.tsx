/**
 * GateReviewModal — overlay modal for Gate 1 (Raw Transcript Review) and
 * Gate 2 (Delivery Review). Extracted from ProgressPanel.tsx into a reusable
 * centered overlay so the review panels appear as modal dialogs rather than
 * inline sections.
 */

import React, { useState, useEffect, useRef } from "react";
import Icon from "./Icon";
import LoadingModal from "./LoadingModal";

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

export default function GateReviewModal({ visible, gate, jobId, onApproveGate1, onRejectGate1, onApproveGate2, onRejectGate2 }: Props) {
  const isGate1 = gate === "gate1";
  const isGate2 = gate === "gate2";

  if (!visible) return null;

  // ── Gate 1 state ──
  const [gate1Loading, setGate1Loading] = useState(false);
  const [gate1Transcript, setGate1Transcript] = useState<any[] | null>(null);
  const [gate1RawText, setGate1RawText] = useState<string>("");
  const [gate1EditMode, setGate1EditMode] = useState(false);
  const [gate1EditedText, setGate1EditedText] = useState("");
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
  const [gate2EditedSummary, setGate2EditedSummary] = useState("");
  const [gate2EditedAnalysis, setGate2EditedAnalysis] = useState("");
  const [gate2EditedTranscript, setGate2EditedTranscript] = useState("");
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

  // ── Reset submitting state when modal hides (parent detected status change) ──
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
    const fetchData = async () => {
      setGate2Loading(true);
      setGate2Error(null);
      try {
        const [summaryRes, analysisRes, transcriptRes] = await Promise.all([
          fetch(`http://127.0.0.1:5010/tools/call`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "transcribe_get_summary", args: { jobId } }),
          }),
          fetch(`http://127.0.0.1:5010/tools/call`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "transcribe_get_analysis", args: { jobId } }),
          }),
          fetch(`http://127.0.0.1:5010/tools/call`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ tool: "transcribe_get_transcript", args: { jobId, format: "json" } }),
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
        if (!cancelled) setGate2Error(err.message || "Failed to load delivery data");
      } finally {
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
                        <div className="pp-gate-section-title">Edit Transcript (JSON)</div>
                        <textarea
                          className="pp-gate-textarea"
                          style={{ minHeight: 200 }}
                          value={gate1EditedText}
                          onChange={(e) => setGate1EditedText(e.target.value)}
                        />
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
                          setGate1EditedText(JSON.stringify(gate1Transcript, null, 2));
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
                              setGate1VoiceConflict({ message: err.message });
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
                            className="pp-gate-btn pp-gate-btn--reject pp-gate-btn--reject-disabled"
                            disabled={true}
                            title="Reject is temporarily disabled">
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
                            let parsed: any[];
                            try {
                              parsed = JSON.parse(gate1EditedText);
                            } catch {
                              setGate1Error("Invalid JSON — cannot parse edited transcript");
                              setGate1Submitting(false);
                              return;
                            }
                            await onApproveGate1?.({ action: "approve_with_edits", editedTranscript: parsed });
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
              </div>
            )}

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
                      <div className="pp-gate-summary-block">
                        {typeof gate2Summary.executive_summary === "string" ? gate2Summary.executive_summary : JSON.stringify(gate2Summary, null, 2)}
                      </div>
                    ) : (
                      <textarea
                        className="pp-gate-textarea"
                        style={{ minHeight: 120 }}
                        value={gate2EditedSummary}
                        onChange={(e) => setGate2EditedSummary(e.target.value)}
                      />
                    )}
                  </div>

                  {/* Action Items */}
                  {Array.isArray(gate2Summary.action_items) && gate2Summary.action_items.length > 0 && (
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
                      <div className="pp-gate-summary-block" style={{ maxHeight: 120, overflowY: "auto" }}>
                        {typeof gate2Analysis.topics !== "undefined" && (
                          <div>Topics: {Array.isArray(gate2Analysis.topics) ? gate2Analysis.topics.join(", ") : String(gate2Analysis.topics)}</div>
                        )}
                        {gate2Analysis.sentiment && <div>Sentiment: {String(gate2Analysis.sentiment)}</div>}
                        {gate2Analysis.effectiveness && <div>Effectiveness: {String(gate2Analysis.effectiveness)}</div>}
                        {!gate2Analysis.topics && !gate2Analysis.sentiment && !gate2Analysis.effectiveness && JSON.stringify(gate2Analysis, null, 2)}
                      </div>
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
                    <>
                      <div className="pp-gate-section">
                        <div className="pp-gate-section-title">Edited Transcript (optional)</div>
                        <textarea
                          className="pp-gate-textarea"
                          style={{ minHeight: 80 }}
                          value={gate2EditedTranscript}
                          onChange={(e) => setGate2EditedTranscript(e.target.value)}
                        />
                      </div>
                    </>
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
                            setGate2EditedSummary(
                              typeof gate2Summary.executive_summary === "string"
                                ? gate2Summary.executive_summary
                                : JSON.stringify(gate2Summary, null, 2),
                            );
                            setGate2EditedAnalysis(gate2Analysis ? JSON.stringify(gate2Analysis, null, 2) : "");
                            setGate2EditedTranscript(gate2Transcript ? JSON.stringify(gate2Transcript, null, 2) : "");
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
                              try {
                                editedSummary = JSON.parse(gate2EditedSummary);
                              } catch {
                                editedSummary = { ...gate2Summary, executive_summary: gate2EditedSummary };
                              }
                              try {
                                editedAnalysis = JSON.parse(gate2EditedAnalysis);
                              } catch {
                                editedAnalysis = gate2EditedAnalysis ? { ...gate2Analysis, note: gate2EditedAnalysis } : undefined;
                              }
                              try {
                                editedTranscript = JSON.parse(gate2EditedTranscript);
                              } catch {
                                editedTranscript = undefined;
                              }
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
                            className="pp-gate-btn pp-gate-btn--reject pp-gate-btn--reject-disabled"
                            disabled={true}
                            title="Reject is temporarily disabled">
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
