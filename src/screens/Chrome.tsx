import { useEffect, useRef, useState } from "react";
import { Wand2, Combine, UserCheck, Tags, Trash2, FileStack, Link as LinkIcon, HelpCircle, CheckSquare, Square, ArrowDown, ArrowUp, Loader2 } from "lucide-react";
import type { SlackUser, StatusPreset } from "../global";
import slackBlackImg from "../assets/SlackBlack.png";

// Poin revisi (diminta user, gak puas sama icon RefreshCw/ArrowDownToLine polos) — logo Slack
// hitam dipadukan arrow kecil di pojok (bawah = Pull/Slack->App, atas = Push/App->Slack), biar
// jelas kedua tombol ini soal SINKRON SLACK, bukan cuma "refresh" generik. Pas lagi proses
// (busy), ganti jadi Loader2 muter — muterin logo+badge gabungan kelihatan aneh, spinner polos
// lebih jelas bacanya sebagai "lagi jalan".
function SlackSyncIcon({ direction, busy }: { direction: "down" | "up"; busy: boolean }) {
  if (busy) return <Loader2 size={14} className="spin" />;
  const Arrow = direction === "down" ? ArrowDown : ArrowUp;
  return (
    <span style={{ position: "relative", display: "inline-flex", width: 15, height: 15, flexShrink: 0 }}>
      <img src={slackBlackImg} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
      <span
        style={{
          position: "absolute", right: -4, bottom: -4, width: 11, height: 11, borderRadius: "50%",
          background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center",
          border: "1.5px solid var(--surface)",
        }}
      >
        <Arrow size={7} color="#fff" strokeWidth={3} />
      </span>
    </span>
  );
}

export interface SidebarActions {
  onGenerateItem: () => void;
  onMerge: () => void;
  canMerge: boolean;
  onRemoveSelected: () => void;
  canRemove: boolean;
  onBatchFile: () => void;
  onHyperlinkManager: () => void;
  onHelp: () => void;
  /** Poin revisi: assign artis SEKALIGUS ke semua item yang checkbox-nya dicentang — di bawah
   * Merge, sama-sama butuh `selected` gak kosong. Popover-nya sendiri (daftar artis) dikelola di
   * sini, mirip pola ArtistPicker.tsx, cuma callback-nya bulk (id doang, bukan per-item). */
  users: SlackUser[];
  onBulkAssignArtist: (artistId: string) => void;
  canBulkAssignArtist: boolean;
  /** Poin revisi — sama konsep kayak bulk assign artis di atas, cuma buat Status (single-select,
   * REPLACE bukan toggle). Gantiin slot "Grup Artis" yang dihapus dari sidebar (fitur itu tetap
   * ada, aksesnya lewat Main menu > Settings/Edit sekarang). */
  statusPresets: StatusPreset[];
  onBulkAssignStatus: (statusId: string) => void;
  canBulkAssignStatus: boolean;
}

