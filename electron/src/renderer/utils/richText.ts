/**
 * Shared rich-text helpers for Tiptap-based content editing.
 *
 * Summary/analysis fields store BOTH a plain-text value (authoritative for
 * downstream consumers — semantic memory, transcript.txt, export fallback)
 * and a parallel `_html` value (the Tiptap-generated HTML, kept for rich
 * rendering in read-only views and exports).
 */
import DOMPurify from "dompurify";

/** Tags allowed through when rendering/exporting rich text. */
const RICH_ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "s",
  "u",
  "ul",
  "ol",
  "li",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "code",
  "pre",
  "a",
];
const RICH_ALLOWED_ATTRS = ["href", "target", "rel", "class", "style"];

/** Sanitize Tiptap-generated HTML before dangerouslySetInnerHTML / export. */
export function sanitizeRichHtml(html: string): string {
  if (!html) return "";
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: RICH_ALLOWED_TAGS,
    ALLOWED_ATTR: RICH_ALLOWED_ATTRS,
  });
}

/** Convert plain text (with newlines) into simple paragraph HTML for the editor. */
export function plainToHtml(text?: string | null): string {
  if (!text) return "";
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((p) => p.replace(/\n/g, "<br />"))
    .map((p) => `<p>${p}</p>`)
    .join("");
}

/** Extract plain text from HTML (block-level tags become line breaks). */
export function htmlToPlainText(html?: string | null): string {
  if (!html) return "";
  if (typeof document === "undefined") {
    return html.replace(/<[^>]*>/g, "");
  }
  const withBreaks = html
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const el = document.createElement("div");
  el.innerHTML = withBreaks;
  return (el.textContent || "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Prefer the rich HTML value for display, falling back to plain text.
 * If only plain text is available it is converted to paragraph HTML so the
 * caller can feed the result straight into a Tiptap editor.
 */
export function pickRich(html?: string | null, plain?: string | null): string {
  const h = (html || "").trim();
  if (h) return h;
  return plainToHtml(plain || "");
}

/**
 * Prefer rich HTML for a list item, falling back to its plain counterpart
 * (converted to paragraph HTML). Returns one entry per index up to the
 * longer of the two arrays; missing entries become empty strings.
 */
export function pickRichList(htmlList?: string[] | null, plainList?: string[] | null): string[] {
  const n = Math.max(htmlList?.length || 0, plainList?.length || 0);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const h = (htmlList?.[i] || "").trim();
    out.push(h ? h : plainToHtml(plainList?.[i] || ""));
  }
  return out;
}
