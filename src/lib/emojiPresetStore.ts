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
// Poin revisi (bug dilaporkan: "emoji tidak show" di chip react Tab Input) — artist preset yang
// pakai emoji STANDAR (unicode_value, bukan PNG custom) gak punya image_path, jadi gak pernah
// masuk `cache` di atas -- ReactionChip (ItemReactions.tsx) jatuh ke fallback teks ":code_name:"
// polos. Cache KEDUA khusus nyimpen karakter unicode-nya, kunci SAMA (code_name), biar ReactionChip
// bisa nampilin karakter aslinya, bukan cuma teks shortcode.
let unicodeCache = new Map<string, string>();
const listeners = new Set<() => void>();

export function getCustomEmojiImagePath(name: string): string | undefined {
  return cache.get(name);
}

export function getCustomEmojiUnicode(name: string): string | undefined {
  return unicodeCache.get(name);
}

export function subscribeEmojiPresets(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Artis Preset (poin revisi) — code_name-nya dipakai jadi emoji_value reaction pending
// (item_reactions.emoji_type='custom'), jadi PNG-nya perlu ke-cache di sini JUGA biar ReactionChip
// bisa nampilin gambar (bukan cuma teks ":code_name:") — cache SATU, gabungan 2 sumber (emoji
// preset custom + artist preset), nama gak boleh bentrok (jarang, gak divalidasi silang).
export async function refreshEmojiPresetCache(): Promise<void> {
  const [emojiList, artistList] = await Promise.all([window.api.emojiPreset.list(), window.api.artistPreset.list()]);
  const nextImages = new Map(emojiList.filter((p) => p.type === "custom" && p.image_path).map((p) => [p.value, p.image_path as string]));
  const nextUnicode = new Map<string, string>();
  for (const p of artistList) {
    if (!p.code_name) continue;
    if (p.image_path) nextImages.set(p.code_name, p.image_path);
    else if (p.unicode_value) nextUnicode.set(p.code_name, p.unicode_value);
  }
  cache = nextImages;
  unicodeCache = nextUnicode;
  listeners.forEach((fn) => fn());
}
