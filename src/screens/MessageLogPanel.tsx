import { useEffect, useState } from "react";
import { X, Trash2, RefreshCw, ShieldCheck, Loader2 } from "lucide-react";
import type { LogEntry } from "../global";

export default function MessageLogPanel({ onClose }: { onClose: () => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [testingRefresh, setTestingRefresh] = useState(false);

  function refresh() {
    window.api.log.list(200).then(setLogs);
  }

  useEffect(() => {
    refresh();
  }, []);

  // Diagnostik manual (poin revisi: "gimana tau refresh token udah aktif?") — paksa tukar
  // refresh_token SEKARANG, gak nunggu access token beneran expired (~12 jam). Hasilnya SELALU
  // ke-log juga (tryRefreshToken sendiri yang nge-log), alert ini cuma ringkasan cepat.
  async function testRefresh() {
    setTestingRefresh(true);
    try {
      const result = await window.api.auth.testRefresh();
      if (result.ok) {
        alert("Refresh token AKTIF & berhasil ditukar jadi access token baru. Cek log di bawah buat detailnya.");
      } else if (result.reason === "no_refresh_token") {
        alert("Belum ada refresh token tersimpan (login sebelum fitur ini ada, atau App Slack belum opt-in Token Rotation). Logout lalu login ulang.");
      } else {
        alert("Refresh token GAGAL ditukar. Cek log di bawah buat pesan error asli dari Slack.");
      }
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Gagal tes refresh token.");
    } finally {
      setTestingRefresh(false);
    }
  }

  return (
    <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 380, background: "var(--surface)", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", zIndex: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14, borderBottom: "1px solid var(--border)" }}>
        <h2>Message Log</h2>
        <div style={{ display: "flex", gap: 4 }}>
          <button className="icon-btn" title="Tes refresh token Slack sekarang (gak perlu nunggu expired)" onClick={testRefresh} disabled={testingRefresh}>
            {testingRefresh ? <Loader2 size={13} className="spin" /> : <ShieldCheck size={13} />}
          </button>
          <button className="icon-btn" title="Refresh" onClick={refresh}>
            <RefreshCw size={13} />
          </button>
          <button className="icon-btn" title="Hapus semua log" onClick={() => window.api.log.clear().then(refresh)}>
            <Trash2 size={13} />
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup" title="Tutup">
            <X size={15} />
          </button>
        </div>
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: 12 }} className="scrollbar-thin">
        {logs.length === 0 && (
          <div className="placeholder-box">
            <span className="caption">Belum ada log.</span>
          </div>
        )}
        {logs.map((l) => (
          <div key={l.id} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
              <span className={`badge ${l.level === "error" ? "badge-error" : "badge-success"}`}>{l.level}</span>
              <span className="caption">{new Date(l.created_at).toLocaleString("id-ID")}</span>
            </div>
            <div style={{ fontSize: 12 }}>{l.message}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
