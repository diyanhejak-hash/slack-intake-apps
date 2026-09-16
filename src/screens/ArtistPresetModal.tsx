// Modal "Preset Artis" (poin revisi) — kelola nickname/code_name/PNG per Slack member. Satu baris
// per member users.list(); member TANPA preset masih bisa langsung diisi (upsert di backend,
// lihat projects.saveArtistPreset). nickname ganti tampilan nama di dropdown Artis (Tab Table &
// Tab Reply, lihat visibleUsers di MainTable.tsx). code_name = shortcode custom emoji Slack
// (TANPA titik dua) buat workflow "assign via reaction" — SENGAJA gak divalidasi ke Slack beneran
// (sama seperti custom emoji preset biasa), diasumsikan emoji itu udah ada di workspace tujuan.
import { useEffect, useState } from "react";
import { X, Upload, Trash2 } from "lucide-react";
import type { ArtistPreset, SlackUser } from "../global";
import { useFileBlobUrl } from "../lib/fileUrl";
import { refreshEmojiPresetCache } from "../lib/emojiPresetStore";

export default function ArtistPresetModal({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<SlackUser[]>([]);
  const [presets, setPresets] = useState<ArtistPreset[]>([]);

  // refreshEmojiPresetCache() JUGA di-panggil di sini (bukan cuma EmojiPresetModal) — cache
  // custom-emoji-name -> PNG dipakai bareng buat nampilin chip reaction (ReactionChip.tsx), dan
  // code_name artis lewat jalur yang SAMA (lihat emojiPresetStore.ts).
  function refresh() {
    window.api.artistPreset.list().then(setPresets);
    refreshEmojiPresetCache();
  }
  useEffect(() => {
    window.api.slack.listUsers().then(setUsers);
    refresh();
  }, []);

  const presetByMember = new Map(presets.map((p) => [p.member_id, p]));

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div
        className="card"
        style={{ padding: 16, width: 620, maxHeight: "80vh", display: "flex", flexDirection: "column", background: "var(--surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6, flexShrink: 0 }}>
          <h3>Preset Artis</h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <p className="caption" style={{ marginBottom: 10, flexShrink: 0 }}>
          Nickname ganti tampilan nama di dropdown Artis. Code name = shortcode custom emoji Slack
          (tanpa titik dua) buat assign-via-reaction — pastikan emoji itu beneran ada di workspace
          Slack tujuan. PNG cuma preview lokal, gak disinkron ke Slack.
        </p>
        <div style={{ flex: 1, overflow: "auto" }} className="scrollbar-thin">
          {users.length === 0 && <p className="caption">Belum ada member (login dulu, atau workspace kosong).</p>}
          {users.map((u) => (
            <ArtistPresetRow key={u.id} user={u} preset={presetByMember.get(u.id) || null} onSaved={refresh} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ArtistPresetRow({ user, preset, onSaved }: { user: SlackUser; preset: ArtistPreset | null; onSaved: () => void }) {
  const [nickname, setNickname] = useState(preset?.nickname || "");
  const [codeName, setCodeName] = useState(preset?.code_name || "");
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const savedUrl = useFileBlobUrl(preset?.image_path || null);

  async function pickImage() {
    const filePath = await window.api.artistPreset.pickImage();
    if (filePath) setPickedPath(filePath);
  }

  async function save() {
    setBusy(true);
    try {
      await window.api.artistPreset.save({
        id: preset?.id,
        memberId: user.id,
        nickname: nickname.trim() || undefined,
        codeName: codeName.trim() || undefined,
        sourcePath: pickedPath || undefined,
      });
      setPickedPath(null);
      onSaved();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Gagal nyimpen preset artis.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!preset) return;
    if (!confirm(`Hapus preset artis "${user.name}"?`)) return;
    await window.api.artistPreset.remove(preset.id);
    onSaved();
  }

  const dirty = nickname !== (preset?.nickname || "") || codeName !== (preset?.code_name || "") || !!pickedPath;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div
          style={{
            width: 26, height: 26, borderRadius: "50%", overflow: "hidden", flexShrink: 0, display: "flex",
            alignItems: "center", justifyContent: "center", background: "var(--surface-hover)", border: "1px solid var(--border)", fontSize: 11,
          }}
        >
          {savedUrl ? <img src={savedUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : user.name.slice(0, 1).toUpperCase()}
        </div>
        <div className="caption" style={{ width: 100, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={user.name}>
          {user.name}
        </div>
        <input placeholder="Nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        <input placeholder="code_name" value={codeName} onChange={(e) => setCodeName(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        <button className="icon-btn" title="Pilih PNG" onClick={pickImage}>
          <Upload size={13} />
        </button>
        <button className="btn btn-primary" disabled={busy || !dirty} onClick={save} style={{ padding: "4px 8px", fontSize: 11, flexShrink: 0 }}>
          Simpan
        </button>
        {preset && (
          <button className="icon-btn" title="Hapus preset" onClick={remove}>
            <Trash2 size={13} />
          </button>
        )}
      </div>
      {pickedPath && <div className="caption" style={{ paddingLeft: 34 }}>PNG baru: {pickedPath.split(/[\\/]/).pop()}</div>}
    </div>
  );
}
