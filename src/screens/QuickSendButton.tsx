// "Instant Intake" — overlay tombol kirim langsung (poin revisi), dipakai di Tab Table (kolom
// Item/Artis/Reply, MainTable.tsx) DAN Tab Reply (tiap Field, Drawer.tsx/ReplyRow). Satu komponen
// shared biar tampilan/perilakunya konsisten di 2 tempat:
//   - Posisi KIRI, digantung di pojok kiri-ATAS cell (nongol keluar dari batas cell, pola sama
//     kayak badge-X AttachedThumb/CapturePoolStrip) — BUKAN ditengah-cell numpuk di atas teks
//     Item (poin revisi: "overlay menghalangi Item").
//   - Lingkaran SOLID hijau (`var(--success)`, referensi gambar dikasih user — ikon kirim ala
//     WhatsApp/Telegram, bulat, hijau, icon pesawat putih) + ring tipis warna surface buat
//     pemisah dari background di belakangnya (pola sama kayak badge-X merah AttachedThumb/
//     CapturePoolStrip) + shadow tipis biar ada depth, bukan rata nempel. Scale-up dikit pas
//     di-hover (`.quicksend-btn:hover`, styles.css). TETAP bulat sempurna (borderRadius 50%),
//     bukan rounded-square kayak di gambar referensi.
//   - Cuma nongol pas CELL/row spesifik di-hover (CSS `.row-quicksend`, lihat styles.css)
//     — bukan tombol lain di sekitarnya — dengan delay 4s sebelum muncul (transition-delay CSS,
//     biar gak "kedip" tiap gerak mouse numpang lewat).
//   - Klik = LANGSUNG kirim (gak ada modal preview/channel-picker lagi) — makanya `onClick` di
//     komponen ini WAJIB async dan pemanggilnya yang nanganin loading/error state-nya sendiri.
import { useState } from "react";
import { SendHorizontal, Loader2, Check } from "lucide-react";

// Gak ada modal lagi buat instant-send, jadi feedback loading/sukses/gagal-nya HARUS dari tombol
// ini sendiri (icon Loader2 muter pas ngirim, Check sekejap kalau sukses, alert() kalau gagal —
// pola error sama kayak tempat lain di app ini).
//
// `variant`:
//   - "overlay" (default, Tab Table) — absolute di pojok kiri cell, `.row-quicksend` (delay 4s
//     lewat CSS `td:hover`, lihat styles.css).
//   - "inline" (Tab Reply, ReplyRow) — flow normal sejajar checkbox/broadcast/trash di
//     `.reply-actions`, reveal-nya ikut mekanisme hover `.reply-actions` yang udah ada (gak perlu
//     delay terpisah, biar konsisten sama ikon lain di baris yang sama).
export default function QuickSendButton({ onClick, title, variant = "overlay" }: { onClick: () => Promise<unknown>; title: string; variant?: "overlay" | "inline" }) {
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");

  async function handleClick() {
    if (state === "sending") return;
    setState("sending");
    try {
      await onClick();
      setState("done");
      setTimeout(() => setState("idle"), 1200);
    } catch (err) {
      setState("idle");
      alert(err instanceof Error ? err.message : "Gagal mengirim.");
    }
  }

  return (
    <button
      className={`quicksend-btn ${variant === "overlay" ? "row-quicksend" : ""}`}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        handleClick();
      }}
      style={{
        ...(variant === "overlay" ? { position: "absolute", top: -8, left: -8, zIndex: 2 } : { flexShrink: 0 }),
        width: 22,
        height: 22,
        borderRadius: "50%",
        background: "var(--success)",
        border: "2px solid var(--surface)",
        boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        cursor: "pointer",
      }}
    >
      {state === "sending" ? (
        <Loader2 size={11} className="spin" />
      ) : state === "done" ? (
        <Check size={12} strokeWidth={3} />
      ) : (
        <SendHorizontal size={11} fill="currentColor" />
      )}
    </button>
  );
}
