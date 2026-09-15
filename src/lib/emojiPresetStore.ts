// Cache in-memory GLOBAL (module singleton) — nama custom emoji -> path PNG lokal. Dibutuhin
// SYNCHRONOUS sama transformer Lexical (EmojiImageNode) pas parsing/nge-render teks ":nama:",
// padahal daftar presetnya sendiri cuma bisa di-fetch ASYNC dari DB lewat IPC. Di-refresh sekali
// pas MainTable mount, dan tiap kali EmojiPresetModal nambah/hapus emoji (biar reply field yang
// lagi kebuka gak keteteran).
//
// ponytail: cache race kecil mungkin kejadian (RichTextEditor pertama kali mount SEBELUM refresh
// pertama kelar) — efeknya CUMA tampilan (":nama:" tetap teks polos, bukan gambar) sampai refresh
// jalan sekali, isi tersimpan/terkirim tetap benar selalu. Upgrade ke context/suspense kalau
// ternyata beneran ganggu.
let cache = new Map<string, string>();
const listeners = new Set<() => void>();

export function getCustomEmojiImagePath(name: string): string | undefined {
  return cache.get(name);
}

export function subscribeEmojiPresets(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function refreshEmojiPresetCache(): Promise<void> {
  const list = await window.api.emojiPreset.list();
  cache = new Map(list.filter((p) => p.type === "custom" && p.image_path).map((p) => [p.value, p.image_path as string]));
  listeners.forEach((fn) => fn());
}
