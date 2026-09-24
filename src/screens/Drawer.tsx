import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  X,
  Bold,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Paperclip,
  Trash2,
  Radio,
  FileText,
  Crop,
  ChevronLeft,
  ChevronRight,
  Plus,
  LayoutTemplate,
  Pin,
  Grip,
  Square,
  CheckSquare,
  FileVideo,
  Check,
  Settings,
  Loader2,
  ChevronDown,
  ChevronUp,
  Lock,
  Unlock,
  CircleUserRound,
} from "lucide-react";
import type { ArtistPreset, CustomHeader, HyperlinkPreset, ItemFile, ProjectItem, Reply, SlackUser, StatusPreset, Template, TemplateField } from "../global";
import { useFileBlobUrl, fileKind } from "../lib/fileUrl";
const PdfViewer = lazy(() => import("./PdfViewer"));
const VideoPlayer = lazy(() => import("./VideoPlayer"));
import RichTextEditor, { type ActiveFormats, type RichTextEditorHandle } from "./RichTextEditor";
import CapturePoolStrip from "./CapturePoolStrip";
import QuickSendButton from "./QuickSendButton";
import EmojiPicker from "./EmojiPicker";
import { ItemReactionBar, InstantReactionOverlay } from "./ItemReactions";
import ArtistPicker from "./ArtistPicker";
import StatusDropdown, { StatusEmoji } from "./StatusDropdown";
import { hoverDelayHandlers } from "../lib/hoverDelay";

// Slack sendiri gak publish angka resmi "maksimal berapa file per pesan" (dicek: dokumentasi
// cuma nyebut batas per-FILE 1GB & rate-limit 1 pesan/detik/channel, gak ada cap eksplisit
// buat JUMLAH file dalam 1 upload/share). Nilai referensi bot lama (Command Builder,
// `MULTI_FILE_MAX_PER_REPLY = 5`) dicoba dulu, tapi user tes langsung ke Slack beneran dan
// ketemu batas asli 10 — dipakai 10, bukan 5.
const MAX_FILES_PER_REPLY = 10;
function capFileRoom(existingCount: number): number {
  const room = MAX_FILES_PER_REPLY - existingCount;
  if (room <= 0) alert(`Field ini sudah penuh (maksimal ${MAX_FILES_PER_REPLY} file).`);
  return Math.max(0, room);
}

const FORM_PANE_WIDTH = 420;

// Deteksi window ke-maximize (poin revisi: "Fullscreen window, lebarkan Field input +15%") —
// Electron gak expose event maximize ke renderer secara default, jadi dipakai heuristik native:
// window kepake penuh (outerWidth/Height nyamain layar) = "fullscreen" dari sudut pandang user.
// ponytail: heuristik screen-size, upgrade ke IPC win.isMaximized()/event kalau ternyata meleset.
function useIsWindowMaximized() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    function check() {
      setMaximized(window.outerWidth >= window.screen.availWidth - 4 && window.outerHeight >= window.screen.availHeight - 4);
    }
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return maximized;
}

