// Artis Picker (poin revisi) — ganti native <select> polos, popover custom buat pilih artis +
// akses Kelola Preset. Dipakai 2 tempat (Tab Table MainTable.tsx, Tab Reply Drawer.tsx) — satu
// komponen shared biar perilaku/tampilan konsisten, sama pola kayak QuickSendButton/
// ItemReactionBar.
//
// Toggle Mention/React (poin revisi lanjutan) — TIDAK lagi di sini. Mode itu sekarang GLOBAL per
// artis (disimpen di artist_presets.mode), diatur SEKALI di modal Kelola Preset Artis — bukan
// per-item/per-row lagi. Picker ini murni buat pilih SIAPA yang di-assign.
//
// Multi-artist (poin revisi terbaru) — sekarang MULTI-SELECT: klik nama di dropdown = toggle
// add/remove (dropdown TETAP kebuka abis klik, beda dari single-select lama yang auto-tutup),
// artis terpilih tampil sebagai chip (+ tombol X) di trigger-nya sendiri, bukan teks 1 nama lagi.
//
// Poin revisi (diminta user) — tiap baris/chip sekarang nampilin icon react/emoji preset artis
// itu (kalau ada), sama pola kayak StatusDropdown — biar keliatan langsung emoji apa yang bakal
// dikirim buat artis itu, gak perlu buka Kelola Preset Artis dulu.
import { useEffect, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import type { ArtistPreset, ProjectItem, SlackUser } from "../global";
import { useFileBlobUrl } from "../lib/fileUrl";

function ArtistEmoji({ preset }: { preset: ArtistPreset | undefined }) {
  const url = useFileBlobUrl(preset?.image_path || null);
  if (url) return <img src={url} alt="" style={{ width: 13, height: 13, objectFit: "contain", flexShrink: 0 }} />;
  if (preset?.unicode_value) return <span style={{ flexShrink: 0, lineHeight: 1, fontSize: 12 }}>{preset.unicode_value}</span>;
  return null;
}

export default function ArtistPicker({
  item,
  users,
  artistPresets,
  onAddArtist,
  onRemoveArtist,
  onOpenChange,
}: {
  item: ProjectItem;
  users: SlackUser[];
  /** Poin revisi — buat nampilin icon react/emoji preset tiap artis di chip & list dropdown. */
  artistPresets: ArtistPreset[];
  onAddArtist: (item: ProjectItem, artistId: string, artistName: string | null) => void;
  onRemoveArtist: (item: ProjectItem, artistId: string) => void;
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

  const assignedIds = new Set(item.artists.map((a) => a.artist_id));
  const presetByMember = new Map(artistPresets.map((p) => [p.member_id, p]));

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <div
        onClick={() => setOpen((v) => !v)}
        style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 3, minHeight: 24, padding: "2px 4px", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer" }}
      >
        {item.artists.length === 0 && <span className="muted" style={{ fontSize: 12, padding: "0 2px" }}>Belum ditugaskan</span>}
        {item.artists.map((a) => {
          const name = users.find((u) => u.id === a.artist_id)?.name || a.artist_name || a.artist_id;
          return (
            <span key={a.artist_id} className="badge" style={{ fontSize: 11, gap: 3, paddingRight: 3 }}>
              <ArtistEmoji preset={presetByMember.get(a.artist_id)} />
              {name}
              <button
                title="Lepas artis ini"
                onClick={(e) => { e.stopPropagation(); onRemoveArtist(item, a.artist_id); }}
                style={{ border: "none", background: "none", padding: 0, display: "flex", cursor: "pointer", color: "inherit" }}
              >
                <X size={10} />
              </button>
            </span>
          );
        })}
        <ChevronDown size={11} className="muted" style={{ marginLeft: "auto", flexShrink: 0 }} />
      </div>
      {open && (
        <div className="card" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: 200, zIndex: 30, padding: 4 }} onMouseDown={(e) => e.stopPropagation()}>
          <div style={{ maxHeight: 220, overflow: "auto" }} className="scrollbar-thin">
            {users.map((u) => {
              const checked = assignedIds.has(u.id);
              return (
                <button
                  key={u.id}
                  className="btn"
                  style={{ width: "100%", justifyContent: "space-between", border: "none", fontSize: 12, ...(checked ? { color: "var(--accent)" } : {}) }}
                  onClick={() => (checked ? onRemoveArtist(item, u.id) : onAddArtist(item, u.id, u.name))}
                >
                  <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
                    <ArtistEmoji preset={presetByMember.get(u.id)} />
                    {u.name}
                  </span>
                  {checked && <span aria-hidden>✓</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
