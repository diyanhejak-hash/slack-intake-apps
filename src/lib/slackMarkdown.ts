// Transformer Lexical <-> Slack mrkdwn (poin H1 rancangan) — BUKAN CommonMark standar bawaan
// @lexical/markdown (default-nya `**bold**`/`_italic_`/`[label](url)`), Slack pakai syntax
// sendiri: `*bold*` (bintang tunggal), `_italic_` (sama persis default), `<url|label>` buat
// link, `- ` buat bullet. Cuma 4 transformer ini yang dipakai — sengaja gak include
// heading/quote/code/table/ordered-list/checklist dari library, gak ada di toolbar kita.
import { $isLinkNode, $createLinkNode, LinkNode } from "@lexical/link";
import { ITALIC_UNDERSCORE, ORDERED_LIST, UNORDERED_LIST, type Transformer } from "@lexical/markdown";
import { $createTextNode, type TextNode } from "lexical";
import { $createEmojiImageNode, $isEmojiImageNode, EmojiImageNode } from "./EmojiImageNode";
import { getCustomEmojiImagePath } from "./emojiPresetStore";

const SLACK_BOLD: Transformer = { format: ["bold"], tag: "*", type: "text-format" };

// Link Slack `<url|label>` — regex kustom, bukan reuse LINK bawaan (itu buat `[label](url)`
// standar Markdown lengkap dengan title/escaping yang gak relevan buat syntax Slack yang jauh
// lebih sederhana).
const SLACK_LINK: Transformer = {
  dependencies: [LinkNode],
  export: (node, exportChildren) => {
    if (!$isLinkNode(node)) return null;
    return `<${node.getURL()}|${exportChildren(node)}>`;
  },
  importRegExp: /<([^|<>]+)\|([^<>]+)>/,
  regExp: /<([^|<>]+)\|([^<>]+)>$/,
  replace: (textNode: TextNode, match: string[]) => {
    const [, url, label] = match;
    const linkNode = $createLinkNode(url);
    linkNode.append($createTextNode(label));
    textNode.replace(linkNode);
  },
  trigger: ">",
  type: "text-match",
};

// Custom emoji (poin revisi: "yang terlihat di software kita adalah PNG-nya, yang dikirim adalah
// kode nama :nama:") — ":nama:" di-convert jadi EmojiImageNode (gambar inline) pas ke-parse
// (loading isi tersimpan ATAU diketik manual char-per-char), tapi export balik ke teks ":nama:"
// polos — isi tersimpan/terkirim ke Slack TETAP string biasa, gak pernah nyimpen path gambar.
// `getCustomEmojiImagePath` cek dulu apa "nama" ini beneran preset custom KITA — kalau bukan
// (atau cache preset belum kemuat), dibiarin jadi teks polos, BUKAN dipaksa jadi node/error.
const EMOJI_IMAGE: Transformer = {
  dependencies: [EmojiImageNode],
  export: (node) => {
    if (!$isEmojiImageNode(node)) return null;
    return `:${node.getName()}:`;
  },
  importRegExp: /:([a-z0-9_+-]+):/,
  regExp: /:([a-z0-9_+-]+):$/,
  replace: (textNode: TextNode, match: string[]) => {
    const [, name] = match;
    if (!getCustomEmojiImagePath(name)) return;
    textNode.replace($createEmojiImageNode(name));
  },
  trigger: ":",
  type: "text-match",
};

// ORDERED_LIST ditambah (poin "list bernomor" revisi UI) — Slack render "1. item" sama persis
// kayak Markdown standar, jadi reuse transformer bawaan @lexical/markdown, gak perlu custom.
// Dipakai buat convert full (load isi tersimpan <-> markdown pas save) — list tetap kebaca/kesave
// bener meskipun shortcut LIVE-nya (di bawah) dimatiin.
export const SLACK_TRANSFORMERS: Transformer[] = [UNORDERED_LIST, ORDERED_LIST, SLACK_BOLD, ITALIC_UNDERSCORE, SLACK_LINK, EMOJI_IMAGE];

// Poin revisi: matiin auto-format LIVE pas ngetik "- "/"1. " jadi bullet/numbered list (ganggu,
// gak diinginkan) — tapi list yang UDAH ada (dari markdown tersimpan, atau dibikin manual lewat
// tombol toolbar List/ListOrdered) tetap harus kebaca/render/tersave bener, makanya UNORDERED_LIST
// & ORDERED_LIST TETAP ada di SLACK_TRANSFORMERS di atas, cuma DIKELUARIN dari transformer yang
// dikasih ke MarkdownShortcutPlugin (live-typing shortcut).
export const LIVE_TYPING_TRANSFORMERS: Transformer[] = SLACK_TRANSFORMERS.filter((t) => t !== UNORDERED_LIST && t !== ORDERED_LIST);
