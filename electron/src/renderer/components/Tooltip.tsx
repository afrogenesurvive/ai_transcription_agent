/**
 * Tooltip — portal-based tooltip component.
 *
 * Renders a tooltip bubble via React portal to document.body,
 * solving overflow clipping and viewport-edge bleeding that
 * CSS-only ::after pseudo-element tooltips cannot handle.
 *
 * Smart viewport detection: if the preferred position doesn't
 * have enough room, the tooltip flips to the opposite side.
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  content: string;
  position?: "top" | "bottom" | "left" | "right";
  children: React.ReactNode;
  /** Delay in ms before showing (default 300) */
  delay?: number;
  /** Max width in px (default 320) */
  maxWidth?: number;
  /** Suppress tooltip display */
  disabled?: boolean;
}

type ComputedPos = "top" | "bottom" | "left" | "right";

export default function Tooltip({ content, position = "top", children, delay = 300, maxWidth = 320, disabled = false }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const [computedPos, setComputedPos] = useState<ComputedPos>(position);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const triggerRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const portalRef = useRef<HTMLDivElement | null>(null);

  const calculatePosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const gap = 8;
    const tooltipW = Math.min(maxWidth, 320);
    const tooltipH = 32; // approximate — will be refined by actual rendering

    // Check available space for each position
    const space = {
      top: rect.top - gap,
      bottom: vh - rect.bottom - gap,
      left: rect.left - gap,
      right: vw - rect.right - gap,
    };

    // Prefer user's chosen position if enough space, otherwise flip
    let pos: ComputedPos = position;
    if (pos === "top" && space.top < tooltipH) pos = "bottom";
    else if (pos === "bottom" && space.bottom < tooltipH) pos = "top";
    else if (pos === "left" && space.left < tooltipW) pos = "right";
    else if (pos === "right" && space.right < tooltipW) pos = "left";

    // Calculate coordinates based on chosen position
    let top = 0;
    let left = 0;
    switch (pos) {
      case "top":
        top = rect.top - gap;
        left = rect.left + rect.width / 2;
        break;
      case "bottom":
        top = rect.bottom + gap;
        left = rect.left + rect.width / 2;
        break;
      case "left":
        top = rect.top + rect.height / 2;
        left = rect.left - gap;
        break;
      case "right":
        top = rect.top + rect.height / 2;
        left = rect.right + gap;
        break;
    }

    setComputedPos(pos);
    setCoords({ top, left });
  }, [position, maxWidth]);

  useEffect(() => {
    if (!visible) return;
    // Recalculate on scroll or resize while visible
    calculatePosition();
    const handle = () => calculatePosition();
    window.addEventListener("scroll", handle, true);
    window.addEventListener("resize", handle);
    return () => {
      window.removeEventListener("scroll", handle, true);
      window.removeEventListener("resize", handle);
    };
  }, [visible, calculatePosition]);

  const show = useCallback(() => {
    if (disabled || !content) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      calculatePosition();
      setVisible(true);
    }, delay);
  }, [disabled, content, delay, calculatePosition]);

  const hide = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setVisible(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <>
      <span ref={triggerRef} className="tooltip-trigger" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
        {children}
      </span>
      {visible &&
        createPortal(
          <div
            ref={portalRef}
            className={`tooltip-portal tooltip-portal--${computedPos} tooltip-portal--enter`}
            style={{ top: coords.top, left: coords.left, maxWidth }}>
            <span className="tooltip-portal__inner">{content}</span>
          </div>,
          document.body,
        )}
    </>
  );
}
