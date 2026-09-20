// Modal "Preset Emoji" (poin revisi) — kelola daftar emoji yang muncul di picker toolbar (bukan
// SEMUA emoji unicode lagi, cuma yang di-preset di sini). 2 sumber: pilih dari daftar emoji
// lengkap (emoji-mart, lazy) ATAU tambah custom (upload PNG lokal + kasih nama, ala custom emoji
// Slack — value yang ke-insert ke text nanti "nama_emoji" jadi teks ":nama_emoji:", BUKAN
// gambarnya, dan SENGAJA gak divalidasi ke Slack beneran — kalau di workspace tujuan gak ada
// custom emoji nama sama, ya biarin aja tampil apa adanya, jangan ditolak).
import { Suspense, useEffect, useState } from "react";
import { X, Upload } from "lucide-react";
import type { EmojiPreset } from "../global";
import { useFileBlobUrl } from "../lib/fileUrl";
import { LazyEmojiPicker, type PickedEmoji } from "../lib/emojiPicker";
import { refreshEmojiPresetCache } from "../lib/emojiPresetStore";

export default function EmojiPresetModal({ onClose }: { onClose: () => void }) {
  const [presets, setPresets] = useState<EmojiPreset[]>([]);
  const [customName, setCustomName] = useState("");
  const [customPath, setCustomPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // refresh() = list lokal buat modal ini doang. refreshEmojiPresetCache() = cache GLOBAL yang
  // dipakai EmojiImageNode (poin revisi "custom emoji tampil PNG di editor") — DUA-duanya wajib
  // di-panggil tiap ada perubahan, biar field reply yang lagi kebuka ikut update tanpa reload.
  function refresh() {
    window.api.emojiPreset.list().then(setPresets);
    refreshEmojiPresetCache();
  }
  useEffect(() => {
    refresh();
  }, []);

  async function addUnicode(emoji: PickedEmoji) {
    // colons contoh ":grinning:" — dipakai jadi slack_shortcode (poin revisi fitur Reaction,
    // butuh nama Slack buat reactions.add, bukan cuma karakter unicode-nya).
    await window.api.emojiPreset.addUnicode({ char: emoji.native, shortcode: emoji.colons });
    refresh();
  }

  async function pickCustomImage() {
    const filePath = await window.api.emojiPreset.pickImage();
    if (filePath) setCustomPath(filePath);
  }

  async function addCustom() {
    if (!customName.trim() || !customPath) return;
    setBusy(true);
    try {
      await window.api.emojiPreset.addCustom({ name: customName.trim(), filePath: customPath });
      setCustomName("");
      setCustomPath(null);
      refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Gagal nambah emoji custom.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    await window.api.emojiPreset.remove(id);
    refresh();
  }

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div
        className="card"
        style={{ padding: 16, width: 480, maxHeight: "80vh", display: "flex", flexDirection: "column", background: "var(--surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexShrink: 0 }}>
          <h3>Preset Emoji</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup" title="Tutup">
            <X size={14} />
          </button>
        </div>

        <div className="label" style={{ marginBottom: 6, flexShrink: 0 }}>
          Preset saat ini ({presets.length})
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14, minHeight: 34, flexShrink: 0 }}>
          {presets.length === 0 && <span className="caption">Belum ada — pilih dari daftar di bawah, atau tambah custom.</span>}
          {presets.map((p) => (
            <PresetChip key={p.id} preset={p} onRemove={() => remove(p.id)} />
          ))}
        </div>

        <div className="label" style={{ marginBottom: 6, flexShrink: 0 }}>
          Tambah emoji custom (PNG, ala Slack)
        </div>
        <div style={{ display: "flex", gap: 6, marginBottom: 4, flexShrink: 0 }}>
          <button className="btn" onClick={pickCustomImage}>
            <Upload size={13} /> {customPath ? "Ganti PNG" : "Pilih PNG"}
          </button>
          <input placeholder="nama_emoji" value={customName} onChange={(e) => setCustomName(e.target.value)} style={{ flex: 1 }} />
          <button className="btn btn-primary" onClick={addCustom} disabled={busy || !customPath || !customName.trim()}>
            Tambah
          </button>
        </div>
        {customPath && (
          <div className="caption" style={{ marginBottom: 10, flexShrink: 0 }}>
            File: {customPath.split(/[\\/]/).pop()}
          </div>
        )}

        <div className="label" style={{ marginBottom: 6, flexShrink: 0 }}>
          Pilih dari daftar emoji — buat ditambah ke preset
        </div>
        <div style={{ flex: 1, minHeight: 200, overflow: "auto" }} className="scrollbar-thin">
          <Suspense
            fallback={
              <div className="placeholder-box">
                <span className="caption">Memuat emoji…</span>
              </div>
            }
          >
            <LazyEmojiPicker onPick={addUnicode} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

function PresetChip({ preset, onRemove }: { preset: EmojiPreset; onRemove: () => void }) {
  const url = useFileBlobUrl(preset.type === "custom" ? preset.image_path : null);
  return (
    <div
      title={preset.type === "custom" ? `:${preset.value}:` : undefined}
      style={{
        position: "relative",
        width: 32,
        height: 32,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        border: "1px solid var(--border)",
        borderRadius: 6,
        fontSize: 16,
      }}
    >
      {preset.type === "unicode" ? preset.value : url ? <img src={url} alt="" style={{ width: 20, height: 20, objectFit: "contain" }} /> : null}
      <button
        onClick={onRemove}
        title="Hapus dari preset"
        style={{
          position: "absolute",
          top: -6,
          right: -6,
          width: 14,
          height: 14,
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
        <X size={9} strokeWidth={3} />
      </button>
    </div>
  );
}
