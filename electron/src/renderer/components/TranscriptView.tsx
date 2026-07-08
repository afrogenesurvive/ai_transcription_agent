/**
 * Transcript View — displays the speaker-labeled transcript with timestamps.
 */

import React from "react";
import Icon from "./Icon";
import type { TranscriptionSegment } from "../types";

interface Props {
  segments?: TranscriptionSegment[];
  summary?: {
    executive_summary?: string;
    key_decisions?: string[];
    discussion_points?: string[];
    action_items?: { description: string; assignee?: string; deadline?: string }[];
  };
  loading?: boolean;
}

const SPEAKER_COLORS = ["#4A90D9", "#E67E22", "#2ECC71", "#E74C3C", "#9B59B6", "#1ABC9C", "#F39C12", "#3498DB"];

function speakerColor(speaker: string): string {
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = speaker.charCodeAt(i) + ((hash << 5) - hash);
  }
  return SPEAKER_COLORS[Math.abs(hash) % SPEAKER_COLORS.length];
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export default function TranscriptView({ segments, summary, loading }: Props) {
  if (loading) {
    return (
      <div className="panel transcript-panel">
        <h2>Transcript</h2>
        <p className="placeholder">Processing...</p>
      </div>
    );
  }

  if (!segments && !summary) {
    return (
      <div className="panel transcript-panel">
        <h2>Transcript</h2>
        <p className="placeholder">Upload a meeting to see the transcript here.</p>
      </div>
    );
  }

  return (
    <div className="panel transcript-panel">
      <h2>Transcript</h2>

      {summary?.executive_summary && (
        <div className="summary-section">
          <h3>
            <Icon name="summarize" size="14" color="accent" /> Executive Summary
          </h3>
          <p>{summary.executive_summary}</p>

          {summary.key_decisions && summary.key_decisions.length > 0 && (
            <>
              <h4>Key Decisions</h4>
              <ul>
                {summary.key_decisions.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </>
          )}

          {summary.action_items && summary.action_items.length > 0 && (
            <>
              <h4>Action Items</h4>
              <ul className="action-items">
                {summary.action_items.map((a, i) => (
                  <li key={i}>
                    <strong>{a.description}</strong>
                    {a.assignee && <span className="assignee"> — {a.assignee}</span>}
                    {a.deadline && <span className="deadline"> (due: {a.deadline})</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      {segments && segments.length > 0 && (
        <div className="segments">
          {segments.map((seg, i) => (
            <div key={i} className="segment">
              <span className="speaker-badge" style={{ backgroundColor: speakerColor(seg.speaker) }}>
                {seg.speaker}
              </span>
              <span className="timestamp">{formatTime(seg.start)}</span>
              <span className="text">{seg.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
