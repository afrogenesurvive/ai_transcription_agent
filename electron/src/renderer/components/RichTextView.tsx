/**
 * RichTextView — read-only renderer for rich text content.
 *
 * Prefers sanitized HTML (from a parallel `_html` field); falls back to
 * plain text when no HTML is present. Sanitized with DOMPurify so only
 * formatting tags survive before dangerouslySetInnerHTML.
 */

import React from "react";
import { sanitizeRichHtml } from "../utils/richText";

interface Props {
  html?: string | null;
  text?: string | null;
  className?: string;
}

export default function RichTextView({ html, text, className = "" }: Props) {
  const safe = html && html.trim() ? sanitizeRichHtml(html) : "";
  if (safe) {
    return <div className={className} dangerouslySetInnerHTML={{ __html: safe }} />;
  }
  return <div className={className}>{text || ""}</div>;
}
