// Modal "Sync & Otomasi Slack" (poin revisi) — Sync 2 arah reaction: nambah/lepas reaction MANUAL
// di Slack (emoji yang cocok code_name preset Artis/Status) otomatis assign artis/set status di
// app ini, kebalikan dari arah biasa (app -> Slack). Socket Mode = koneksi WebSocket KELUAR (app
// ini gak punya server publik buat nerima webhook HTTP) + App-Level Token (xapp-...) yang
// di-generate manual sekali sama admin Slack App.
//
// App-Level Token itu rahasia level WORKSPACE APP (bukan per-user kayak token OAuth login biasa)
// — SENGAJA gak lewat proses build/installer (lihat electron/auth-store.cjs), user paste sendiri
// di sini, disimpen terenkripsi LOKAL di device itu doang.
//
// Poin revisi (diminta user) — Otomasi Kata Kunci (fitur lain yang numpang Socket Mode koneksi
// yang SAMA) sekarang modal berdiri sendiri (KeywordAutomationModal, trigger dari Main menu >
// Settings), gak nested di sini lagi.
import { useEffect, useState } from "react";
import { X, Wifi, WifiOff, Loader2, UserPlus, Trash2 } from "lucide-react";
import type { SlackUser } from "../global";

const STATUS_LABEL: Record<string, string> = {
  connecting: "Menghubungkan…",
  connected: "Terhubung",
  disconnected: "Terputus",
  error: "Error",
};