export default function Drawer({
  item,
  projectId,
  projectFiles,
  onChanged,
  onPrev,
  onNext,
  canPrev,
  canNext,
  users,
  senderUsers,
  artistPresets,
  onAddArtist,
  onRemoveArtist,
  onManageArtistPresets,
  statusPresets,
  onSetStatus,
  onManageStatusPresets,
  customHeaders,
  onSetCustomValue,
  onManageCustomHeaders,
  instantIntakeEnabled,
  onToggleInstantIntake,
  syncing,
  reactionTick,
  phase,
}: {
  item: ProjectItem;
  projectId: string;
  /** Tahap alur kerja Setup/Input (poin revisi, diminta user; nama lama "Assign") — "setup"
   * nyembunyiin dropdown Artis & Status (belum relevan pas masih nyusun daftar item), "input"
   * nampilin keduanya. */
  phase: "setup" | "input";
  /** General Display (poin b1 revisi) — level PROJECT, gak reset pas ganti item. */
  projectFiles: ItemFile[];
  onChanged: () => void;
  onPrev: () => void;
  onNext: () => void;
  canPrev: boolean;
  canNext: boolean;
  users: SlackUser[];
  /** Daftar penuh, tidak terpotong filter grup artis, untuk label pengirim field. */
  senderUsers: SlackUser[];
  /** Poin revisi — buat nampilin icon react/emoji preset tiap artis di ArtistPicker. */
  artistPresets: ArtistPreset[];
  /** Multi-artist (poin revisi) — assign/lepas 1 artis, dipanggil tiap toggle klik ArtistPicker. */
  onAddArtist: (item: ProjectItem, artistId: string, artistName: string | null) => void;
  onRemoveArtist: (item: ProjectItem, artistId: string) => void;
  /** Buka modal Kelola Preset Artis dari dalam ArtistPicker. Toggle Mention/React GLOBAL per
   * artis (poin revisi) diatur DI modal itu, bukan di sini lagi. Icon "Assign Mode" di header
   * section Artis (poin revisi) buka modal yang SAMA — shortcut, gak duplikat toggle-nya. */
  onManageArtistPresets: () => void;
  /** Fitur Status (poin revisi) — sama pola shared kayak Artis di atas. */
  statusPresets: StatusPreset[];
  onSetStatus: (item: ProjectItem, statusId: string | null) => void;
  onManageStatusPresets: () => void;
  customHeaders: CustomHeader[];
  onSetCustomValue: (item: ProjectItem, headerId: string, optionId: string | null) => void;
  onManageCustomHeaders: () => void;
  /** Toggle global Instant Intake + Instant Reaction (poin revisi) — matiin QuickSendButton DAN
   * InstantReactionOverlay di sini, "Add React" (ItemReactionBar) TETAP gak kesentuh. */
  instantIntakeEnabled: boolean;
  onToggleInstantIntake: () => void;
  /** Poin revisi (diminta user) — item ini lagi nunggu roundtrip reconcile ke Slack (assign/status
   * baru aja diganti), tampilin animasi spin di label "Artis" sebagai penanda, BUKAN nge-disable
   * ArtistPicker/StatusDropdown (tetap responsive, update-nya optimistic di MainTable). */
  syncing?: boolean;
  /** Poin revisi — refetch trigger buat ItemReactionBar di bawah item Pill (lihat MainTable.tsx),
   * biar chip react artis langsung nongol abis assign artis dari ArtistPicker TANPA pindah tab. */
  reactionTick: number;
}) {
  const isMaximized = useIsWindowMaximized();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [hyperlinkPresets, setHyperlinkPresets] = useState<HyperlinkPreset[]>([]);
  const [selectedReplyIds, setSelectedReplyIds] = useState<Set<string>>(new Set());
  const [showTemplateBuilder, setShowTemplateBuilder] = useState(false);
  // Section Field/Reply collapsible (poin revisi, diminta user) — preferensi tampilan doang,
  // SENGAJA gak di-reset pas ganti item (lihat useEffect [item.id] di bawah) biar konsisten
  // selama sesi buka Drawer, bukan kebuka/ketutup sendiri tiap pindah item.
  const [repliesCollapsed, setRepliesCollapsed] = useState(false);
  // Apa yang lagi tampil di DisplayPane — poin revisi terbaru: General Display (project_files,
  // per-file, statis) DAN Field Display (per REPLY, bisa punya banyak file digabung 1 chip,
  // ada halaman/pager kalau lebih dari 1) sekarang 2 KONSEP TERPISAH, bukan 1 daftar chip datar
  // per-file kayak sebelumnya. Bisa dipicu dari chip DisplayPane sendiri ATAU dari klik file
  // yang nempel di salah satu field kanan.
  const [selection, setSelection] = useState<{ kind: "general"; fileId: string } | { kind: "field"; replyId: string; fileIndex: number } | null>(null);
  // Poin revisi — status AKTIF item ini, buat chip read-only di bawah item Pill.
  const statusPreset = statusPresets.find((p) => p.id === item.status_id) || null;
  function selectField(replyId: string, fileId?: string) {
    const reply = item.replies.find((r) => r.id === replyId);
    const idx = fileId ? Math.max(0, reply?.files.findIndex((f) => f.id === fileId) ?? 0) : 0;
    setSelection({ kind: "field", replyId, fileIndex: idx });
  }

  // Capture pool (crop gambar / frame video) — sementara di memori aja (ephemeral, ilang kalau
  // ganti item/tutup app), belum ditulis ke disk sampai di-drag ke tujuannya (drop ke field).
  const [capturePool, setCapturePool] = useState<{ id: string; dataUrl: string; filename: string }[]>([]);
  function addToPool(dataUrl: string, filename: string) {
    setCapturePool((prev) => [...prev, { id: crypto.randomUUID(), dataUrl, filename }]);
  }
  function removeFromPool(id: string) {
    setCapturePool((prev) => prev.filter((p) => p.id !== id));
  }

  // b2 revisi — composer lama (input judul + editor + tombol kirim) dihapus, diganti tombol
  // sederhana: bikin 1 field kosong, langsung bisa diisi/dilengkapi di card-nya sendiri.
  async function addBlankField() {
    await window.api.reply.add({ itemId: item.id, title: "" });
    onChanged();
  }

  useEffect(() => {
    window.api.template.list().then(setTemplates);
    window.api.hyperlink.list().then(setHyperlinkPresets);
  }, []);

  // Drawer gak lagi di-`key`-in per item.id di MainTable (poin revisi: "Statis file display
  // jangan reload ketika item berganti") — General Display (projectFiles, level project) harus
  // TETAP instance yang sama pas ganti item (video/PDF gak reset posisi/zoom). Konsekuensinya,
  // state yang MEMANG per-item (seleksi reply buat dihapus, wizard template baru, capture pool
  // ephemeral) harus di-reset manual di sini — sebelumnya ke-reset gratis lewat remount.
  useEffect(() => {
    setSelectedReplyIds(new Set());
    setShowTemplateBuilder(false);
    setCapturePool([]);
  }, [item.id]);

  // C9 — panah kiri/kanan pindah item pas Tab Reply aktif, nonaktif pas fokus lagi ngetik
  // (termasuk contenteditable Lexical).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const el = document.activeElement as HTMLElement | null;
      const tag = (el?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || el?.isContentEditable) return;
      if (e.key === "ArrowLeft" && canPrev) {
        e.preventDefault();
        onPrev();
      } else if (e.key === "ArrowRight" && canNext) {
        e.preventDefault();
        onNext();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canPrev, canNext, onPrev, onNext]);

  async function applyTemplate(template: Template) {
    for (const field of template.fields) {
      await window.api.reply.add({ itemId: item.id, title: field.label });
    }
    onChanged();
  }

  // Poin revisi: item baru (belum ada reply) LANGSUNG keisi field template Default — gak lagi
  // nyuruh user pilih template dulu. autoAppliedItemIds jaga biar gak dobel-apply (item.replies
  // belum keupdate dari props SEBELUM onChanged() di atas selesai refetch, ada celah async).
  const autoAppliedItemIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (item.replies.length > 0 || !templates.length || autoAppliedItemIds.current.has(item.id)) return;
    const defaultTemplate = templates.find((t) => t.id === "tpl-default") || templates[0];
    if (!defaultTemplate) return;
    autoAppliedItemIds.current.add(item.id);
    applyTemplate(defaultTemplate);
  }, [item.id, item.replies.length, templates]);

  async function clearSelectedThisItem() {
    if (!selectedReplyIds.size) return;
    await window.api.reply.removeMany(Array.from(selectedReplyIds));
    setSelectedReplyIds(new Set());
    onChanged();
  }

  // Ikon select-all di baris "Replies (N)" — toggle semua/none.
  function toggleSelectAll() {
    setSelectedReplyIds((prev) => (prev.size === item.replies.length ? new Set() : new Set(item.replies.map((r) => r.id))));
  }
  const allSelected = item.replies.length > 0 && selectedReplyIds.size === item.replies.length;

  // C6 — scope tambahan: hapus field kategori sama di SEMUA item project ini, bukan cuma item
  // yang lagi dibuka. Lebih destruktif, dikasih confirm() eksplisit.
  async function clearSelectedAllItems() {
    if (!selectedReplyIds.size) return;
    const categories = item.replies.filter((r) => selectedReplyIds.has(r.id)).map((r) => r.category);
    if (!confirm(`Hapus ${selectedReplyIds.size} field ini di SEMUA item yang kategorinya sama? Ini gak bisa dibatalkan.`)) return;
    await window.api.reply.removeManyEverywhere(projectId, categories);
    setSelectedReplyIds(new Set());
    onChanged();
  }

  // C4 — drag-reorder reply. Drag mulai dari avatar/handle (bukan seluruh card, biar gak
  // tabrakan sama seleksi teks di field), drop di card lain = pindah ke posisi situ.
  const dragReplyId = useRef<string | null>(null);
  async function handleReplyDrop(targetId: string) {
    const draggedId = dragReplyId.current;
    dragReplyId.current = null;
    if (!draggedId || draggedId === targetId) return;
    const ids = item.replies.map((r) => r.id);
    const fromIdx = ids.indexOf(draggedId);
    const toIdx = ids.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, draggedId);
    await window.api.reply.reorder(item.id, ids);
    onChanged();
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* a. Item — struktur horizontal terpisah dari Display|Field di bawahnya: nav kiri/kanan,
          nama item center. Sengaja CLEAN — gak ada pensil/fullscreen/X lagi (poin revisi UI). */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
        <div>
          <button className="icon-btn" title="Item sebelumnya" onClick={onPrev} disabled={!canPrev}>
            <ChevronLeft size={16} />
          </button>
        </div>
        <div style={{ textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center" }}>
          {/* Koreksi poin revisi sebelumnya — bukan badge sumber (Manual/Folder Import) terpisah,
              tapi NAMA ITEM-nya sendiri yang dibungkus pil. Dibungkus lagi "pill-hover-zone" —
              poin revisi fitur Reaction: overlay reaction INSTAN nongol di pojok pil pas di-hover
              (pola sama kayak Instant Intake, delay 0.5s lewat CSS `.row-quicksend`). */}
          <div className="pill-hover-zone" style={{ position: "relative", display: "inline-flex", alignItems: "center" }} {...hoverDelayHandlers()}>
            <span
              style={{
                fontWeight: 800,
                fontSize: 18,
                padding: "4px 16px",
                borderRadius: 999,
                border: "1px solid var(--border)",
                background: "var(--surface-2, var(--surface))",
              }}
            >
              {item.name}
            </span>
            {instantIntakeEnabled && <InstantReactionOverlay projectId={projectId} itemId={item.id} />}
            {/* Poin revisi (diminta user) — chip react (status + artis assignment) sekarang di
                KANAN title, absolute biar title-nya TETAP CENTER (gak ikut flex yang ngelebarin
                pill). Tombol "Add React" dihapus (hideButton) — bar ini sekarang murni display. */}
            <div style={{ position: "absolute", left: "100%", top: "50%", transform: "translateY(-50%)", marginLeft: 8, display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
              {statusPreset && (
                <span title={`Status: ${statusPreset.name}`} style={{ display: "inline-flex", alignItems: "center", padding: 2, fontSize: 15 }}>
                  <StatusEmoji preset={statusPreset} />
                </span>
              )}
              <ItemReactionBar projectId={projectId} itemId={item.id} refreshToken={reactionTick} hideButton />
            </div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <button className="icon-btn" title="Item berikutnya" onClick={onNext} disabled={!canNext}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* b. Display | Field input — 2 kolom. */}
      <div className="drawer-columns" style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <DisplayPane
          item={item}
          projectId={projectId}
          projectFiles={projectFiles}
          onChanged={onChanged}
          capturePool={capturePool}
          onCapture={addToPool}
          onRemoveFromPool={removeFromPool}
          selection={selection}
          onSelectGeneral={(fileId) => setSelection({ kind: "general", fileId })}
          onSelectField={(replyId, fileId) => selectField(replyId, fileId)}
          onSetFieldPage={(replyId, fileIndex) => setSelection({ kind: "field", replyId, fileIndex })}
        />

        <div
          className="form-pane"
          style={{
            width: isMaximized ? FORM_PANE_WIDTH * 1.15 : FORM_PANE_WIDTH,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            borderLeft: "1px solid var(--border)",
          }}
        >
          {/* Tahap Setup/Assign (poin revisi, diminta user) — dropdown Artis & Status disembunyiin
              pas tahap Setup (belum relevan, item-nya sendiri masih disusun), nongol lagi pas
              tahap Assign. C7 — ganti artis langsung dari Tab Reply, data sama persis dgn kolom
              Artis di Tab Table. */}
          {phase === "input" && (
            <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span className="label" style={{ marginBottom: 0 }}>Artis</span>
                  {/* Poin revisi (diminta user) — Toggle Realtime Sync + tombol Update dihapus dari
                      sini, sekarang 1 kontrol GLOBAL di atas tombol "Kirim ke Slack" (MainTable.tsx),
                      kepake baik dari Tab Table maupun Tab Input. */}
                  {syncing && <span title="Lagi sinkron ke Slack…" style={{ display: "inline-flex" }}><Loader2 size={12} className="spin" /></span>}
                </div>
                {/* Icon "Assign Mode" (poin revisi) — shortcut buka Kelola Preset Artis (section
                    Mode Mention/React) tanpa perlu buka dropdown Artis Picker dulu. */}
                <button className="icon-btn" title="Assign Mode (Mention/React)" onClick={onManageArtistPresets}>
                  <Settings size={14} />
                </button>
              </div>
              {/* Artis Picker (poin revisi) — satu popover buat pilih artis + akses Kelola Preset
                  Artis, sama persis kayak Tab Table. */}
              <ArtistPicker item={item} users={users} artistPresets={artistPresets} onAddArtist={onAddArtist} onRemoveArtist={onRemoveArtist} />

              {/* Status (poin revisi, fitur baru) — DI BAWAH Dropdown Artis, sama persis kayak
                  permintaan lokasi UI-nya. */}
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 8, marginBottom: 4 }}>
                <span className="label" style={{ marginBottom: 0 }}>Status</span>
                <button className="icon-btn" title="Kelola Status" onClick={onManageStatusPresets}>
                  <Settings size={14} />
                </button>
              </div>
              <StatusDropdown statusId={item.status_id} presets={statusPresets} onChange={(statusId) => onSetStatus(item, statusId)} />
              {customHeaders.map((header) => (
                <div key={header.id} style={{ marginTop: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                    <span className="label" style={{ marginBottom: 0 }}>{header.name}</span>
                    <button className="icon-btn" title="Kelola Header" onClick={onManageCustomHeaders}><Settings size={14} /></button>
                  </div>
                  <StatusDropdown
                    statusId={item.custom_values.find((value) => value.header_id === header.id)?.option_id || null}
                    presets={header.options}
                    placeholder={header.name}
                    onChange={(optionId) => onSetCustomValue(item, header.id, optionId)}
                  />
                </div>
              ))}
            </div>
          )}

          <div style={{ flex: 1, overflow: "auto", padding: 16 }} className="scrollbar-thin">
            {/* Field/Reply section collapsible (poin revisi, diminta user) — header SELALU
                nongol (klik buat expand/collapse), beda dari sebelumnya yang cuma muncul kalau
                udah ada reply. Collapse nyembunyiin daftar reply DAN tombol "+ Reply" di footer
                (lihat di bawah), select-all/trash ikut kesembunyi karena gak ada gunanya kalau
                daftarnya lagi ketutup. */}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, cursor: "pointer" }} onClick={() => setRepliesCollapsed((v) => !v)}>
              <span className="label" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                {repliesCollapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                Replies ({item.replies.length})
              </span>
              {!repliesCollapsed && item.replies.length > 0 && (
                <div style={{ display: "flex", gap: 2 }}>
                  <button className="icon-btn" title={allSelected ? "Batal pilih semua" : "Pilih semua"} onClick={(e) => { e.stopPropagation(); toggleSelectAll(); }}>
                    {allSelected ? <CheckSquare size={14} /> : <Square size={14} />}
                  </button>
                  <button className="icon-btn" title="Hapus reply terpilih di item ini" onClick={(e) => { e.stopPropagation(); clearSelectedThisItem(); }} disabled={!selectedReplyIds.size}>
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
            {!repliesCollapsed && selectedReplyIds.size > 0 && (
              <button
                className="btn"
                onClick={clearSelectedAllItems}
                style={{ padding: "4px 8px", marginBottom: 10 }}
                title="Hapus field kategori sama di SEMUA item"
              >
                <Trash2 size={13} /> Hapus di Semua Item ({selectedReplyIds.size})
              </button>
            )}
            {!repliesCollapsed && showTemplateBuilder && (
              <TemplateBuilder
                onCancel={() => setShowTemplateBuilder(false)}
                onSaved={async (tpl) => {
                  const updated = await window.api.template.list();
                  setTemplates(updated);
                  setShowTemplateBuilder(false);
                  await applyTemplate(tpl);
                }}
              />
            )}

            {!repliesCollapsed && item.replies.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {item.replies.map((reply) => (
                  <ReplyRow
                    key={reply.id}
                    reply={reply}
                    itemId={item.id}
                    projectId={projectId}
                    users={senderUsers}
                    hyperlinkPresets={hyperlinkPresets}
                    onRefreshHyperlinks={() => window.api.hyperlink.list().then(setHyperlinkPresets)}
                    selected={selectedReplyIds.has(reply.id)}
                    onToggleSelected={() =>
                      setSelectedReplyIds((prev) => {
                        const next = new Set(prev);
                        next.has(reply.id) ? next.delete(reply.id) : next.add(reply.id);
                        return next;
                      })
                    }
                    onChanged={onChanged}
                    onSelectFile={selectField}
                    capturePool={capturePool}
                    onRemoveFromPool={removeFromPool}
                    onDragStart={() => (dragReplyId.current = reply.id)}
                    onDropOn={() => handleReplyDrop(reply.id)}
                    instantIntakeEnabled={instantIntakeEnabled}
                  />
                ))}
              </div>
            )}
          </div>

          <div style={{ borderTop: "1px solid var(--border)", padding: 10, display: "flex", gap: 6 }}>
            {/* "+ Reply" (poin revisi, diminta user) — disembunyiin pas section Replies ketutup,
                gak ada gunanya nambah field ke daftar yang lagi disembunyiin. */}
            {!repliesCollapsed && (
              <button className="btn" onClick={addBlankField} style={{ flex: 1, justifyContent: "center" }}>
                <Plus size={14} /> Reply
              </button>
            )}
            {/* Template Baru (poin revisi) — dulu cuma bisa dibuat pas item MASIH kosong (lewat
                picker yang sekarang dihapus, field Default langsung keisi otomatis). Tombol ini
                satu-satunya jalur bikin template custom baru yang tersisa, jadi TETAP dipertahankan
                di sini, gak lagi memblokir/wajib diisi dulu. */}
            <button className="icon-btn" title="Bikin Template Baru" onClick={() => setShowTemplateBuilder(true)}>
              <LayoutTemplate size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type DisplaySelection = { kind: "general"; fileId: string } | { kind: "field"; replyId: string; fileIndex: number };

// Poin revisi terbaru — General Display (kiri, statis per-file, project_files) dan Field
// Display (kanan, 1 chip per FIELD/reply, BUKAN per file lagi) sekarang 2 grup KE-PISAH SECARA
// VISUAL di baris chip yang sama (General nempel kiri, Field nempel kanan lewat
// margin-left:auto). Field yang punya lebih dari 1 file TETAP 1 chip — viewer di bawahnya
// nampilin pager ala PDF ("‹ 1/2 ›") buat pindah antar file dalam field itu, bukan bikin chip
// terpisah per file (itu yang bikin "Animatic"/"General Note" dobel-dobel sebelumnya).
function DisplayPane({
  item,
  projectId,
  projectFiles,
  onChanged,
  capturePool,
  onCapture,
  onRemoveFromPool,
  selection,
  onSelectGeneral,
  onSelectField,
  onSetFieldPage,
}: {
  item: ProjectItem;
  projectId: string;
  projectFiles: ItemFile[];
  onChanged: () => void;
  capturePool: { id: string; dataUrl: string; filename: string }[];
  onCapture: (dataUrl: string, filename: string) => void;
  onRemoveFromPool: (id: string) => void;
  selection: DisplaySelection | null;
  onSelectGeneral: (fileId: string) => void;
  onSelectField: (replyId: string, fileId?: string) => void;
  onSetFieldPage: (replyId: string, fileIndex: number) => void;
}) {
  const generalChips = projectFiles;
  const fieldChips = item.replies.filter((r) => r.files.length > 0);
  const idsKey = generalChips.map((f) => f.id).join(",") + "|" + fieldChips.map((r) => `${r.id}:${r.files.length}`).join(",");

  useEffect(() => {
    const stillValid =
      selection?.kind === "general"
        ? generalChips.some((f) => f.id === selection.fileId)
        : selection?.kind === "field"
          ? fieldChips.some((r) => r.id === selection.replyId)
          : false;
    if (!stillValid) {
      if (generalChips[0]) onSelectGeneral(generalChips[0].id);
      else if (fieldChips[0]) onSelectField(fieldChips[0].id);
    }
    // idsKey dipakai sebagai dep proxy (array baru tiap render).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  async function addGeneralFile() {
    const paths = await window.api.item.pickFiles();
    if (paths.length) {
      await window.api.project.attachFiles(projectId, paths);
      onChanged();
    }
  }

  const activeField = selection?.kind === "field" ? fieldChips.find((r) => r.id === selection.replyId) : undefined;
  const fieldPage = activeField ? Math.min(Math.max(0, selection && selection.kind === "field" ? selection.fileIndex : 0), activeField.files.length - 1) : 0;
  const selectedFile = selection?.kind === "general" ? generalChips.find((f) => f.id === selection.fileId) : activeField?.files[fieldPage];

  return (
    <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4, padding: 8, borderBottom: "1px solid var(--border)", overflowX: "auto" }}>
        {/* General Display — statis, mulai dari KIRI. */}
        <button className="icon-btn" title="Tambah file referensi (General Display, ikut project)" onClick={addGeneralFile} style={{ flexShrink: 0 }}>
          <Plus size={13} />
        </button>
        {generalChips.map((f) => (
          <button
            key={f.id}
            className="btn"
            style={{
              padding: "4px 8px",
              maxWidth: 110,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              flexShrink: 0,
              ...(selection?.kind === "general" && selection.fileId === f.id ? { borderColor: "var(--accent)", color: "var(--accent)", background: "var(--accent-soft)" } : {}),
            }}
            title={`${f.original_name} (General Display, ikut project)`}
            onClick={() => onSelectGeneral(f.id)}
          >
            <Pin size={11} style={{ flexShrink: 0 }} />
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{f.original_name}</span>
            <X
              size={11}
              onClick={(e) => {
                e.stopPropagation();
                window.api.project.removeFile(f.id).then(onChanged);
              }}
            />
          </button>
        ))}

        {/* Field Display — 1 chip per FIELD (bukan per file), mulai dari KANAN
            (margin-left:auto dorong grup ini ke ujung kanan baris). */}
        <div style={{ display: "flex", gap: 4, marginLeft: "auto", flexShrink: 0 }}>
          {fieldChips.map((r) => {
            const label = r.title || "(tanpa judul)";
            const active = selection?.kind === "field" && selection.replyId === r.id;
            return (
              <button
                key={r.id}
                className="btn"
                style={{
                  padding: "4px 8px",
                  maxWidth: 130,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                  ...(active ? { borderColor: "var(--accent)", color: "var(--accent)", background: "var(--accent-soft)" } : {}),
                }}
                title={r.files.length > 1 ? `${label} (${r.files.length} file)` : label}
                onClick={() => onSelectField(r.id)}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
                {r.files.length > 1 && (
                  <span className="caption" style={{ flexShrink: 0 }}>
                    ({r.files.length})
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Pager ala PDF — cuma nongol kalau field yang aktif punya lebih dari 1 file. */}
      {activeField && activeField.files.length > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <button className="icon-btn" title="File sebelumnya" onClick={() => onSetFieldPage(activeField.id, fieldPage - 1)} disabled={fieldPage <= 0}>
            <ChevronLeft size={13} />
          </button>
          <span className="caption">
            {fieldPage + 1} / {activeField.files.length} — {selectedFile?.original_name}
          </span>
          <button
            className="icon-btn"
            title="File berikutnya"
            onClick={() => onSetFieldPage(activeField.id, fieldPage + 1)}
            disabled={fieldPage >= activeField.files.length - 1}
          >
            <ChevronRight size={13} />
          </button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "auto", padding: 12 }} className="scrollbar-thin">
        {selectedFile ? (
          <FilePreview
            key={selectedFile.id}
            file={selectedFile}
            onCapture={onCapture}
            capturePool={capturePool}
            onRemoveFromPool={onRemoveFromPool}
            isActiveViewer
          />
        ) : (
          <div className="placeholder-box">
            <span className="caption">Belum ada file. Klik "+" buat tambah file referensi (General Display), atau tambah file lewat field di kanan.</span>
          </div>
        )}
      </div>
    </div>
  );
}

function TemplateBuilder({ onCancel, onSaved }: { onCancel: () => void; onSaved: (t: Template) => void }) {
  const [name, setName] = useState("");
  const [fields, setFields] = useState<TemplateField[]>([{ label: "" }]);
  const [touched, setTouched] = useState(false);

  async function save() {
    if (!name.trim() || fields.some((f) => !f.label.trim())) {
      setTouched(true);
      return;
    }
    const id = await window.api.template.save({ name: name.trim(), fields });
    onSaved({ id, name: name.trim(), is_builtin: 0, fields });
  }

  return (
    <div className="card" style={{ padding: 12 }}>
      <div className="label" style={{ marginBottom: 6 }}>
        Template Baru
      </div>
      <input
        placeholder="Nama template"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className={touched && !name.trim() ? "input-error" : ""}
        style={{ width: "100%", marginBottom: 8 }}
      />
      {fields.map((f, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <input
            placeholder="Label field"
            value={f.label}
            onChange={(e) => setFields((prev) => prev.map((x, idx) => (idx === i ? { ...x, label: e.target.value } : x)))}
            className={touched && !f.label.trim() ? "input-error" : ""}
            style={{ flex: 1 }}
          />
          <button className="icon-btn" onClick={() => setFields((prev) => prev.filter((_, idx) => idx !== i))}>
            <X size={13} />
          </button>
        </div>
      ))}
      <button className="btn" onClick={() => setFields((prev) => [...prev, { label: "" }])} style={{ marginBottom: 10 }}>
        <Plus size={13} /> Field
      </button>
      <div style={{ display: "flex", gap: 6 }}>
        <button className="btn btn-primary" onClick={save}>
          Simpan & Terapkan
        </button>
        <button className="btn" onClick={onCancel}>
          Batal
        </button>
      </div>
    </div>
  );
}

function ReplyRow({
  reply,
  itemId,
  projectId,
  users,
  hyperlinkPresets,
  onRefreshHyperlinks,
  selected,
  onToggleSelected,
  onChanged,
  onSelectFile,
  capturePool,
  onRemoveFromPool,
  onDragStart,
  onDropOn,
  instantIntakeEnabled,
}: {
  reply: Reply;
  itemId: string;
  projectId: string;
  users: SlackUser[];
  hyperlinkPresets: HyperlinkPreset[];
  onRefreshHyperlinks: () => Promise<void>;
  selected: boolean;
  onToggleSelected: () => void;
  onChanged: () => void;
  /** b2 revisi — klik file yang nempel di field ini = buka preview-nya di DisplayPane (jadi
   * chip Field ini + halaman ke-berapa di dalamnya, kalau field-nya punya banyak file). */
  onSelectFile: (replyId: string, fileId: string) => void;
  capturePool: { id: string; dataUrl: string; filename: string }[];
  onRemoveFromPool: (id: string) => void;
  /** C4 — drag-reorder, avatar/handle di header jadi titik drag-nya. */
  onDragStart: () => void;
  onDropOn: () => void;
  instantIntakeEnabled: boolean;
}) {
  const editorRef = useRef<RichTextEditorHandle | null>(null);
  const linkMenuRef = useRef<HTMLDivElement | null>(null);
  const [showLinkMenu, setShowLinkMenu] = useState(false);
  const [selectedLinkPreset, setSelectedLinkPreset] = useState("");
  const [linkName, setLinkName] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  // Highlight tombol toolbar yang lagi aktif di posisi kursor — port dari Command Builder.
  const [activeFormats, setActiveFormats] = useState<ActiveFormats>({ bold: false, italic: false, bulletList: false, numberList: false });
  const [fieldDragOver, setFieldDragOver] = useState(false);
  // Counter bukan boolean — dragenter/dragleave nembak berkali-kali pas kursor lewatin
  // elemen-elemen ANAK di dalam card (tiap kali pindah ke anak baru: leave lalu enter lagi),
  // kalau langsung pakai boolean bakal kedip-kedip. Cuma beneran "leave" (balik ke 0) yang
  // matiin highlight.
  const dragCounter = useRef(0);

  useEffect(() => {
    if (!showLinkMenu) return;
    function closeOnOutsideClick(event: MouseEvent) {
      if (linkMenuRef.current && !linkMenuRef.current.contains(event.target as Node)) setShowLinkMenu(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setShowLinkMenu(false);
    }
    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [showLinkMenu]);
  // Read-only lock (poin revisi, diminta user) — field yang UDAH kekirim ke Slack gak bisa
  // diedit lagi (isi Slack gak ikut ke-update kalau diedit belakangan), tapi thumbnail file
  // TETAP tampil & bisa di-klik buat preview. Backend (projects.cjs assertReplyEditable) udah
  // nolak panggilan edit apa pun buat reply ini juga -- ini cuma nyembunyiin UI-nya.
  const locked = reply.sent;
  const sender = users.find((user) => user.id === reply.sent_by_user_id);
  const senderName = sender?.name || reply.sent_by_user_id || "Akun Slack aktif";

  async function attachFiles() {
    if (locked) return;
    const room = capFileRoom(reply.files.length);
    if (room <= 0) return;
    const paths = await window.api.item.pickFiles();
    if (!paths.length) return;
    const capped = paths.slice(0, room);
    if (capped.length < paths.length) alert(`Cuma ${capped.length} file yang ditambahkan (maksimal ${MAX_FILES_PER_REPLY} file per field).`);
    await window.api.reply.addFiles(reply.id, itemId, capped);
    onChanged();
  }

  // b2 revisi — area drop-nya SELURUH card field (bukan cuma text area), deteksi tipe drop:
  // custom mime internal (capture pool) -> attach capture, ada Files -> attach file native (lewat
  // webUtils.getPathForFile, `.path` udah gak ada lagi otomatis di Electron 32+), selain itu ->
  // drag-reorder antar reply (grip handle).
  function onCardDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCounter.current = 0;
    setFieldDragOver(false);
    const poolId = e.dataTransfer.getData("application/x-capture-id");
    if (poolId) {
      if (locked || capFileRoom(reply.files.length) <= 0) return;
      const captured = capturePool.find((p) => p.id === poolId);
      if (!captured) return;
      window.api.reply.addCapturedToReply(reply.id, itemId, captured.dataUrl, captured.filename).then(() => {
        onRemoveFromPool(poolId);
        onChanged();
      });
      return;
    }
    if (e.dataTransfer.files.length > 0) {
      if (locked) return;
      const room = capFileRoom(reply.files.length);
      if (room <= 0) return;
      const paths = Array.from(e.dataTransfer.files)
        .map((f) => window.api.file.getPathForFile(f))
        .filter((p): p is string => !!p)
        .slice(0, room);
      if (paths.length) window.api.reply.addFiles(reply.id, itemId, paths).then(onChanged);
      return;
    }
    onDropOn();
  }

  // Paste gambar/file langsung di text area (bukan cuma drag-drop) — file dari OS (punya path
  // lewat webUtils) lewat addFiles biasa, gambar clipboard murni (screenshot, gak ada path)
  // lewat jalur capture (base64) yang udah ada.
  async function onFieldPasteCapture(e: React.ClipboardEvent) {
    const pasted = Array.from(e.clipboardData?.files || []);
    if (!pasted.length) return;
    e.preventDefault();
    e.stopPropagation();
    const room = capFileRoom(reply.files.length);
    if (room <= 0) return;
    const files = pasted.slice(0, room);
    if (files.length < pasted.length) alert(`Cuma ${files.length} file yang ditambahkan (maksimal ${MAX_FILES_PER_REPLY} file per field).`);
    const withPath: { file: File; path: string }[] = [];
    const withoutPath: File[] = [];
    for (const f of files) {
      const p = window.api.file.getPathForFile(f);
      p ? withPath.push({ file: f, path: p }) : withoutPath.push(f);
    }
    if (withPath.length) await window.api.reply.addFiles(reply.id, itemId, withPath.map((x) => x.path));
    for (const f of withoutPath) {
      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(f);
      });
      await window.api.reply.addCapturedToReply(reply.id, itemId, dataUrl, f.name || `paste-${Date.now()}.png`);
    }
    onChanged();
  }

  return (
    <div
      className={`card reply-bubble ${locked ? "sent" : ""} ${selected ? "selected" : ""} ${fieldDragOver ? "field-drag-over" : ""}`}
      style={{ padding: 10 }}
      onDragEnter={(e) => {
        e.preventDefault();
        dragCounter.current++;
        setFieldDragOver(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragCounter.current = Math.max(0, dragCounter.current - 1);
        if (dragCounter.current === 0) setFieldDragOver(false);
      }}
      onDrop={onCardDrop}
    >
      {/* b2 revisi — urutan header: Drag, Judul, Checkbox, Broadcast, Trash (1 baris). */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        {locked ? (
          <div title={`Dikirim oleh ${senderName}`} style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--success)", flexShrink: 0, maxWidth: 150 }}>
            <CircleUserRound size={18} />
            <span style={{ fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{senderName}</span>
          </div>
        ) : (
          <div
            draggable
            onDragStart={onDragStart}
            title="Drag buat ubah urutan"
            style={{
              width: 20,
              height: 20,
              borderRadius: 5,
              color: "var(--text-muted)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              cursor: "grab",
            }}
          >
            <Grip size={14} />
          </div>
        )}
        {locked ? (
          <div style={{ flex: 1 }} />
        ) : (
        <input
          // key ikut reply.title: sama kayak fix di MainTable — defaultValue gak nangkep
          // perubahan dari luar (mis. konsolidasi reply pas Merge) tanpa remount paksa.
          key={`${reply.id}:${reply.title}`}
          defaultValue={reply.title}
          aria-label="Judul field"
          onBlur={(e) => e.target.value !== reply.title && window.api.reply.update(reply.id, { title: e.target.value }).then(onChanged)}
          style={{ flex: 1, border: "none", background: "transparent", fontWeight: 600, padding: "2px 0" }}
        />
        )}
        <div className="reply-actions" style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <button
            className="icon-btn"
            title={locked ? "Buka kunci field" : "Kunci field sebagai sudah terkirim"}
            onClick={() => {
              if (locked) {
                if (confirm("Buka gembok field ini? Cuma lakuin ini kalau field ini BENERAN belum/gagal terkirim ke Slack — kalau ternyata udah kekirim, kirim ulang bisa bikin pesan dobel di Slack.")) {
                  window.api.reply.unlock(reply.id).then(onChanged);
                }
              } else {
                window.api.reply.lock(reply.id).then(onChanged);
              }
            }}
          >
            {locked ? <Unlock size={12} /> : <Lock size={12} />}
          </button>
          <input type="checkbox" checked={selected} onChange={onToggleSelected} aria-label={`Pilih field ${reply.title || "tanpa judul"}`} />
          {!locked && (
            <>
              <button className="icon-btn" title="Broadcast ke semua item kategori sama" onClick={() => window.api.reply.broadcast(reply.id, projectId).then(onChanged)}>
                <Radio size={13} />
              </button>
              <button className="icon-btn" title="Hapus field ini" onClick={() => window.api.reply.remove(reply.id).then(onChanged)}>
                <Trash2 size={13} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Field unified (poin D1) — teks dan file bisa keisi bareng di 1 field yang sama. Tool
          text cuma nongol pas fokus di area ini (CSS :focus-within, lihat styles.css), dan area
          ini juga terima drag-drop file dari luar & paste gambar/file langsung. Poin revisi
          (diminta user) — field yang UDAH kekirim (locked) gak nampilin toolbar/editor sama
          sekali, diganti teks read-only biasa (thumbnail filenya tetap di AttachedFilesRow di
          bawah, di luar blok ini). */}
      {locked ? (
        <div style={{ padding: "4px 0", whiteSpace: "pre-wrap", color: "var(--text)", fontSize: 13 }}>
          {reply.title && <div style={{ fontWeight: 700, marginBottom: reply.text_value ? 8 : 0 }}>{reply.title}</div>}
          {reply.text_value || null}
        </div>
      ) : (
      <div className="field-editor-wrap" style={{ position: "relative" }} onPasteCapture={onFieldPasteCapture}>
        {/* onMouseDown preventDefault di tiap tombol toolbar — WAJIB, tanpa ini klik tombol
            narik fokus DOM keluar dari contentEditable SEBELUM handler-nya jalan, bikin Lexical
            baca selection null pas insert (bug: klik Bold/Emoji di editor kosong = gak ngefek). */}
        <div className="field-toolbar" style={{ gap: 2, marginBottom: 4 }}>
          <button
            className="icon-btn"
            title="Bold"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editorRef.current?.toggleBold()}
            style={activeFormats.bold ? { background: "var(--accent-soft)", color: "var(--accent)" } : {}}
          >
            <Bold size={13} />
          </button>
          <button
            className="icon-btn"
            title="Italic"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editorRef.current?.toggleItalic()}
            style={activeFormats.italic ? { background: "var(--accent-soft)", color: "var(--accent)" } : {}}
          >
            <Italic size={13} />
          </button>
          <div ref={linkMenuRef} style={{ position: "relative", display: "inline-flex" }}>
            <button
              className="icon-btn"
              title="Link"
              aria-haspopup="dialog"
              aria-expanded={showLinkMenu}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                const next = !showLinkMenu;
                setShowLinkMenu(next);
                if (next) {
                  const selectedText = editorRef.current?.getSelectedText().trim() || "";
                  setSelectedLinkPreset("");
                  setLinkName(selectedText);
                  setLinkUrl("");
                  void onRefreshHyperlinks().catch(() => undefined);
                }
              }}
              style={showLinkMenu ? { background: "var(--accent-soft)", color: "var(--accent)" } : {}}
            >
              <LinkIcon size={13} />
            </button>
            {showLinkMenu && (
              <div
                className="card"
                role="dialog"
                aria-label="Sisipkan hyperlink"
                style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 50, width: 290, padding: 10, background: "var(--surface)" }}
              >
                <select
                  className="input"
                  aria-label="Preset hyperlink"
                  value={selectedLinkPreset}
                  onChange={(event) => {
                    const presetId = event.target.value;
                    const selectedText = editorRef.current?.getSelectedText().trim() || "";
                    setSelectedLinkPreset(presetId);
                    if (!presetId) {
                      setLinkName(selectedText);
                      setLinkUrl("");
                      return;
                    }
                    const preset = hyperlinkPresets.find((item) => item.id === presetId);
                    if (preset) {
                      setLinkName(selectedText || preset.label);
                      setLinkUrl(preset.url);
                    }
                  }}
                  style={{ width: "100%" }}
                >
                  <option value="">URL manual</option>
                  {hyperlinkPresets.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>

                {!selectedLinkPreset && (
                  <input
                    className="input"
                    type="url"
                    aria-label="URL hyperlink"
                    placeholder="https://..."
                    value={linkUrl}
                    onChange={(event) => setLinkUrl(event.target.value)}
                    autoFocus
                    style={{ width: "100%", marginTop: 8 }}
                  />
                )}

                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <input
                    className="input"
                    aria-label="Nama hyperlink"
                    placeholder="Nama"
                    value={linkName}
                    onChange={(event) => setLinkName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" || !linkUrl.trim()) return;
                      event.preventDefault();
                      editorRef.current?.insertLink(linkUrl.trim(), linkName.trim() || undefined);
                      setShowLinkMenu(false);
                    }}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  <button
                    className="btn btn-primary"
                    disabled={!linkUrl.trim()}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      editorRef.current?.insertLink(linkUrl.trim(), linkName.trim() || undefined);
                      setShowLinkMenu(false);
                    }}
                    style={{ whiteSpace: "nowrap" }}
                  >
                    Sisipkan Link
                  </button>
                </div>
              </div>
            )}
          </div>
          <button
            className="icon-btn"
            title="Bullet list"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editorRef.current?.insertBulletList()}
            style={activeFormats.bulletList ? { background: "var(--accent-soft)", color: "var(--accent)" } : {}}
          >
            <List size={13} />
          </button>
          <button
            className="icon-btn"
            title="Numbered list"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => editorRef.current?.insertNumberList()}
            style={activeFormats.numberList ? { background: "var(--accent-soft)", color: "var(--accent)" } : {}}
          >
            <ListOrdered size={13} />
          </button>
          <EmojiPicker onPick={(emoji) => {
            if (emoji.type === "custom") editorRef.current?.insertEmojiImage(emoji.shortcode);
            else editorRef.current?.insertText(emoji.value);
          }} />
          <button className="icon-btn" title="Tambah file" onMouseDown={(e) => e.preventDefault()} onClick={attachFiles}>
            <Paperclip size={13} />
          </button>
        </div>
        <RichTextEditor
          key={`${reply.id}:${reply.text_value}`}
          ref={editorRef}
          onActiveFormatsChange={setActiveFormats}
          defaultValue={reply.text_value || ""}
          onBlurValue={(markdown) => window.api.reply.update(reply.id, { textValue: markdown }).then(onChanged)}
        />
        {/* Icon centang "selesai edit" (poin revisi) — alternatif klik-di-luar buat commit teks,
            biar gak disangka tombol lain. Cuma nongol pas field lagi fokus (sama gating :focus-within
            kayak .field-toolbar, lihat styles.css), overlay di pojok kanan-bawah AREA TEKS-nya. */}
        <button
          className="icon-btn field-done-btn"
          title="Selesai edit"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => editorRef.current?.commitAndBlur()}
        >
          <Check size={13} />
        </button>
      </div>
      )}

      {/* Instant Intake per-field (poin revisi) — pindah ke bawah-kanan field (dulu di baris atas
          sejajar checkbox/broadcast/trash, ambigu kesenggol). Aktif cuma kalau field-nya udah ada
          isinya (teks atau file) — gak ada gunanya ngirim field kosong. Koreksi (poin revisi
          lanjutan): visibility BALIK ke hover-reveal (posisi bawah-kanan TETAP) — pakai className
          "reply-actions" yang SAMA biar ikut rule CSS fade in/out punya .reply-bubble:hover yang
          udah ada, bukan selalu-tampil. Poin revisi (diminta user) — field yang UDAH kekirim
          (locked) gak nampilin tombol ini lagi, gak ada isi baru yang bisa dikirim ulang. */}
      {!locked && instantIntakeEnabled && (
        <div className="reply-actions" style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
          <QuickSendButton
            variant="inline"
            title="Instant Intake — kirim field ini aja"
            disabled={!(reply.text_value || "").trim() && reply.files.length === 0}
            onClick={() => window.api.send.quick({ projectId, itemId, scope: "field", replyId: reply.id }).then(onChanged)}
          />
        </div>
      )}

      <AttachedFilesRow files={reply.files} locked={locked} onRemove={(fileId) => window.api.reply.removeFile(fileId).then(onChanged)} onSelect={(fileId) => onSelectFile(reply.id, fileId)} />

    </div>
  );
}

