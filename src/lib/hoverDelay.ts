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
// ponytail: closure per elemen (dipanggil ulang tiap render, no hooks-in-loop) — kalau re-render
// kejadian PERSIS di tengah hover (jarang), timer lama yang udah gak ke-attach ke handler baru bisa
// telat nambah class walau mouse udah pindah; efeknya PALING BURUK cuma overlay nongol sekejap
// salah waktu, bukan nyangkut permanen (mouseenter/leave berikutnya tetap benerin). Upgrade ke
// hook per-row kalau ternyata beneran ganggu.
export function hoverDelayHandlers(delayMs = 1500) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      const el = e.currentTarget;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => el.classList.add("hover-ready"), delayMs);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      if (timer) { clearTimeout(timer); timer = null; }
      e.currentTarget.classList.remove("hover-ready");
    },
  };
}
