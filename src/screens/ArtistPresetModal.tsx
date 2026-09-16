// Modal "Preset Artis" (poin revisi) — SATU modal, 2 section collapsible, gak ada UI/modal
// terpisah lain buat setting artis:
//   1. Info Artis — nickname/code_name/PNG per Slack member (upsert per baris).
//   2. Dropdown Artis — pilih/bikin GRUP (dulu modal "Dropdown Artis" terpisah, sekarang jadi
//      section di sini) + toggle Mention/React. Toggle ini GLOBAL buat SEMUA artis (BUKAN
//      per-artis lagi, koreksi dari percobaan sebelumnya) — satu switch, berlaku ke semua
//      assignment di seluruh app.
import { useEffect, useState } from "react";
import { X, Upload, Trash2, ChevronDown, ChevronRight, AtSign, SmilePlus, CheckSquare, Square, Plus } from "lucide-react";
import type { ArtistAssignMode, ArtistGroup, ArtistPreset, SlackUser } from "../global";
import { useFileBlobUrl } from "../lib/fileUrl";
import { refreshEmojiPresetCache } from "../lib/emojiPresetStore";

export default function ArtistPresetModal({
  users,
  groups,
  activeGroupId,
  onSelectGroup,
  onGroupsChanged,
  onClose,
}: {
  users: SlackUser[];
  groups: ArtistGroup[];
  activeGroupId: string;
  onSelectGroup: (id: string) => void;
  onGroupsChanged: (groups: ArtistGroup[]) => void;
  onClose: () => void;
}) {
  const [presets, setPresets] = useState<ArtistPreset[]>([]);
  const [assignMode, setAssignMode] = useState<ArtistAssignMode>("mention");
  const [infoOpen, setInfoOpen] = useState(true);
  const [dropdownOpen, setDropdownOpen] = useState(true);

  // refreshEmojiPresetCache() JUGA di-panggil di sini (bukan cuma EmojiPresetModal) — cache
  // custom-emoji-name -> PNG dipakai bareng buat nampilin chip reaction (ReactionChip.tsx), dan
  // code_name artis lewat jalur yang SAMA (lihat emojiPresetStore.ts).
  function refreshPresets() {
    window.api.artistPreset.list().then(setPresets);
    refreshEmojiPresetCache();
  }
  useEffect(() => {
    refreshPresets();
    window.api.artistAssignMode.get().then(setAssignMode);
  }, []);

  const presetByMember = new Map(presets.map((p) => [p.member_id, p]));

  async function toggleAssignMode(which: "mention" | "react") {
    const mentionOn = assignMode === "mention" || assignMode === "both";
    const reactOn = assignMode === "react" || assignMode === "both";
    const nextMention = which === "mention" ? !mentionOn : mentionOn;
    const nextReact = which === "react" ? !reactOn : reactOn;
    const next = nextMention && nextReact ? "both" : nextMention ? "mention" : nextReact ? "react" : "none";
    setAssignMode(next);
    await window.api.artistAssignMode.set(next);
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

          <SectionHeader title="1. Info Artis — nickname, code name, PNG" open={infoOpen} onToggle={() => setInfoOpen((v) => !v)} />
          {infoOpen && (
            <>
              <p className="caption" style={{ margin: "0 0 8px" }}>
                Nickname ganti tampilan nama di dropdown Artis. Code name = shortcode custom emoji
                Slack buat assign-via-reaction — pastikan emoji itu beneran ada di workspace Slack
                tujuan. PNG cuma preview lokal, gak disinkron ke Slack.
              </p>
              {users.map((u) => (
                <ArtistInfoRow key={u.id} user={u} preset={presetByMember.get(u.id) || null} onSaved={refreshPresets} />
              ))}
            </>
          )}

          <SectionHeader title="2. Dropdown Artis — mode assign & grup" open={dropdownOpen} onToggle={() => setDropdownOpen((v) => !v)} style={{ marginTop: 14 }} />
          {dropdownOpen && (
            <>
              <div className="label" style={{ marginBottom: 4 }}>2a. Mode assign (GLOBAL, berlaku ke SEMUA artis)</div>
              <p className="caption" style={{ margin: "0 0 8px" }}>
                Bukan per-artis — satu switch ini berlaku ke semua assignment di seluruh app.
                Default Mention aktif. Aktifin dua-duanya buat mention + reaction bareng.
              </p>
              <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                <button
                  className="icon-btn"
                  title={`Mention (@artis di-post pas kirim) — ${["mention", "both"].includes(assignMode) ? "aktif" : "nonaktif"}`}
                  onClick={() => toggleAssignMode("mention")}
                  style={["mention", "both"].includes(assignMode) ? { borderColor: "var(--accent)", color: "var(--accent)", background: "var(--accent-soft)" } : {}}
                >
                  <AtSign size={14} />
                </button>
                <button
                  className="icon-btn"
                  title={`Reaction (antre code name artis, gak ada mention) — ${["react", "both"].includes(assignMode) ? "aktif" : "nonaktif"}`}
                  onClick={() => toggleAssignMode("react")}
                  style={["react", "both"].includes(assignMode) ? { borderColor: "var(--accent)", color: "var(--accent)", background: "var(--accent-soft)" } : {}}
                >
                  <SmilePlus size={14} />
                </button>
              </div>

              <div className="label" style={{ marginBottom: 4 }}>Grup — filter dropdown Artis</div>
              <ArtistGroupSection users={users} groups={groups} activeGroupId={activeGroupId} onSelectGroup={onSelectGroup} onGroupsChanged={onGroupsChanged} />
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

// Grup filter dropdown Artis (poin revisi) — dulu modal "Dropdown Artis" terpisah, sekarang
// section di sini. Klik grup = pilih/highlight doang (GAK auto-nutup modal lagi — beda dari
// dulu — biar user bisa lanjut kerjain section lain di modal yang sama tanpa buka ulang).
function ArtistGroupSection({
  users,
  groups,
  activeGroupId,
  onSelectGroup,
  onGroupsChanged,
}: {
  users: SlackUser[];
  groups: ArtistGroup[];
  activeGroupId: string;
  onSelectGroup: (id: string) => void;
  onGroupsChanged: (groups: ArtistGroup[]) => void;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [memberIds, setMemberIds] = useState<Set<string>>(new Set());
  const [touched, setTouched] = useState(false);

  async function save() {
    if (!name.trim() || !memberIds.size) {
      setTouched(true);
      return;
    }
    await window.api.artistGroup.save({ name: name.trim(), memberIds: Array.from(memberIds) });
    const updated = await window.api.artistGroup.list();
    onGroupsChanged(updated);
    setName("");
    setMemberIds(new Set());
    setTouched(false);
    setCreating(false);
  }

  return (
    <div>
      <button className="btn" style={{ width: "100%", justifyContent: "flex-start", marginBottom: 4 }} onClick={() => onSelectGroup("")}>
        {activeGroupId === "" ? <CheckSquare size={14} /> : <Square size={14} />} Semua Artis ({users.length})
      </button>
      {groups.map((g) => (
        <button key={g.id} className="btn" style={{ width: "100%", justifyContent: "flex-start", marginBottom: 4 }} onClick={() => onSelectGroup(g.id)}>
          {activeGroupId === g.id ? <CheckSquare size={14} /> : <Square size={14} />} {g.name} ({g.memberIds.length})
        </button>
      ))}

      {creating ? (
        <div className="card" style={{ padding: 10, marginTop: 8 }}>
          <input
            placeholder="Nama grup, mis. Tim BG"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={touched && !name.trim() ? "input-error" : ""}
            style={{ width: "100%", marginBottom: 8 }}
          />
          <div
            style={{
              maxHeight: 180,
              overflow: "auto",
              ...(touched && !memberIds.size ? { outline: "2px solid var(--danger)", borderRadius: "var(--radius)" } : {}),
            }}
            className="scrollbar-thin"
          >
            {users.map((u) => (
              <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                <input
                  type="checkbox"
                  checked={memberIds.has(u.id)}
                  onChange={(e) => {
                    setMemberIds((prev) => {
                      const next = new Set(prev);
                      e.target.checked ? next.add(u.id) : next.delete(u.id);
                      return next;
                    });
                  }}
                />
                {u.name}
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }} onClick={save}>
              Simpan Grup
            </button>
            <button className="btn" onClick={() => setCreating(false)}>
              Batal
            </button>
          </div>
        </div>
      ) : (
        <button className="btn" style={{ width: "100%", justifyContent: "center", marginTop: 4 }} onClick={() => setCreating(true)}>
          <Plus size={13} /> Grup Baru
        </button>
      )}
    </div>
  );
}
