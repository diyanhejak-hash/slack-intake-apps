// Dropdown "Status" per item (poin revisi) — single-select, beda dari ArtistPicker (multi-select)
// soalnya cuma boleh 1 status aktif per item. Dipakai 2 tempat (Tab Table MainTable.tsx, Tab
// Reply Drawer.tsx). Sinkron ke Slack (realtime/react) sepenuhnya ditangani backend (item:setStatus).
//
// Poin revisi (diminta user: "show emoji di tiap dropdown status") — native <select>/<option>
// GAK BISA nampilin <img> sama sekali (batasan HTML standar, bukan CSS), jadi diganti popover
// custom (pola sama kayak ArtistPicker) biar bisa nampilin thumbnail/karakter emoji tiap opsi.
import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { StatusPreset } from "../global";
import { useFileBlobUrl } from "../lib/fileUrl";

export default function StatusDropdown({
  statusId,
  presets,
  onChange,
  onOpenChange,
}: {
  statusId: string | null;
  presets: StatusPreset[];
  onChange: (statusId: string | null) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  function setOpen(v: boolean | ((prev: boolean) => boolean)) {
    setOpenState((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      onOpenChange?.(next);
      return next;
    });
  }

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const selected = presets.find((p) => p.id === statusId) || null;

  function pick(id: string | null) {
    onChange(id);
    setOpen(false);
  }

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <div
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        role="button"
        tabIndex={0}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={selected ? `Status: ${selected.name}` : "Pilih status"}
        style={{ display: "flex", alignItems: "center", gap: 5, minHeight: 24, padding: "2px 6px", border: "1px solid var(--border)", borderRadius: 6, cursor: "pointer", fontSize: 12 }}
      >
        <StatusEmoji preset={selected} />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected ? selected.name : <span className="muted">— Status —</span>}
        </span>
        <ChevronDown size={11} className="muted" style={{ flexShrink: 0 }} />
      </div>
      {open && (
        <div className="card" style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, minWidth: 180, zIndex: 30, padding: 4 }} onMouseDown={(e) => e.stopPropagation()}>
          <div style={{ maxHeight: 220, overflow: "auto" }} className="scrollbar-thin" role="listbox">
            <button
              className="btn"
              role="option"
              aria-selected={statusId === null}
              style={{ width: "100%", justifyContent: "flex-start", border: "none", fontSize: 12, ...(statusId === null ? { color: "var(--accent)" } : {}) }}
              onClick={() => pick(null)}
            >
              — Status —
            </button>
            {presets.map((p) => (
              <button
                key={p.id}
                className="btn"
                role="option"
                aria-selected={p.id === statusId}
                style={{ width: "100%", justifyContent: "flex-start", gap: 6, border: "none", fontSize: 12, ...(p.id === statusId ? { color: "var(--accent)" } : {}) }}
                onClick={() => pick(p.id)}
              >
                <StatusEmoji preset={p} />
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function StatusEmoji({ preset }: { preset: StatusPreset | null }) {
  const url = useFileBlobUrl(preset?.image_path || null);
  if (url) return <img src={url} alt="" style={{ width: 14, height: 14, objectFit: "contain", flexShrink: 0 }} />;
  if (preset?.unicode_value) return <span style={{ flexShrink: 0, lineHeight: 1 }}>{preset.unicode_value}</span>;
  return <span style={{ width: 14, flexShrink: 0 }} />;
}
