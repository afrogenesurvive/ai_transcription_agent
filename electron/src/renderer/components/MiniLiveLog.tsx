/**
 * MiniLiveLog — live log feed for the pipeline stepper.
 *
 * Subscribes to live log entries via IPC (same stream as the DevPanel Live Log)
 * and shows the last ~8 entries with source-colored dots.
 *
 * Horizontal-scrollable (long lines can be scrolled) but NOT vertically
 * scrollable — it auto-scrolls to keep the newest entry visible.
 */

import React, { useEffect, useRef, useState } from "react";

interface Props {
  maxLines?: number;
}

const MAX_BUFFER = 200;
const PLACEHOLDER_LINES = [
  "Waiting for pipeline...",
  "Checking system health...",
  "Preparing transcription engine...",
  "Monitoring job progress...",
  "Ready for audio processing...",
];

/** Map source names to a short color dot style */
const SOURCE_COLORS: Record<string, string> = {
  python: "#58a6ff",
  bridge: "#3fb950",
  agent: "#d29922",
  main: "#8b949e",
};

interface LogLine {
  source: string;
  message: string;
}

export default function MiniLiveLog({ maxLines = 8 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [buffer, setBuffer] = useState<LogLine[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  // Subscribe to live log stream
  useEffect(() => {
    const unsub = window.electronAPI?.onLog((entry) => {
      if (entry.level === "debug") return;
      setBuffer((prev) => {
        const next = [...prev, { source: entry.source, message: entry.message }];
        return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next;
      });
    });
    return () => unsub?.();
  }, []);

  // Reset horizontal scroll to the left when new messages arrive
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollLeft = 0;
    }
  }, [buffer.length]);

  const visible = buffer.slice(-maxLines);

  return (
    <div className="pp-mini-log">
      {/* ── Collapsible header ── */}
      <div className="pp-mini-log-header" onClick={() => setCollapsed((c) => !c)}>
        <span className={`pp-mini-log-chevron${collapsed ? "" : " pp-mini-log-chevron--open"}`} />
        <span className="pp-mini-log-header-label">Live Log</span>
        <span className="pp-mini-log-header-count">{buffer.length} entries</span>
      </div>

      {/* ── Log entries ── */}
      {!collapsed && (
        <div className="pp-mini-log-body" ref={containerRef}>
          {visible.length > 0
            ? visible.map((line, i) => (
                <div key={`log-${buffer.length - visible.length + i}`} className="pp-mini-log-entry" title={line.message}>
                  <span className="pp-mini-log-dot" style={{ backgroundColor: SOURCE_COLORS[line.source] || "#8b949e" }} />
                  {line.message}
                </div>
              ))
            : PLACEHOLDER_LINES.slice(0, maxLines).map((line, i) => (
                <div key={`ph-${i}`} className="pp-mini-log-entry pp-mini-log-entry--placeholder">
                  {line}
                </div>
              ))}
        </div>
      )}
    </div>
  );
}
