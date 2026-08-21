/**
 * Shared markdown utilities extracted from AboutPanel.tsx.
 *
 * Provides:
 *  - renderMarkdown()   — minimal markdown-to-HTML renderer
 *  - splitIntoPages()   — split markdown into pages by ## headings
 *  - slugify()          — generate HTML-safe id from text
 */

/** Slugify a string for use as an HTML element id. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Minimal markdown-to-HTML renderer.
 *
 * Supports: headings (# through ####), paragraphs, lists, tables,
 * code blocks, inline code, bold, links, blockquotes, horizontal rules,
 * and line breaks.
 *
 * Heading IDs are slugified so TOC links and internal anchors work.
 */
export function renderMarkdown(md: string, opts?: { imagesEnabled?: boolean; imgBaseUrl?: string }): string {
  const imagesEnabled = opts?.imagesEnabled !== false;

  // Resolve a (possibly relative) image src to an absolute URL. The in-app
  // guides use app-doc:// so bundled docs/screenshots can be loaded; plain
  // http(s)/data/file/… srcs are left untouched.
  const resolveSrc = (src: string): string => {
    if (!opts?.imgBaseUrl) return src;
    if (/^(https?:|data:|file:|app-doc:|blob:|about:)/i.test(src)) return src;
    return opts.imgBaseUrl + src;
  };

  // Protect image content so the HTML escaping below can't mangle it. Covers:
  //   - Whole <p ...>...</p> blocks containing an <img> (the centered figure +
  //     caption pattern used in end_user_guide.md)
  //   - Standalone <img ... /> tags
  //   - Markdown image syntax: ![alt](url)
  // When images are disabled the placeholders become empty, so the whole figure
  // (image + caption) is omitted from the rendered output.
  const protectedBlocks: string[] = [];
  let html = md;

  html = html.replace(/<p\b[^>]*>[\s\S]*?<img\b[^>]*>[\s\S]*?<\/p>/gi, (block) => {
    if (!imagesEnabled) return "";
    protectedBlocks.push(block.replace(/\bsrc="([^"]*)"/gi, (m, s) => `src="${resolveSrc(s)}"`));
    return `\n@@UGIMG${protectedBlocks.length - 1}@@\n`;
  });
  html = html.replace(/<img\b[^>]*\/?>/gi, (tag) => {
    if (!imagesEnabled) return "";
    protectedBlocks.push(tag.replace(/\bsrc="([^"]*)"/gi, (m, s) => `src="${resolveSrc(s)}"`));
    return `@@UGIMG${protectedBlocks.length - 1}@@`;
  });
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => {
    if (!imagesEnabled) return "";
    protectedBlocks.push(`<img src="${resolveSrc(src)}" alt="${alt}" />`);
    return `@@UGIMG${protectedBlocks.length - 1}@@`;
  });

  // Escape HTML entities first
  html = html.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Horizontal rules
  html = html.replace(/^---+/gm, "<hr />");

  // Blockquotes
  html = html.replace(/^&gt;\s?(.*)$/gm, "<blockquote>$1</blockquote>");

  // Code blocks (fenced). Mermaid fences render as an in-app diagram container;
  // the caller runs mermaid.run() on the .mermaid nodes after injecting the HTML.
  html = html.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    if (lang.toLowerCase() === "mermaid") {
      // `code` is already HTML-escaped by the top-level escape pass; embedding it
      // as-is yields a text node whose textContent is the raw mermaid source.
      return `<div class="mermaid">${code.trim()}</div>`;
    }
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
      return `<a href="#${slugify(url.slice(1))}" class="guide-anchor">${text}</a>`;
    }
    // Relative/local file links that are NOT markdown docs (e.g.
    // `../../electron/src/main/license.ts#L108`) are editor navigation in VS
    // Code's markdown preview but are not navigable in-app. Render them as
    // inert inline code so the Guide tab shows them as code references instead
    // of attempting broken external navigation. Doc-to-doc links (*.md) and
    // absolute paths / URL schemes (http/https/mailto/data/…) stay real links.
    if (!/^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(url) && !url.startsWith("/")) {
      if (!/\.md$/i.test(url.split("#")[0])) {
        // The label's inline-code backticks were already rendered to
        // <code>…</code> by the inline-code pass; unwrap so we don't nest.
        const codeText = text
          .replace(/^<code>(.*)<\/code>$/, "$1")
          .replace(/^`(.*)`$/, "$1");
        return `<code>${codeText}</code>`;
      }
      return `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
    }
    return `<a href="${url}" target="_blank" rel="noopener">${text}</a>`;
  });

  // Tables
  html = html.replace(/^\|(.+)\|$/gm, (line) => {
    const cells = line
      .slice(1, -1)
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^[-]+$/.test(c))) {
      return `<tr class="table-sep"><td colspan="${cells.length}"></td></tr>`;
    }
    const tag = line.includes("<hr") ? "" : "td";
    return `<tr>${cells.map((c) => `<${tag}>${c}</${tag}>`).join("")}</tr>`;
  });
  html = html.replace(/((?:<tr>.*?<\/tr>\n?)+)/g, "<table>$1</table>");
  html = html.replace(/<table>\s*<\/table>/g, "");

  // Headings
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

  // Lists — handled in a single pass with distinct markers so unordered and
  // ordered lists never re-wrap each other (previously nested <ul>/<ol>).
  {
    const lines = html.split("\n");
    const out: string[] = [];
    let listType: "ul" | "ol" | null = null;
    for (const line of lines) {
      const ulMatch = line.match(/^-\s+(.*)$/);
      const olMatch = line.match(/^\d+\.\s+(.*)$/);
      if (ulMatch || olMatch) {
        const type = ulMatch ? "ul" : "ol";
        const text = ulMatch ? ulMatch[1] : (olMatch as RegExpMatchArray)[1];
        if (listType !== type) {
          if (listType) out.push(`</${listType}>`);
          out.push(`<${type}>`);
          listType = type;
        }
        out.push(`<li>${text}</li>`);
      } else {
        if (listType) {
          out.push(`</${listType}>`);
          listType = null;
        }
        out.push(line);
      }
    }
    if (listType) out.push(`</${listType}>`);
    html = out.join("\n");
  }

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
    if (
      /^<\/?(h[1-4]|ul|ol|li|table|tr|td|th|pre|code|blockquote|hr|div)/.test(trimmed) ||
      trimmed.startsWith("@@UGIMG") ||
      trimmed.startsWith("---")
    ) {
      wrapped.push(trimmed);
      inBlock = trimmed.startsWith("<pre") || trimmed.startsWith("<table") || trimmed.startsWith("<blockquote");
      continue;
    }
    if (inBlock) {
      wrapped.push(trimmed);
      if (trimmed.match(/<\/(pre|table|blockquote)>/)) inBlock = false;
      continue;
    }
    wrapped.push(`<p>${trimmed}</p>`);
  }
  html = wrapped.join("\n");

  // Restore protected image blocks last (raw HTML, already safe)
  html = html.replace(/@@UGIMG(\d+)@@/g, (_, i) => protectedBlocks[Number(i)] ?? "");

  return html;
}

/** Split markdown into pages, one per ## heading, skipping the TOC section.
 *
 * Content before the first ## heading is captured as its own page so that
 * intro paragraphs, H1 titles, and other preamble content are not lost.
 * The 📖 TOC heading (used by end_user_guide.md) is skipped entirely. */
export function splitIntoPages(md: string): Array<{ id: string; title: string; content: string }> {
  const lines = md.split("\n");
  const pages: Array<{ id: string; title: string; content: string }> = [];
  let current: { id: string; title: string; content: string[] } | null = null;
  let pastToc = false;

  // Collect preamble lines (before the first ## heading) so they aren't lost
  const preamble: string[] = [];
  let foundFirstHeading = false;

  for (const line of lines) {
    const match = line.match(/^##\s+(.+)/);
    if (match) {
      const title = match[1].trim();
      if (title.startsWith("📖")) {
        pastToc = true;
        continue;
      }
      // Flush preamble as the first page before creating this one
      if (!foundFirstHeading && preamble.length > 0) {
        foundFirstHeading = true;
        const h1Match = preamble.find((l) => /^#\s/.test(l));
        const pageTitle = h1Match ? h1Match.replace(/^#\s+/, "") : "Introduction";
        const content = preamble.join("\n");
        pages.push({ id: slugify(pageTitle), title: pageTitle, content });
      }

      if (current) {
        pages.push({ id: current.id, title: current.title, content: current.content.join("\n") });
      }
      current = { id: slugify(title), title, content: [`# ${title}`] };
      pastToc = true;
    } else if (!foundFirstHeading && !pastToc) {
      preamble.push(line);
    } else if (current && pastToc) {
      current.content.push(line);
    }
  }

  // Handle docs with no ## headings at all — all content is preamble
  if (!foundFirstHeading && preamble.length > 0) {
    const pageTitle = "Document";
    const content = preamble.join("\n");
    pages.push({ id: slugify(pageTitle), title: pageTitle, content });
  }

  // Push the last section
  if (current) {
    pages.push({ id: current.id, title: current.title, content: current.content.join("\n") });
  }
  return pages;
}
