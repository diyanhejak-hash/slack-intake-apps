// Editor WYSIWYG Lexical (poin H1 rancangan) — gantiin textarea polos + toolbar insert-syntax
// manual. Isi tersimpan/tersinkron tetap string Slack mrkdwn murni (lihat src/lib/slackMarkdown.ts
// buat transformer-nya) — komponen ini cuma lapisan tampilan, data yang keluar/masuk IPC sama
// persis kayak sebelumnya.
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { LinkPlugin } from "@lexical/react/LexicalLinkPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { $isListNode, ListItemNode, ListNode, INSERT_UNORDERED_LIST_COMMAND, INSERT_ORDERED_LIST_COMMAND } from "@lexical/list";
import { LinkNode, $createLinkNode } from "@lexical/link";
import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import { $getSelection, $isRangeSelection, $setSelection, $createTextNode, FORMAT_TEXT_COMMAND, type LexicalEditor, type RangeSelection } from "lexical";
import { SLACK_TRANSFORMERS } from "../lib/slackMarkdown";
import { $createEmojiImageNode, EmojiImageNode } from "../lib/EmojiImageNode";

export interface ActiveFormats {
  bold: boolean;
  italic: boolean;
  bulletList: boolean;
  numberList: boolean;
}

export interface RichTextEditorHandle {
  insertText: (text: string) => void;
  /** Custom emoji (poin revisi) — insert LANGSUNG sebagai EmojiImageNode (gambar inline), bukan
   * teks ":nama:" polos yang nunggu di-parse. Insert multi-karakter programatik BEDA dari ngetik
   * asli — MarkdownShortcutPlugin Lexical sengaja gak nge-trigger transform buat insert borongan
   * (cuma buat 1 karakter per ketikan), jadi butuh jalur eksplisit ini. */
  insertEmojiImage: (name: string) => void;
  /** label opsional — kalau gak dikasih, pakai teks yang lagi diseleksi (fallback ke url-nya
   * sendiri kalau gak ada seleksi), sama persis perilaku applyLink lama. */
  insertLink: (url: string, label?: string) => void;
  toggleBold: () => void;
  toggleItalic: () => void;
  insertBulletList: () => void;
  insertNumberList: () => void;
  focus: () => void;
  /** Baca isi editor saat ini sebagai string Slack mrkdwn — buat submit aktif (mis. composer
   * pas Enter), beda dari onBlurValue yang cuma jalan pas blur. */
  getMarkdown: () => string;
  /** Poin revisi: icon centang "selesai edit" di dalam field — alternatif klik-di-luar buat commit
   * perubahan. Blur DOM root-nya aja (bukan reimplement logic commit) — native onBlur yang udah
   * ada (handleBlur) yang jalanin convert+onBlurValue, sama persis kayak klik area luar. */
  commitAndBlur: () => void;
}

// Nempel LexicalEditor instance dari context (cuma bisa dibaca dari DALAM LexicalComposer) ke
// ref yang dipegang komponen luar, biar forwardRef di luar bisa implement imperative handle-nya.
function EditorCapture({ editorRef }: { editorRef: React.MutableRefObject<LexicalEditor | null> }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    editorRef.current = editor;
  }, [editor, editorRef]);
  return null;
}

// Nyimpen selection VALID TERAKHIR (poin revisi, fix bug "insert link gak kerja") — PromptModal
// (dipakai buat isi URL link) auto-focus input-nya sendiri begitu kebuka, nyolong focus dari
// contentEditable ini. $getSelection() abis itu udah gak balikin RangeSelection lagi, jadi
// insertLink yang ngandelin live selection silent no-op (gak ada error, cuma gak ke-insert).
// Fix: rekam CLONE selection tiap kali valid (update listener, pola sama kayak
// ActiveFormatsPlugin di bawah), insertLink pakai clone ini buat restore selection kalau live
// selection udah ilang pas balik dari modal.
function LastSelectionPlugin({ lastSelectionRef }: { lastSelectionRef: React.MutableRefObject<RangeSelection | null> }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) lastSelectionRef.current = selection.clone();
      });
    });
  }, [editor, lastSelectionRef]);
  return null;
}

// Highlight tombol toolbar (Bold/Italic/Bullet/Number) pas kursor lagi berada di teks yang
// formatnya aktif — port perilaku dari Command Builder JavaScript.html (updateToolbarActiveState_,
// pakai document.queryCommandState di versi execCommand mereka; di sini pakai
// selection.hasFormat()/cek ancestor ListNode, versi Lexical-nya).
function ActiveFormatsPlugin({ onChange }: { onChange?: (formats: ActiveFormats) => void }) {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    if (!onChange) return;
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) {
          onChange({ bold: false, italic: false, bulletList: false, numberList: false });
          return;
        }
        let bulletList = false;
        let numberList = false;
        let node = selection.anchor.getNode();
        while (node) {
          if ($isListNode(node)) {
            if (node.getListType() === "bullet") bulletList = true;
            if (node.getListType() === "number") numberList = true;
            break;
          }
          const parent = node.getParent();
          if (!parent) break;
          node = parent;
        }
        onChange({ bold: selection.hasFormat("bold"), italic: selection.hasFormat("italic"), bulletList, numberList });
      });
    });
  }, [editor, onChange]);
  return null;
}

