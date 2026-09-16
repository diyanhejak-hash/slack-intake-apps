// Modal "Preset Artis" (poin revisi) — SATU modal, 2 section collapsible, gak ada UI/modal
// terpisah lain buat setting artis:
//   1. Info Artis — nickname/code_name/PNG per Slack member (upsert per baris).
//   2. Dropdown Artis — pilih/bikin GRUP (dulu modal "Dropdown Artis" terpisah, sekarang jadi
//      section di sini) + toggle Mention/React. Toggle ini GLOBAL buat SEMUA artis (BUKAN
//      per-artis lagi, koreksi dari percobaan sebelumnya) — satu switch, berlaku ke semua
//      assignment di seluruh app.
import { useEffect, useState } from "react";
import { X, Trash2, ChevronDown, ChevronRight, AtSign, SmilePlus, CheckSquare, Square, Plus } from "lucide-react";
import type { ArtistAssignMode, ArtistGroup, ArtistPreset, EmojiPreset, SlackUser } from "../global";
import { useFileBlobUrl } from "../lib/fileUrl";
import { refreshEmojiPresetCache } from "../lib/emojiPresetStore";
import EmojiPicker from "./EmojiPicker";

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

  // Poin revisi: Mention ATAU React, gak boleh dua-duanya (dulu bisa "both") — klik salah satu
  // langsung PINDAH kesitu (matiin yang lain otomatis). Klik yang LAGI aktif = matiin (balik ke
  // "none", dua-duanya nonaktif).
  async function toggleAssignMode(which: "mention" | "react") {
    const next = assignMode === which ? "none" : which;
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
                Nickname = nama di dropdown. Emoji = dipakai buat assign-via-reaction — pilih dari preset, atau tambah custom (PNG) lewat "Kelola preset...".
              </p>
              {users.map((u) => (
                <ArtistInfoRow key={u.id} user={u} preset={presetByMember.get(u.id) || null} onSaved={refreshPresets} />
              ))}
            </>
          )}

          <SectionHeader title="2. Dropdown Artis — mode assign & grup" open={dropdownOpen} onToggle={() => setDropdownOpen((v) => !v)} style={{ marginTop: 14 }} />
          {dropdownOpen && (
            <>
              <div className="label" style={{ marginBottom: 4 }}>2a. Mode assign (Global)</div>
              <p className="caption" style={{ margin: "0 0 8px" }}>
                Global — berlaku ke semua artis sekaligus. Mention ATAU React, gak bisa dua-duanya. Default: Mention aktif.
              </p>
              <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
                <button
                  className="icon-btn"
                  title={`Mention (@artis di-post pas kirim) — ${assignMode === "mention" ? "aktif" : "nonaktif"}`}
                  onClick={() => toggleAssignMode("mention")}
                  style={assignMode === "mention" ? { borderColor: "var(--accent)", color: "var(--accent)", background: "var(--accent-soft)" } : {}}
                >
                  <AtSign size={14} />
                </button>
                <button
                  className="icon-btn"
                  title={`Reaction (antre code name artis, gak ada mention) — ${assignMode === "react" ? "aktif" : "nonaktif"}`}
                  onClick={() => toggleAssignMode("react")}
                  style={assignMode === "react" ? { borderColor: "var(--accent)", color: "var(--accent)", background: "var(--accent-soft)" } : {}}
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

// Poin revisi: nickname/code_name/PNG yang UDAH TERSIMPAN sekarang tampil READ-ONLY (bukan input
// aktif terus-terusan) — root cause bug lama "code name selalu balik kosong": input pakai
// useState(preset?.code_name...) yang cuma jalan SEKALI pas mount, sementara `presets` (fetch
// async) sering masih [] pas render PERTAMA (preset=null) — begitu data beneran kelar di-fetch,
// initializer itu gak re-run, input nyangkut kosong permanen. Sekarang: cuma TAMPIL doang (baca
// langsung dari `preset`, SELALU ikut data terbaru, gak ada local state buat nilai tersimpan),
// klik "Edit" baru mount form (ArtistInfoEditRow) dengan `preset` yang UDAH PASTI valid (baris
// baca-doang di atasnya kebukti nampilin nilai bener sebelum tombol Edit bisa diklik).
function ArtistInfoRow({ user, preset, onSaved }: { user: SlackUser; preset: ArtistPreset | null; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return <ArtistInfoEditRow user={user} preset={preset} onDone={() => { setEditing(false); onSaved(); }} onCancel={() => setEditing(false)} />;
  }
  return <ArtistInfoDisplayRow user={user} preset={preset} onEdit={() => setEditing(true)} onRemoved={onSaved} />;
}

function ArtistAvatar({ user, imagePath }: { user: SlackUser; imagePath: string | null | undefined }) {
  const url = useFileBlobUrl(imagePath || null);
  return (
    <div
      style={{
        width: 26, height: 26, borderRadius: "50%", overflow: "hidden", flexShrink: 0, display: "flex",
        alignItems: "center", justifyContent: "center", background: "var(--surface-hover)", border: "1px solid var(--border)", fontSize: 11,
      }}
    >
      {url ? <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : user.name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function ArtistInfoDisplayRow({ user, preset, onEdit, onRemoved }: { user: SlackUser; preset: ArtistPreset | null; onEdit: () => void; onRemoved: () => void }) {
  async function remove() {
    if (!preset) return;
    if (!confirm(`Hapus preset artis "${user.name}"?`)) return;
    await window.api.artistPreset.remove(preset.id);
    onRemoved();
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
      <ArtistAvatar user={user} imagePath={preset?.image_path} />
      <div className="caption" style={{ width: 100, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={user.name}>
        {user.name}
      </div>
      <span className="caption" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {preset?.nickname || <span className="muted">— nickname —</span>}
      </span>
      <span className="caption" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {preset?.code_name ? `:${preset.code_name}:` : <span className="muted">— code name —</span>}
      </span>
      <button className="btn" onClick={onEdit} style={{ padding: "4px 8px", fontSize: 11, flexShrink: 0 }}>
        Edit
      </button>
      {preset && (
        <button className="icon-btn" title="Hapus preset" onClick={remove}>
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

function ArtistInfoEditRow({ user, preset, onDone, onCancel }: { user: SlackUser; preset: ArtistPreset | null; onDone: () => void; onCancel: () => void }) {
  const [nickname, setNickname] = useState(preset?.nickname || "");
  const [codeName, setCodeName] = useState(preset?.code_name || "");
  // Poin revisi: code_name + PNG gak lagi diketik/upload manual — dipilih lewat EmojiPicker
  // (SAMA persis kayak popover "Add React"), biar code_name-nya PASTI valid (cocok sama emoji
  // beneran, bukan hasil ketik salah) dan PNG-nya otomatis ikut kalau preset-nya custom. Butuh
  // PNG yang belum ada di preset? Tambah dulu lewat "Kelola preset..." di dalam picker yang sama.
  const [pickedPath, setPickedPath] = useState<string | null>(null);
  const [pickedUnicode, setPickedUnicode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function pickEmojiPreset(emojiPreset: EmojiPreset) {
    if (!emojiPreset.slack_shortcode) return;
    setCodeName(emojiPreset.slack_shortcode);
    if (emojiPreset.type === "custom" && emojiPreset.image_path) {
      setPickedPath(emojiPreset.image_path);
      setPickedUnicode(null);
    } else {
      setPickedPath(null);
      setPickedUnicode(emojiPreset.value);
    }
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
      onDone();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Gagal nyimpen preset artis.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <ArtistAvatar user={user} imagePath={pickedPath || preset?.image_path} />
        <div className="caption" style={{ width: 100, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={user.name}>
          {user.name}
        </div>
        <input autoFocus placeholder="Nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 4 }}>
          <span className="caption" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {pickedUnicode && `${pickedUnicode} `}
            {codeName ? `:${codeName}:` : <span className="muted">— pilih emoji —</span>}
          </span>
          <EmojiPicker onPick={(_text, emojiPreset) => pickEmojiPreset(emojiPreset)} />
        </div>
        <button className="btn btn-primary" disabled={busy} onClick={save} style={{ padding: "4px 8px", fontSize: 11, flexShrink: 0 }}>
          Simpan
        </button>
        <button className="btn" disabled={busy} onClick={onCancel} style={{ padding: "4px 8px", fontSize: 11, flexShrink: 0 }}>
          Batal
        </button>
      </div>
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
