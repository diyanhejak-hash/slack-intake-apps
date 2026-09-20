// Modal "Kelola Status" (poin revisi, fitur baru) — daftar preset Status GLOBAL, bebas (bukan
// 1-per-member kayak Preset Artis). Tiap preset = nama tampilan (dropdown) + 1 emoji (dikirim
// sebagai react di pesan item). Pola UI mirip section "Info Artis" di ArtistPresetModal.tsx
// (display row baca-doang, klik Edit baru mount form) — dipisah modal sendiri sesuai permintaan,
// bukan digabung ke modal Preset Artis.
import { useEffect, useRef, useState } from "react";
import { X, Trash2, Plus, Grip } from "lucide-react";
import type { EmojiPreset, StatusPreset } from "../global";
import { useFileBlobUrl } from "../lib/fileUrl";
import { CombinedEmojiPickerButton } from "./EmojiPicker";

export default function StatusPresetModal({ onClose }: { onClose: () => void }) {
  const [presets, setPresets] = useState<StatusPreset[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function refresh() {
    window.api.statusPreset.list().then(setPresets);
  }
  useEffect(() => {
    refresh();
  }, []);

  async function remove(id: string) {
    if (!confirm("Hapus status ini?")) return;
    await window.api.statusPreset.remove(id);
    refresh();
  }

  // Drag-reorder (poin revisi, diminta user) — urutan di sini yang dipakai dropdown Status (Tab
  // Table/Tab Reply), pola sama persis kayak drag-reorder Reply di Drawer.tsx (grip handle di tiap
  // baris, drag mulai dari situ doang biar gak tabrakan sama klik Edit/Hapus).
  const dragId = useRef<string | null>(null);
  async function handleDrop(targetId: string) {
    const draggedId = dragId.current;
    dragId.current = null;
    if (!draggedId || draggedId === targetId) return;
    const ids = presets.map((p) => p.id);
    const fromIdx = ids.indexOf(draggedId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, draggedId);
    await window.api.statusPreset.reorder(ids);
    refresh();
  }

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div
        className="card"
        style={{ padding: 16, width: 460, maxHeight: "80vh", display: "flex", flexDirection: "column", background: "var(--surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexShrink: 0 }}>
          <h3>Kelola Status</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup" title="Tutup">
            <X size={14} />
          </button>
        </div>
        <p className="caption" style={{ margin: "0 0 8px" }}>
          Status dikirim sebagai react di pesan item — cuma 1 status aktif per item, ganti status
          otomatis lepas react status lama.
        </p>

        <div style={{ flex: 1, overflow: "auto" }} className="scrollbar-thin">
          {presets.length === 0 && !adding && <p className="caption">Belum ada status — tambah dulu di bawah.</p>}
          {presets.map((p) =>
            editingId === p.id ? (
              <StatusPresetEditRow
                key={p.id}
                preset={p}
                onDone={() => {
                  setEditingId(null);
                  refresh();
                }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <StatusPresetDisplayRow
                key={p.id}
                preset={p}
                onEdit={() => setEditingId(p.id)}
                onRemove={() => remove(p.id)}
                onDragStart={() => (dragId.current = p.id)}
                onDropOn={() => handleDrop(p.id)}
              />
            )
          )}
          {adding ? (
            <StatusPresetEditRow
              preset={null}
              onDone={() => {
                setAdding(false);
                refresh();
              }}
              onCancel={() => setAdding(false)}
            />
          ) : (
            <button className="btn" style={{ width: "100%", justifyContent: "center", marginTop: 8 }} onClick={() => setAdding(true)}>
              <Plus size={13} /> Status Baru
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusPresetDisplayRow({
  preset,
  onEdit,
  onRemove,
  onDragStart,
  onDropOn,
}: {
  preset: StatusPreset;
  onEdit: () => void;
  onRemove: () => void;
  /** Drag-reorder (poin revisi) — grip handle di baris ini jadi titik drag-nya, pola sama persis
   * kayak drag-reorder Reply di Drawer.tsx. */
  onDragStart: () => void;
  onDropOn: () => void;
}) {
  const url = useFileBlobUrl(preset.image_path);
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)" }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); onDropOn(); }}
    >
      <div draggable onDragStart={onDragStart} title="Drag buat ubah urutan" style={{ display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, width: 16, cursor: "grab", color: "var(--text-muted)" }}>
        <Grip size={13} />
      </div>
      <div style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 15 }}>
        {url ? <img src={url} alt="" style={{ width: 18, height: 18, objectFit: "contain" }} /> : preset.unicode_value}
      </div>
      <span className="caption" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {preset.name}
      </span>
      {!preset.unicode_value && (
        <span className="caption muted" style={{ flexShrink: 0 }}>
          :{preset.code_name}:
        </span>
      )}
      <button className="btn" onClick={onEdit} style={{ padding: "4px 8px", fontSize: 11, flexShrink: 0 }}>
        Edit
      </button>
      <button className="icon-btn" title="Hapus status" onClick={onRemove}>
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function StatusPresetEditRow({ preset, onDone, onCancel }: { preset: StatusPreset | null; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(preset?.name || "");
  const [codeName, setCodeName] = useState(preset?.code_name || "");
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  // Poin revisi (bug dilaporkan: "show selected emoji, bukan aliasnya", lanjut "abis Simpan
  // balik jadi kode nama lagi") — feedback visual buat emoji unicode (bukan custom/PNG) sekarang
  // karakter emoji-nya sendiri, DAN di-prefill dari preset.unicode_value biar edit yang gak
  // nyentuh emoji (cuma ganti nama status) tetep ngirim ulang nilai unicode yang bener.
  const [pickedUnicode, setPickedUnicode] = useState<string | null>(preset?.unicode_value || null);
  const [busy, setBusy] = useState(false);
  const previewUrl = useFileBlobUrl(pickedPath || preset?.image_path);

  function pickPreset(emojiPreset: EmojiPreset) {
    if (!emojiPreset.slack_shortcode) return;
    setCodeName(emojiPreset.slack_shortcode);
    if (emojiPreset.type === "custom") {
      setPickedPath(emojiPreset.image_path);
      setPickedUnicode(null);
    } else {
      setPickedPath(null);
      setPickedUnicode(emojiPreset.value);
    }
  }

  async function pickFromSlack(emojiName: string, url: string) {
    setBusy(true);
    try {
      const tempPath = await window.api.slack.downloadEmojiImage(url);
      setCodeName(emojiName);
      setPickedPath(tempPath);
      setPickedUnicode(null);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Gagal ambil gambar emoji dari Slack.");
    } finally {
      setBusy(false);
    }
  }

  // Poin revisi (tombol "+" — Semua Emoji) — pilih langsung dari picker unicode lengkap, gak
  // perlu bikin preset dulu. `colons` dari emoji-mart bentuknya ":nama:" (ada titik dua), code_name
  // kita simpen TANPA titik dua (sama pola kayak semua shortcode lain di app ini).
  function pickUnicode(native: string, colons: string) {
    setCodeName(colons.replace(/^:|:$/g, ""));
    setPickedPath(null);
    setPickedUnicode(native);
  }

  async function save() {
    if (!name.trim() || !codeName) return;
    setBusy(true);
    try {
      await window.api.statusPreset.save({
        id: preset?.id,
        name: name.trim(),
        codeName,
        sourcePath: pickedPath || undefined,
        // Backend ngasih prioritas sourcePath kalau dua-duanya keisi (lihat saveStatusPreset).
        unicodeValue: pickedUnicode || undefined,
      });
      onDone();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Gagal nyimpen status.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ width: 20, height: 20, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 15 }}>
        {previewUrl ? <img src={previewUrl} alt="" style={{ width: 18, height: 18, objectFit: "contain" }} /> : pickedUnicode}
      </div>
      <input autoFocus placeholder="Nama status" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
      {!codeName && (
        <span className="caption muted" style={{ flexShrink: 0 }}>
          — pilih emoji —
        </span>
      )}
      <CombinedEmojiPickerButton onPickPreset={pickPreset} onPickSlack={pickFromSlack} onPickUnicode={pickUnicode} disabled={busy} />
      <button className="btn btn-primary" disabled={busy || !name.trim() || !codeName} onClick={save} style={{ padding: "4px 8px", fontSize: 11, flexShrink: 0 }}>
        Simpan
      </button>
      <button className="btn" disabled={busy} onClick={onCancel} style={{ padding: "4px 8px", fontSize: 11, flexShrink: 0 }}>
        Batal
      </button>
    </div>
  );
}
