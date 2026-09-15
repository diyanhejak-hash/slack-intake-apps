// Node Lexical custom (poin revisi: "yang terlihat di software kita adalah PNG-nya, yang dikirim
// adalah kode nama :nama:") — custom emoji tampil sebagai GAMBAR inline di editor, tapi
// serialize balik ke teks ":nama:" polos pas di-export ke markdown (isi tersimpan/terkirim ke
// Slack TETAP teks kode, gak pernah berubah). Transformer-nya ada di slackMarkdown.ts
// (EMOJI_IMAGE_TRANSFORMER) — import/export/live-typing SEMUA lewat 1 node ini.
import { useEffect, useState, type JSX } from "react";
import { DecoratorNode, type LexicalNode, type NodeKey, type SerializedLexicalNode, type Spread } from "lexical";
import { useFileBlobUrl } from "./fileUrl";
import { getCustomEmojiImagePath, subscribeEmojiPresets } from "./emojiPresetStore";

export type SerializedEmojiImageNode = Spread<{ name: string }, SerializedLexicalNode>;

export class EmojiImageNode extends DecoratorNode<JSX.Element> {
  __name: string;

  static getType(): string {
    return "emoji-image";
  }

  static clone(node: EmojiImageNode): EmojiImageNode {
    return new EmojiImageNode(node.__name, node.__key);
  }

  constructor(name: string, key?: NodeKey) {
    super(key);
    this.__name = name;
  }

  getName(): string {
    return this.__name;
  }

  static importJSON(serializedNode: SerializedEmojiImageNode): EmojiImageNode {
    return $createEmojiImageNode(serializedNode.name);
  }

  exportJSON(): SerializedEmojiImageNode {
    return { ...super.exportJSON(), type: "emoji-image", version: 1, name: this.__name };
  }

  createDOM(): HTMLElement {
    const span = document.createElement("span");
    span.style.display = "inline-flex";
    span.style.verticalAlign = "middle";
    return span;
  }

  updateDOM(): false {
    return false;
  }

  isInline(): true {
    return true;
  }

  decorate(): JSX.Element {
    return <EmojiImageComponent name={this.__name} />;
  }
}

function EmojiImageComponent({ name }: { name: string }) {
  // Preset bisa berubah (ditambah/dihapus lewat EmojiPresetModal) SETELAH node ini kebentuk —
  // subscribe biar node yang lagi kelihatan ikut update tanpa perlu reload/reopen field.
  const [, forceTick] = useState(0);
  useEffect(() => subscribeEmojiPresets(() => forceTick((v) => v + 1)), []);

  const imagePath = getCustomEmojiImagePath(name);
  const url = useFileBlobUrl(imagePath || null);

  if (!imagePath) {
    // Preset custom-nya udah dihapus (atau cache belum sempat kemuat) — fallback teks polos,
    // biar gak keliatan "rusak".
    return <span>:{name}:</span>;
  }
  return (
    <img
      src={url || undefined}
      alt={`:${name}:`}
      title={`:${name}:`}
      style={{ height: "1.2em", width: "1.2em", objectFit: "contain", verticalAlign: "-0.25em", display: "inline-block" }}
    />
  );
}

export function $createEmojiImageNode(name: string): EmojiImageNode {
  return new EmojiImageNode(name);
}

export function $isEmojiImageNode(node: LexicalNode | null | undefined): node is EmojiImageNode {
  return node instanceof EmojiImageNode;
}
