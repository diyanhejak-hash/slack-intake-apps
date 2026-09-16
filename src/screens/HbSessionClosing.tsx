import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

// Papan status HB Apps (poin revisi) — overlay full-screen pas app mau ditutup DAN sesi ini
// online (user klik "Mulai Sesi" sebelumnya). main.cjs nahan window close-nya, kirim event ini,
// proses kirim pesan ":yawning_face: Offline" jalan di balik layar (timeout 5 detik jaga-jaga),
// baru window bener-bener ditutup — overlay ini CUMA buat kasih tau user "lagi proses", app-nya
// emang bakal ketutup sendiri abis itu (gak ada tombol apa pun di sini, sengaja).
export default function HbSessionClosing() {
  const [closing, setClosing] = useState(false);

  useEffect(() => window.api.hbStatus.onClosing(() => setClosing(true)), []);

  if (!closing) return null;
  return (
    <div
      role="alert"
      style={{
        position: "fixed", inset: 0, background: "var(--surface)", zIndex: 100,
        display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10,
      }}
    >
      <Loader2 size={22} className="spin" />
      <span className="caption">Menutup sesi…</span>
    </div>
  );
}
