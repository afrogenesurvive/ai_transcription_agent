/**
 * About Panel — tabbed view with About info and a searchable End User Guide.
 *
 * Tabs:
 *   "about" — app name, version, and README content
 *   "guide" — formatted end-user guide with search and section navigation
 */

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Icon from "./Icon";
import Tooltip from "./Tooltip";

type AboutTab = "about" | "guide";

export default function AboutPanel({ onClose }: { onClose: () => void }) {
  const [activeTab, setActiveTab] = useState<AboutTab>("about");
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

/** Slugify a string for use as an HTML element id. */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['"]/g, "") // remove quotes
    .replace(/[^a-z0-9]+/g, "-") // replace non-alphanumeric with hyphens
    .replace(/^-+|-+$/g, ""); // trim leading/trailing hyphens
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

/** Minimal markdown-to-HTML renderer.
 *
 * Supports: headings (# through ####), paragraphs, lists, tables,
 * code blocks, inline code, bold, links, blockquotes, horizontal rules,
 * and line breaks.
 *
 * Heading IDs are slugified so TOC links and internal anchors work.
 */
function renderMarkdown(md: string): string {
  // Escape HTML entities first
  let html = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Horizontal rules
  html = html.replace(/^---+/gm, "<hr />");

  // Blockquotes
  html = html.replace(/^&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>");

  // Code blocks (fenced)
  html = html.replace(/```[\w]*\n([\s\S]*?)```/g, (_, code) => {
    const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<pre><code>${escaped}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => {
    if (url.startsWith("#")) {
      // Internal anchor link — slugify the href to match the heading id
      return `<a href="#${slugify(url.slice(1))}" class="guide-anchor">${text}</a>`;
    }
    return `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
  });

  // Tables
  html = html.replace(/^\|(.+)\|$/gm, (line) => {
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^[-]+$/.test(c))) return '<hr class="table-sep" />';
    const tag = line.includes("<hr") ? "" : "td";
    return `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
  });
  // Wrap consecutive <tr> in a table
  html = html.replace(/((?:<tr>.*?<\/tr>\n?)+)/g, "<table>$1</table>");
  // Remove empty table separators
  html = html.replace(/<table>\s*<\/table>/g, "");

  // Headings (must come before paragraph wrapping)
  // Use slugified IDs so TOC links and internal anchors can target them
  html = html.replace(/^#### (.*$)/gm, (_, title) => {
    const t = title.trim();
    return `<h4 id="${slugify(t)}">${t}</h4>`;
  });
  html = html.replace(/^### (.*$)/gm, (_, title) => {
    const t = title.trim();
    return `<h3 id="${slugify(t)}">${t}</h3>`;
  });
  html = html.replace(/^## (.*$)/gm, (_, title) => {
    const t = title.trim();
    return `<h2 id="${slugify(t)}">${t}</h2>`;
  });
  html = html.replace(/^# (.*$)/gm, (_, title) => {
    const t = title.trim();
    return `<h1 id="${slugify(t)}">${t}</h1>`;
  });

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>");

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  // Re-wrap consecutive <li> that aren't already in <ul> into <ol>
  html = html.replace(/((?:<li>.*<\/li>\n?)+)(?!\s*<\/?[uo]l>)/g, "<ol>$1</ol>");

  // Paragraphs — wrap orphan text
  const lines = html.split("\n");
  const wrapped = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      wrapped.push("");
      continue;
    }
    if (/^<(h[1-4]|ul|ol|li|table|tr|td|th|pre|code|blockquote|hr|div)/.test(trimmed) || trimmed.startsWith("---")) {
      wrapped.push(trimmed);
      inBlock = trimmed.startsWith("<pre") || trimmed.startsWith("<table") || trimmed.startsWith("<blockquote");
      continue;
    }
    if (inBlock) {
      wrapped.push(trimmed);
      if (trimmed.match(/<\/(pre|table|blockquote)>/)) inBlock = false;
      continue;
    }
    // Wrap in paragraph if not already a block element
    wrapped.push(`<p>${trimmed}</p>`);
  }
  html = wrapped.join("\n");

  return html;
}

