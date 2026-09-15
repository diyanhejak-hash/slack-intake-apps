// Strip thumbnail capture pool (crop/frame yang belum di-drag ke field mana pun) — dipakai
// bareng oleh FilePreview (image/pdf, di Drawer.tsx) dan VideoPlayer.tsx, jadi 1 komponen
// (sebelumnya dobel, masing-masing punya salinan sendiri-sendiri).
//
// Klik thumbnail = buka preview ukuran penuh (poin revisi: "hasil capture belum bisa dilihat" —
// sebelumnya cuma bisa didrag atau dihapus, gak ada cara lihat isinya selain thumbnail 44x44).
import { useState } from "react";
import { X } from "lucide-react";

export default function CapturePoolStrip({
  pool,
  onRemove,
}: {
  pool: { id: string; dataUrl: string; filename: string }[];
  onRemove: (id: string) => void;
}) {
  const [previewing, setPreviewing] = useState<{ dataUrl: string; filename: string } | null>(null);
  if (!pool.length) return null;
  return (
    <>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6, padding: 6, border: "1px dashed var(--border-strong)", borderRadius: 6, flexShrink: 0 }}>
        {pool.map((p) => (
          <div
            key={p.id}
            draggable
            onDragStart={(e) => e.dataTransfer.setData("application/x-capture-id", p.id)}
            onClick={() => setPreviewing(p)}
            title="Klik buat lihat ukuran penuh — drag ke field buat attach"
            style={{ position: "relative", cursor: "pointer" }}
          >
            <img src={p.dataUrl} alt={p.filename} style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 4, border: "1px solid var(--border)" }} />
            {/* Lingkaran merah solid — poin revisi: badge X outline tipis sebelumnya nyaris gak
                keliatan di atas thumbnail terang. */}
            <button
              onClick={(e) => {
                e.stopPropagation();
                onRemove(p.id);
              }}
              title="Hapus dari pool"
              style={{
                position: "absolute",
                top: -6,
                right: -6,
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: "var(--danger)",
                border: "1.5px solid var(--surface)",
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
              }}
            >
              <X size={10} strokeWidth={3} />
            </button>
          </div>
        ))}
      </div>
      {previewing && (
        <div
          style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={() => setPreviewing(null)}
        >
          <div className="card" style={{ padding: 12, background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 16 }}>
              <span className="caption">{previewing.filename}</span>
              <button className="icon-btn" title="Tutup" onClick={() => setPreviewing(null)}>
                <X size={14} />
              </button>
            </div>
            <img src={previewing.dataUrl} style={{ maxWidth: "80vw", maxHeight: "75vh", display: "block", borderRadius: 6 }} />
          </div>
        </div>
      )}
    </>
  );
}
