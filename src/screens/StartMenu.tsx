import { useEffect, useState } from "react";
import { FolderOpen, Plus, Upload, Hash, LogOut, Lock, Trash2, Settings } from "lucide-react";
import type { AuthStatus, ProjectSummary, SlackChannel, SlackUser } from "../global";
import ChannelPicker from "./ChannelPicker";
import SlackSyncSettingsModal from "./SlackSyncSettingsModal";

// Sama kayak UX asli Slack pas bikin channel: lowercase & spasi->dash langsung pas ngetik,
// karakter gak valid ditolak (gak sekadar dibersihin pas submit). Cermin regex server-side
// di slack.cjs createPrivateChannel, minus trim leading/trailing dash biar gak ganggu user
// yang masih lagi ngetik.
function sanitizeChannelInput(raw: string) {
  return raw.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "");
}

export default function StartMenu({
  auth,
  isOwner,
  isAdminMember,
  onOpenProject,
}: {
  auth: AuthStatus;
  /** Sistem Admin/Member (poin revisi, diminta user) — buka section "Manage Member Admin" DI
   * DALAM modal Sync & Otomasi Slack. */
  isOwner: boolean;
  /** Gate munculnya gear Settings ini sama sekali — user biasa (bukan admin-member channel
   * "hb-adm") gak butuh liat App-Level Token paste UI, gak ada fitur yang mereka bisa nyalain
   * dari situ. */
  isAdminMember: boolean;
  onOpenProject: (id: string) => void;
}) {
  const [legacyCount, setLegacyCount] = useState(0);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [channels, setChannels] = useState<SlackChannel[]>([]);
  const [users, setUsers] = useState<SlackUser[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [mode, setMode] = useState<"existing" | "new-channel">("existing");
  const [newName, setNewName] = useState("");
  const [newChannelId, setNewChannelId] = useState("");
  const [newChannelName, setNewChannelName] = useState("");
  const [newChannelMembers, setNewChannelMembers] = useState<Set<string>>(new Set());
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updateUrl, setUpdateUrl] = useState<string | null>(null);
  // Versi app sendiri (poin revisi) — sebelumnya cuma dipakai INTERNAL buat bandingin ke rilis
  // terbaru (app.getVersion(), updater.cjs), gak pernah ditampilin ke user. Dipisah dari
  // update.check yang butuh internet/GitHub API (bisa gagal kalau offline) — ini murni lokal,
  // jadi user SELALU bisa liat versi yang lagi jalan, terlepas dari ada update baru atau gak.
  const [version, setVersion] = useState<string | null>(null);
  // Papan status HB Apps (poin revisi, hasil diskusi rate-limit) — modal opsional, SEKALI per
  // proses app (main.cjs yang nentuin, bukan state lokal — biar gak nongol lagi kalau user
  // navigasi keluar-masuk Start Menu dalam sesi yang sama).
  const [showHbModal, setShowHbModal] = useState(false);
  const [hbBusy, setHbBusy] = useState(false);
  // Sync 2 Arah Reaction Slack (poin revisi, pindah dari menu Settings dalam project) — ini
  // pengaturan GLOBAL (App-Level Token, bukan per-project), jadi lebih pas diakses dari Start
  // Menu (sebelum/di luar buka project manapun), bukan nested di menu bar dalam 1 project.
  const [showSlackSyncSettings, setShowSlackSyncSettings] = useState(false);

  useEffect(() => {
    window.api.project.legacyCount().then(setLegacyCount).catch((err) => setError(err.message));
    window.api.project.list().then(setProjects).catch((err) => setError(err.message));
    window.api.app.version().then(setVersion).catch(() => undefined);
    window.api.update.check().then((result) => {
      if (result.available && result.url) setUpdateUrl(result.url);
    }).catch(() => undefined);
    window.api.hbStatus.shouldShowModal().then(setShowHbModal).catch(() => undefined);
    const offUsersUpdated = window.api.slack.onUsersUpdated((list) => setUsers(list.filter((u) => u.id !== auth.userId)));
    return offUsersUpdated;
  }, [auth.userId]);

  function openNewProjectForm() {
    setShowNew(true);
    setLoadingChannels(true);
    window.api.slack
      .listChannels()
      .then(setChannels)
      .catch((err) => setError(err.message))
      .finally(() => setLoadingChannels(false));
  }

  function switchToNewChannelMode() {
    setMode("new-channel");
    if (!users.length) {
      setLoadingUsers(true);
      window.api.slack
        .listUsers()
        // Diri sendiri (yang login) dihilangkan dari daftar invite — udah otomatis jadi
        // owner channel pas dibuat, conversations.invite nolak invite diri sendiri
        // ("cant_invite_self") kalau kecentang.
        .then((list) => setUsers(list.filter((u) => u.id !== auth.userId)))
        .catch((err) => setError(err.message))
        .finally(() => setLoadingUsers(false));
    }
  }

  async function createProject() {
    if (!newName.trim()) return;
    setError(null);
    setCreating(true);
    try {
      let channelId: string;
      let channelName: string;

      if (mode === "existing") {
        const channel = channels.find((c) => c.id === newChannelId);
        if (!channel) return;
        channelId = channel.id;
        channelName = channel.name;
      } else {
        if (!newChannelName.trim()) return;
        const created = await window.api.slack.createChannel({
          name: newChannelName.trim(),
          memberIds: Array.from(newChannelMembers),
        });
        channelId = created.channelId;
        channelName = created.name;
      }

      const project = await window.api.project.create({ name: newName.trim(), channelId, channelName });
      onOpenProject(project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal buat project.");
    } finally {
      setCreating(false);
    }
  }

  async function handleImport() {
    setError("");
    try {
      const res = await window.api.project.import();
      if (!res.canceled && res.projectId) onOpenProject(res.projectId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal mengimpor project.");
    }
  }

  const canSubmit = newName.trim() && (mode === "existing" ? !!newChannelId : newChannelName.trim());

  async function recoverLegacy() {
    await window.api.project.recoverLegacy();
    setProjects(await window.api.project.list());
    setLegacyCount(await window.api.project.legacyCount());
  }

  // Poin revisi: hapus project langsung dari Start Menu (dulu cuma bisa lewat menu File di
  // dalam project) — icon doang (Trash2), gak ada teks. Sama pola konfirmasi kayak
  // handleDeleteProject di MainTable.tsx.
  async function handleDeleteProject(id: string, name: string) {
    if (!confirm(`Hapus project "${name}"? Ini gak bisa dibatalkan.`)) return;
    await window.api.project.delete(id);
    setProjects((prev) => prev.filter((p) => p.id !== id));
  }

  async function goOnline() {
    setHbBusy(true);
    try {
      await window.api.hbStatus.goOnline();
    } finally {
      setHbBusy(false);
      setShowHbModal(false);
    }
  }
  async function skipHbModal() {
    setShowHbModal(false);
    await window.api.hbStatus.skip();
  }

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 24px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <h1>Slack Intake Apps</h1>
          {version && <span className="caption" title="Versi yang lagi terpasang">v{version}</span>}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="caption">
            {auth.userId} · {auth.team}
          </span>
          {/* Sistem Admin/Member (poin revisi, diminta user) — gear ini (App-Level Token paste,
              yang ngaktifin Realtime Sync/Otomasi Kata Kunci) cuma buat admin-member channel
              "hb-adm", disembunyiin total dari user biasa. Poin revisi (bug ditemukan lewat
              audit, S01) — OWNER juga HARUS bisa buka ini walau BELUM jadi admin-member (channel
              "hb-adm" belum pernah dibuat) -- gate isAdminMember doang bikin owner baru gak
              pernah bisa buka modal yang justru fungsinya bikin channel itu (deadlock diri
              sendiri). isOwner || isAdminMember: owner SELALU bisa masuk buat onboarding. */}
          {(isOwner || isAdminMember) && (
            <button className="icon-btn" title="Sync 2 Arah Reaction Slack..." onClick={() => setShowSlackSyncSettings(true)}>
              <Settings size={15} />
            </button>
          )}
          <button
            className="icon-btn"
            title="Logout"
            onClick={async () => {
              await window.api.auth.logout();
              location.reload();
            }}
          >
            <LogOut size={15} />
          </button>
        </div>
      </div>

      {legacyCount > 0 && <button className="btn" onClick={recoverLegacy}>Pulihkan {legacyCount} project lama</button>}
      {error && <p role="alert" style={{ color: "var(--danger)" }}>{error}</p>}
      {!showNew ? (
        <div style={{ display: "flex", gap: 10, marginBottom: 28 }}>
          <button className="btn btn-primary" onClick={openNewProjectForm}>
            <Plus size={15} /> New Project
          </button>
          <button className="btn" onClick={handleImport}>
            <Upload size={15} /> Import Project
          </button>
        </div>
      ) : (
        <div className="card" style={{ padding: 20, marginBottom: 28 }}>
          <h2 style={{ marginBottom: 12 }}>New Project</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div>
              <div className="label" style={{ marginBottom: 4 }}>
                Nama Project
              </div>
              <input style={{ width: "100%" }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="mis. EP05 Batch" />
            </div>

            <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
              <button
                className="btn"
                style={{ flex: 1, justifyContent: "center", ...(mode === "existing" ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }}
                onClick={() => setMode("existing")}
              >
                Pilih Channel
              </button>
              <button
                className="btn"
                style={{ flex: 1, justifyContent: "center", ...(mode === "new-channel" ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }}
                onClick={switchToNewChannelMode}
              >
                <Lock size={13} /> Buat Channel Privat Baru
              </button>
            </div>

            {mode === "existing" ? (
              <div>
                <div className="label" style={{ marginBottom: 4 }}>
                  Channel Slack Tujuan
                </div>
                <ChannelPicker
                  channels={channels}
                  value={newChannelId}
                  loading={loadingChannels}
                  onChange={(c) => setNewChannelId(c.id)}
                />
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div>
                  <div className="label" style={{ marginBottom: 4 }}>
                    Nama Channel Baru
                  </div>
                  <input
                    style={{ width: "100%" }}
                    value={newChannelName}
                    onChange={(e) => setNewChannelName(sanitizeChannelInput(e.target.value))}
                    placeholder="mis. ht-ep06 (otomatis di-lowercase, spasi jadi -)"
                  />
                </div>
                <div>
                  <div className="label" style={{ marginBottom: 4 }}>
                    Invite Member ({newChannelMembers.size} dipilih)
                  </div>
                  {loadingUsers ? (
                    <span className="caption">Memuat daftar member…</span>
                  ) : (
                    <div className="card" style={{ maxHeight: 160, overflow: "auto", padding: 8 }}>
                      {users.map((u) => (
                        <label key={u.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                          <input
                            type="checkbox"
                            checked={newChannelMembers.has(u.id)}
                            onChange={(e) => {
                              setNewChannelMembers((prev) => {
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
                  )}
                </div>
              </div>
            )}


            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button className="btn btn-primary" onClick={createProject} disabled={!canSubmit || creating}>
                {creating ? "Membuat…" : "Buat Project"}
              </button>
              <button className="btn" onClick={() => setShowNew(false)}>
                Batal
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="label" style={{ marginBottom: 10 }}>
        Project Tersimpan
      </div>
      {updateUrl && (
        <button className="btn" style={{ marginBottom: 10 }} onClick={() => window.api.shell.openExternal(updateUrl)}>
          Update aplikasi tersedia
        </button>
      )}
      {projects.length === 0 ? (
        <div className="placeholder-box">
          <FolderOpen size={22} />
          <span className="caption">Belum ada project. Mulai dari "New Project" di atas.</span>
        </div>
      ) : (
        <div className="card">
          {projects.map((p) => (
            <div
              key={p.id}
              onClick={() => onOpenProject(p.id)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "12px 16px",
                borderBottom: "1px solid var(--border)",
                cursor: "pointer",
              }}
            >
              <div>
                <div style={{ fontWeight: 500 }}>{p.name}</div>
                <div className="caption" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <Hash size={11} /> {p.channel_name} · diubah {new Date(p.updated_at).toLocaleString("id-ID")}
                </div>
              </div>
              <button
                className="icon-btn"
                title="Hapus project"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteProject(p.id, p.name);
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}

      {showHbModal && (
        <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="card" style={{ padding: 16, width: 360, background: "var(--surface)" }}>
            <h3 style={{ marginBottom: 8 }}>Mulai Sesi Bersama HB Apps</h3>
            <p className="caption" style={{ marginBottom: 12 }}>
              Kasih tau Koor lain kalau kamu lagi pakai app ini — biar bisa saling koordinasi
              (kirim bareng bisa rebutan rate-limit Slack) lewat channel <code>hb-apps</code>.
              Opsional, boleh dilewati.
            </p>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }} disabled={hbBusy} onClick={goOnline}>
                {hbBusy ? "Mengirim…" : "Mulai Sesi"}
              </button>
              <button className="btn" disabled={hbBusy} onClick={skipHbModal}>
                Lewati
              </button>
            </div>
          </div>
        </div>
      )}

      {showSlackSyncSettings && <SlackSyncSettingsModal isOwner={isOwner} onClose={() => setShowSlackSyncSettings(false)} />}
    </div>
  );
}
