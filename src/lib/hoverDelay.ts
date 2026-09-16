// Audit (poin revisi): overlay Instant Intake/Add React/Reaction instan SEHARUSNYA nunggu N detik
// diam di section sebelum muncul (kayak tooltip), tapi pola CSS lama (transition-delay di rule
// `:hover`) gak kerasa delay-nya sama sekali di real-world testing — dicoba naik sampai 4 detik
// pun user bilang "keliatan sama aja, langsung muncul". Root cause paling mungkin: transition-delay
// yang di-declare di rule `:hover` doang (bukan di rule dasar) itu SECARA TEORI kerja (dipakai luas
// sebagai trik CSS), tapi rawan diganggu re-render React yang bikin elemen ke-remount pas lagi
// hover (transition gak jalan buat elemen yang BARU di-insert, browser langsung render state akhir
// tanpa animasi) — sulit dipastikan tanpa browser devtools langsung. Daripada nebak-nebak CSS
// engine lebih jauh, ganti ke timer JS yang DETERMINISTIK: className `.hover-ready` ditambah
// manual lewat setTimeout pas mouseenter, dicabut LANGSUNG pas mouseleave. CSS-nya tinggal gate ke
// class ini (bukan `:hover` lagi), gak ada lagi transition-delay yang bisa "gak kerasa".
//
// UPGRADE (poin revisi, bug dilaporkan: "overlay muncul dan tidak terkontrol", nongol nyangkut
// di baris random) — versi sebelumnya nyimpen `timer` di closure lokal punya `hoverDelayHandlers()`
// itu sendiri, yang dipanggil ULANG tiap render (tabel ini re-render SERING: reactionTick,
// editingCell, dll). Kalau mouseenter mulai timer di closure render-A, lalu re-render kejadian
// SEBELUM timer itu selesai, td-nya kepasang handler BARU dari closure render-B (timer lokalnya
// `null`, gak tau soal timer punya render-A). Timer punya render-A TETAP jalan (elemen DOM-nya
// masih sama), nambahin class telat walau mouse udah pindah — dan handler onMouseLeave yang AKTIF
// sekarang (dari render-B) gak punya referensi buat nyabut timer render-A, jadi class NYANGKUT
// permanen sampai baris itu di-hover+leave lagi. Fix: simpen timer di ELEMEN DOM-nya sendiri
// (bukan closure JS), jadi handler mana pun yang lagi aktif (dari render manapun) baca/tulis ke
// tempat yang SAMA — gak ada lagi "timer orphan" yang gak kejangkau.
export function hoverDelayHandlers(delayMs = 500, onLeave?: () => void) {
  return {
    onMouseEnter: (e: React.MouseEvent<HTMLElement & { _hoverTimer?: ReturnType<typeof setTimeout> }>) => {
      const el = e.currentTarget;
      if (el._hoverTimer) clearTimeout(el._hoverTimer);
      el._hoverTimer = setTimeout(() => el.classList.add("hover-ready"), delayMs);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement & { _hoverTimer?: ReturnType<typeof setTimeout> }>) => {
      const el = e.currentTarget;
      if (el._hoverTimer) { clearTimeout(el._hoverTimer); el._hoverTimer = undefined; }
      el.classList.remove("hover-ready");
      onLeave?.();
    },
  };
}
