/**
 * DocViewer — reusable guide-style rendered markdown viewer.
 *
 * Mimics the GuideTab from AboutPanel.tsx: sidebar TOC, full-text search,
 * page-by-page navigation (by ## headings), and keyboard shortcuts.
 */

import React, { useEffect, useState, useCallback, useMemo, useRef } from "react";
import mermaid from "mermaid";
import Icon from "./Icon";
import Tooltip from "./Tooltip";
import { renderMarkdown, splitIntoPages } from "../utils/markdown";

// Configure Mermaid once for the in-app guide (diagrams in docs/safe/*.md).
mermaid.initialize({ startOnLoad: false, theme: "neutral", suppressErrorRendering: false });

interface Props {
  markdown: string;
  /** Placeholder text when markdown is empty. */
  emptyMessage?: string;
  /** TOC page index to restore on first content load (persisted ui-state). */
  initialIndex?: number;
  /** Called whenever the active TOC page changes (for ui-state persistence). */
  onIndexChange?: (index: number) => void;
  /** Show images in the rendered markdown. Defaults to the USER_GUIDE_IMAGES_ENABLED config. */
  imagesEnabled?: boolean;
}

export default function DocViewer({ markdown, emptyMessage, initialIndex, onIndexChange, imagesEnabled: imagesEnabledProp }: Props) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  // Whether to render images (from the prop, else from the USER_GUIDE_IMAGES_ENABLED config).
  const [imagesEnabled, setImagesEnabled] = useState<boolean>(imagesEnabledProp !== undefined ? imagesEnabledProp : true);
  const contentRef = useRef<HTMLDivElement>(null);
  const appliedInitialRef = useRef(false);
  // Keep the latest onIndexChange without re-binding effects that depend on it.
  const onIndexChangeRef = useRef(onIndexChange);
  onIndexChangeRef.current = onIndexChange;
  // The document we last normalized the TOC position for ("" before first load).
  const lastDocRef = useRef<string>("");
  // Becomes true once the user navigates (TOC/prev/next/search) — after that the
  // persisted index is never re-applied to the current document.
  const userNavigatedRef = useRef(false);

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
      if (idx >= 0) {
        userNavigatedRef.current = true;
        setCurrentIndex(idx);
      }
    }
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  // Read the USER_GUIDE_IMAGES_ENABLED config when the caller didn't pass an explicit value.
  useEffect(() => {
    if (imagesEnabledProp !== undefined) {
      setImagesEnabled(imagesEnabledProp);
      return;
    }
    let cancelled = false;
    window.electronAPI
      ?.getConfig()
      .then((cfg) => {
        if (cancelled) return;
        setImagesEnabled((cfg.USER_GUIDE_IMAGES_ENABLED ?? "true") !== "false");
      })
      .catch(() => {
        if (!cancelled) setImagesEnabled(true);
      });
    return () => {
      cancelled = true;
    };
  }, [imagesEnabledProp]);

  const renderedHtml = useMemo(() => {
    if (pages.length === 0) return "";
    let html = renderMarkdown(pages[currentIndex].content, { imagesEnabled, imgBaseUrl: "app-doc://" });
    if (searchQuery.trim()) {
      const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(${escaped})`, "gi");
      // Protect Mermaid source (raw diagram text, not prose) from search highlighting.
      const mermaidBlocks: string[] = [];
      html = html.replace(/<div class="mermaid">[\s\S]*?<\/div>/g, (m) => {
        mermaidBlocks.push(m);
        return `@@MERMAIDHTML${mermaidBlocks.length - 1}@@`;
      });
      html = html.replace(re, '<mark class="guide-search-hl">$1</mark>');
      html = html.replace(/@@MERMAIDHTML(\d+)@@/g, (_, i) => mermaidBlocks[Number(i)] ?? "");
    }
    return html;
  }, [pages, currentIndex, searchQuery, imagesEnabled]);

  const goTo = useCallback((idx: number) => {
    userNavigatedRef.current = true;
    setCurrentIndex(idx);
    onIndexChangeRef.current?.(idx);
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

  // Normalize the TOC position ONLY when the document changes. `initialIndex` is
  // the parent's persisted value, which the parent echoes back after every
  // onIndexChange — so an `initialIndex` change must NOT reset the page (that was
  // making TOC/prev/next clicks snap back to page 0). A new document restores the
  // persisted index on the first content load, otherwise resets to page 0.
  useEffect(() => {
    if (pages.length === 0) return;
    if (markdown === lastDocRef.current) {
      // Same document: re-seek to the persisted index only until the user has
      // interacted (covers the persisted value arriving after the markdown loads).
      if (!userNavigatedRef.current) {
        const idx = Math.min(Math.max(initialIndex ?? 0, 0), pages.length - 1);
        setCurrentIndex(idx);
        onIndexChangeRef.current?.(idx);
      }
      return;
    }
    // New document loaded — reset tracking, then restore/clear.
    lastDocRef.current = markdown;
    userNavigatedRef.current = false;
    const idx = appliedInitialRef.current ? 0 : Math.min(Math.max(initialIndex ?? 0, 0), pages.length - 1);
    appliedInitialRef.current = true;
    setCurrentIndex(idx);
    setSearchQuery("");
    onIndexChangeRef.current?.(idx);
  }, [markdown, pages.length, initialIndex]);

  // Render any Mermaid diagrams in the current page after the HTML is injected.
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    const nodes = container.querySelectorAll<HTMLElement>(".mermaid");
    if (nodes.length === 0) return;
    nodes.forEach((n) => n.removeAttribute("data-processed"));
    mermaid
      .run({ nodes: Array.from(nodes), suppressErrors: true })
      .catch((err) => console.error("[mermaid] render failed:", err));
  }, [renderedHtml]);

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
