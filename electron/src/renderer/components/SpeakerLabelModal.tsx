/**
 * Speaker Label Modal — appears when pipeline pauses after diarization.
 *
 * Shows each detected speaker with a playable audio clip and a name input.
 * User must label ALL detected speakers before continuing. Every speaker
 * must have a non-empty name — the Confirm button stays disabled until all
 * are filled in.
 * Once confirmed, voiceprints are saved and the pipeline resumes.
 */

import React, { useState, useEffect, useRef, useCallback } from "react";

interface SpeakerInfo {
  speaker_id: string;
  segment_count: number;
  total_duration: number;
  sample_clip_url: string;
  sample_start: number;
  sample_end: number;
  suggested_name: string;
}

interface Props {
  jobId: string;
  speakers: SpeakerInfo[];
  onConfirm: (labels: Array<{ speaker_id: string; name: string; email?: string }>) => Promise<void>;
  onCancel: () => void;
  submitting: boolean;
}

export default function SpeakerLabelModal({ jobId, speakers, onConfirm, onCancel, submitting }: Props) {
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [playing, setPlaying] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Initialize labels with suggested names from attendees list
  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const spk of speakers) {
      if (spk.suggested_name) {
        initial[spk.speaker_id] = spk.suggested_name;
      }
    }
    setLabels(initial);
  }, [speakers]);

  // Stop playback when switching speakers
  const playClip = useCallback(
    (speakerId: string, clipUrl: string) => {
      if (playing === speakerId) {
        audioRef.current?.pause();
        setPlaying(null);
        return;
      }
      if (audioRef.current) {
        audioRef.current.pause();
      }
      const audio = new Audio(`http://127.0.0.1:5010${clipUrl}`);
      audio.onended = () => setPlaying(null);
      audio.onerror = () => setPlaying(null);
      audio.play().catch(() => setPlaying(null));
      audioRef.current = audio;
      setPlaying(speakerId);
    },
    [playing],
  );

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      audioRef.current?.pause();
    };
  }, []);

  // Every speaker must have a non-empty name
  const allLabeled = speakers.every((s) => (labels[s.speaker_id]?.trim() ?? "").length > 0);

  const handleConfirm = async () => {
    // Build labels for ALL speakers — discard any extras beyond speaker count
    const result = speakers.map((s) => ({
      speaker_id: s.speaker_id,
      name: labels[s.speaker_id]?.trim() || s.speaker_id,
    }));
    await onConfirm(result);
  };

  const handleSkip = () => {
    // Use default speaker IDs for any unnamed speakers
    const defaultLabels = speakers.map((s) => ({
      speaker_id: s.speaker_id,
      name: labels[s.speaker_id]?.trim() || s.speaker_id,
    }));
    onConfirm(defaultLabels);
  };

  return (
    <div className="modal-overlay">
      <div className="modal speaker-label-modal">
        <div className="modal-header">
          <h2>🎤 Identify Speakers</h2>
          <p className="modal-subtitle">
            {speakers.length} speaker{speakers.length !== 1 ? "s" : ""} detected. Listen to each clip and enter a name for every speaker. All must be
            labeled before continuing.
          </p>
        </div>

        <div className="speaker-list">
          {speakers.map((spk, idx) => {
            const hasName = (labels[spk.speaker_id]?.trim() ?? "").length > 0;
            return (
              <div key={spk.speaker_id} className={`speaker-item ${hasName ? "speaker-item--labeled" : ""}`}>
                <div className="speaker-header">
                  <span className="speaker-number">#{idx + 1}</span>
                  <span className="speaker-stats">
                    {spk.segment_count} segment{spk.segment_count !== 1 ? "s" : ""} · {spk.total_duration.toFixed(0)}s total
                  </span>
                  <button
                    className="btn-icon speaker-play-btn"
                    onClick={() => playClip(spk.speaker_id, spk.sample_clip_url)}
                    title={playing === spk.speaker_id ? "Stop" : "Play clip"}>
                    {playing === spk.speaker_id ? "⏹" : "▶️"}
                  </button>
                </div>
                <div className="speaker-name-row">
                  <input
                    type="text"
                    className="speaker-name-input"
                    placeholder={`Name for ${spk.speaker_id}`}
                    value={labels[spk.speaker_id] ?? ""}
                    onChange={(e) => setLabels((prev) => ({ ...prev, [spk.speaker_id]: e.target.value }))}
                    autoFocus={idx === 0 && !spk.suggested_name}
                    title="Enter a name for this speaker"
                    data-tooltip="Type the speaker's name — this maps the detected voice to a person"
                  />
                  {hasName && <span className="speaker-label-check">✓</span>}
                </div>
              </div>
            );
          })}
        </div>

        <div className="modal-actions">
          <button
            className="btn-secondary"
            onClick={onCancel}
            disabled={submitting}
            title="Cancel the entire transcription job"
            data-tooltip="Cancel the entire job without saving speaker labels">
            Cancel Job
          </button>
          <button
            className="btn-secondary"
            onClick={handleSkip}
            disabled={submitting}
            title="Use auto-generated speaker IDs instead of names"
            data-tooltip="Skip naming — speakers will use their auto-generated IDs (Speaker_1, etc.)">
            Use Default Names
          </button>
          <button
            className="btn-primary"
            onClick={handleConfirm}
            disabled={submitting || !allLabeled}
            title="Save labels and resume pipeline"
            data-tooltip="Save all speaker names and continue the transcription pipeline">
            {submitting ? "Saving & Resuming..." : `Confirm & Continue (${speakers.length} speaker${speakers.length !== 1 ? "s" : ""})`}
          </button>
        </div>
      </div>
    </div>
  );
}