// Baris file attached — poin revisi terbaru: HORIZONTAL, thumbnail doang (nama file dihapus,
// keliatan pas hover lewat title tooltip), tombol hapus jadi badge X di pojok kanan-atas
// thumbnail. Kalau kepanjangan buat muat horizontal (bisa >5 file, tapi field lama bisa punya
// lebih dari cap baru), muncul panah overlay kiri/kanan buat scroll (bukan cuma andelin
// scrollbar/wheel yang kurang jelas keliatannya).
function AttachedFilesRow({
  files,
  locked,
  onRemove,
  onSelect,
}: {
  files: { id: string; stored_path: string; original_name: string }[];
  /** Poin revisi (diminta user) — field UDAH kekirim: thumbnail TETAP tampil & bisa di-klik
   * buat preview, tapi badge hapus (X) disembunyiin (gak boleh diedit lagi). */
  locked?: boolean;
  onRemove: (fileId: string) => void;
  onSelect: (fileId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  function updateArrows() {
    const el = scrollRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 2);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 2);
  }
  useEffect(() => {
    updateArrows();
  }, [files.length]);

  if (!files.length) return null;

  return (
    <div style={{ position: "relative", marginTop: 6 }}>
      <div
        ref={scrollRef}
        onScroll={updateArrows}
        className="scrollbar-thin"
        style={{ display: "flex", gap: 6, overflowX: "auto", paddingTop: 6 }}
      >
        {files.map((f) => (
          <AttachedThumb key={f.id} file={f} locked={locked} onRemove={() => onRemove(f.id)} onSelect={() => onSelect(f.id)} />
        ))}
      </div>
      {canLeft && (
        <button
          className="icon-btn"
          title="Scroll kiri"
          onClick={() => scrollRef.current?.scrollBy({ left: -120, behavior: "smooth" })}
          style={{ position: "absolute", left: -4, top: "50%", transform: "translateY(-50%)", background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "0 1px 4px rgba(0,0,0,0.15)" }}
        >
          <ChevronLeft size={13} />
        </button>
      )}
      {canRight && (
        <button
          className="icon-btn"
          title="Scroll kanan"
          onClick={() => scrollRef.current?.scrollBy({ left: 120, behavior: "smooth" })}
          style={{ position: "absolute", right: -4, top: "50%", transform: "translateY(-50%)", background: "var(--surface)", border: "1px solid var(--border)", boxShadow: "0 1px 4px rgba(0,0,0,0.15)" }}
        >
          <ChevronRight size={13} />
        </button>
      )}
    </div>
  );
}

