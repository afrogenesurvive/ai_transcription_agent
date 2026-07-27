/**
 * DocViewer — reusable guide-style rendered markdown viewer.
 *
 * Mimics the GuideTab from AboutPanel.tsx: sidebar TOC, full-text search,
 * page-by-page navigation (by ## headings), and keyboard shortcuts.
 */

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import Icon from "./Icon";
import Tooltip from "./Tooltip";
import { renderMarkdown, splitIntoPages } from "../utils/markdown";

interface Props {
  markdown: string;
  /** Placeholder text when markdown is empty. */
  emptyMessage?: string;
}

export default function DocViewer({ markdown, emptyMessage }: Props) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);

  const pages = useMemo(() => splitIntoPages(markdown), [markdown]);
  const toc = useMemo(() => pages.map((p) => ({ id: p.id, title: p.title })), [pages]);

  const filteredToc = useMemo(() => {
    if (!searchQuery.trim()) return toc;
    const q = searchQuery.toLowerCase();
    return toc.filter((s) => s.title.toLowerCase().includes(q));
  }, [toc, searchQuery]);

  useEffect(() => {
    if (searchQuery.trim() && filteredToc.length > 0) {
      const idx = toc.findIndex((t) => t.id === filteredToc[0].id);
      if (idx >= 0) setCurrentIndex(idx);
    }
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

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

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") goPrev();
      else if (e.key === "ArrowRight") goNext();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goPrev, goNext]);

  // Reset to first page when markdown changes
  useEffect(() => {
    setCurrentIndex(0);
    setSearchQuery("");
  }, [markdown]);

  if (pages.length === 0) {
    return <p className="about-md-content about-md-content--empty">{emptyMessage || "No content available."}</p>;
  }

  const currentPage = pages[currentIndex];

  return (
    <div className="guide-container">
      {/* ── Toolbar: search ── */}
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
