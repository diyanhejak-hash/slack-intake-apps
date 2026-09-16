// Modal "Preset Artis" (poin revisi) — SATU modal, 2 section collapsible, gak ada UI/modal
// terpisah lain buat setting artis (ArtistPicker cuma buat PILIH artis, gak ada pengaturan lagi
// di situ):
//   1. Info Artis — nickname/code_name/PNG per Slack member (upsert per baris).
//   2. Mode Assign — toggle Mention/React GLOBAL per artis (bukan per-item/per-row lagi). Semua
//      item yang di-assign ke artis ini ikut mode yang sama, diatur SEKALI di sini.
import { useEffect, useState } from "react";
import { X, Upload, Trash2, ChevronDown, ChevronRight, AtSign, SmilePlus } from "lucide-react";
import type { ArtistPreset, SlackUser } from "../global";
import { useFileBlobUrl } from "../lib/fileUrl";
import { refreshEmojiPresetCache } from "../lib/emojiPresetStore";

export default function ArtistPresetModal({ onClose }: { onClose: () => void }) {
  const [users, setUsers] = useState<SlackUser[]>([]);
  const [presets, setPresets] = useState<ArtistPreset[]>([]);
  const [infoOpen, setInfoOpen] = useState(true);
  const [modeOpen, setModeOpen] = useState(true);

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

  // Toggle mode langsung SIMPAN (gak nunggu tombol Simpan terpisah, beda dari Section 1) — pakai
  // nickname/code_name/image YANG UDAH TERSIMPAN (dari preset, bukan draft lokal Section 1 yang
  // mungkin belum di-Simpan), biar toggle mode gak nimpa draft nickname yang lagi diketik user.
  async function setMode(user: SlackUser, mode: "mention" | "react" | "both" | "none") {
    const preset = presetByMember.get(user.id);
    await window.api.artistPreset.save({
      id: preset?.id,
      memberId: user.id,
      nickname: preset?.nickname || undefined,
      codeName: preset?.code_name || undefined,
      mode,
    });
    refresh();
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div
        className="card"
        style={{ padding: 16, width: 620, maxHeight: "82vh", display: "flex", flexDirection: "column", background: "var(--surface)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexShrink: 0 }}>
          <h3>Preset Artis</h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <div style={{ flex: 1, overflow: "auto" }} className="scrollbar-thin">
          {users.length === 0 && <p className="caption">Belum ada member (login dulu, atau workspace kosong).</p>}

          <SectionHeader title="Info Artis — nickname, code name, PNG" open={infoOpen} onToggle={() => setInfoOpen((v) => !v)} />
          {infoOpen && (
            <>
              <p className="caption" style={{ margin: "0 0 8px" }}>
                Nickname ganti tampilan nama di dropdown Artis. Code name = shortcode custom emoji
                Slack buat assign-via-reaction — pastikan emoji itu beneran ada di workspace Slack
                tujuan. PNG cuma preview lokal, gak disinkron ke Slack.
              </p>
              {users.map((u) => (
                <ArtistInfoRow key={u.id} user={u} preset={presetByMember.get(u.id) || null} onSaved={refresh} />
              ))}
            </>
          )}

          <SectionHeader title="Mode Assign — Mention / React" open={modeOpen} onToggle={() => setModeOpen((v) => !v)} style={{ marginTop: 14 }} />
          {modeOpen && (
            <>
              <p className="caption" style={{ margin: "0 0 8px" }}>
                Berlaku GLOBAL per artis (bukan per item) — semua item yang di-assign ke artis ini
                ikut mode yang sama. Default Mention aktif. Aktifin dua-duanya buat mention +
                reaction bareng.
              </p>
              {users.map((u) => (
                <ArtistModeRow key={u.id} user={u} mode={presetByMember.get(u.id)?.mode || "mention"} onChange={(mode) => setMode(u, mode)} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionHeader({ title, open, onToggle, style }: { title: string; open: boolean; onToggle: () => void; style?: React.CSSProperties }) {
  return (
    <button
      onClick={onToggle}
      className="btn"
      style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", justifyContent: "flex-start", border: "none", borderBottom: "1px solid var(--border)", borderRadius: 0, padding: "6px 0", marginBottom: 8, ...style }}
    >
      {open ? <ChevronDown size={13} className="muted" /> : <ChevronRight size={13} className="muted" />}
      <span className="label">{title}</span>
    </button>
  );
}

function ArtistInfoRow({ user, preset, onSaved }: { user: SlackUser; preset: ArtistPreset | null; onSaved: () => void }) {
  const [nickname, setNickname] = useState(preset?.nickname || "");
  // Poin revisi: tampil DENGAN titik dua (":rev:") biar jelas ini shortcode ala Slack, bukan teks
  // biasa — sebelumnya selalu polos "rev" abis simpan+buka lagi, bikin ambigu. Titik dua di-strip
  // otomatis di backend (saveArtistPreset), jadi aman user mau nulis pake atau tanpa titik dua.
  const [codeName, setCodeName] = useState(preset?.code_name ? `:${preset.code_name}:` : "");
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
      const id = await window.api.artistPreset.save({
        id: preset?.id,
        memberId: user.id,
        nickname: nickname.trim() || undefined,
        codeName: codeName.trim() || undefined,
        sourcePath: pickedPath || undefined,
      });
      setPickedPath(null);
      onSaved();
      return id;
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

  const dirty = nickname !== (preset?.nickname || "") || codeName !== (preset?.code_name ? `:${preset.code_name}:` : "") || !!pickedPath;

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
        <input placeholder=":code_name:" value={codeName} onChange={(e) => setCodeName(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
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

function ArtistModeRow({ user, mode, onChange }: { user: SlackUser; mode: "mention" | "react" | "both" | "none"; onChange: (mode: "mention" | "react" | "both" | "none") => void }) {
  const mentionOn = mode === "mention" || mode === "both";
  const reactOn = mode === "react" || mode === "both";
  function toggle(which: "mention" | "react") {
    const nextMention = which === "mention" ? !mentionOn : mentionOn;
    const nextReact = which === "react" ? !reactOn : reactOn;
    onChange(nextMention && nextReact ? "both" : nextMention ? "mention" : nextReact ? "react" : "none");
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
      <div className="caption" style={{ width: 140, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={user.name}>
        {user.name}
      </div>
      <button
        className="icon-btn"
        title={`Mention (@${user.name} di-post pas kirim) — ${mentionOn ? "aktif" : "nonaktif"}`}
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
  );
}
