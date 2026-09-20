// Modal "Kelola Otomasi Kata Kunci" (poin revisi — digeneralisasi dari "Otomasi WIP" yang awalnya
// hardcode "@WIP" -> status "Working on it" doang). User bikin sendiri daftar mapping "kata kunci
// di reply thread item" -> "set status ATAU assign artis" — dieksekusi di main.cjs
// (handleIncomingMessage) tiap ada pesan Slack yang cocok, lewat Socket Mode yang sama kayak sync
// 2 arah reaction (lihat SlackSyncSettingsModal).
// Poin revisi (diminta user) — modal ini sekarang BERDIRI SENDIRI (trigger-nya Main menu >
// Settings), toggle master ON/OFF-nya dipindah ke sini juga (dulu di modal "Sync & Otomasi
// Slack" di Start Menu) — butuh koneksi Socket Mode dari modal itu tetap konek biar beneran aktif.
import { useEffect, useState } from "react";
import { X, Trash2, Plus } from "lucide-react";
import type { KeywordAutomation, SlackUser, StatusPreset } from "../global";
import { showToast } from "../lib/toast";

export default function KeywordAutomationModal({ onClose }: { onClose: () => void }) {
  const [automations, setAutomations] = useState<KeywordAutomation[]>([]);
  const [statusPresets, setStatusPresets] = useState<StatusPreset[]>([]);
  const [users, setUsers] = useState<SlackUser[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [enabled, setEnabled] = useState(false);

  function refresh() {
    window.api.keywordAutomation.list().then(setAutomations);
  }
  useEffect(() => {
    refresh();
    window.api.statusPreset.list().then(setStatusPresets);
    // Poin revisi (bug dilaporkan: gagal fetch listUsers nongolin alert() native jelek) — toast
    // doang kalau gagal, gak boleh nge-crash ke alert() blocking.
    window.api.slack.listUsers().then(setUsers).catch((err) => showToast(err instanceof Error ? err.message : "Gagal ambil daftar user Slack.", "error"));
    window.api.keywordAutomation.getEnabled().then(setEnabled);
  }, []);

  async function toggleEnabled() {
    const next = !enabled;
    setEnabled(next);
    await window.api.keywordAutomation.setEnabled(next);
  }

  async function remove(id: string) {
    if (!confirm("Hapus otomasi ini?")) return;
    await window.api.keywordAutomation.remove(id);
    refresh();
  }

  function targetLabel(a: KeywordAutomation) {
    if (a.target_type === "status") return statusPresets.find((p) => p.id === a.target_id)?.name || "(status gak ketemu — mungkin udah dihapus)";
    return users.find((u) => u.id === a.target_id)?.name || "(artis gak ketemu)";
  }

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 65, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div className="card scrollbar-thin" style={{ padding: 16, width: 480, maxHeight: "85vh", overflow: "auto", background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
          <h3>Otomasi Kata Kunci</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup" title="Tutup">
            <X size={14} />
          </button>
        </div>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", marginBottom: 10 }}>
          <input type="checkbox" checked={enabled} onChange={toggleEnabled} style={{ marginTop: 2 }} />
          <span>
            <span style={{ display: "block" }}>Aktifkan Otomasi Kata Kunci</span>
            <span className="caption" style={{ display: "block" }}>
              Siapa pun yang mengirim pesan thread pada item dengan kata kunci seperti @WIP atau
              @DONE akan otomatis menambahkan react yang sesuai. Pastikan "Sync & Otomasi Slack"
              di Start Menu tetap terhubung melalui Socket Mode.
            </span>
          </span>
        </label>

        {automations.length === 0 && !adding && <p className="caption">Belum ada otomasi — tambah dulu di bawah.</p>}
        {automations.map((a) =>
          editingId === a.id ? (
            <AutomationEditRow
              key={a.id}
              automation={a}
              statusPresets={statusPresets}
              users={users}
              onDone={() => { setEditingId(null); refresh(); }}
              onCancel={() => setEditingId(null)}
            />
          ) : (
            <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
              <span className="caption" style={{ flexShrink: 0, fontWeight: 600 }}>
                {a.keyword}
              </span>
              <span className="caption" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                → {a.target_type === "status" ? "Status" : "Artis"}: {targetLabel(a)}
              </span>
              <button className="btn" onClick={() => setEditingId(a.id)} style={{ padding: "4px 8px", fontSize: 11, flexShrink: 0 }}>
                Edit
              </button>
              <button className="icon-btn" title="Hapus otomasi" onClick={() => remove(a.id)}>
                <Trash2 size={13} />
              </button>
            </div>
          )
        )}

        {adding ? (
          <AutomationEditRow
            automation={null}
            statusPresets={statusPresets}
            users={users}
            onDone={() => { setAdding(false); refresh(); }}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <button className="btn" style={{ width: "100%", justifyContent: "center", marginTop: 8 }} onClick={() => setAdding(true)}>
            <Plus size={13} /> Otomasi Baru
          </button>
        )}
      </div>
    </div>
  );
}

function AutomationEditRow({
  automation,
  statusPresets,
  users,
  onDone,
  onCancel,
}: {
  automation: KeywordAutomation | null;
  statusPresets: StatusPreset[];
  users: SlackUser[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [keyword, setKeyword] = useState(automation?.keyword || "");
  const [targetType, setTargetType] = useState<"status" | "artist">(automation?.target_type || "status");
  const [targetId, setTargetId] = useState(automation?.target_id || "");
  const [busy, setBusy] = useState(false);

  function switchType(next: "status" | "artist") {
    setTargetType(next);
    setTargetId(""); // ganti tipe target -- pilihan lama (id status/artis) gak relevan lagi
  }

  async function save() {
    if (!keyword.trim() || !targetId) return;
    setBusy(true);
    try {
      await window.api.keywordAutomation.save({ id: automation?.id, keyword: keyword.trim(), targetType, targetId });
      onDone();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Gagal nyimpen otomasi.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 0", borderBottom: "1px solid var(--border)" }}>
      <input autoFocus placeholder='Kata kunci, mis. "@WIP"' value={keyword} onChange={(e) => setKeyword(e.target.value)} />
      <div style={{ display: "flex", gap: 6 }}>
        <button
          className="btn"
          style={{ flex: 1, justifyContent: "center", ...(targetType === "status" ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }}
          onClick={() => switchType("status")}
        >
          Set Status
        </button>
        <button
          className="btn"
          style={{ flex: 1, justifyContent: "center", ...(targetType === "artist" ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }}
          onClick={() => switchType("artist")}
        >
          Assign Artis
        </button>
      </div>
      {targetType === "status" ? (
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
          <option value="">— pilih status —</option>
          {statusPresets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      ) : (
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
          <option value="">— pilih artis —</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn btn-primary" disabled={busy || !keyword.trim() || !targetId} onClick={save} style={{ flex: 1, justifyContent: "center" }}>
          Simpan
        </button>
        <button className="btn" disabled={busy} onClick={onCancel} style={{ flex: 1, justifyContent: "center" }}>
          Batal
        </button>
      </div>
    </div>
  );
}