// Sidebar ikon vertikal, niru posisi Command Builder — M = Merge, langsung eksekusi merge
// pakai separator aktif (default "-"), BUKAN buka menu Edit lagi. "Tambah Item" dihapus dari
// sini, pindah jadi baris "+" di dalam tabel (lihat MainTable).
export function Sidebar(a: SidebarActions) {
  const items: Array<{ icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }> = [
    { icon: <Wand2 size={16} />, label: "Generate Item", onClick: a.onGenerateItem },
    { icon: <FileStack size={16} />, label: "Batch File", onClick: a.onBatchFile },
    { icon: <Combine size={16} />, label: "Merge (M)", onClick: a.onMerge, disabled: !a.canMerge },
  ];
  const afterMerge: Array<{ icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }> = [
    { icon: <Trash2 size={16} />, label: "Hapus Terpilih", onClick: a.onRemoveSelected, disabled: !a.canRemove },
    { icon: <LinkIcon size={16} />, label: "Hyperlink Preset", onClick: a.onHyperlinkManager },
  ];

  return (
    <div style={{ width: 48, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", alignItems: "center", padding: "10px 0", gap: 4 }}>
      {items.map((it) => (
        <button key={it.label} className="icon-btn" title={it.label} onClick={it.onClick} disabled={it.disabled} style={{ width: 34, height: 34 }}>
          {it.icon}
        </button>
      ))}
      <BulkAssignArtistButton users={a.users} onPick={a.onBulkAssignArtist} disabled={!a.canBulkAssignArtist} />
      <BulkAssignStatusButton statusPresets={a.statusPresets} onPick={a.onBulkAssignStatus} disabled={!a.canBulkAssignStatus} />
      {afterMerge.map((it) => (
        <button key={it.label} className="icon-btn" title={it.label} onClick={it.onClick} disabled={it.disabled} style={{ width: 34, height: 34 }}>
          {it.icon}
        </button>
      ))}
      <div style={{ flex: 1 }} />
      <button className="icon-btn" title="Keyboard Shortcuts" onClick={a.onHelp} style={{ width: 34, height: 34 }}>
        <HelpCircle size={16} />
      </button>
    </div>
  );
}

function BulkAssignArtistButton({ users, onPick, disabled }: { users: SlackUser[]; onPick: (artistId: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        className="icon-btn"
        title="Assign artis ke item yang dicentang"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        style={{ width: 34, height: 34 }}
      >
        <UserCheck size={16} />
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", top: 0, left: "calc(100% + 4px)", minWidth: 200, zIndex: 30, padding: 4 }} onMouseDown={(e) => e.stopPropagation()}>
          <div style={{ maxHeight: 220, overflow: "auto" }} className="scrollbar-thin">
            {users.map((u) => (
              <button
                key={u.id}
                className="btn"
                style={{ width: "100%", justifyContent: "flex-start", border: "none", fontSize: 12 }}
                onClick={() => { onPick(u.id); setOpen(false); }}
              >
                {u.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Poin revisi — sama pola persis kayak BulkAssignArtistButton, cuma target-nya Status (single-
// select, REPLACE status item yang dicentang, bukan toggle add/remove kayak artis).
function BulkAssignStatusButton({ statusPresets, onPick, disabled }: { statusPresets: StatusPreset[]; onPick: (statusId: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        className="icon-btn"
        title="Assign status ke item yang dicentang"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        style={{ width: 34, height: 34 }}
      >
        <Tags size={16} />
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", top: 0, left: "calc(100% + 4px)", minWidth: 200, zIndex: 30, padding: 4 }} onMouseDown={(e) => e.stopPropagation()}>
          <div style={{ maxHeight: 220, overflow: "auto" }} className="scrollbar-thin">
            {statusPresets.length === 0 && <div className="caption" style={{ padding: "8px 4px" }}>Belum ada preset Status.</div>}
            {statusPresets.map((p) => (
              <button
                key={p.id}
                className="btn"
                style={{ width: "100%", justifyContent: "flex-start", border: "none", fontSize: 12 }}
                onClick={() => { onPick(p.id); setOpen(false); }}
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export interface MenuBarActions {
  onImportProject: () => void;
  onExportProject: () => void;
  onSaveAs: () => void;
  onDeleteProject: () => void;
  onBackToStartMenu: () => void;
  mergeSeparator: "," | "-";
  onMergeSeparatorChange: (separator: "," | "-") => void;
  onToggleWorkload: () => void;
  onToggleLog: () => void;
  onGroupEditor: () => void;
  onHyperlinkManager: () => void;
  onEmojiPresetManager: () => void;
  onArtistPresetManager: () => void;
  onHelp: () => void;
  openMenu: MenuName | null;
  onOpenMenuChange: (m: MenuName | null) => void;
  /** Toggle global Instant Intake + Instant Reaction (poin revisi) — di menu Settings, gak sentuh
   * tombol "Add React" (ItemReactionBar). */
  instantIntakeEnabled: boolean;
  onToggleInstantIntake: () => void;
  /** Poin revisi — buka modal "Kelola Otomasi Kata Kunci" (berdiri sendiri, punya toggle
   * enable/disable sendiri di dalamnya), dari sub menu Settings. */
  onKeywordAutomation: () => void;
  /** Sistem Admin/Member (poin revisi, diminta user) — sembunyiin entry "Otomasi Kata Kunci..."
   * ini kalau bukan member channel "hb-adm" (default OFF/hidden buat user biasa). */
  isAdminMember: boolean;
}

/** Poin revisi — Pull, Push, Toggle Realtime Sync (icon doang, gak ada teks). DULUNYA bagian dari
 * MenuBar (section rata kanan menu bar), sekarang komponen berdiri sendiri: tahap Setup/Assign
 * (poin revisi lanjutan, diminta user) cuma nampilin ini pas tahap Assign, direposisi ke baris
 * folder-tabbar (gantiin tombol "Kirim ke Slack" yang disembunyiin di tahap itu) — lihat
 * MainTable.tsx. Urutan: Pull (Slack->App) dulu, baru Push (App->Slack), baru toggle.
 */
export interface SyncControlsProps {
  realtimeAssignEnabled: boolean;
  onToggleRealtimeAssign: () => void;
  syncingAssign: boolean;
  onSyncAssignToSlack: () => void;
  pulling: boolean;
  onPullFromSlack: () => void;
  /** Teks buat tooltip Pull/Push, beda tergantung tab aktif ("semua item project ini" di Tab
   * Table, `item "nama"` di Tab Input). */
  scopeLabel: string;
  /** Sistem Admin/Member (poin revisi, diminta user) — toggle Realtime Sync (event/Socket Mode)
   * disembunyiin buat user biasa, default OFF sampai jadi member channel "hb-adm". Pull/Push
   * (manual, Web API doang) TETAP kepake semua orang, gak ikut digate. */
  isAdminMember: boolean;
}

export function SyncControls(a: SyncControlsProps) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <button
        className="icon-btn"
        title={`Pull — tarik update dari Slack ke ${a.scopeLabel} (react manual + kata kunci di reply thread yang mungkin kelewat pas app offline)`}
        onClick={a.onPullFromSlack}
        disabled={a.pulling}
      >
        <SlackSyncIcon direction="down" busy={a.pulling} />
      </button>
      <button
        className="icon-btn"
        title={`Push — kirim state app ke Slack buat ${a.scopeLabel} (react/mention/status sesuai mode assign saat ini)`}
        onClick={a.onSyncAssignToSlack}
        disabled={a.syncingAssign}
      >
        <SlackSyncIcon direction="up" busy={a.syncingAssign} />
      </button>
      {a.isAdminMember && (
        <input
          type="checkbox"
          className="toggle-switch"
          title="Sesi assign artis realtime — assign/lepas artis & ganti status langsung sinkron ke Slack"
          checked={a.realtimeAssignEnabled}
          onChange={a.onToggleRealtimeAssign}
        />
      )}
    </div>
  );
}

const MENUS = ["File", "Edit", "View", "Settings", "Help"] as const;
export type MenuName = (typeof MENUS)[number];

export function MenuBar(a: MenuBarActions) {
  const { openMenu: open, onOpenMenuChange: setOpen } = a;
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Klik di luar menu bar = tutup. Ganti pola onBlur+setTimeout lama yang race-y (nyebabin
  // dropdown kebuka-lalu-ketutup sendiri, baru klik ke-2 baru beneran kebuka).
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(null);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open, setOpen]);

  const contents: Record<MenuName, Array<{ label: string; onClick: () => void }>> = {
    File: [
      { label: "Import Project", onClick: a.onImportProject },
      { label: "Export Project", onClick: a.onExportProject },
      { label: "Save As", onClick: a.onSaveAs },
      { label: "Hapus Project", onClick: a.onDeleteProject },
      { label: "Kembali ke Start Menu", onClick: a.onBackToStartMenu },
    ],
    Edit: [
      { label: "Preset Emoji...", onClick: a.onEmojiPresetManager },
      { label: "Preset Artis...", onClick: a.onArtistPresetManager },
    ],
    View: [
      { label: "Workload Distribution", onClick: a.onToggleWorkload },
      { label: "Message Log", onClick: a.onToggleLog },
    ],
    Settings: [
      { label: "Grup Artis", onClick: a.onGroupEditor },
      { label: "Hyperlink Preset", onClick: a.onHyperlinkManager },
      // Sistem Admin/Member (poin revisi, diminta user) — default hidden, cuma admin-member
      // channel "hb-adm" yang liat entry ini.
      ...(a.isAdminMember ? [{ label: "Otomasi Kata Kunci...", onClick: a.onKeywordAutomation }] : []),
    ],
    Help: [{ label: "Keyboard Shortcuts", onClick: a.onHelp }],
  };

  return (
    <div ref={containerRef} style={{ display: "flex", gap: 2, padding: "4px 10px", borderBottom: "1px solid var(--border)", position: "relative" }}>
      {MENUS.map((m) => (
        <div key={m} style={{ position: "relative" }}>
          <button
            className="btn"
            style={{ border: "none", padding: "4px 10px", fontWeight: 500, ...(open === m ? { background: "var(--surface-hover)" } : {}) }}
            onClick={() => setOpen(open === m ? null : m)}
          >
            {m}
          </button>
          {open === m && (
            <div className="card" style={{ position: "absolute", top: 30, left: 0, width: 220, padding: 4, zIndex: 40 }}>
              {m === "Edit" && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 8px" }}>
                  <span style={{ fontSize: 13 }}>Merge default</span>
                  <div style={{ display: "flex", border: "1px solid var(--border-strong)", borderRadius: 6, overflow: "hidden" }}>
                    {(["," , "-"] as const).map((sep) => (
                      <button
                        key={sep}
                        className="btn"
                        style={{
                          border: "none",
                          borderRadius: 0,
                          padding: "3px 12px",
                          ...(sep === "-" ? { borderLeft: "1px solid var(--border-strong)" } : {}),
                          ...(a.mergeSeparator === sep ? { background: "var(--accent)", color: "#fff" } : {}),
                        }}
                        onClick={() => a.onMergeSeparatorChange(sep)}
                      >
                        {sep}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {m === "Settings" && (
                <button
                  className="btn"
                  style={{ width: "100%", justifyContent: "space-between", border: "none", padding: "6px 8px" }}
                  onClick={() => a.onToggleInstantIntake()}
                >
                  <span>Instant Intake</span>
                  {a.instantIntakeEnabled ? <CheckSquare size={14} /> : <Square size={14} />}
                </button>
              )}
              {contents[m].map((item) => (
                <button
                  key={item.label}
                  className="btn"
                  style={{ width: "100%", justifyContent: "flex-start", border: "none", padding: "6px 8px" }}
                  onClick={() => {
                    item.onClick();
                    setOpen(null);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