function AttachedThumb({
  file,
  locked,
  onRemove,
  onSelect,
}: {
  file: { id: string; stored_path: string; original_name: string };
  locked?: boolean;
  onRemove: () => void;
  onSelect: () => void;
}) {
  const kind = fileKind(file.original_name);
  const url = useFileBlobUrl(kind === "image" ? file.stored_path : null);
  return (
    <div
      onClick={onSelect}
      title={file.original_name}
      style={{
        position: "relative",
        width: 44,
        height: 44,
        flexShrink: 0,
        cursor: "pointer",
      }}
    >
      {/* overflow:hidden pindah ke wrapper KONTEN doang (bukan lagi di div luar) — poin revisi:
          badge X kepotong soalnya sebelumnya div luar yang ngasih badge posisi absolute JUGA yang
          clip overflow buat bikin gambarnya rounded, jadi badge yang nongol di luar batas ikut
          kepotong. */}
      <div style={{ width: "100%", height: "100%", borderRadius: 6, overflow: "hidden", border: "1px solid var(--border)", background: "var(--surface)" }}>
        {kind === "image" && url ? (
          <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : kind === "video" ? (
          <VideoThumbnail filePath={file.stored_path} />
        ) : (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%" }}>
            <FileText size={16} className="muted" />
          </div>
        )}
      </div>
      {/* Lingkaran merah solid (bukan outline tipis lagi) — poin revisi: badge X sebelumnya
          nyaris gak keliatan di atas thumbnail terang. Poin revisi lanjutan (diminta user) —
          field UDAH kekirim (locked): badge hapus disembunyiin, thumbnail TETAP tampil & bisa
          diklik buat preview (onSelect di div luar gak kesentuh). */}
      {!locked && (
        <button
          style={{
            position: "absolute",
            top: -5,
            right: -5,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "var(--danger)",
            border: "1.5px solid var(--surface)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
          }}
          title="Hapus file ini"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X size={10} strokeWidth={3} />
        </button>
      )}
    </div>
  );
}

// Thumbnail video — video gak punya "gambar" statis buat di-<img>-kan langsung kayak file
// gambar biasa, jadi di-generate sendiri: <video> tersembunyi, seek ke tengah durasi, gambar
// frame itu ke canvas, hasilnya dipakai sebagai <img>. blob: URL yang sama (useFileBlobUrl)
// dipakai buat baca file-nya, alasan sama kayak <img>/<video> lain (lihat fileUrl.ts).
function VideoThumbnail({ filePath }: { filePath: string }) {
  const url = useFileBlobUrl(filePath);
  const [thumb, setThumb] = useState<string | null>(null);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.preload = "metadata";
    function onLoadedMetadata() {
      video.currentTime = Math.min(Math.max(0.1, video.duration / 2), Math.max(0.1, video.duration - 0.1));
    }
    function onSeeked() {
      if (cancelled) return;
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth || 1;
      canvas.height = video.videoHeight || 1;
      canvas.getContext("2d")?.drawImage(video, 0, 0);
      setThumb(canvas.toDataURL("image/jpeg", 0.7));
    }
    video.addEventListener("loadedmetadata", onLoadedMetadata);
    video.addEventListener("seeked", onSeeked);
    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", onLoadedMetadata);
      video.removeEventListener("seeked", onSeeked);
    };
  }, [url]);

  return thumb ? (
    <img src={thumb} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
  ) : (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%" }}>
      <FileVideo size={16} className="muted" />
    </div>
  );
}

