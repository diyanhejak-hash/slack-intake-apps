// Saran install Slack Desktop (poin revisi) — SENGAJA bukan bundling/redistribusi installer
// Slack sendiri (lisensi Software Integration Supplement mereka larang redistribusi:
// "neither you nor the customer may rent, lease, lend, redistribute or sublicense the software").
// Tombol di sini cuma buka halaman download RESMI slack.com — user download langsung dari server
// Slack sendiri, kita gak pernah nyimpen/megang file installer mereka.
//
// Non-blocking (card kecil, bukan modal `aria-modal`) — murni saran, gampang di-skip, gak
// ganggu alur utama app. Muncul cuma sekali per komputer (localStorage) DAN cuma kalau Slack
// Desktop kebukti belum ke-install (cek eksistensi file, lihat main.cjs `hasSlackDesktop`).
import { useEffect, useState } from "react";
import { X, ExternalLink } from "lucide-react";

const DISMISS_KEY = "slack-desktop-suggestion-dismissed";

export default function SlackDesktopSuggestion() {
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  useEffect(() => {
    let dismissed = false;
    try {
      dismissed = localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      // localStorage bisa gak kebaca (private mode dst.) — anggap belum pernah di-dismiss.
    }
    if (dismissed) return;
    window.api.system.hasSlackDesktop().then(({ installed, downloadUrl: url }) => {
      if (!installed) setDownloadUrl(url);
    });
  }, []);

  function dismiss() {
    setDownloadUrl(null);
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // Gagal nyimpen preference gak masalah — paling nongol lagi lain kali buka app.
    }
  }

  function install() {
    if (downloadUrl) window.api.shell.openExternal(downloadUrl);
    dismiss();
  }

  if (!downloadUrl) return null;

  return (
    <div
      className="card"
      style={{
        position: "fixed",
        right: 16,
        bottom: 16,
        width: 300,
        padding: 12,
        background: "var(--surface)",
        boxShadow: "0 4px 16px rgba(0,0,0,0.2)",
        zIndex: 90,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
        <div style={{ fontWeight: 600, fontSize: 13 }}>Install Slack Desktop</div>
        <button className="icon-btn" title="Lewati" onClick={dismiss} style={{ flexShrink: 0 }}>
          <X size={13} />
        </button>
      </div>
      <p className="caption" style={{ marginBottom: 10 }}>
        Buka pesan langsung di app Slack (bukan browser) buat pengalaman lebih lancar. Opsional — bisa dilewati kapan pun.
      </p>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn btn-primary" onClick={install} style={{ flex: 1 }}>
          <ExternalLink size={13} /> Install Slack
        </button>
        <button className="btn" onClick={dismiss}>
          Lewati
        </button>
      </div>
    </div>
  );
}
