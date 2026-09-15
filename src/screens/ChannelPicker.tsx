import { useEffect, useRef, useState } from "react";
import { Hash, Lock, ChevronDown, Search } from "lucide-react";
import type { SlackChannel } from "../global";

// List channel bergaya Slack asli (icon gembok buat private, cari-cepat) — gantiin <select>
// polos yang gak bisa nampilin icon per baris.
export default function ChannelPicker({
  channels,
  value,
  onChange,
  loading,
}: {
  channels: SlackChannel[];
  value: string;
  onChange: (channel: SlackChannel) => void;
  loading?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const selected = channels.find((c) => c.id === value);
  const filtered = channels.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  if (loading) return <span className="caption">Memuat daftar channel…</span>;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button className="btn" style={{ width: "100%", justifyContent: "space-between" }} onClick={() => setOpen((v) => !v)}>
        <span style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected?.isPrivate ? <Lock size={12} /> : <Hash size={12} />}
          {selected?.name || "Pilih channel…"}
        </span>
        <ChevronDown size={13} className="muted" />
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", top: 34, left: 0, right: 0, zIndex: 40, padding: 6, maxHeight: 280, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 6px", borderBottom: "1px solid var(--border)", marginBottom: 4 }}>
            <Search size={12} className="muted" />
            <input
              autoFocus
              placeholder="Cari channel…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              style={{ border: "none", padding: "4px 0", width: "100%" }}
            />
          </div>
          <div style={{ overflow: "auto" }} className="scrollbar-thin">
            {filtered.length === 0 && <div className="caption" style={{ padding: "6px 8px" }}>Gak ketemu.</div>}
            {filtered.map((c) => (
              <button
                key={c.id}
                className="btn"
                style={{ width: "100%", justifyContent: "flex-start", border: "none", padding: "6px 8px", ...(c.id === value ? { background: "var(--accent-soft)", color: "var(--accent)" } : {}) }}
                onClick={() => {
                  onChange(c);
                  setOpen(false);
                  setQuery("");
                }}
              >
                {c.isPrivate ? <Lock size={12} /> : <Hash size={12} />}
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
