/**
 * About Panel — tabbed view with About info and a searchable End User Guide.
 *
 * Tabs:
 *   "about" — app name, version, and README content
 *   "guide" — formatted end-user guide with search and section navigation
 */

import React, { useEffect, useState, useMemo } from "react";
import Icon from "./Icon";
import Tooltip from "./Tooltip";
import DocViewer from "./DocViewer";
import { useUiStateValue } from "../hooks/useUiState";
import { renderMarkdown } from "../utils/markdown";

type AboutTab = "about" | "guide";

export default function AboutPanel({ onClose }: { onClose: () => void }) {
  // Persisted About tab selection (rule 7a)
  const [activeTab, setActiveTab] = useUiStateValue<AboutTab>("about.tab", "about");
  const [appName, setAppName] = useState("Transcription Agent");
  const [version, setVersion] = useState("");
  const [readme, setReadme] = useState("");
  const [guideMd, setGuideMd] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      window.electronAPI?.getAppVersion().catch(() => "1.0.0"),
      window.electronAPI?.getAppName().catch(() => "Transcription Agent"),
      window.electronAPI?.getReadme().catch(() => ""),
      window.electronAPI?.getGuide().catch(() => ""),
    ])
      .then(([v, name, content, guide]) => {
        setVersion(v || "");
        setAppName(name || "Transcription Agent");
        setReadme(content || "");
        setGuideMd(guide || "");
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="about-panel">
      {/* ── Header ── */}
      <div className="about-header">
        <h2>
          <Icon name="mic" size="18" color="accent" /> {appName}
        </h2>
        <Tooltip content="Close">
          <button className="about-close-btn" onClick={onClose} title="Close the About panel">
            <Icon name="close" size="16" />
          </button>
        </Tooltip>
      </div>

      {/* ── Tab bar ── */}
      <div className="about-tab-bar">
        <button className={`about-tab ${activeTab === "about" ? "about-tab--active" : ""}`} onClick={() => setActiveTab("about")}>
          <Icon name="info" size="14" /> About
        </button>
        <button className={`about-tab ${activeTab === "guide" ? "about-tab--active" : ""}`} onClick={() => setActiveTab("guide")}>
          <Icon name="book" size="14" /> Guide
        </button>
      </div>

      {/* ── Tab content ── */}
      {loading ? (
        <p className="about-loading">Loading…</p>
      ) : activeTab === "about" ? (
        <AboutTab version={version} readme={readme} />
      ) : (
        <GuideTab markdown={guideMd} />
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════
   About Tab — renders the README with full markdown formatting
   ═══════════════════════════════════════════════════════════ */

function AboutTab({ version, readme }: { version: string; readme: string }) {
  const renderedHtml = useMemo(() => (readme ? renderMarkdown(readme) : ""), [readme]);

  return (
    <>
      <div className="about-version">
        <span className="about-version-label">Version</span>
        <span className="about-version-value">{version || "1.0.0"}</span>
      </div>

      <div className="about-divider" />

      {renderedHtml ? (
        <div className="about-md-content" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
      ) : (
        <p className="about-md-content about-md-content--empty">
          <strong>Transcription Agent</strong> is a desktop application that transcribes, diarizes, and summarizes meeting audio using AI. It supports
          speaker identification, action item extraction, semantic memory, and integrates with Gmail, Google Drive, and Trello.
        </p>
      )}
    </>
  );
}

/* ═══════════════════════════════════════════════════════════
   Guide Tab — rendered markdown with search & TOC nav
   ═══════════════════════════════════════════════════════════ */

function GuideTab({ markdown }: { markdown: string }) {
  // Persisted guide TOC page selection (rule 7b)
  const [tocIndex, setTocIndex] = useUiStateValue<number>("about.guideTocIndex", 0);
  return (
    <DocViewer
      markdown={markdown}
      initialIndex={tocIndex}
      onIndexChange={setTocIndex}
      emptyMessage={"The user guide is not available. Make sure <code>docs/end_user_guide.md</code> exists in the application directory."}
    />
  );
}
