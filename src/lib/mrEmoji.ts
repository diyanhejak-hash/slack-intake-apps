// mr-emoji (github.com/Dipen-Dedania/mr-emoji) — paket npm-nya KE-PATAHIN (main gak ada di
// tarball, dist-es import babel-runtime/prop-types yang gak dideklarasiin dependency). Source
// ASLI-nya (di-download manual sama user, di-vendor ke src/vendor/mr-emoji/) gak punya masalah
// itu — babel-runtime CUMA muncul di hasil build npm pakai Babel 6 lama, source mentahnya native
// ES class biasa. `data/data.js` (dataset emoji, di-gitignore upstream) di-generate manual sekali
// lewat `scripts/build-data.js` (emoji-datasource 4.0.2 + emojilib + inflection).
//
// Lazy loader SHARED — dipakai di EmojiPresetModal.tsx (buat pilih emoji unicode masuk preset).
// CSS-nya di-dynamic-import bareng biar gak numpang beban ke bundle utama, cuma kepanggil pas
// modal preset beneran dibuka.
import { lazy } from "react";

export const MrEmojiPicker = lazy(async () => {
  await import("../vendor/mr-emoji/emoji-mart.css");
  const mod = await import("../vendor/mr-emoji");
  return { default: mod.Picker };
});
