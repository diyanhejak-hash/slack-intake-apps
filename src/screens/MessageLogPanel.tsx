import { useEffect, useState } from "react";
import { X, Trash2, RefreshCw } from "lucide-react";
import type { LogEntry } from "../global";

export default function MessageLogPanel({ onClose }: { onClose: () => void }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);

  function refresh() {
    window.api.log.list(200).then(setLogs);
  }

  useEffect(() => {
    refresh();
  }, []);

  return (
    <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: 380, background: "var(--surface)", borderLeft: "1px solid var(--border)", display: "flex", flexDirection: "column", zIndex: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 14, borderBottom: "1px solid var(--border)" }}>
        <h2>Message Log</h2>
        <div style={{ display: "flex", gap: 4 }}>
          <button className="icon-btn" title="Refresh" onClick={refresh}>
            <RefreshCw size={13} />
          </button>
          <button className="icon-btn" title="Hapus semua log" onClick={() => window.api.log.clear().then(refresh)}>
            <Trash2 size={13} />
          </button>
          <button className="icon-btn" onClick={onClose}>
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