// Konten gambar sering ke-"letterbox" (ada bar kosong) di dalam elemennya sendiri gara-gara
// object-fit:contain — port dari videoContentRect_ (Hej Pro/Command Builder): hitung posisi+
// skala KONTEN ASLI relatif ke stage, dipakai buat konversi koordinat drag-select ke koordinat
// pixel asli gambar pas crop. (Video sekarang punya salinannya sendiri di VideoPlayer.tsx.)
function computeImageContentRect(img: HTMLImageElement, stage: HTMLElement) {
  const stageRect = stage.getBoundingClientRect();
  const imgRect = img.getBoundingClientRect();
  const naturalW = img.naturalWidth;
  const naturalH = img.naturalHeight;
  if (!naturalW || !naturalH) {
    return { left: imgRect.left - stageRect.left, top: imgRect.top - stageRect.top, width: imgRect.width, height: imgRect.height, scale: 1 };
  }
  const scale = Math.min(imgRect.width / naturalW, imgRect.height / naturalH);
  const rw = naturalW * scale;
  const rh = naturalH * scale;
  return {
    left: imgRect.left + (imgRect.width - rw) / 2 - stageRect.left,
    top: imgRect.top + (imgRect.height - rh) / 2 - stageRect.top,
    width: rw,
    height: rh,
    scale,
  };
}

