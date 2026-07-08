/**
 * About Panel — shows app name, version, and README content.
 */

import React, { useEffect, useState } from "react";

export default function AboutPanel({ onClose }: { onClose: () => void }) {
  const [appName, setAppName] = useState("Transcription Agent");
  const [version, setVersion] = useState("");
  const [readme, setReadme] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      window.electronAPI?.getAppVersion().catch(() => "1.0.0"),
      window.electronAPI?.getAppName().catch(() => "Transcription Agent"),
      window.electronAPI?.getReadme().catch(() => ""),
    ])
      .then(([v, name, content]) => {
        setVersion(v || "");
        setAppName(name || "Transcription Agent");
        setReadme(content || "");
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="panel about-panel">
      <div className="about-header">
        <h2>🎙️ {appName}</h2>
        <button className="about-close-btn" onClick={onClose} title="Close the About panel" data-tooltip="Close the About panel">
          ✕
        </button>
      </div>

      {loading ? (
        <p className="about-loading">Loading…</p>
      ) : (
        <>
          <div className="about-version">
            <span className="about-version-label">Version</span>
            <span className="about-version-value">{version}</span>
          </div>

          <div className="about-divider" />

          {readme ? (
            <div className="about-readme">{readme}</div>
          ) : (
            <p className="about-readme about-readme-empty">
              <strong>Transcription Agent</strong> is a desktop application that transcribes, diarizes, and summarizes meeting audio using AI. It
              supports speaker identification, action item extraction, semantic memory, and integrates with Gmail, Google Drive, and Trello.
            </p>
          )}
        </>
      )}
    </div>
  );
}
