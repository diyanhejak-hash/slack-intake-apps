// Artis Picker (poin revisi) — SATUKAN pilih-artis + toggle Mention/React + akses Kelola Preset
// jadi 1 sesi (1 popover), ganti native <select> polos yang dipakai sebelumnya. Dipakai 2 tempat
// (Tab Table MainTable.tsx, Tab Reply Drawer.tsx) — satu komponen shared biar perilaku/tampilan
// konsisten, sama pola kayak QuickSendButton/ItemReactionBar.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, AtSign, SmilePlus, Settings } from "lucide-react";
import type { ProjectItem, SlackUser } from "../global";

export default function ArtistPicker({
  item,
  users,
  onArtistChange,
  onArtistModeChange,
  onManagePresets,
  onOpenChange,
}: {
  item: ProjectItem;
  users: SlackUser[];
  onArtistChange: (item: ProjectItem, artistId: string) => void;
  onArtistModeChange: (item: ProjectItem, mode: "mention" | "react" | "both" | "none") => void;
  onManagePresets: () => void;
  /** Opsional — dipanggil pas popover buka/tutup, biar caller bisa nyembunyiin overlay lain
   * (misal QuickSendButton) yang numpuk di cell yang sama, konsisten sama pola "hideButton pas
   * lagi edit" yang udah ada. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = (v: boolean | ((prev: boolean) => boolean)) => {
    setOpenState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      onOpenChange?.(next);
      return next;
    });
  };
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const current = users.find((u) => u.id === item.artist_id);
  // Mode disimpen 1 string ('mention'/'react'/'both'/'none') tapi TAMPIL sebagai 2 toggle
  // independen (poin revisi: "hanya 2 button, kalau mau keduanya tinggal aktifin keduanya").
  const mentionOn = item.artist_mode === "mention" || item.artist_mode === "both";
  const reactOn = item.artist_mode === "react" || item.artist_mode === "both";
  function toggle(which: "mention" | "react") {
    const nextMention = which === "mention" ? !mentionOn : mentionOn;
    const nextReact = which === "react" ? !reactOn : reactOn;
    const mode = nextMention && nextReact ? "both" : nextMention ? "mention" : nextReact ? "react" : "none";
    onArtistModeChange(item, mode);
  }

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        className="btn"
        onClick={() => setOpen((v) => !v)}
        style={{ width: "100%", justifyContent: "space-between", fontWeight: 400 }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{current?.name || "Belum ditugaskan"}</span>
        <ChevronDown size={12} className="muted" />
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: 200, zIndex: 30, padding: 4 }} onMouseDown={(e) => e.stopPropagation()}>
          <div style={{ maxHeight: 220, overflow: "auto" }} className="scrollbar-thin">
            <button
              className="btn"
              style={{ width: "100%", justifyContent: "flex-start", border: "none", fontSize: 12, ...(item.artist_id ? {} : { color: "var(--accent)" }) }}
              onClick={() => { onArtistChange(item, ""); setOpen(false); }}
            >
              Belum ditugaskan
            </button>
            {users.map((u) => (
              <button
                key={u.id}
                className="btn"
                style={{ width: "100%", justifyContent: "flex-start", border: "none", fontSize: 12, ...(u.id === item.artist_id ? { color: "var(--accent)" } : {}) }}
                onClick={() => { onArtistChange(item, u.id); setOpen(false); }}
              >
                {u.name}
              </button>
            ))}
          </div>
          {/* Toggle Mention/React (poin revisi) — icon doang + tooltip, BUKAN teks. Independen
              (bukan radio) — aktifin dua-duanya = mode "both". Cuma relevan kalau UDAH ada artis
              di-assign. */}
          {item.artist_id && (
            <div style={{ display: "flex", gap: 4, padding: "6px 4px 2px", borderTop: "1px solid var(--border)", marginTop: 4 }}>
              <button
                className="icon-btn"
                title={`Mention (@${current?.name || "artis"} di-post pas kirim) — ${mentionOn ? "aktif" : "nonaktif"}`}
                onClick={() => toggle("mention")}
                style={mentionOn ? { borderColor: "var(--accent)", color: "var(--accent)", background: "var(--accent-soft)" } : {}}
              >
                <AtSign size={14} />
              </button>
              <button
                className="icon-btn"
                title={`Reaction (antre code name preset, gak ada mention) — ${reactOn ? "aktif" : "nonaktif"}`}
                onClick={() => toggle("react")}
                style={reactOn ? { borderColor: "var(--accent)", color: "var(--accent)", background: "var(--accent-soft)" } : {}}
              >
                <SmilePlus size={14} />
              </button>
            </div>
          )}
          <button
            className="btn"
            style={{ width: "100%", justifyContent: "center", fontSize: 11, marginTop: 4, padding: "4px 0" }}
            onClick={() => { setOpen(false); onManagePresets(); }}
          >
            <Settings size={11} /> Kelola preset artis...
          </button>
        </div>
      )}
    </div>
  );
}
