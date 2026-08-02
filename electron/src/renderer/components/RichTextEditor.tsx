/**
 * RichTextEditor — reusable Tiptap-based rich text editor.
 *
 * Headless (no built-in CSS) so it themes into the app's dark palette.
 * Emits both the generated HTML and a plain-text snapshot on every change,
 * so callers can keep a plain `field` (for downstream) plus a parallel
 * `field_html` (for rich rendering) without parsing or stripping tags.
 *
 * The `value` prop is treated as HTML. When a caller only has plain text it
 * should pass it through `plainToHtml` (see utils/richText.ts).
 */

import React, { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Link from "@tiptap/extension-link";
import Icon from "./Icon";

export interface RichTextEditorProps {
  /** Controlled content as HTML (see plainToHtml for plain-text input). */
  value: string;
  /** Called with (html, plainText) on every content change. */
  onChange: (html: string, text: string) => void;
  placeholder?: string;
  /** Minimum height of the editable body in px. */
  minHeight?: number;
  /** Compact mode — slim toolbar (bold/italic/strike only), smaller body. */
  compact?: boolean;
  className?: string;
  disabled?: boolean;
}

export default function RichTextEditor({
  value,
  onChange,
  placeholder,
  minHeight,
  compact = false,
  className = "",
  disabled = false,
}: RichTextEditorProps) {
  // Keep a ref to the latest onChange so the editor's onUpdate closure never
  // captures stale state.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      // StarterKit v3 bundles Link + Underline; disable Link here so we can
      // add it explicitly with our own options (avoids duplicate-name warning).
      StarterKit.configure({ link: false }),
      Placeholder.configure({ placeholder: placeholder || "Start typing…" }),
      Link.configure({ openOnClick: false, autolink: true }),
    ],
    content: value || "",
    editable: !disabled,
    immediatelyRender: false,
    onUpdate: ({ editor }) => {
      onChangeRef.current(editor.getHTML(), editor.getText());
    },
  });

  // Sync external value into the editor when it changes and the editor isn't
  // focused (avoids clobbering an in-progress edit and avoids update loops,
  // since our onChange feeds the same HTML straight back).
  useEffect(() => {
    if (!editor) return;
    if (editor.isFocused) return;
    const current = editor.getHTML();
    const next = value || "";
    if (current !== next) {
      editor.commands.setContent(next, { emitUpdate: false });
    }
  }, [value, editor]);

  if (!editor) return null;

  const btn = (name: string, active: boolean, action: () => void, title: string) => (
    <button
      type="button"
      key={name}
      className={`rte-btn${active ? " rte-btn--active" : ""}`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={action}
      title={title}
      tabIndex={-1}
      aria-label={title}
    >
      <Icon name={name} size="14" />
    </button>
  );

  const sep = (k: string) => <span key={k} className="rte-sep" />;

  const toolbarItems: React.ReactNode[] = [
    btn("format_bold", editor.isActive("bold"), () => editor.chain().focus().toggleBold().run(), "Bold"),
    btn("format_italic", editor.isActive("italic"), () => editor.chain().focus().toggleItalic().run(), "Italic"),
    btn("format_strikethrough", editor.isActive("strike"), () => editor.chain().focus().toggleStrike().run(), "Strikethrough"),
  ];

  if (!compact) {
    toolbarItems.push(
      sep("sep1"),
      btn("format_list_bulleted", editor.isActive("bulletList"), () => editor.chain().focus().toggleBulletList().run(), "Bullet list"),
      btn("format_list_numbered", editor.isActive("orderedList"), () => editor.chain().focus().toggleOrderedList().run(), "Numbered list"),
      btn("format_quote", editor.isActive("blockquote"), () => editor.chain().focus().toggleBlockquote().run(), "Blockquote"),
      sep("sep2"),
      btn("format_clear", false, () => editor.chain().focus().unsetAllMarks().clearNodes().run(), "Clear formatting"),
      sep("sep3"),
      btn("undo", false, () => editor.chain().focus().undo().run(), "Undo"),
      btn("redo", false, () => editor.chain().focus().redo().run(), "Redo"),
    );
  }

  return (
    <div
      className={`rte${compact ? " rte--compact" : ""}${disabled ? " rte--disabled" : ""} ${className}`}
      style={minHeight ? ({ "--rte-min-height": `${minHeight}px` } as React.CSSProperties) : undefined}
    >
      <div className="rte-toolbar">{toolbarItems}</div>
      <div className="rte-body">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
