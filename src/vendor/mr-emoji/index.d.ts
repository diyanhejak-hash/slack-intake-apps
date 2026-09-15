// Source mentah mr-emoji (lihat komentar di Drawer.tsx) gak punya type declaration sendiri —
// shim minimal, cuma bagian yang dipakai (Picker + shape object emoji di onClick).
import type { ComponentType } from "react";

export interface MrEmojiPicked {
  native: string;
  colons: string;
  id: string;
  name: string;
}

export interface MrEmojiPickerProps {
  onClick?: (emoji: MrEmojiPicked, event: MouseEvent) => void;
  native?: boolean;
  title?: string;
  emoji?: string;
  perLine?: number;
  style?: React.CSSProperties;
}

export const Picker: ComponentType<MrEmojiPickerProps>;