export default function SlackSyncSettingsModal({ isOwner, onClose }: { isOwner: boolean; onClose: () => void }) {
  const [hasToken, setHasToken] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string>("disconnected");
  const [tokenInput, setTokenInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.api.slackSocket.hasToken().then(setHasToken);
    window.api.slackSocket.isRunning().then(setRunning);
    return window.api.slackSocket.onStatus((data) => {
      setStatus(data.status);
      setRunning(data.status === "connected");
      if (data.status === "error") setError(data.detail);
    });
  }, []);

  // Sistem Admin/Member (poin revisi, diminta user) — section "Manage Member Admin", OWNER doang
  // (backend juga nge-guard ulang tiap panggilan admin:*, ini cuma UI). Member channel "hb-adm"
  // = otomatis dapet fitur Sync Realtime/Otomasi Kata Kunci abis login ulang (lihat adminAccess.cjs).
  const [members, setMembers] = useState<{ id: string; name: string }[] | null>(null);
  const [allUsers, setAllUsers] = useState<SlackUser[]>([]);
  const [memberBusy, setMemberBusy] = useState<string | null>(null);
  const [memberError, setMemberError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOwner) return;
    window.api.admin.listChannelMembers().then((r) => setMembers(r.members)).catch((err) => setMemberError(err instanceof Error ? err.message : "Gagal muat member admin."));
    window.api.slack.listUsers().then(setAllUsers).catch(() => undefined);
  }, [isOwner]);

  async function addMember(userId: string) {
    setMemberBusy(userId);
    setMemberError(null);
    try {
      await window.api.admin.addMember(userId);
      const r = await window.api.admin.listChannelMembers();
      setMembers(r.members);
    } catch (err) {
      setMemberError(err instanceof Error ? err.message : "Gagal nambah member.");
    } finally {
      setMemberBusy(null);
    }
  }

  async function removeMember(userId: string) {
    setMemberBusy(userId);
    setMemberError(null);
    try {
      await window.api.admin.removeMember(userId);
      setMembers((prev) => prev?.filter((m) => m.id !== userId) || null);
    } catch (err) {
      setMemberError(err instanceof Error ? err.message : "Gagal hapus member.");
    } finally {
      setMemberBusy(null);
    }
  }

  const nonMembers = allUsers.filter((u) => !members?.some((m) => m.id === u.id));

  async function save() {
    if (!tokenInput.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.slackSocket.setToken(tokenInput.trim());
      setTokenInput("");
      setHasToken(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal simpan/konek token.");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm("Hapus App-Level Token? Sync 2 arah reaction bakal berhenti sampai token dipasang lagi.")) return;
    setBusy(true);
    try {
      await window.api.slackSocket.clearToken();
      setHasToken(false);
      setRunning(false);
      setStatus("disconnected");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div className="card scrollbar-thin" style={{ padding: 16, width: 500, maxHeight: "85vh", overflow: "auto", background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h3>Sync &amp; Otomasi Slack</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup" title="Tutup">
            <X size={14} />
          </button>
        </div>

        <p className="caption" style={{ marginBottom: 10 }}>
          Kalau user nambah/lepas react LANGSUNG di Slack pakai emoji yang cocok code_name preset
          Artis atau Status, app ini otomatis assign artis / set status yang sesuai — kebalikan
          dari arah biasa (app → Slack). Koneksi ini juga dipakai fitur "Otomasi Kata Kunci"
          (Main menu &gt; Settings di dalam project).
        </p>

        <div className="label" style={{ marginBottom: 4 }}>
          Setup sekali (butuh akses admin Slack App)
        </div>
        <ol className="caption" style={{ marginBottom: 14, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 }}>
          <li>
            Buka <b>api.slack.com/apps</b> → pilih App ini → menu <b>Socket Mode</b> → aktifkan.
          </li>
          <li>
            <b>Basic Information</b> → <b>App-Level Tokens</b> → Generate Token, kasih scope{" "}
            <code>connections:write</code>, salin token-nya (diawali <code>xapp-</code>).
          </li>
          <li>
            <b>OAuth &amp; Permissions</b> → User Token Scopes → pastikan <code>reactions:read</code>{" "}
            udah ditambahin (dan <code>channels:history</code> + <code>groups:history</code> kalau
            mau pakai Otomasi Kata Kunci di bawah).
          </li>
          <li>
            <b>Event Subscriptions</b> → aktifkan → "Subscribe to events on behalf of users" → tambah{" "}
            <code>reaction_added</code> dan <code>reaction_removed</code> (dan{" "}
            <code>message.channels</code> + <code>message.groups</code> kalau mau pakai Otomasi
            Kata Kunci).
          </li>
          <li>Semua user app ini logout lalu login ulang (biar dapet scope baru di atas).</li>
        </ol>

        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
          {running ? <Wifi size={14} color="var(--success)" /> : <WifiOff size={14} className="muted" />}
          <span className="caption">Status koneksi: {STATUS_LABEL[status] || status}</span>
        </div>

        {hasToken ? (
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn" disabled={busy} onClick={remove}>
              Hapus Token
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 6 }}>
            <input
              placeholder="xapp-..."
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              style={{ flex: 1 }}
            />
            <button className="btn btn-primary" disabled={busy || !tokenInput.trim()} onClick={save}>
              {busy ? <Loader2 size={13} className="spin" /> : "Simpan & Konek"}
            </button>
          </div>
        )}
        {error && (
          <p className="caption" style={{ color: "var(--danger)", marginTop: 8 }}>
            {error}
          </p>
        )}

        {/* Manage Member Admin (poin revisi, diminta user) — OWNER doang. Nambah/hapus member
            channel privat "hb-adm" -- siapa pun di dalamnya otomatis dapet Sync Realtime +
            Otomasi Kata Kunci abis login ulang, gak ada data custom yang perlu diurus manual. */}
        {isOwner && (
          <div style={{ borderTop: "1px solid var(--border)", marginTop: 14, paddingTop: 14 }}>
            <div className="label" style={{ marginBottom: 6 }}>
              Manage Member Admin (channel #hb-adm)
            </div>
            <p className="caption" style={{ marginBottom: 8 }}>
              Member di sini otomatis dapet fitur Sync Realtime &amp; Otomasi Kata Kunci setelah
              login ulang — hapus dari sini buat cabut aksesnya lagi.
            </p>
            {memberError && (
              <p className="caption" style={{ color: "var(--danger)", marginBottom: 8 }}>
                {memberError}
              </p>
            )}
            {members === null ? (
              <span className="caption">Memuat member…</span>
            ) : (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
                  {members.length === 0 && <span className="caption">Belum ada member admin.</span>}
                  {members.map((m) => (
                    <div key={m.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "3px 0" }}>
                      <span>{m.name}</span>
                      <button className="icon-btn" title="Cabut akses admin" disabled={memberBusy === m.id} onClick={() => removeMember(m.id)}>
                        {memberBusy === m.id ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />}
                      </button>
                    </div>
                  ))}
                </div>
                {nonMembers.length > 0 && (
                  <div className="card" style={{ maxHeight: 140, overflow: "auto", padding: 6 }}>
                    {nonMembers.map((u) => (
                      <div key={u.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "3px 4px" }}>
                        <span>{u.name}</span>
                        <button className="icon-btn" title="Tambah jadi admin" disabled={memberBusy === u.id} onClick={() => addMember(u.id)}>
                          {memberBusy === u.id ? <Loader2 size={13} className="spin" /> : <UserPlus size={13} />}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