/** Split markdown into pages, one per ## heading, skipping the TOC section. */
function splitIntoPages(md: string): Array<{ id: string; title: string; content: string }> {
  const lines = md.split("\n");
  const pages: Array<{ id: string; title: string; content: string }> = [];
  let current: { id: string; title: string; content: string[] } | null = null;
  let pastToc = false;

  for (const line of lines) {
    const match = line.match(/^##\s+(.+)/);
    if (match) {
      const title = match[1].trim();
      // Skip the TOC section itself
      if (title.startsWith("📖")) {
        pastToc = true;
        continue;
      }
      // Finalize previous page
      if (current) {
        pages.push({ id: current.id, title: current.title, content: current.content.join("\n") });
      }
      // Start new page (promote ## heading to # so it renders as page title)
      current = { id: slugify(title), title, content: [`# ${title}`] };
      pastToc = true;
    } else if (current && pastToc) {
      current.content.push(line);
    }
  }
  // Push the last page
  if (current) {
    pages.push({ id: current.id, title: current.title, content: current.content.join("\n") });
  }
  return pages;
}

function GuideTab({ markdown }: { markdown: string }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);

  // Split into pages
  const pages = useMemo(() => splitIntoPages(markdown), [markdown]);

  // TOC entries (all pages)
  const toc = useMemo(() => pages.map((p) => ({ id: p.id, title: p.title })), [pages]);

  // Filter TOC by search
  const filteredToc = useMemo(() => {
    if (!searchQuery.trim()) return toc;
    const q = searchQuery.toLowerCase();
    return toc.filter((s) => s.title.toLowerCase().includes(q));
  }, [toc, searchQuery]);

  // When search changes, jump to first matching page
  useEffect(() => {
    if (searchQuery.trim() && filteredToc.length > 0) {
      const idx = toc.findIndex((t) => t.id === filteredToc[0].id);
      if (idx >= 0) setCurrentIndex(idx);
    }
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // Render current page markdown with search highlighting
  const renderedHtml = useMemo(() => {
    if (pages.length === 0) return "";
    let html = renderMarkdown(pages[currentIndex].content);
    if (searchQuery.trim()) {
      const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(${escaped})`, "gi");
      html = html.replace(re, '<mark class="guide-search-hl">$1</mark>');
    }
    return html;
  }, [pages, currentIndex, searchQuery]);

  // Navigate helpers
  const goTo = useCallback((idx: number) => {
    setCurrentIndex(idx);
    contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  const goPrev = useCallback(() => {
    if (currentIndex > 0) goTo(currentIndex - 1);
  }, [currentIndex, goTo]);

  const goNext = useCallback(() => {
    if (currentIndex < pages.length - 1) goTo(currentIndex + 1);
  }, [currentIndex, pages.length, goTo]);

  // Keyboard navigation (Arrow Left / Arrow Right)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goPrev, goNext]);

  if (pages.length === 0) {
    return (
      <p className="about-md-content about-md-content--empty">
        The user guide is not available. Make sure <code>docs/end_user_guide.md</code> exists in the application directory.
      </p>
    );
  }

  const currentPage = pages[currentIndex];

  return (
    <div className="guide-container">
      {/* ── Toolbar: search + page counter ── */}
      <div className="guide-toolbar">
        <div className="guide-search-wrap">
          <Icon name="search" size="14" color="text-muted" />
          <input
            className="guide-search-input"
            type="text"
            placeholder="Search the guide…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          {searchQuery && (
            <button className="guide-search-clear" onClick={() => setSearchQuery("")} title="Clear search">
              <Icon name="close" size="14" />
            </button>
          )}
        </div>
      </div>

      <div className="guide-layout">
        {/* ── Sidebar TOC ── */}
        <nav className="guide-sidebar">
          <div className="guide-sidebar-title">
            Pages
            <span className="guide-sidebar-page-count">
              {currentIndex + 1} / {pages.length}
            </span>
          </div>
          {filteredToc.map((s) => {
            const idx = toc.findIndex((t) => t.id === s.id);
            const isActive = idx === currentIndex;
            return (
              <button
                key={s.id}
                className={`guide-sidebar-item ${isActive ? "guide-sidebar-item--active" : ""}`}
                onClick={() => goTo(idx)}
                title={s.title}>
                <span className="guide-sidebar-num">{idx + 1}.</span>
                <span className="guide-sidebar-label">{s.title}</span>
              </button>
            );
          })}
          {filteredToc.length === 0 && searchQuery && <p className="guide-sidebar-empty">No pages match "{searchQuery}"</p>}
        </nav>

        {/* ── Page content ── */}
        <div className="guide-page-area">
          <div className="about-md-content" ref={contentRef} dangerouslySetInnerHTML={{ __html: renderedHtml }} />

          {/* ── Navigation bar ── */}
          <div className="guide-nav">
            <button className="guide-nav-btn" disabled={currentIndex === 0} onClick={goPrev}>
              <Icon name="chevron_left" size="16" /> Previous
            </button>
            <span className="guide-nav-label">{currentPage.title}</span>
            <button className="guide-nav-btn guide-nav-btn--next" disabled={currentIndex === pages.length - 1} onClick={goNext}>
              Next <Icon name="chevron_right" size="16" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