const RichTextEditor = forwardRef<
  RichTextEditorHandle,
  {
    defaultValue: string;
    placeholder?: string;
    onBlurValue: (markdown: string) => void;
    onFocusEditor?: () => void;
    /** Enter (tanpa Shift) submit alih-alih baris baru — dipakai composer chat. */
    onEnterSubmit?: () => void;
    /** Dipanggil tiap seleksi/format berubah — buat highlight tombol toolbar yang lagi aktif. */
    onActiveFormatsChange?: (formats: ActiveFormats) => void;
  }
>(function RichTextEditor({ defaultValue, placeholder = "", onBlurValue, onFocusEditor, onEnterSubmit, onActiveFormatsChange }, ref) {
  const editorRef = useRef<LexicalEditor | null>(null);
  const lastSavedRef = useRef(defaultValue);
  const lastSelectionRef = useRef<RangeSelection | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      insertText(text) {
        editorRef.current?.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) selection.insertText(text);
        });
      },
      insertEmojiImage(name) {
        editorRef.current?.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) selection.insertNodes([$createEmojiImageNode(name)]);
        });
      },
      insertLink(url, label) {
        editorRef.current?.update(() => {
          let selection = $getSelection();
          // Fallback ke selection valid terakhir (poin revisi) — PromptModal nyolong focus,
          // live selection udah null/bukan RangeSelection lagi pas fungsi ini kepanggil.
          if (!$isRangeSelection(selection) && lastSelectionRef.current) {
            $setSelection(lastSelectionRef.current);
            selection = $getSelection();
          }
          if (!$isRangeSelection(selection)) return;
          const text = label || selection.getTextContent() || url;
          const linkNode = $createLinkNode(url);
          linkNode.append($createTextNode(text));
          selection.insertNodes([linkNode]);
        });
      },
      toggleBold() {
        editorRef.current?.dispatchCommand(FORMAT_TEXT_COMMAND, "bold");
      },
      toggleItalic() {
        editorRef.current?.dispatchCommand(FORMAT_TEXT_COMMAND, "italic");
      },
      insertBulletList() {
        editorRef.current?.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
      },
      insertNumberList() {
        editorRef.current?.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
      },
      focus() {
        editorRef.current?.focus();
      },
      getMarkdown() {
        const editor = editorRef.current;
        if (!editor) return lastSavedRef.current;
        let markdown = lastSavedRef.current;
        editor.getEditorState().read(() => {
          markdown = $convertToMarkdownString(SLACK_TRANSFORMERS, undefined, true);
        });
        return markdown;
      },
      commitAndBlur() {
        editorRef.current?.getRootElement()?.blur();
      },
    }),
    []
  );

  function handleBlur() {
    const editor = editorRef.current;
    if (!editor) return;
    editor.getEditorState().read(() => {
      const markdown = $convertToMarkdownString(SLACK_TRANSFORMERS, undefined, true);
      if (markdown !== lastSavedRef.current) {
        lastSavedRef.current = markdown;
        onBlurValue(markdown);
      }
    });
  }

  return (
    <LexicalComposer
      initialConfig={{
        namespace: "slack-reply-editor",
        nodes: [ListNode, ListItemNode, LinkNode, EmojiImageNode],
        onError: (error) => console.error(error),
        editorState: () => {
          $convertFromMarkdownString(defaultValue, SLACK_TRANSFORMERS, undefined, true);
        },
      }}
    >
      <EditorCapture editorRef={editorRef} />
      <LastSelectionPlugin lastSelectionRef={lastSelectionRef} />
      <div className="lexical-editor-wrap">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              className="lexical-content-editable"
              onFocus={onFocusEditor}
              onBlur={handleBlur}
              onKeyDown={(e) => {
                if (onEnterSubmit && e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  onEnterSubmit();
                }
              }}
              aria-placeholder={placeholder}
              placeholder={<div className="lexical-placeholder">{placeholder}</div>}
            />
          }
          placeholder={<div className="lexical-placeholder">{placeholder}</div>}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <HistoryPlugin />
      <ListPlugin />
      <LinkPlugin />
      {/* Auto-format LIVE pas ngetik: "- "->bullet, "1. "->numbered list, "*teks*"->bold,
          "_teks_"->italic — pakai SLACK_TRANSFORMERS yang sama dengan convert save/load, biar
          list beneran auto-jalan pas ngetik (poin revisi, dipastikan aktif). */}
      <MarkdownShortcutPlugin transformers={SLACK_TRANSFORMERS} />
      <ActiveFormatsPlugin onChange={onActiveFormatsChange} />
    </LexicalComposer>
  );
});

export default RichTextEditor;
