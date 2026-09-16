// Artis Picker (poin revisi) — ganti native <select> polos, popover custom buat pilih artis +
// akses Kelola Preset. Dipakai 2 tempat (Tab Table MainTable.tsx, Tab Reply Drawer.tsx) — satu
// komponen shared biar perilaku/tampilan konsisten, sama pola kayak QuickSendButton/
// ItemReactionBar.
//
// Toggle Mention/React (poin revisi lanjutan) — TIDAK lagi di sini. Mode itu sekarang GLOBAL per
// artis (disimpen di artist_presets.mode), diatur SEKALI di modal Kelola Preset Artis — bukan
// per-item/per-row lagi. Picker ini murni buat pilih SIAPA yang di-assign.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, Settings } from "lucide-react";
import type { ProjectItem, SlackUser } from "../global";

export default function ArtistPicker({
  item,
  users,
  onArtistChange,
  onManagePresets,
  onOpenChange,
}: {
  item: ProjectItem;
  users: SlackUser[];
  onArtistChange: (item: ProjectItem, artistId: string) => void;
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
          <button
            className="btn"
            style={{ width: "100%", justifyContent: "center", fontSize: 11, marginTop: 4, padding: "4px 0", borderTop: "1px solid var(--border)", borderRadius: 0 }}
            onClick={() => { setOpen(false); onManagePresets(); }}
          >
            <Settings size={11} /> Kelola preset artis...
          </button>
        </div>
      )}
    </div>
  );
}
