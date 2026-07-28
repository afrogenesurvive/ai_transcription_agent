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
export function renderMarkdown(md: string): string {
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

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*?<\/li>\n?)+)/g, "<ul>$1</ul>");

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
  html = html.replace(/((?:<li>.*?<\/li>\n?)+)(?!\s*<\/?[uo]l>)/g, "<ol>$1</ol>");

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
    wrapped.push(`<p>${trimmed}</p>`);
  }
  html = wrapped.join("\n");

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