function FilePreview({
  file,
  onCapture,
  capturePool,
  onRemoveFromPool,
  isActiveViewer,
}: {
  file: { id: string; stored_path: string; original_name: string };
  capturePool: { id: string; dataUrl: string; filename: string }[];
  onCapture: (dataUrl: string, filename: string) => void;
  onRemoveFromPool: (id: string) => void;
  /** C9 — cuma file yang lagi ditampilin di DisplayPane yang dapet shortcut keyboard `,`/`.`/`C`. */
  isActiveViewer?: boolean;
}) {
  const kind = fileKind(file.original_name);
  const url = useFileBlobUrl(kind === "image" ? file.stored_path : null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [captureMode, setCaptureMode] = useState(false);
  const [selRect, setSelRect] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const selDragStart = useRef<{ x: number; y: number } | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  function toggleCaptureMode() {
    setCaptureMode((v) => !v);
  }

  function onStageMouseDown(e: React.MouseEvent) {
    if (!captureMode) return;
    e.preventDefault();
    const stageRect = stageRef.current?.getBoundingClientRect();
    if (!stageRect) return;
    selDragStart.current = { x: e.clientX - stageRect.left, y: e.clientY - stageRect.top };
    setSelRect({ x: selDragStart.current.x, y: selDragStart.current.y, w: 0, h: 0 });
  }

  useEffect(() => {
    if (!captureMode) return;
    function onMove(e: MouseEvent) {
      if (!selDragStart.current) return;
      const stageRect = stageRef.current?.getBoundingClientRect();
      if (!stageRect) return;
      const x = Math.max(0, Math.min(stageRect.width, e.clientX - stageRect.left));
      const y = Math.max(0, Math.min(stageRect.height, e.clientY - stageRect.top));
      setSelRect({
        x: Math.min(selDragStart.current.x, x),
        y: Math.min(selDragStart.current.y, y),
        w: Math.abs(x - selDragStart.current.x),
        h: Math.abs(y - selDragStart.current.y),
      });
    }
    function onUp() {
      if (!selDragStart.current) return;
      selDragStart.current = null;
      const stage = stageRef.current;
      const img = imgRef.current;
      setSelRect((r) => {
        if (stage && img && r && r.w >= 6 && r.h >= 6) {
          const content = computeImageContentRect(img, stage);
          if (img.naturalWidth && img.naturalHeight && content.scale > 0) {
            const sx = Math.max(0, (r.x - content.left) / content.scale);
            const sy = Math.max(0, (r.y - content.top) / content.scale);
            const sw = Math.min(img.naturalWidth - sx, r.w / content.scale);
            const sh = Math.min(img.naturalHeight - sy, r.h / content.scale);
            if (sw > 1 && sh > 1) {
              const canvas = document.createElement("canvas");
              canvas.width = sw;
              canvas.height = sh;
              canvas.getContext("2d")?.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
              setPreviewUrl(canvas.toDataURL("image/png"));
            }
          }
        }
        return null;
      });
      setCaptureMode(false);
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [captureMode]);

  if (kind === "image") {
    return (
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <div
          ref={stageRef}
          onMouseDown={onStageMouseDown}
          style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden", cursor: captureMode ? "crosshair" : "default", borderRadius: 6 }}
        >
          {url ? (
            <img ref={imgRef} src={url} alt={file.original_name} style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", height: "100%" }}>
              <span className="caption">Memuat gambar…</span>
            </div>
          )}
          {captureMode && (
            <div className="caption" style={{ position: "absolute", top: 6, left: 6, background: "rgba(0,0,0,0.6)", color: "#fff", padding: "2px 6px", borderRadius: 4, pointerEvents: "none" }}>
              Drag buat pilih area capture
            </div>
          )}
          {selRect && (
            <div style={{ position: "absolute", left: selRect.x, top: selRect.y, width: selRect.w, height: selRect.h, border: "2px solid var(--accent)", background: "rgba(47,111,235,0.15)", pointerEvents: "none" }} />
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 4, flexShrink: 0 }}>
          <span className="caption">{file.original_name}</span>
          <button className={`icon-btn ${captureMode ? "active" : ""}`} title="Capture — drag pilih area" onClick={toggleCaptureMode} style={captureMode ? { background: "var(--accent-soft)", color: "var(--accent)" } : {}}>
            <Crop size={13} />
          </button>
        </div>
        {previewUrl && (
          <CapturePreviewModal
            previewUrl={previewUrl}
            onCancel={() => setPreviewUrl(null)}
            onRetry={() => {
              setPreviewUrl(null);
              setCaptureMode(true);
            }}
            onConfirm={() => {
              onCapture(previewUrl, `capture-${Date.now()}.png`);
              setPreviewUrl(null);
            }}
          />
        )}
        <CapturePoolStrip pool={capturePool} onRemove={onRemoveFromPool} />
      </div>
    );
  }

  if (kind === "video") {
    return (
      <Suspense fallback={<div className="placeholder-box">Memuat video…</div>}>
      <VideoPlayer
        filePath={file.stored_path}
        isActiveViewer={isActiveViewer}
        capturePool={capturePool}
        onCapture={onCapture}
        onRemoveFromPool={onRemoveFromPool}
      />
      </Suspense>
    );
  }

  if (kind === "pdf") {
    // PdfViewer sekarang responsif (flex:1, poin revisi "ruang kosong") — wrapper ini JUGA
    // harus flex column biar tinggi flex:1-nya ada yang ngasih, bukan collapse ke konten.
    return (
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Suspense fallback={<div className="placeholder-box">Memuat PDF…</div>}>
          <PdfViewer filePath={file.stored_path} onCapture={onCapture} />
        </Suspense>
        <span className="caption" style={{ flexShrink: 0, marginTop: 4 }}>
          {file.original_name}
        </span>
        <CapturePoolStrip pool={capturePool} onRemove={onRemoveFromPool} />
      </div>
    );
  }

  return (
    <div className="badge" style={{ background: "var(--surface-hover)", color: "var(--text-secondary)", marginBottom: 6 }}>
      <FileText size={11} /> {file.original_name}
    </div>
  );
}

// Sniping-tool style capture (poin b1 revisi) — drag pilih area DULU di atas source (frame video
// yang di-freeze, atau gambar), baru pas mouse-up tampil PREVIEW hasil crop-nya di modal yang
// sama sebelum user confirm simpan ke pool. Ganti dari capture instan sebelumnya.
// Preview hasil capture (poin b1 revisi terbaru) — drag-select-nya sendiri sekarang LANGSUNG
// di atas video/gambar yang lagi ditampilin (lihat stageRef/onStageMouseDown di FilePreview,
// port persis dari Command Builder JavaScript.html: toggle captureMode -> drag di "stage" ->
// crop -> modal ini cuma buat preview+confirm, gak ada drag-select lagi di sini.
function CapturePreviewModal({
  previewUrl,
  onConfirm,
  onRetry,
  onCancel,
}: {
  previewUrl: string;
  onConfirm: () => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ padding: 12, background: "var(--surface)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <div style={{ fontWeight: 600, fontSize: 13 }}>Preview hasil capture</div>
          <button className="icon-btn" title="Tutup" onClick={onCancel}>
            <X size={14} />
          </button>
        </div>
        <img src={previewUrl} style={{ maxWidth: "60vw", maxHeight: "60vh", display: "block", borderRadius: 6, border: "1px solid var(--border)" }} />
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 10 }}>
          <button className="btn" onClick={onRetry}>
            Ulangi
          </button>
          <button className="btn" onClick={onCancel}>
            Batal
          </button>
          <button className="btn btn-primary" onClick={onConfirm}>
            Simpan ke Pool
          </button>
        </div>
      </div>
    </div>
  );
}
