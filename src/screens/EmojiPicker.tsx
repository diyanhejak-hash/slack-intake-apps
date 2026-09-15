// Tombol Emoji + popover — SHARED, dipakai di toolbar field (Drawer.tsx/ReplyRow) DAN di Prefix
// modal Generate Item (MainTable.tsx). Poin revisi: popover ini SEKARANG cuma nampilin preset
// (bukan picker lengkap lagi) — daftar lengkapnya pindah ke dalam modal "Kelola preset" (buka
// lewat baris teks di bawah popover, ATAU dari menu Edit).
import { useEffect, useState } from "react";
import { Smile, FileText } from "lucide-react";
import type { EmojiPreset } from "../global";
import { useFileBlobUrl } from "../lib/fileUrl";
import EmojiPresetModal from "./EmojiPresetModal";

export default function EmojiPicker({ onPick }: { onPick: (text: string, preset: EmojiPreset) => void }) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<EmojiPreset[]>([]);
  const [showManage, setShowManage] = useState(false);

  function refresh() {
    window.api.emojiPreset.list().then(setPresets);
  }
  useEffect(() => {
    if (open) refresh();
  }, [open]);

  function pick(preset: EmojiPreset) {
    onPick(preset.type === "unicode" ? preset.value : `:${preset.value}:`, preset);
    setOpen(false);
  }

  return (
    <div style={{ position: "relative" }}>
      {/* onMouseDown preventDefault di tombol toggle DAN wrapper popover — biar fokus/selection di
          text area gak ilang duluan sebelum onPick jalan (bug lama: emoji gak ke-insert). */}
      <button className="icon-btn" title="Emoji" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}>
        <Smile size={13} />
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", bottom: 34, left: 0, padding: 8, width: 200, zIndex: 10 }} onMouseDown={(e) => e.preventDefault()}>
          {presets.length === 0 ? (
            <div className="caption" style={{ padding: "10px 4px", textAlign: "center" }}>
              Belum ada preset emoji.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 4 }}>
              {presets.map((p) => (
                <EmojiPresetButton key={p.id} preset={p} onClick={() => pick(p)} />
              ))}
            </div>
          )}
          <button
            className="btn"
            style={{ width: "100%", marginTop: 6, justifyContent: "center", fontSize: 11, padding: "4px 0" }}
            onClick={() => setShowManage(true)}
          >
            Kelola preset...
          </button>
        </div>
      )}
      {showManage && (
        <EmojiPresetModal
          onClose={() => {
            setShowManage(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function EmojiPresetButton({ preset, onClick }: { preset: EmojiPreset; onClick: () => void }) {
  const url = useFileBlobUrl(preset.type === "custom" ? preset.image_path : null);
  return (
    <button
      onClick={onClick}
      title={preset.type === "custom" ? `:${preset.value}:` : undefined}
      style={{ border: "none", background: "none", fontSize: 16, cursor: "pointer", padding: 4, display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26 }}
    >
      {preset.type === "unicode" ? preset.value : url ? <img src={url} alt="" style={{ width: 18, height: 18, objectFit: "contain" }} /> : <FileText size={14} className="muted" />}
    </button>
  );
}
