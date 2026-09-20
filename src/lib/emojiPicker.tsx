// Picker emoji standar (poin revisi — ganti "mr-emoji" yang di-vendor manual, keluhan user: paket
// npm-nya patah + dataset emoji-datasource 4.0.2 udah ketinggalan zaman, ada emoji yang ADA di
// Slack tapi GAK ADA di situ). Diganti `emoji-mart` ASLI (github.com/missive/emoji-mart, resmi
// diinstall lewat npm, gak perlu vendor manual lagi) — dataset-nya (`@emoji-mart/data`) ikut versi
// terbaru paket ini, jauh lebih lengkap. Render-nya Web Component shadow-DOM (`<em-emoji-picker>`),
// jadi CSS-nya OTOMATIS terisolasi — gak perlu import stylesheet terpisah kayak dulu.
//
// Lazy loader SHARED — dipakai EmojiPresetModal.tsx (nambah preset emoji unicode) DAN
// EmojiPicker.tsx (tombol "+" Semua Emoji di picker gabungan). Data (~430KB) + komponennya
// di-dynamic-import bareng, cuma kepanggil pas picker beneran dibuka, gak numpang beban ke bundle
// utama.
import { lazy } from "react";

export interface PickedEmoji {
  native: string;
  /** Format ":nama_emoji:" (SUDAH pakai titik dua) — konsisten sama pola shortcode lain di app
   * ini (caller tinggal .replace(/^:|:$/g, "") kalau butuh versi tanpa titik dua). */
  colons: string;
}

// `set="native"` (default emoji-mart) — render karakter Unicode langsung, BUKAN gambar/spritesheet
// dari CDN mana pun (sesuai CSP app ini, gak ada domain gambar tambahan yang perlu diizinin).
// previewPosition/skinTonePosition "none" — poin revisi keluhan "tampilannya besar": preview bar
// bawah bikin widget makan tempat lebih tinggi dari perlu buat kasus pakai kita (pilih SEKALI,
// bukan chat), dan skin-tone kalau kepilih bikin shortcode-nya numpuk jadi ":nama::skin-tone-3:"
// yang berantakan abis di-strip karakter non-alfanumerik pas disimpan jadi code_name.
export const LazyEmojiPicker = lazy(async () => {
  const [{ default: data }, { default: Picker }] = await Promise.all([
    import("@emoji-mart/data"),
    import("@emoji-mart/react"),
  ]);
  function BoundEmojiPicker({ onPick }: { onPick: (emoji: PickedEmoji) => void }) {
    return (
      <Picker
        data={data}
        onEmojiSelect={(e: { native: string; id: string }) => onPick({ native: e.native, colons: `:${e.id}:` })}
        perLine={8}
        emojiButtonSize={32}
        emojiSize={20}
        previewPosition="none"
        skinTonePosition="none"
        theme="auto"
      />
    );
  }
  return { default: BoundEmojiPicker };
});
