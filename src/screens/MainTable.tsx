import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Send, Square, CheckSquare, X, Loader2, MessageSquare, Eye, Plus, ClipboardPaste, ExternalLink, Link as LinkIcon, LayoutTemplate, Settings } from "lucide-react";
import type { ArtistGroup, ArtistPreset, HyperlinkPreset, Project, ProjectItem, SendResult, SlackChannel, SlackUser, StatusPreset, Template } from "../global";
const Drawer = lazy(() => import("./Drawer"));
import BatchFileModal from "./BatchFileModal";
import MessageLogPanel from "./MessageLogPanel";
import { Sidebar, MenuBar, SyncControls, type MenuName } from "./Chrome";
import PromptModal from "./PromptModal";
import SendRecovery from "./SendRecovery";
import ChannelPicker from "./ChannelPicker";
import QuickSendButton from "./QuickSendButton";
import ArtistPresetModal from "./ArtistPresetModal";
import StatusPresetModal from "./StatusPresetModal";
import KeywordAutomationModal from "./KeywordAutomationModal";
import StatusDropdown from "./StatusDropdown";
import ArtistPicker from "./ArtistPicker";
import EmojiPicker from "./EmojiPicker";
import ToastHost from "./ToastHost";
import { showToast } from "../lib/toast";
import { refreshEmojiCatalogCache } from "../lib/emojiCatalog";
import { hoverDelayHandlers } from "../lib/hoverDelay";
import slackButtonImg from "../assets/SlackButton.png";

interface UndoCommand {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

const PALETTE = ["#2F6FEB", "#F59E0B", "#16A34A", "#DC2626", "#7C3AED", "#0EA5E9", "#DB2777", "#65A30D"];
const CHANNEL_MEMBERS_GROUP_ID = "__channel_members__";

// Label progress per-fase (poin revisi) — send:start sekarang kirim per-fase lintas semua item
// (bukan per-item lagi), jadi "1/10" restart tiap ganti fase; label ini biar jelas itu fase baru.
const PHASE_LABEL: Record<"root" | "artist" | "react" | "post", string> = {
  root: "Kirim pesan utama",
  artist: "Assign artis",
  react: "Kirim react",
  post: "Kirim reply",
};

export default function MainTable({
  projectId,
  isAdminMember,
  onBackToStartMenu,
  onOpenProject,
}: {
  projectId: string;
  /** Sistem Admin/Member (poin revisi, diminta user) — gate menu "Otomasi Kata Kunci..." (MenuBar)
   * doang, default hidden buat user biasa. Toggle Realtime Sync (SyncControls, poin revisi
   * lanjutan) UDAH gak digate lagi -- kebuka semua user. Pull/Push (manual, Web API, gak lewat
   * Socket Mode/event) dari dulu emang gak digate. */
  isAdminMember: boolean;
  onBackToStartMenu: () => void;
  onOpenProject: (id: string) => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [users, setUsers] = useState<SlackUser[]>([]);
  const [channelMemberIds, setChannelMemberIds] = useState<string[]>([]);
  const [groups, setGroups] = useState<ArtistGroup[]>([]);
  const [artistPresets, setArtistPresets] = useState<ArtistPreset[]>([]);
  const [multiAssignment, setMultiAssignment] = useState(true);
  const [showArtistPresetManager, setShowArtistPresetManager] = useState(false);
  // Fitur Status (poin revisi) — daftar preset GLOBAL, sama pola fetch/refresh kayak artistPresets.
  const [statusPresets, setStatusPresets] = useState<StatusPreset[]>([]);
  const [showStatusPresetManager, setShowStatusPresetManager] = useState(false);
  // Otomasi Kata Kunci (poin revisi) — dipindah jadi modal berdiri sendiri, trigger-nya di Main
  // menu > Settings (bukan lagi nested di dalam modal "Sync & Otomasi Slack" di Start Menu).
  const [showKeywordAutomation, setShowKeywordAutomation] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState<string>("");
  const [instantIntakeEnabled, setInstantIntakeEnabledState] = useState(false);
  async function toggleInstantIntake() {
    const next = !instantIntakeEnabled;
    setInstantIntakeEnabledState(next);
    await window.api.instantIntake.set(next);
  }
  // Toggle "sesi assign artis realtime" (poin revisi, multi-artist) — GLOBAL, shared sama Tab
  // Table (header kolom Artis) DAN Tab Reply (section Artis), state SATU sumber di sini.
  const [realtimeAssignEnabled, setRealtimeAssignEnabledState] = useState(false);
  async function toggleRealtimeAssign() {
    const next = !realtimeAssignEnabled;
    setRealtimeAssignEnabledState(next);
    await window.api.artistRealtimeAssign.set(next);
    // Poin revisi (diminta user, "Pull ikut toggle") — begitu Realtime Sync dinyalain LAGI,
    // langsung Pull sekali (scope project, sama kayak tombol Pull di Tab Table) buat nyusul apa
    // pun yang kejadian di Slack selama toggle-nya OFF tadi (event Slack->App di-skip lokal +
    // Socket Mode kemungkinan disconnect kalau Otomasi Kata Kunci JUGA OFF, lihat main.cjs
    // updateSocketModeConnectionState) — biar gak ada yang nyangkut ketinggalan pas nyalain lagi.
    if (next) handlePullFromSlack();
  }
  // Tombol manual "Update" (poin revisi) — ganti mode assign (Mention/React, di ArtistPresetModal)
  // sengaja gak otomatis nembak Slack buat semua item seketika (itu tetap lokal/instan doang).
  // Tombol ini yang beneran push perubahan mode itu ke Slack, kapan pun user siap — jalan walau
  // toggle realtime di atas OFF.
  const [syncingAssign, setSyncingAssign] = useState(false);
  async function handleSyncAssignToSlack() {
    if (syncingAssign) return;
    setSyncingAssign(true);
    try {
      const result = await window.api.artistAssign.syncProject(projectId);
      if (!result.total) {
        showToast("Gak ada item yang punya artis assigned di project ini — gak ada yang perlu disinkron.", "info");
      } else if (result.errors.length) {
        showToast(`Sinkron ${result.synced}/${result.total} item berhasil. Gagal:\n${result.errors.join("\n")}`, "error");
      } else {
        showToast(`Sinkron ${result.synced} item berhasil.`, "success");
      }
      refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Gagal sinkron assign ke Slack.", "error");
    } finally {
      setSyncingAssign(false);
    }
  }
  // "Pull" manual (poin revisi) — kebalikan arah dari tombol di atas (Push, App -> Slack): ini
  // Slack -> App, nutup celah react/kata kunci yang kejadian pas semua instalasi offline (event
  // Socket Mode-nya ilang, gak ada cara nyusul otomatis).
  const [pulling, setPulling] = useState(false);
  async function handlePullFromSlack() {
    if (pulling) return;
    setPulling(true);
    try {
      const result = await window.api.slackPull.syncProject(projectId);
      if (result.errors.length) {
        showToast(`Pull selesai (${result.reactionChanges} react, ${result.keywordChanges} kata kunci, ${result.namesChanged} nama item ke-update). Gagal:\n${result.errors.join("\n")}`, "error");
      } else if (!result.reactionChanges && !result.keywordChanges && !result.namesChanged) {
        showToast("Sudah sinkron — gak ada update baru dari Slack.", "info");
      } else {
        showToast(`Pull selesai — ${result.reactionChanges} react, ${result.keywordChanges} kata kunci, ${result.namesChanged} nama item ke-update dari Slack.`, "success");
      }
      refresh();
      setReactionTick((v) => v + 1);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Gagal pull dari Slack.", "error");
    } finally {
      setPulling(false);
    }
  }
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ index: number; total: number; itemName: string; phase?: "root" | "artist" | "react" | "post"; counts?: { items: number; assigns: number; replies: number; files: number; total: number } } | null>(null);
  const [results, setResults] = useState<SendResult[] | null>(null);
  const [sending, setSending] = useState(false);
  const [activeTab, setActiveTab] = useState<"table" | "reply">("table");
  const [activeItemId, setActiveItemId] = useState<string | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [showWorkload, setShowWorkload] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showBatchFile, setShowBatchFile] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showHyperlinkManager, setShowHyperlinkManager] = useState(false);
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [showTemplateAll, setShowTemplateAll] = useState(false);
  const [openMenu, setOpenMenu] = useState<MenuName | null>(null);
  const [mergeSeparator, setMergeSeparator] = useState<"," | "-">("-");
  const [editingName, setEditingName] = useState(false);
  const [bulkPasteCol, setBulkPasteCol] = useState<"item" | "artis" | null>(null);
  // Overlay Instant Intake per-row DISABLE selama user lagi edit input/dropdown di cell itu (poin
  // revisi) — dropdown Artis kebuka misalnya, overlay yang numpuk di pojok bisa ganggu klik opsi.
  // Cuma per (item, kolom) yang lagi fokus, bukan seluruh tabel.
  const [editingCell, setEditingCell] = useState<{ itemId: string; col: "item" | "artist" | "status" } | null>(null);
  // Poin revisi: Instant Intake sekarang JUGA ngirim reaction pending (lihat send:quick di
  // main.cjs) — chip di ItemReactionBar (state INTERNAL komponen itu sendiri, fetch sendiri lewat
  // itemId) gak otomatis tau reaction-nya udah kekirim/kehapus dari server abis quickSend selesai.
  // Tick ini di-passing ke ItemReactionBar biar dia refetch ulang begitu ada quickSend sukses.
  const [reactionTick, setReactionTick] = useState(0);
  // Poin revisi (diminta user) — assign artis/status realtime dulu KERASA nge-lag (dropdown
  // "tertahan") soalnya UI nunggu reconcile ke Slack (network) kelar dulu baru checkbox/status
  // ke-update. Sekarang optimistic: tampilan di-update LANGSUNG (lihat updateItemLocally di
  // handleAddArtist/removeArtist/setStatus), item ini ditandain "syncing" selama roundtrip ke
  // Slack masih jalan di background -- ditampilin lewat animasi spin (Loader2) di kolom nomor.
  const [syncingItemIds, setSyncingItemIds] = useState<Set<string>>(new Set());
  function markSyncing(itemId: string, on: boolean) {
    setSyncingItemIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(itemId); else next.delete(itemId);
      return next;
    });
  }
  function updateItemLocally(itemId: string, updater: (item: ProjectItem) => ProjectItem) {
    setProject((prev) => (prev ? { ...prev, items: prev.items.map((i) => (i.id === itemId ? updater(i) : i)) } : prev));
  }

  // Copy-paste ala Excel (poin revisi) — Ctrl+C/Ctrl+V jalan murni dari POSISI MOUSE (hover cell
  // Item/Artis), gak butuh klik/fokus dulu. hoveredCellRef diisi lewat onMouseEnter/Leave di <td>
  // (ref biasa, bukan state, biar gak micu re-render tiap gerak mouse). "Clipboard"-nya in-memory
  // doang (bukan OS clipboard) — cukup buat antar-cell di tabel ini, sesuai yang diminta.
  const hoveredCellRef = useRef<{ itemId: string; col: "item" | "artist" | "status" } | null>(null);
  const cellClipboardRef = useRef<string | null>(null);
  // Gabung hover-delay (overlay Instant Intake/Add React) SAMA ref-tracking di atas jadi 1 set
  // handler — biar 2 fitur beda gak rebutan onMouseEnter/onMouseLeave di td yang sama.
  function cellHoverHandlers(col: "item" | "artist" | "status", itemId: string) {
    const hd = hoverDelayHandlers();
    return {
      onMouseEnter: (e: React.MouseEvent<HTMLElement & { _hoverTimer?: ReturnType<typeof setTimeout> }>) => {
        hd.onMouseEnter(e);
        hoveredCellRef.current = { itemId, col };
      },
      onMouseLeave: (e: React.MouseEvent<HTMLElement & { _hoverTimer?: ReturnType<typeof setTimeout> }>) => {
        hd.onMouseLeave(e);
        if (hoveredCellRef.current?.itemId === itemId && hoveredCellRef.current.col === col) hoveredCellRef.current = null;
      },
    };
  }

  const undoStack = useRef<UndoCommand[]>([]);
  const redoStack = useRef<UndoCommand[]>([]);
  const [, forceRender] = useState(0);

  const [loadError, setLoadError] = useState<string | null>(null);
  const historyBusy = useRef(false);
  async function refresh() {
    try {
      const p = await window.api.project.load(projectId);
      if (!p) throw new Error("Project tidak ditemukan.");
      setProject(p); setLoadError(null);
    } catch (err) { setLoadError(err instanceof Error ? err.message : "Gagal memuat project."); }
  }

  useEffect(() => {
    refresh();
    // Poin revisi (bug dilaporkan: gagal fetch listUsers nongolin alert() native jelek, "seakan
    // nge-block input") — timeout/gagal koneksi Slack (light call, 60s, lihat slack.cjs) TOAST
    // doang, gak boleh nge-crash ke alert() blocking cuma gara-gara dropdown Artis kosong.
    window.api.slack.listUsers().then(setUsers);
    const offUsersUpdated = window.api.slack.onUsersUpdated(setUsers);
    window.api.artistGroup.list().then(setGroups);
    window.api.artistPreset.list().then(setArtistPresets);
    window.api.artistAssignMode.get().then((modes) => setMultiAssignment(modes.multi));
    window.api.statusPreset.list().then(setStatusPresets);
    window.api.instantIntake.get().then(setInstantIntakeEnabledState);
    window.api.artistRealtimeAssign.get().then(setRealtimeAssignEnabledState);
    // Cache preset custom emoji (poin revisi) — di-load sedini mungkin biar pas Tab Reply
    // dibuka, EmojiImageNode udah bisa langsung parse ":nama:" tersimpan jadi gambar (bukan
    // nunggu field-nya sendiri yang fetch).
    refreshEmojiCatalogCache();
    const offProgress = window.api.send.onProgress((data) => { if (data.projectId === projectId) { setProgress(data); setSending(true); } });
    const offDone = window.api.send.onDone(({ results, projectId: completedProject }) => {
      if (completedProject !== projectId) return;
      setResults(results);
      setSending(false);
      setProgress(null);
      refresh();
      setReactionTick((v) => v + 1); // send:start juga nge-flush reaction pending (main.cjs)
    });
    // Sync 2 arah reaction Slack->App (poin revisi) — item berubah di BACKGROUND (bukan hasil
    // aksi user di jendela ini), auto-refresh biar UI gak nyangkut stale (bug dilaporkan: klik
    // chip react yang udah kehapus backend duluan, dapet error "tidak ditemukan").
    const offItemChanged = window.api.item.onChanged((data) => {
      if (data.projectId !== projectId) return;
      refresh();
      setReactionTick((v) => v + 1);
    });
    return () => {
      offProgress();
      offDone();
      offItemChanged();
      offUsersUpdated();
      void window.api.project.releaseUndo(projectId).catch(() => undefined);
    };
  }, [projectId]);

  useEffect(() => {
    if (!project?.channel_id) return;
    // Membership channel hanya filter tampilan: baca cache dulu, lalu refresh di background.
    let cancelled = false;
    (async () => {
      const cached = await window.api.project.listChannelMemberIds(projectId);
      if (!cancelled) setChannelMemberIds(cached);
      const result = await window.api.project.refreshChannelMembers(projectId);
      if (!cancelled) setChannelMemberIds(result.memberIds);
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [projectId, project?.channel_id]);

  function pushUndo(cmd: UndoCommand) {
    undoStack.current.push(cmd);
    redoStack.current = [];
    forceRender((n) => n + 1);
  }

  async function handleUndo() {
    if (historyBusy.current) return;
    const cmd = undoStack.current[undoStack.current.length - 1];
    if (!cmd) return;
    historyBusy.current = true;
    try {
      await cmd.undo();
      undoStack.current.pop();
      redoStack.current.push(cmd);
      forceRender((n) => n + 1);
      await refresh();
    } catch (err) { showToast(err instanceof Error ? err.message : "Gagal undo.", "error"); }
    finally { historyBusy.current = false; }
  }

  async function handleRedo() {
    if (historyBusy.current) return;
    const cmd = redoStack.current[redoStack.current.length - 1];
    if (!cmd) return;
    historyBusy.current = true;
    try {
      await cmd.redo();
      redoStack.current.pop();
      undoStack.current.push(cmd);
      forceRender((n) => n + 1);
      await refresh();
    } catch (err) { showToast(err instanceof Error ? err.message : "Gagal redo.", "error"); }
    finally { historyBusy.current = false; }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // Poin revisi (bug ditemukan lewat audit, U01) — showStatusPresetManager & showKeywordAutomation
      // KETINGGALAN dari guard ini (modal-nya sendiri juga gak punya aria-modal, lihat
      // StatusPresetModal.tsx/KeywordAutomationModal.tsx), jadi Delete/Ctrl+Z/dst tetap tembus ke
      // tabel walau modal itu lagi kebuka. Kedua flag ditambah + kedua modal dikasih aria-modal
      // (defense in depth, guard querySelector di atas jadi valid lagi buat keduanya juga).
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"]') ||
        showGenerate || showWorkload || showHelp || showPreview || showBatchFile ||
        showLog || showHyperlinkManager || showArtistPresetManager ||
        showStatusPresetManager || showKeywordAutomation || showSaveAs || showTemplateAll || openMenu || bulkPasteCol) return;
      const active = document.activeElement as HTMLElement | null;
      const tag = (active?.tagName || "").toLowerCase();
      const typing = tag === "input" || tag === "textarea" || !!active?.isContentEditable;
      if (typing) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        e.preventDefault();
        handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "y" || (e.key.toLowerCase() === "z" && e.shiftKey))) {
        e.preventDefault();
        handleRedo();
      } else if (!typing && (e.key === "Delete" || e.key === "Backspace") && selected.size) {
        e.preventDefault();
        handleRemoveSelected();
      } else if (!typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        toggleAll(true);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  // Artis Preset (poin revisi) — map member_id -> preset, buat lookup nickname (dropdown) DAN
  // code_name (workflow assign-via-reaction) sekali tempat.
  const presetByMember = useMemo(() => new Map(artistPresets.map((p) => [p.member_id, p])), [artistPresets]);

  // Copy-paste ala Excel (poin revisi) — Ctrl+C/Ctrl+V jalan murni dari POSISI MOUSE (hover cell
  // Item/Artis, lihat cellHoverHandlers di atas), gak butuh klik/fokus dulu.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const cell = hoveredCellRef.current;
      if (!cell || !project || !(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key !== "c" && key !== "v") return;
      // Poin revisi (bug ditemukan lewat audit, U03) — kalau user lagi NGETIK (input/textarea/
      // contenteditable fokus, mis. lagi edit nama item di cell yang KEBETULAN lagi di-hover
      // mouse juga), biarin Ctrl+C/V native OS jalan apa adanya. SEBELUMNYA gak ada pengecekan
      // ini sama sekali -- shortcut cell ini kepicu duluan (preventDefault) walau user cuma mau
      // paste teks biasa dari OS ke input nama yang lagi difokus.
      const active = document.activeElement as HTMLElement | null;
      const typing = !!active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.isContentEditable);
      if (typing) return;
      const item = project.items.find((i) => i.id === cell.itemId);
      if (!item) return;
      e.preventDefault();
      if (key === "c") {
        // Multi-artist (poin revisi) — copy nama SEMUA artis, dipisah koma (cocok sama format
        // yang diterima paste-nya sendiri, lihat cabang "v" di bawah). Poin revisi (bug ditemukan
        // lewat audit, U02) — kolom Status DULU ke-treat kayak Artis (fall-through ke cabang
        // default), copy Status malah ngambil nama artis. Sekarang switch eksplisit per kolom.
        cellClipboardRef.current = cell.col === "item"
          ? item.name
          : cell.col === "status"
            ? statusPresets.find((p) => p.id === item.status_id)?.name || ""
            : item.artists.map((a) => presetByMember.get(a.artist_id)?.nickname || a.artist_name || a.artist_id).join(", ");
        return;
      }
      const value = cellClipboardRef.current;
      if (value === null) return;
      if (cell.col === "item") {
        if (value !== item.name) handleRenameItem(item, value);
        return;
      }
      if (cell.col === "status") {
        // Poin revisi (bug ditemukan lewat audit, U02) — SEBELUMNYA cabang ini gak ada, paste di
        // kolom Status jatuh ke logic Artis di bawah (diff assignment artis nge-anggep isi
        // clipboard itu daftar nama artis -- paste Status bisa NGEHAPUS artis yang sah). Cocokin
        // ke nama preset Status (case-insensitive); nama kosong = clear status; nama gak dikenal
        // DIBIARIN (gak ngubah apa-apa), sama filosofi kayak paste Artis/Bulk Paste.
        const trimmed = value.trim();
        const matched = trimmed ? statusPresets.find((p) => p.name.toLowerCase() === trimmed.toLowerCase()) : null;
        if (!trimmed || matched) handleSetStatus(item, matched?.id ?? null);
        return;
      }
      // Paste kolom Artis (poin revisi multi-artist) — parse koma-pisah, cocokin tiap nama ke
      // nickname/username (nama gak ketemu di roster DIBIARIN, gak nulis data salah, sama
      // filosofi kayak Bulk Paste), lalu diff ke daftar SEKARANG: assign yang baru, lepas yang
      // gak ada lagi di hasil parse.
      const names = value.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const resolved = names
        .map((line) => users.find((u) => (presetByMember.get(u.id)?.nickname || "").toLowerCase() === line || u.name.toLowerCase() === line))
        .filter((u): u is SlackUser => !!u);
      if (!multiAssignment) {
        const artist = resolved[0];
        if (names.length > 0 && !artist) return;
        handleSetArtists(item, artist ? [{ artistId: artist.id, artistName: artist.name }] : []);
        return;
      }
      const resolvedIds = new Set(resolved.map((u) => u.id));
      const currentIds = new Set(item.artists.map((a) => a.artist_id));
      for (const u of resolved) if (!currentIds.has(u.id)) handleAddArtist(item, u.id, u.name);
      for (const a of item.artists) if (!resolvedIds.has(a.artist_id)) handleRemoveArtist(item, a.artist_id);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [project, users, presetByMember, statusPresets, multiAssignment]);

  // Dropdown Artis (Tab Table DAN Tab Reply, satu sumber sama-sama pakai ini) — nama yang
  // ditampilkan pakai nickname preset kalau ada, fallback nama Slack asli kalau belum. Cuma
  // ganti TAMPILAN (u.name) — u.id tetap Slack member_id asli, mention/lookup lain gak kepengaruh.
  const visibleUsers = useMemo(() => {
    const base = activeGroupId === CHANNEL_MEMBERS_GROUP_ID
      ? users.filter((u) => channelMemberIds.includes(u.id))
      : !activeGroupId ? users : (() => {
      const g = groups.find((g) => g.id === activeGroupId);
      return g ? users.filter((u) => g.memberIds.includes(u.id)) : users;
    })();
    return base.map((u) => {
      const nickname = presetByMember.get(u.id)?.nickname;
      return nickname ? { ...u, name: nickname } : u;
    });
  }, [users, groups, activeGroupId, channelMemberIds, presetByMember]);

  const workload = useMemo(() => {
    if (!project) return [];
    const counts = new Map<string, number>();
    for (const item of project.items) {
      // Multi-artist (poin revisi) — item dengan 2+ artis kehitung di SEMUA artisnya (bukan cuma
      // 1), biar workload per-artis akurat.
      if (item.artists.length === 0) {
        counts.set("Belum ditugaskan", (counts.get("Belum ditugaskan") || 0) + 1);
      } else {
        for (const a of item.artists) {
          const name = a.artist_name || a.artist_id;
          counts.set(name, (counts.get(name) || 0) + 1);
        }
      }
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [project]);
  const workloadTotal = workload.reduce((s, [, c]) => s + c, 0) || 1;

  // Lebar kolom Item ngikutin panjang teks TERPANJANG (poin revisi: hemat ruang kalau nilainya
  // pendek), pakai satuan `ch` (perkiraan lebar 1 karakter di font aktif). Dicap max 60 karakter
  // biar nama super panjang gak nge-blow-out tabel. Kolom Artis (poin revisi lanjutan: HAPUS
  // auto-width-by-content, khusus kolom ini) — lebar TETAP, chip artis (bisa lebih dari 1
  // sekarang) wrap sendiri ke bawah kalau kepanjangan, gak perlu ngukur teks lagi.
  const columnWidths = useMemo(() => {
    if (!project) return { item: "auto" };
    const itemChars = Math.max(8, ...project.items.map((i) => (i.name || "").length));
    return { item: `${Math.min(itemChars, 60) + 4}ch` };
  }, [project]);
  const ARTIST_COLUMN_WIDTH = "200px";

  // Shift+klik = pilih range dari checkbox terakhir diklik s.d. yang di-shift-klik (semua
  // di antaranya jadi checked). Klik-tahan-geser = "cat" checkbox yang disentuh mouse pas
  // ditahan, ikut nilai checkbox pertama yang diklik (check kalau mulai dari uncheck, dst).
  const dragging = useRef(false);
  const dragValue = useRef(false);
  const lastClickedIndex = useRef<number | null>(null);

  useEffect(() => {
    function onMouseUp() {
      dragging.current = false;
    }
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, []);

  function handleCheckboxMouseDown(e: React.MouseEvent, itemId: string, index: number) {
    // Shift+klik tanpa ini bikin browser nganggep ini "extend text selection" (drag dari klik
    // terakhir ke klik sekarang), nongolin kotak highlight/border oren di sepanjang baris yang
    // "terselect" — bukan style kita, itu seleksi teks native browser. preventDefault matiin itu.
    e.preventDefault();
    if (e.shiftKey && lastClickedIndex.current !== null && project) {
      const [start, end] = [lastClickedIndex.current, index].sort((a, b) => a - b);
      const rangeIds = project.items.slice(start, end + 1).map((i) => i.id);
      setSelected((prev) => new Set([...prev, ...rangeIds]));
      lastClickedIndex.current = index;
      return;
    }
    const willCheck = !selected.has(itemId);
    setSelected((prev) => {
      const next = new Set(prev);
      willCheck ? next.add(itemId) : next.delete(itemId);
      return next;
    });
    dragging.current = true;
    dragValue.current = willCheck;
    lastClickedIndex.current = index;
  }

  function handleCheckboxMouseEnter(itemId: string) {
    if (!dragging.current) return;
    setSelected((prev) => {
      const next = new Set(prev);
      dragValue.current ? next.add(itemId) : next.delete(itemId);
      return next;
    });
  }

  function toggleAll(forceOn = false) {
    if (!project) return;
    setSelected((prev) => (forceOn || prev.size !== project.items.length ? new Set(project.items.map((i) => i.id)) : new Set()));
  }

  async function handleAddManual() {
    const currentId = await window.api.item.addManual({ projectId, name: "" });
    const added = (await window.api.project.load(projectId))?.items.find((i) => i.id === currentId);
    if (!added) throw new Error("Item baru tidak ditemukan.");
    pushUndo({
      undo: () => window.api.item.remove(currentId),
      redo: async () => {
        await window.api.item.restore(added);
      },
    });
    refresh();
  }

  async function handleRenameItem(item: ProjectItem, name: string) {
    const oldName = item.name;
    await window.api.item.update(item.id, { name });
    pushUndo({
      undo: () => window.api.item.update(item.id, { name: oldName }),
      redo: () => window.api.item.update(item.id, { name }),
    });
    refresh();
  }

  // Multi-artist (poin revisi) — assign/lepas 1 artis, side-effect-nya (antre reaction mode
  // react, sinkron realtime ke Slack kalau togglenya ON) SEPENUHNYA ditangani backend
  // (item:addArtist/removeArtist, main.cjs) — frontend gak perlu tau mode/realtime sama sekali
  // lagi. Undo = panggil kebalikannya (add<->remove), simetris & otomatis ikut undo side-effect
  // yang sama di backend.
  async function handleSetArtists(item: ProjectItem, artists: Array<{ artistId: string; artistName: string | null }>) {
    const previous = item.artists.map((a) => ({ artistId: a.artist_id, artistName: a.artist_name }));
    pushUndo({
      undo: () => window.api.item.setArtists({ projectId, itemId: item.id, artists: previous }),
      redo: () => window.api.item.setArtists({ projectId, itemId: item.id, artists }),
    });
    updateItemLocally(item.id, (i) => ({
      ...i,
      artists: artists.map((a) => ({ id: a.artistId, artist_id: a.artistId, artist_name: a.artistName })),
    }));
    markSyncing(item.id, true);
    try {
      await window.api.item.setArtists({ projectId, itemId: item.id, artists });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Gagal assign artis.", "error");
    } finally {
      setReactionTick((v) => v + 1);
      markSyncing(item.id, false);
      refresh();
    }
  }

  async function handleAddArtist(item: ProjectItem, artistId: string, artistName: string | null) {
    if (!multiAssignment) {
      return handleSetArtists(item, [{ artistId, artistName }]);
    }
    pushUndo({
      undo: () => window.api.item.removeArtist({ projectId, itemId: item.id, artistId }),
      redo: () => window.api.item.addArtist({ projectId, itemId: item.id, artistId, artistName }),
    });
    updateItemLocally(item.id, (i) => (i.artists.some((a) => a.artist_id === artistId) ? i : { ...i, artists: [...i.artists, { id: artistId, artist_id: artistId, artist_name: artistName }] }));
    markSyncing(item.id, true);
    try {
      await window.api.item.addArtist({ projectId, itemId: item.id, artistId, artistName });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Gagal assign artis.", "error");
    } finally {
      setReactionTick((v) => v + 1); // chip react ikut realtime muncul abis assign artis (poin revisi)
      markSyncing(item.id, false);
      refresh();
    }
  }

  async function handleRemoveArtist(item: ProjectItem, artistId: string) {
    const artistName = item.artists.find((a) => a.artist_id === artistId)?.artist_name || null;
    pushUndo({
      undo: () => window.api.item.addArtist({ projectId, itemId: item.id, artistId, artistName }),
      redo: () => window.api.item.removeArtist({ projectId, itemId: item.id, artistId }),
    });
    updateItemLocally(item.id, (i) => ({ ...i, artists: i.artists.filter((a) => a.artist_id !== artistId) }));
    markSyncing(item.id, true);
    try {
      await window.api.item.removeArtist({ projectId, itemId: item.id, artistId });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Gagal lepas artis.", "error");
    } finally {
      setReactionTick((v) => v + 1);
      markSyncing(item.id, false);
      refresh();
    }
  }

  // Fitur Status (poin revisi) — single-select, ganti status = replace langsung (bukan
  // add/remove pasangan kayak artis), undo-nya cukup simpen status SEBELUMNYA.
  async function handleSetStatus(item: ProjectItem, statusId: string | null) {
    const prevStatusId = item.status_id;
    pushUndo({
      undo: () => window.api.item.setStatus({ projectId, itemId: item.id, statusId: prevStatusId }),
      redo: () => window.api.item.setStatus({ projectId, itemId: item.id, statusId }),
    });
    updateItemLocally(item.id, (i) => ({ ...i, status_id: statusId }));
    markSyncing(item.id, true);
    try {
      await window.api.item.setStatus({ projectId, itemId: item.id, statusId });
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Gagal ganti status.", "error");
    } finally {
      markSyncing(item.id, false);
      refresh();
    }
  }

  // Poin revisi: assign artis SEKALIGUS ke semua item yang checkbox-nya dicentang (tombol di
  // Sidebar, bawah Merge) — ADDITIF (nambah ke daftar artis item, gak nge-replace yang udah ada,
  // masuk akal buat multi-artist), skip item yang UDAH punya artis ini. 1 undo batch.
  async function handleBulkAssignArtist(artistId: string) {
    if (!project || selected.size === 0) return;
    const u = users.find((u) => u.id === artistId);
    if (!multiAssignment) {
      const rows = project.items.filter((i) => selected.has(i.id) && (i.artists.length !== 1 || i.artists[0].artist_id !== artistId));
      if (!rows.length) return;
      const previous = rows.map((row) => ({
        id: row.id,
        artists: row.artists.map((a) => ({ artistId: a.artist_id, artistName: a.artist_name })),
      }));
      const next = [{ artistId, artistName: u?.name || null }];
      for (const row of rows) await window.api.item.setArtists({ projectId, itemId: row.id, artists: next });
      pushUndo({
        undo: async () => { for (const row of previous) await window.api.item.setArtists({ projectId, itemId: row.id, artists: row.artists }); },
        redo: async () => { for (const row of rows) await window.api.item.setArtists({ projectId, itemId: row.id, artists: next }); },
      });
      setReactionTick((v) => v + 1);
      showToast(`${u?.name || artistId} di-assign ke ${rows.length} item.`, "success");
      refresh();
      return;
    }
    const rows = project.items.filter((i) => selected.has(i.id) && !i.artists.some((a) => a.artist_id === artistId));
    if (!rows.length) return;
    for (const r of rows) await window.api.item.addArtist({ projectId, itemId: r.id, artistId, artistName: u?.name || null });
    pushUndo({
      undo: async () => { for (const r of rows) await window.api.item.removeArtist({ projectId, itemId: r.id, artistId }); },
      redo: async () => { for (const r of rows) await window.api.item.addArtist({ projectId, itemId: r.id, artistId, artistName: u?.name || null }); },
    });
    setReactionTick((v) => v + 1);
    showToast(`${u?.name || artistId} di-assign ke ${rows.length} item.`, "success");
    refresh();
  }

  // Poin revisi: sama konsep kayak bulk assign artis di atas, cuma buat Status — single-select,
  // jadi SET (replace) status semua item yang dicentang, bukan additif. Undo simpen status
  // SEBELUMNYA per-item (bisa beda-beda), bukan 1 nilai buat semua.
  async function handleBulkAssignStatus(statusId: string) {
    if (!project || selected.size === 0) return;
    const rows = project.items.filter((i) => selected.has(i.id));
    if (!rows.length) return;
    const prevStatusIds = rows.map((r) => ({ id: r.id, statusId: r.status_id }));
    for (const r of rows) await window.api.item.setStatus({ projectId, itemId: r.id, statusId });
    pushUndo({
      undo: async () => { for (const p of prevStatusIds) await window.api.item.setStatus({ projectId, itemId: p.id, statusId: p.statusId }); },
      redo: async () => { for (const r of rows) await window.api.item.setStatus({ projectId, itemId: r.id, statusId }); },
    });
    const statusName = statusPresets.find((p) => p.id === statusId)?.name || statusId;
    showToast(`Status "${statusName}" di-set ke ${rows.length} item.`, "success");
    refresh();
  }

  async function handleRemoveItem(item: ProjectItem) {
    await window.api.item.remove(item.id);
    pushUndo({
      undo: () => window.api.item.restore(item),
      redo: () => window.api.item.remove(item.id),
    });
    setSelected((prev) => {
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
    refresh();
  }

  async function handleRemoveSelected() {
    if (!project || !selected.size) return;
    const items = project.items.filter((i) => selected.has(i.id));
    for (const item of items) await window.api.item.remove(item.id);
    pushUndo({
      undo: async () => {
        for (const item of items) await window.api.item.restore(item);
      },
      redo: async () => {
        for (const item of items) await window.api.item.remove(item.id);
      },
    });
    setSelected(new Set());
    refresh();
  }

  async function handleMerge(separator: "," | "-") {
    if (selected.size < 2) return;
    try {
      const { snapshot } = await window.api.item.merge(Array.from(selected), separator === "," ? ", " : "-");
      if (snapshot) {
        let activeSnapshot = snapshot;
        pushUndo({
          undo: () => window.api.item.unmerge(activeSnapshot),
          redo: async () => {
            const result = await window.api.item.merge(activeSnapshot.itemIds, activeSnapshot.separator);
            if (result.snapshot) activeSnapshot = result.snapshot;
          },
        });
      }
      setSelected(new Set());
      refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Gagal merge.", "error");
    }
  }

  async function handleExport() {
    try {
      const res = await window.api.project.export(projectId);
      if (!res.canceled) showToast("Project berhasil diekspor.", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Gagal mengekspor project.", "error");
    }
  }

  async function handleImportProject() {
    try {
      const res = await window.api.project.import();
      if (!res.canceled) showToast("Project berhasil di-import. Buka dari Start Menu.", "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Gagal mengimpor project.", "error");
    }
  }

  // window.prompt() TIDAK didukung Electron (beda dari alert()/confirm() yang jalan normal) —
  // klik Save As sebelumnya silent no-op karena prompt() gak nampilin dialog apa pun. Ganti
  // pakai PromptModal in-app (lihat showSaveAs di bawah).
  function handleSaveAs() {
    setShowSaveAs(true);
  }

  async function submitSaveAs(name: string) {
    setShowSaveAs(false);
    const newId = await window.api.project.duplicate(projectId, name);
    onOpenProject(newId);
  }

  async function handleDeleteProject() {
    if (!confirm(`Hapus project "${project?.name}"? Ini gak bisa dibatalkan.`)) return;
    await window.api.project.delete(projectId);
    onBackToStartMenu();
  }

  function doSend(itemIds: string[], channelId: string, scope?: "item" | "artist" | "replies") {
    setShowPreview(false);
    setSending(true);
    setResults(null);
    window.api.send.start({ projectId, itemIds, channelId, scope }).catch((err) => {
      setSending(false);
      setProgress(null);
      setResults(itemIds.map((itemId) => ({ itemId, itemName: project?.items.find((i) => i.id === itemId)?.name || itemId, status: "gagal", reason: err instanceof Error ? err.message : "Gagal mengirim." })));
    });
  }

  // Instant Intake per-KOLOM (poin revisi: overlay di header tabel, bukan cuma per-row) — kirim
  // scope yang sama (item/artist/replies) ke SEMUA item terpilih (atau semua item kalau gak ada
  // yang dicentang, sama seperti tombol "Preview & Kirim") sekaligus, lewat send:start (progress
  // bar + satu openSlack doang, bukan spam buka Slack per item).
  // async biar cocok sama tipe onClick QuickSendButton (=> Promise) — doSend sendiri fire-and-
  // forget (progress/hasil ditangani state sending/progress/results yang udah ada, bukan spinner
  // lokal tombol ini), jadi promise di sini nyelesai begitu proses kirim DIMULAI, bukan selesai.
  async function quickSendColumn(scope: "item" | "artist" | "replies" | "status", label: string) {
    const ids = effectiveItemIds;
    if (!ids.length || !project) return;
    const target = selected.size === 0 ? "SEMUA item" : `${ids.length} item terpilih`;
    if (!confirm(`Instant Intake — kirim kolom "${label}" ke ${target}?`)) return;
    // Poin revisi (diminta user) — scope "item"/"artist"/"status" (assign-state doang, gak ada
    // isi yang dikirim) di-split per-item: yang UDAH ADA thread-nya cukup di-Push (paralel, gak
    // ikut antre batch progress), yang BENERAN baru tetap lewat Instant Intake batch (send:start).
    // Scope "replies" TETAP instant intake semua item -- ngirim ISI reply, Push gak bisa gantiin.
    if (scope === "replies") {
      doSend(ids, project.channel_id, scope);
      return;
    }
    const existingIds = ids.filter((id) => project.items.find((i) => i.id === id)?.has_thread);
    const newIds = ids.filter((id) => !existingIds.includes(id));
    for (const id of existingIds) {
      const item = project.items.find((i) => i.id === id);
      // openAfter=false -- overlay KOLOM bisa nge-Push BANYAK item sekaligus, jangan buka tab
      // Slack per item (beda dari overlay per-row/menu-bar Push yang cuma 1 target).
      if (item) {
        const operation = scope === "item" ? pushItemName(item, false) : pushItem(item, false);
        operation.catch((err) => showToast(err instanceof Error ? err.message : `Gagal push "${item.name}".`, "error"));
      }
    }
    // doSend cuma kenal scope "item"/"artist"/"replies" -- "status" efeknya SAMA persis kayak
    // "item" di send:start (status SELALU ikut disinkron di Fase 2 apa pun scope-nya), jadi
    // dipetain ke situ, gak perlu nambah scope baru di backend.
    if (newIds.length) doSend(newIds, project.channel_id, scope === "status" ? "item" : scope);
  }

  async function handleCancel() {
    await window.api.send.cancel();
  }

  if (!project) return <div role="alert" style={{ padding: 24 }}>
    {loadError || "Memuat project…"} <button className="btn" onClick={refresh}>Coba lagi</button>
    <button className="btn" onClick={onBackToStartMenu}>Kembali</button>
  </div>;
  // Reply tab defaultnya nunjukin item pertama kalau belum ada yang dipilih dari Tab Table.
  const activeItemIndex = project.items.findIndex((i) => i.id === activeItemId);
  const activeItem = activeItemIndex >= 0 ? project.items[activeItemIndex] : project.items[0] || null;
  const activeIndex = activeItem ? project.items.findIndex((i) => i.id === activeItem.id) : -1;

  function openReplyTab(itemId: string) {
    setActiveItemId(itemId);
    setActiveTab("reply");
  }

  // Poin revisi (diminta user) — Pull/Push punya 2 prilaku beda tergantung tab aktif: Tab Table
  // scope-nya SELURUH project (handleSyncAssignToSlack/handlePullFromSlack di atas, gak berubah),
  // Tab Reply scope-nya CUMA item yang lagi aktif — 2 fungsi baru ini, dipilih di JSX <MenuBar>
  // di bawah berdasarkan activeTab. Ditaruh di sini (bukan di atas bareng yang lain) karena butuh
  // `activeItem` yang baru kehitung setelah guard `!project` di atas.
  async function handlePushActiveItem() {
    if (!activeItem || syncingAssign) return;
    setSyncingAssign(true);
    try {
      await pushItem(activeItem); // reuse fungsi yang sama kayak overlay per-item (poin revisi)
      showToast(`Push selesai — "${activeItem.name}" disinkron ke Slack.`, "success");
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Gagal push item ke Slack.", "error");
    } finally {
      setSyncingAssign(false);
    }
  }
  async function handlePullActiveItem() {
    if (!activeItem || pulling) return;
    setPulling(true);
    try {
      const result = await window.api.slackPull.syncItem({ projectId, itemId: activeItem.id });
      if (!result.reactionChanges && !result.keywordChanges && !result.nameChanged) {
        showToast(`"${activeItem.name}" sudah sinkron — gak ada update baru dari Slack.`, "info");
      } else {
        // result.itemName (bukan activeItem.name) -- kalau nameChanged, activeItem.name di sini
        // masih nama LAMA (state belum ke-refresh), result.itemName udah yang TERBARU.
        showToast(`Pull selesai — "${result.itemName}": ${result.reactionChanges} react, ${result.keywordChanges} kata kunci ke-update${result.nameChanged ? ", nama item ikut ke-update" : ""}.`, "success");
      }
      refresh();
      setReactionTick((v) => v + 1);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Gagal pull item dari Slack.", "error");
    } finally {
      setPulling(false);
    }
  }

  // Gak ada yang dicentang = kirim SEMUA item (bukan gak ada yang dikirim); sebagian dicentang
  // = kirim yang dicentang aja. Tombol cuma disabled kalau tabelnya beneran kosong.
  const effectiveItemIds = selected.size > 0 ? Array.from(selected) : project.items.map((i) => i.id);

  // "Instant Intake" (poin revisi) — overlay pesawat, kirim LANGSUNG (gak ada modal preview/
  // channel-picker lagi kayak percobaan sebelumnya), scoped ke SEBAGIAN item doang lewat
  // send:quick (lihat main.cjs). channelId SENGAJA gak dikasih dari sini — biar backend yang
  // nentuin (channel tempat item ini SUDAH punya thread kalau ada, baru fallback ke default
  // project; nyegah bikin thread duplikat di channel yang salah, bug yang dilaporkan user).
  function quickSend(itemId: string, scope: "item" | "artist" | "replies" | "field", replyId?: string) {
    return window.api.send.quick({ projectId, itemId, scope, replyId }).then(() => { refresh(); setReactionTick((v) => v + 1); }).catch((err) => {
      setResults([{ itemId, itemName: project?.items.find((i) => i.id === itemId)?.name || itemId, status: "gagal", reason: err.message }]);
      throw err;
    });
  }

  // Poin revisi (diminta user) — overlay "Instant Intake" per-item sekarang 2 prilaku beda:
  // item yang UDAH ADA thread-nya (item.has_thread) gak perlu kirim isi ulang, cukup di-Push
  // (sinkron ulang assign/status, fungsi yang SAMA persis kayak tombol Push di menu bar); item
  // yang BENERAN baru tetap lewat Instant Intake (quickSend, bikin thread + kirim isi). Ini CUMA
  // buat scope "item"/"artist" (assign-state doang) -- scope "field"/"replies" (kirim ISI reply)
  // TETAP Instant Intake terus, gak peduli has_thread, soalnya Push gak pernah ngirim isi reply.
  function pushItem(item: ProjectItem, openAfter = true) {
    return window.api.artistAssign.syncItem({ projectId, itemId: item.id, openAfter }).then(() => {
      refresh();
      setReactionTick((v) => v + 1);
    });
  }
  function pushItemName(item: ProjectItem, openAfter = true) {
    return window.api.item.pushRootName({ projectId, itemId: item.id, openAfter }).then(refresh);
  }
  function quickSendOrPush(item: ProjectItem, scope: "item" | "artist" | "status") {
    if (item.has_thread) return scope === "item" ? pushItemName(item) : pushItem(item);
    return quickSend(item.id, scope === "status" ? "item" : scope);
  }

  async function handleSetPhase(phase: "setup" | "input") {
    if (!project || phase === project.phase) return;
    await window.api.project.setPhase(projectId, phase);
    refresh();
  }

  // Tahapan gak boleh dilewatin (poin revisi, diminta user) -- tombol "Input" cuma bisa diklik
  // kalau SEMUA item udah punya thread (nama item-nya kekirim ke Slack); reply/field boleh
  // nyusul belakangan di tahap Input, gak ikut disyaratkan di sini. Backend (projects.cjs
  // setProjectPhase) nge-guard ULANG rule yang SAMA, ini cuma buat nge-disable tombolnya.
  const canEnterInput = project.items.length > 0 && project.items.every((i) => i.has_thread);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Poin revisi (diminta user) — section nama project diperpendek (padding dikurangi) DAN
          jadi host toast (ToastHost, posisi absolute nutup section ini, "tengah atas"). */}
      <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 16px", borderBottom: "1px solid var(--border)" }}>
        <ToastHost />
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button className="icon-btn" onClick={onBackToStartMenu} title="Kembali">
            <ArrowLeft size={16} />
          </button>
          <div>
            {editingName ? (
              <input
                defaultValue={project.name}
                autoFocus
                onBlur={async (e) => {
                  if (e.target.value.trim() && e.target.value !== project.name) {
                    await window.api.project.rename(projectId, e.target.value.trim());
                    refresh();
                  }
                  setEditingName(false);
                }}
                style={{ fontSize: 15, fontWeight: 600 }}
              />
            ) : (
              <h2 onClick={() => setEditingName(true)} style={{ cursor: "text" }} title="Klik buat rename">
                {project.name}
              </h2>
            )}
          </div>
          {/* Tahap alur kerja Setup/Input (poin revisi, diminta user; nama lama "Assign") — "ini
              bukan fitur baru, cuma nyesuain alur kerja": Setup nyembunyiin kolom Artis/Status/
              Pull/Push/Toggle (belum relevan pas masih nyusun daftar item), Input nampilin
              semuanya & gantiin tombol "Kirim ke Slack" jadi Pull/Push/Toggle. Tahapan gak boleh
              dilewatin — tombol "Input" disable sampai SEMUA item punya thread (canEnterInput).
              Poin revisi lanjutan (diminta user) — SEKALI masuk Input gak bisa balik lagi ke
              Setup (one-way door, ganti dari keputusan awal yang masih ngebolehin mundur bebas). */}
          <div style={{ display: "flex", border: "1px solid var(--border-strong)", borderRadius: 6, overflow: "hidden" }}>
            {(["setup", "input"] as const).map((p) => (
              <button
                key={p}
                className="btn"
                disabled={(p === "input" && !canEnterInput) || (p === "setup" && project.phase === "input")}
                title={
                  p === "setup"
                    ? project.phase === "input"
                      ? "Tahap Input gak bisa dibalikin lagi ke Setup"
                      : "Tahap Setup — nyusun daftar item, kolom Artis/Status/Pull/Push disembunyiin"
                    : canEnterInput
                      ? "Tahap Input — assign artis/status/reply, tombol Kirim ke Slack diganti Pull/Push/Toggle"
                      : "Semua item harus udah terkirim ke Slack dulu (tahap Setup) sebelum lanjut ke tahap Input"
                }
                style={{
                  border: "none", borderRadius: 0, padding: "3px 10px", fontSize: 11,
                  ...(p === "input" ? { borderLeft: "1px solid var(--border-strong)" } : {}),
                  ...(project.phase === p ? { background: "var(--accent)", color: "#fff" } : {}),
                }}
                onClick={() => handleSetPhase(p)}
              >
                {p === "setup" ? "Setup" : "Input"}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Keterangan channel terhubung (poin revisi, diminta user) — cuma teks read-only,
              muncul pas tahap Input doang (Setup belum tentu channel-nya final/relevan). */}
          {project.phase === "input" && (
            <span className="caption" style={{ whiteSpace: "nowrap" }}>
              # {project.channel_name}
            </span>
          )}
          {/* Poin revisi (diminta user) — ganti notif toast pas toggle Realtime Sync jadi pill
              status PERSISTEN (bukan sekejap), rata kanan section nama project. Ada SELAMA
              toggle-nya ON, ilang begitu di-OFF-in (bukan animasi masuk/keluar, murni tampil/gak). */}
          {realtimeAssignEnabled && (
            <span
              style={{
                display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 999,
                background: "var(--success)", color: "#fff", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
              }}
            >
              Slack Realtime Sync Active
            </span>
          )}
        </div>
      </div>

      <MenuBar
        openMenu={openMenu}
        onOpenMenuChange={setOpenMenu}
        onImportProject={handleImportProject}
        onExportProject={handleExport}
        onSaveAs={handleSaveAs}
        onDeleteProject={handleDeleteProject}
        onBackToStartMenu={onBackToStartMenu}
        mergeSeparator={mergeSeparator}
        onMergeSeparatorChange={setMergeSeparator}
        onToggleWorkload={() => setShowWorkload((v) => !v)}
        onToggleLog={() => setShowLog((v) => !v)}
        onGroupEditor={() => setShowArtistPresetManager(true)}
        onHyperlinkManager={() => setShowHyperlinkManager(true)}
        onArtistPresetManager={() => setShowArtistPresetManager(true)}
        onHelp={() => setShowHelp(true)}
        instantIntakeEnabled={instantIntakeEnabled}
        onToggleInstantIntake={toggleInstantIntake}
        onKeywordAutomation={() => setShowKeywordAutomation(true)}
        isAdminMember={isAdminMember}
      />

      {showWorkload && (
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
          <div className="label" style={{ marginBottom: 6 }}>
            Workload Distribution
          </div>
          <div style={{ display: "flex", height: 26, borderRadius: 6, overflow: "hidden" }}>
            {workload.map(([name, count], i) => (
              <div
                key={name}
                title={`${name}: ${count}`}
                style={{ width: `${(count / workloadTotal) * 100}%`, background: PALETTE[i % PALETTE.length], display: "flex", alignItems: "center", justifyContent: "center" }}
              >
                <span style={{ fontSize: 11, color: "#fff", fontWeight: 700 }}>{count}</span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 6 }}>
            {workload.map(([name], i) => (
              <span key={name} className="caption" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: 999, background: PALETTE[i % PALETTE.length], display: "inline-block" }} /> {name}
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        <Sidebar
          onGenerateItem={() => setShowGenerate(true)}
          onMerge={() => handleMerge(mergeSeparator)}
          // Merge dimatikan pas tahap Input (poin revisi, diminta user) -- item yang udah kekirim
          // beresiko bikin pesan Slack yatim kalau ikut di-merge, ditunda ke versi berikutnya.
          canMerge={selected.size >= 2 && project.phase === "setup"}
          onRemoveSelected={handleRemoveSelected}
          canRemove={selected.size > 0}
          onBatchFile={() => setShowBatchFile(true)}
          onHyperlinkManager={() => setShowHyperlinkManager(true)}
          onHelp={() => setShowHelp(true)}
          users={visibleUsers}
          onBulkAssignArtist={handleBulkAssignArtist}
          canBulkAssignArtist={selected.size > 0}
          statusPresets={statusPresets}
          onBulkAssignStatus={handleBulkAssignStatus}
          canBulkAssignStatus={selected.size > 0}
        />

        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div className="folder-tabbar">
            <button className={`folder-tab ${activeTab === "table" ? "active" : ""}`} onClick={() => setActiveTab("table")}>
              Table
            </button>
            <button className={`folder-tab ${activeTab === "reply" ? "active" : ""}`} onClick={() => setActiveTab("reply")}>
              Reply
            </button>
            {/* Tahap Input (poin revisi, diminta user; nama lama "Assign") — tombol "Kirim ke
                Slack" gak dibutuhin lagi di tahap ini (isinya udah kekirim, tinggal assign/
                sinkron), digantikan Pull/Push/Toggle yang direposisi ke sini (dulu di MenuBar,
                lihat Chrome.tsx). */}
            {project.phase === "input" ? (
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 9 }}>
                <SyncControls
                  realtimeAssignEnabled={realtimeAssignEnabled}
                  onToggleRealtimeAssign={toggleRealtimeAssign}
                  syncingAssign={syncingAssign}
                  // Poin revisi (diminta user) — Pull/Push scope beda tergantung tab: Tab Table =
                  // seluruh project, Tab Reply = item yang lagi aktif doang. Toggle Realtime Sync
                  // TETAP global (session setting, gak ada versi "per item").
                  onSyncAssignToSlack={activeTab === "table" ? handleSyncAssignToSlack : handlePushActiveItem}
                  pulling={pulling}
                  onPullFromSlack={activeTab === "table" ? handlePullFromSlack : handlePullActiveItem}
                  scopeLabel={activeTab === "table" ? "semua item project ini" : activeItem ? `item "${activeItem.name}"` : "item aktif"}
                />
              </div>
            ) : (
              /* "Kirim ke Slack" (poin revisi) — dipindah dari MenuBar ke sini, tetap rata kanan,
                 bareng buat Tab Table & Tab Reply (baris ini di luar switch activeTab). */
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 9 }}>
                <button
                className="btn"
                onClick={() => setShowPreview(true)}
                disabled={project.items.length === 0 || sending}
                title={`Preview & Kirim (${effectiveItemIds.length}${selected.size === 0 && project.items.length > 0 ? " — semua" : ""})`}
                style={{ marginBottom: 4, background: "var(--surface)", borderRadius: 999, padding: "1px 6px", border: "1px solid var(--border-strong)" }}
              >
                <img src={slackButtonImg} alt="Kirim ke Slack" style={{ height: 22, display: "block" }} />
                </button>
              </div>
            )}
          </div>

          {activeTab === "reply" ? (
            <div className="folder-panel">
              {activeItem ? (
                <Suspense fallback={<div className="placeholder-box"><span className="caption">Memuat editor…</span></div>}>
                <Drawer
                  item={activeItem}
                  projectId={projectId}
                  phase={project.phase}
                  projectFiles={project.files}
                  onChanged={refresh}
                  onPrev={() => setActiveItemId(project.items[activeIndex - 1].id)}
                  onNext={() => setActiveItemId(project.items[activeIndex + 1].id)}
                  canPrev={activeIndex > 0}
                  canNext={activeIndex >= 0 && activeIndex < project.items.length - 1}
                  users={visibleUsers}
                  senderUsers={users}
                  artistPresets={artistPresets}
                  onAddArtist={handleAddArtist}
                  onRemoveArtist={handleRemoveArtist}
                  onManageArtistPresets={() => setShowArtistPresetManager(true)}
                  statusPresets={statusPresets}
                  onSetStatus={handleSetStatus}
                  onManageStatusPresets={() => setShowStatusPresetManager(true)}
                  syncing={syncingItemIds.has(activeItem.id)}
                  reactionTick={reactionTick}
                  instantIntakeEnabled={instantIntakeEnabled}
                  onToggleInstantIntake={toggleInstantIntake}
                />
                </Suspense>
              ) : (
                <div className="placeholder-box" style={{ margin: 16 }}>
                  <span className="caption">Belum ada item. Tambah item dulu di Tab Table.</span>
                </div>
              )}
            </div>
          ) : (
          <div className="folder-panel scrollbar-thin" style={{ overflow: "auto", paddingTop: 10 }}>
            {/* paddingTop 10px KHUSUS ngasih ruang overlay Instant Intake di header (poking
                top:-8) — thead th pakai position:sticky (freeze pas scroll), overlay yang poke ke
                atas kepotong sama batas overflow:auto div ini KALAU gak ada ruang. Padding ikut
                masuk padding-box scroll container ini, jadi titik "nempel" sticky (top:0) geser
                turun 10px, nyisain ruang di atasnya buat overlay poke tanpa kepotong. */}
            <table>
              <thead>
                <tr>
                  <th onClick={() => toggleAll()} style={{ width: 16, maxWidth: 16, padding: "8px 1px", textAlign: "center" }}>
                    {selected.size === project.items.length && project.items.length > 0 ? <CheckSquare size={14} /> : <Square size={14} />}
                  </th>
                  <th style={{ width: 16, maxWidth: 16, padding: "8px 1px", textAlign: "center" }}>No</th>
                  {/* position:relative DIHAPUS dari 3 th ini (poin revisi, bug freeze header) —
                      inline style SELALU menang atas rule stylesheet apapun specificity-nya, jadi
                      ini nimpa `thead th { position: sticky }` (styles.css) dan bikin header
                      Item/Artis/Reply ikut scroll bareng body, bukan freeze. Sticky sendiri
                      SUDAH jadi positioning context yang valid buat overlay absolute di dalamnya
                      (QuickSendButton), jadi position:relative di sini emang gak perlu. */}
                  <th style={{ width: columnWidths.item }} onClick={() => setBulkPasteCol("item")} title="Klik buat bulk paste" {...hoverDelayHandlers()}>
                    Item <ClipboardPaste size={10} style={{ display: "inline", verticalAlign: "-1px" }} />
                    {instantIntakeEnabled && <QuickSendButton title="Instant Intake — kirim nama SEMUA item (gak ada artis/reply)" onClick={() => quickSendColumn("item", "Item")} />}
                  </th>
                  {/* B4 — klik header kolom Reply (bubble icon) = pilih Template buat diterapkan
                      ke SEMUA item sekaligus, bukan cuma per-item lewat Tab Reply. Reply dipindah
                      ke SEBELUM Artis/Status (poin revisi, urutan kolom tahap Setup/Assign: Item,
                      Reply, [Artis, Status], X — Reply SELALU ada, gak digate fase). */}
                  <th style={{ width: 50, maxWidth: 50, textAlign: "center" }} onClick={() => setShowTemplateAll(true)} title="Terapkan Template ke SEMUA item" {...hoverDelayHandlers()}>
                    <LayoutTemplate size={12} style={{ display: "inline" }} />
                    {instantIntakeEnabled && <QuickSendButton title="Instant Intake — kirim semua reply/field SEMUA item" onClick={() => quickSendColumn("replies", "Reply")} />}
                  </th>
                  {/* Poin revisi (diminta user, tahap Setup/Input) — kolom Artis/Status cuma
                      relevan pas tahap Input (belum ada gunanya di tahap Setup, item-nya
                      sendiri aja belum tentu final). */}
                  {project.phase === "input" && (
                    <>
                      <th style={{ width: ARTIST_COLUMN_WIDTH }} onClick={() => setBulkPasteCol("artis")} title="Klik buat bulk paste" {...hoverDelayHandlers()}>
                        Artis <ClipboardPaste size={10} style={{ display: "inline", verticalAlign: "-1px" }} />
                        {/* Poin revisi (diminta user) — toggle Realtime Sync + tombol Update (sinkron
                            ulang) dipindah jadi 1 kontrol GLOBAL di atas tombol "Kirim ke Slack" (lihat
                            baris di atas folder-tabbar), gak lagi per-kolom di sini. Header ini sekarang
                            cuma punya shortcut Settings buat buka Kelola Preset Artis. */}
                        <button
                          className="icon-btn"
                          title="Kelola Preset Artis"
                          onClick={(e) => { e.stopPropagation(); setShowArtistPresetManager(true); }}
                          style={{ marginLeft: 4, verticalAlign: "-3px", padding: 2 }}
                        >
                          <Settings size={11} />
                        </button>
                        {instantIntakeEnabled && <QuickSendButton title="Instant Intake — mention artis SEMUA item" onClick={() => quickSendColumn("artist", "Artis")} />}
                      </th>
                      {/* Kolom Status (poin revisi, fitur baru) — dropdown single-select, dikirim
                          sebagai 1 reaction. Realtime/sinkron pakai toggle+tombol Update GLOBAL yang
                          SAMA (lihat baris di atas folder-tabbar). */}
                      <th style={{ width: 110 }} {...hoverDelayHandlers()}>
                        Status
                        <button
                          className="icon-btn"
                          title="Kelola Status"
                          onClick={(e) => { e.stopPropagation(); setShowStatusPresetManager(true); }}
                          style={{ marginLeft: 4, verticalAlign: "-3px", padding: 2 }}
                        >
                          <Settings size={11} />
                        </button>
                        {instantIntakeEnabled && <QuickSendButton title="Instant Intake / Push — sinkron status SEMUA item" onClick={() => quickSendColumn("status", "Status")} />}
                      </th>
                    </>
                  )}
                  <th style={{ width: 40, maxWidth: 40 }} />
                </tr>
              </thead>
              <tbody>
                {project.items.map((item, index) => {
                  const unsentReplyCount = item.replies.filter((reply) => !reply.sent).length;
                  const allRepliesSent = item.replies.length > 0 && unsentReplyCount === 0;
                  return (
                    <tr key={item.id}>
                      <td
                        onMouseDown={(e) => handleCheckboxMouseDown(e, item.id, index)}
                        onMouseEnter={() => handleCheckboxMouseEnter(item.id)}
                        role="checkbox"
                        aria-checked={selected.has(item.id)}
                        aria-label={`Pilih item ${item.name || index + 1}`}
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === " " || e.key === "Enter") {
                            e.preventDefault();
                            handleCheckboxMouseDown(e as unknown as React.MouseEvent, item.id, index);
                          }
                        }}
                        style={{ cursor: "pointer", userSelect: "none", padding: "8px 1px" }}
                      >
                        {selected.has(item.id) ? <CheckSquare size={14} /> : <Square size={14} />}
                      </td>
                      <td className="caption" style={{ textAlign: "center", padding: "8px 1px" }}>
                        {syncingItemIds.has(item.id) ? (
                          <span title="Lagi sinkron ke Slack…" style={{ display: "inline-flex" }}><Loader2 size={12} className="spin" /></span>
                        ) : index + 1}
                      </td>
                      <td className={item.has_thread ? "item-sent-cell" : ""} style={{ position: "relative" }} {...cellHoverHandlers("item", item.id)}>
                        {/* Poin revisi (diminta user) — Tab Table dibersihin dari fitur React
                            (ItemReactionBar/chip) sama sekali, react cuma ada di Tab Reply
                            (Drawer) sekarang, di bawah item Pill. */}
                        <input
                          // key ikut item.name: input uncontrolled (defaultValue) gak update
                          // sendiri kalau nilainya berubah dari LUAR (merge/bulk-paste/undo) —
                          // React reuse DOM node yang sama karena item.id gak berubah, jadi
                          // defaultValue lama nyangkut sampai remount. Paksa remount kalau nama
                          // berubah dari luar, ini bug yang dilaporkan ("baru kelihatan bener
                          // setelah reopen project").
                          key={`${item.id}:${item.name}`}
                          className={item.has_thread ? "item-sent-input" : ""}
                          defaultValue={item.name}
                          aria-label={`Nama item ${index + 1}`}
                          placeholder="Nama item…"
                          style={{ border: "1px solid var(--border)", borderRadius: 4, background: item.has_thread ? "var(--success-soft)" : "transparent", width: "100%", padding: "4px 6px", cursor: "pointer" }}
                          onFocus={() => setEditingCell({ itemId: item.id, col: "item" })}
                          onBlur={(e) => {
                            setEditingCell((c) => (c?.itemId === item.id && c.col === "item" ? null : c));
                            if (e.target.value !== item.name) handleRenameItem(item, e.target.value);
                          }}
                          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                        />
                        {instantIntakeEnabled && !(editingCell?.itemId === item.id && editingCell.col === "item") && (
                          <QuickSendButton
                            title={item.has_thread ? "Push — perbarui nama root item ini di Slack" : "Instant Intake — kirim nama item ini aja (gak ada artis/reply)"}
                            action={item.has_thread ? "push" : "intake"}
                            onClick={() => quickSendOrPush(item, "item")}
                          />
                        )}
                      </td>
                      <td className={allRepliesSent ? "reply-sent-cell" : ""} style={{ position: "relative" }} {...hoverDelayHandlers()}>
                        <button
                          className="icon-btn"
                          title={item.replies.length ? (allRepliesSent ? "Semua reply sudah terkirim" : `${unsentReplyCount} reply belum terkirim`) : "Belum ada reply"}
                          onClick={() => openReplyTab(item.id)}
                          style={{ position: "relative" }}
                        >
                          <MessageSquare size={16} className={item.replies.length ? "" : "muted"} fill={item.replies.length ? "var(--accent-soft)" : "none"} />
                          {unsentReplyCount > 0 && (
                            <span
                              style={{
                                position: "absolute",
                                top: -2,
                                right: -2,
                                background: "var(--danger)",
                                color: "#fff",
                                borderRadius: 999,
                                fontSize: 10,
                                fontWeight: 700,
                                lineHeight: 1,
                                padding: "2px 4px",
                                minWidth: 14,
                                textAlign: "center",
                              }}
                            >
                              {unsentReplyCount}
                            </span>
                          )}
                        </button>
                        {instantIntakeEnabled && <QuickSendButton action={allRepliesSent ? "push" : "intake"} title={allRepliesSent ? "Push — semua reply item ini sudah terkirim" : "Instant Intake — kirim semua reply/field yang belum terkirim"} onClick={() => quickSend(item.id, "replies")} />}
                      </td>
                      {project.phase === "input" && (
                        <>
                          <td style={{ position: "relative" }} {...cellHoverHandlers("artist", item.id)}>
                            {/* Artis Picker (poin revisi) — satu popover buat pilih artis, gak ada
                                native <select> lagi. Akses "Kelola Preset Artis" sekarang lewat
                                Settings di header kolom ini (bukan tombol di dalam dropdown lagi). */}
                            <ArtistPicker
                              item={item}
                              users={visibleUsers}
                              artistPresets={artistPresets}
                              onAddArtist={handleAddArtist}
                              onRemoveArtist={handleRemoveArtist}
                              onOpenChange={(isOpen) => setEditingCell(isOpen ? { itemId: item.id, col: "artist" } : (c) => (c?.itemId === item.id && c.col === "artist" ? null : c))}
                            />
                            {instantIntakeEnabled && !(editingCell?.itemId === item.id && editingCell.col === "artist") && (
                              <QuickSendButton
                                title={item.has_thread ? "Push — sinkron ulang artis item ini ke Slack" : "Instant Intake — mention artis ini aja"}
                                action={item.has_thread ? "push" : "intake"}
                                onClick={() => quickSendOrPush(item, "artist")}
                              />
                            )}
                          </td>
                          <td style={{ position: "relative" }} {...cellHoverHandlers("status", item.id)}>
                            <StatusDropdown
                              statusId={item.status_id}
                              presets={statusPresets}
                              onChange={(statusId) => handleSetStatus(item, statusId)}
                              onOpenChange={(isOpen) => setEditingCell(isOpen ? { itemId: item.id, col: "status" } : (c) => (c?.itemId === item.id && c.col === "status" ? null : c))}
                            />
                            {instantIntakeEnabled && !(editingCell?.itemId === item.id && editingCell.col === "status") && (
                              <QuickSendButton
                                title={item.has_thread ? "Push — sinkron ulang status item ini ke Slack" : "Instant Intake — kirim status item ini aja"}
                                action={item.has_thread ? "push" : "intake"}
                                onClick={() => quickSendOrPush(item, "status")}
                              />
                            )}
                          </td>
                        </>
                      )}
                      <td>
                        <button className="icon-btn" onClick={() => handleRemoveItem(item)} title="Hapus">
                          <X size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                <tr>
                  <td colSpan={6} style={{ padding: 0 }}>
                    <button
                      className="btn"
                      style={{ width: "100%", justifyContent: "flex-start", border: "none", borderRadius: 0, padding: "8px 10px", color: "var(--text-secondary)" }}
                      onClick={handleAddManual}
                    >
                      <Plus size={14} /> Tambah Item
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>
            {project.items.length === 0 && (
              <p className="caption" style={{ margin: "0 10px 12px" }}>
                Belum ada item — klik "+ Tambah Item" di atas, atau pakai Batch File / Generate Item di sidebar kiri.
              </p>
            )}
          </div>
          )}

          <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span className="caption">{selected.size} item tercentang dari {project.items.length}</span>
            {sending && (
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                {progress && (
                  <div className="caption" style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}>
                    {progress.counts && (
                      <span>Item {progress.counts.items} · Assign {progress.counts.assigns} · Reply {progress.counts.replies} · File {progress.counts.files} · Total {progress.counts.total}</span>
                    )}
                    <span>
                      <Loader2 size={12} className="spin" style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }} />
                      {PHASE_LABEL[progress.phase || "post"]} {progress.index + 1}/{progress.total}: {progress.itemName}
                    </span>
                  </div>
                )}
                <button className="btn btn-danger" onClick={handleCancel}>
                  Cancel
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {results && !sending && (
        // Poin revisi: header (judul + tombol X) DULU ikut ke-scroll bareng listnya (overflow:auto
        // di card SELURUHNYA) — kalau ringkasannya panjang, tombol X-nya kescroll keluar, gak bisa
        // ditutup tanpa scroll balik ke atas dulu. Fix: scroll cuma di list-nya sendiri (div
        // terpisah), header TETAP di luar area scroll situ.
        <div className="card" style={{ position: "fixed", right: 16, bottom: 70, width: 320, padding: 14, maxHeight: 300, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, flexShrink: 0 }}>
            <h3>Ringkasan Hasil</h3>
            <button className="icon-btn" onClick={() => setResults(null)}>
              <X size={13} />
            </button>
          </div>
          <div className="scrollbar-thin" style={{ overflow: "auto" }}>
            {results.map((r) => (
              <div key={r.itemId} className="caption" style={{ marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
                <span>
                  {r.status === "berhasil" ? "✓" : r.status === "gagal" ? "✗" : "–"} {r.itemName}
                  {r.reason && <span style={{ color: "var(--danger)" }}> — {r.reason}</span>}
                </span>
                {r.status === "gagal" && <SendRecovery projectId={projectId} itemId={r.itemId} channelId={r.channelId} />}
                {r.permalink && (
                  <>
                    <button
                      className="icon-btn"
                      title="Buka thread di Slack (app desktop kalau ada)"
                      style={{ width: 20, height: 20 }}
                      onClick={() => window.api.shell.openSlackMessage({ channelId: r.channelId || project.channel_id, ts: r.threadTs })}
                    >
                      <ExternalLink size={11} />
                    </button>
                    <button
                      className="icon-btn"
                      title="Copy link thread"
                      style={{ width: 20, height: 20 }}
                      onClick={() => navigator.clipboard.writeText(r.permalink!)}
                    >
                      <LinkIcon size={11} />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {showSaveAs && project && (
        <PromptModal
          title="Save As"
          label="Nama project baru"
          defaultValue={`${project.name} (copy)`}
          submitLabel="Simpan"
          onSubmit={submitSaveAs}
          onCancel={() => setShowSaveAs(false)}
        />
      )}

      {showGenerate && (
        <GenerateItemModal
          onClose={() => setShowGenerate(false)}
          onGenerate={async (names) => {
            const before = new Set(project.items.map((i) => i.id));
            for (const name of names) await window.api.item.addManual({ projectId, name });
            const after = await window.api.project.load(projectId);
            const created = after.items.filter((i) => !before.has(i.id));
            pushUndo({
              undo: async () => {
                for (const c of created) await window.api.item.remove(c.id);
              },
              redo: async () => {
                for (const c of created) await window.api.item.restore(c);
              },
            });
            setShowGenerate(false);
            refresh();
          }}
        />
      )}

      {bulkPasteCol && (
        <BulkPasteModal
          column={bulkPasteCol}
          project={project}
          users={users}
          presetByMember={presetByMember}
          onClose={() => setBulkPasteCol(null)}
          onSubmitItems={async (lines) => {
            const rows = project.items;
            const changes: Array<{ id: string; oldName: string; newName: string }> = [];
            for (let i = 0; i < Math.min(lines.length, rows.length); i++) {
              const val = lines[i].trim();
              if (val && rows[i].name !== val) {
                changes.push({ id: rows[i].id, oldName: rows[i].name, newName: val });
                await window.api.item.update(rows[i].id, { name: val });
              }
            }
            const extra = lines.slice(rows.length).filter((l) => l.trim());
            const before = new Set(rows.map((i) => i.id));
            for (const name of extra) await window.api.item.addManual({ projectId, name });
            const after = await window.api.project.load(projectId);
            const created = after.items.filter((i) => !before.has(i.id));
            pushUndo({
              undo: async () => {
                for (const c of changes) await window.api.item.update(c.id, { name: c.oldName });
                for (const c of created) await window.api.item.remove(c.id);
              },
              redo: async () => {
                for (const c of changes) await window.api.item.update(c.id, { name: c.newName });
                for (const c of created) await window.api.item.restore(c);
              },
            });
            setBulkPasteCol(null);
            refresh();
          }}
          onSubmitArtists={async (lines) => {
            // Multi-artist (poin revisi) — 1 baris = 1 item, isinya nama artis dipisah koma
            // (sama format kayak hover copy-paste di tabel). Per baris: cocokin tiap nama ke
            // nickname/username, diff ke daftar SEKARANG (add yang baru, remove yang gak ada
            // lagi di hasil parse) — nama yang gak ketemu di roster DIBIARIN (gak nulis data salah).
            const rows = project.items;
            if (!multiAssignment) {
              const changes: Array<{
                id: string;
                previous: Array<{ artistId: string; artistName: string | null }>;
                next: Array<{ artistId: string; artistName: string | null }>;
              }> = [];
              for (let i = 0; i < Math.min(lines.length, rows.length); i++) {
                const names = lines[i].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
                const artist = names
                  .map((line) => users.find((u) => (presetByMember.get(u.id)?.nickname || "").toLowerCase() === line || u.name.toLowerCase() === line))
                  .find((u): u is SlackUser => !!u);
                if (names.length > 0 && !artist) continue;
                changes.push({
                  id: rows[i].id,
                  previous: rows[i].artists.map((a) => ({ artistId: a.artist_id, artistName: a.artist_name })),
                  next: artist ? [{ artistId: artist.id, artistName: artist.name }] : [],
                });
              }
              for (const change of changes) await window.api.item.setArtists({ projectId, itemId: change.id, artists: change.next });
              pushUndo({
                undo: async () => { for (const change of changes) await window.api.item.setArtists({ projectId, itemId: change.id, artists: change.previous }); },
                redo: async () => { for (const change of changes) await window.api.item.setArtists({ projectId, itemId: change.id, artists: change.next }); },
              });
              setBulkPasteCol(null);
              refresh();
              return;
            }
            const adds: Array<{ id: string; artistId: string; artistName: string | null }> = [];
            const removes: Array<{ id: string; artistId: string; artistName: string | null }> = [];
            for (let i = 0; i < Math.min(lines.length, rows.length); i++) {
              const names = lines[i].split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
              const resolved = names
                .map((line) => users.find((u) => (presetByMember.get(u.id)?.nickname || "").toLowerCase() === line || u.name.toLowerCase() === line))
                .filter((u): u is SlackUser => !!u);
              const resolvedIds = new Set(resolved.map((u) => u.id));
              const currentIds = new Set(rows[i].artists.map((a) => a.artist_id));
              for (const u of resolved) if (!currentIds.has(u.id)) adds.push({ id: rows[i].id, artistId: u.id, artistName: u.name });
              for (const a of rows[i].artists) if (!resolvedIds.has(a.artist_id)) removes.push({ id: rows[i].id, artistId: a.artist_id, artistName: a.artist_name });
            }
            for (const c of adds) await window.api.item.addArtist({ projectId, itemId: c.id, artistId: c.artistId, artistName: c.artistName });
            for (const c of removes) await window.api.item.removeArtist({ projectId, itemId: c.id, artistId: c.artistId });
            pushUndo({
              undo: async () => {
                for (const c of adds) await window.api.item.removeArtist({ projectId, itemId: c.id, artistId: c.artistId });
                for (const c of removes) await window.api.item.addArtist({ projectId, itemId: c.id, artistId: c.artistId, artistName: c.artistName });
              },
              redo: async () => {
                for (const c of adds) await window.api.item.addArtist({ projectId, itemId: c.id, artistId: c.artistId, artistName: c.artistName });
                for (const c of removes) await window.api.item.removeArtist({ projectId, itemId: c.id, artistId: c.artistId });
              },
            });
            setBulkPasteCol(null);
            refresh();
          }}
        />
      )}

      {showBatchFile && <BatchFileModal project={project} onClose={() => setShowBatchFile(false)} onApplied={() => (setShowBatchFile(false), refresh())} />}

      {showLog && <MessageLogPanel onClose={() => setShowLog(false)} />}

      {showHyperlinkManager && <HyperlinkManager onClose={() => setShowHyperlinkManager(false)} />}

      {showArtistPresetManager && (
        <ArtistPresetModal
          users={users}
          channelMemberIds={channelMemberIds}
          channelMembersGroupId={CHANNEL_MEMBERS_GROUP_ID}
          groups={groups}
          activeGroupId={activeGroupId}
          onSelectGroup={setActiveGroupId}
          onGroupsChanged={setGroups}
          onClose={() => {
            setShowArtistPresetManager(false);
            window.api.artistPreset.list().then(setArtistPresets);
            window.api.artistAssignMode.get().then((modes) => setMultiAssignment(modes.multi));
          }}
        />
      )}
      {showStatusPresetManager && (
        <StatusPresetModal
          onClose={() => {
            setShowStatusPresetManager(false);
            window.api.statusPreset.list().then(setStatusPresets);
          }}
        />
      )}
      {showKeywordAutomation && <KeywordAutomationModal onClose={() => setShowKeywordAutomation(false)} />}

      {showTemplateAll && (
        <TemplateAllModal
          project={project}
          onClose={() => setShowTemplateAll(false)}
          onApplied={() => {
            setShowTemplateAll(false);
            refresh();
          }}
        />
      )}

      {showPreview && (
        <SlackViewPreview project={project} itemIds={effectiveItemIds} onClose={() => setShowPreview(false)} onConfirm={(channelId) => doSend(effectiveItemIds, channelId)} />
      )}

      {showHelp && <ShortcutsHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}

function GenerateItemModal({ onClose, onGenerate }: { onClose: () => void; onGenerate: (names: string[]) => void }) {
  const [prefix, setPrefix] = useState("");
  const [start, setStart] = useState(1);
  const [count, setCount] = useState(5);
  const [padding, setPadding] = useState<2 | 3 | 4>(3);
  const [step, setStep] = useState(1);

  const preview = Array.from({ length: Math.min(count, 20) }, (_, i) => `${prefix}${String(start + i * step).padStart(padding, "0")}`);

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ padding: 16, width: 340, background: "var(--surface)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <h3>Generate Item</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup" title="Tutup">
            <X size={13} />
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {/* Poin revisi: emoji picker di Prefix — insert = tempel di UJUNG teks prefix (input
              polos, bukan rich editor, gak ada tracking posisi kursor). */}
          <div style={{ display: "flex", gap: 4 }}>
            <input placeholder="Prefix, mis. HT5_" value={prefix} onChange={(e) => setPrefix(e.target.value)} style={{ flex: 1 }} />
            <EmojiPicker onPick={(emoji) => setPrefix((p) => p + (emoji.type === "unicode" ? emoji.value : `:${emoji.shortcode}:`))} />
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <label className="caption" style={{ flex: 1 }}>
              Mulai
              <input type="number" value={start} onChange={(e) => setStart(Number(e.target.value))} style={{ width: "100%" }} />
            </label>
            <label className="caption" style={{ flex: 1 }}>
              Kelipatan
              <input type="number" value={step} onChange={(e) => setStep(Number(e.target.value))} style={{ width: "100%" }} />
            </label>
            <label className="caption" style={{ flex: 1 }}>
              Jumlah
              <input type="number" value={count} onChange={(e) => setCount(Number(e.target.value))} style={{ width: "100%" }} />
            </label>
          </div>
          <label className="caption">
            Padding angka
            <select value={padding} onChange={(e) => setPadding(Number(e.target.value) as 2 | 3 | 4)} style={{ width: "100%" }}>
              <option value={2}>00</option>
              <option value={3}>000</option>
              <option value={4}>0000</option>
            </select>
          </label>
          <div className="caption" style={{ background: "var(--surface-hover)", padding: 8, borderRadius: 6, maxHeight: 100, overflow: "auto" }}>
            {preview.join(", ")}
            {count > 20 && " …"}
          </div>
          <button
            className="btn btn-primary"
            onClick={() => onGenerate(Array.from({ length: count }, (_, i) => `${prefix}${String(start + i * step).padStart(padding, "0")}`))}
          >
            Buat {count} Item
          </button>
        </div>
      </div>
    </div>
  );
}

function BulkPasteModal({
  column,
  project,
  users,
  presetByMember,
  onClose,
  onSubmitItems,
  onSubmitArtists,
}: {
  column: "item" | "artis";
  project: Project;
  users: SlackUser[];
  presetByMember: Map<string, ArtistPreset>;
  onClose: () => void;
  onSubmitItems: (lines: string[]) => void;
  onSubmitArtists: (lines: string[]) => void;
}) {
  // Prefill dari nilai item yang sekarang (poin 3) — user tinggal edit, "Terapkan" nge-overwrite
  // baris tabel sesuai posisi baris teks, bukan selalu nambah item baru. Kolom Artis (poin revisi):
  // ambil nickname kalau ada, fallback ke username asli — sama urutan yang dipake buat nge-resolve
  // pas Terapkan, jadi apa yang keliatan di sini emang bisa langsung diterapkan ulang apa adanya.
  const [text, setText] = useState(() =>
    column === "item"
      ? project.items.map((i) => i.name).join("\n")
      : project.items.map((i) => i.artists.map((a) => presetByMember.get(a.artist_id)?.nickname || a.artist_name || a.artist_id).join(", ")).join("\n")
  );
  const lines = text.split("\n");
  const filledCount = lines.filter((l) => l.trim()).length;

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 25, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ padding: 16, width: 420, background: "var(--surface)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <h3>Bulk Paste — {column === "item" ? "Item" : "Artis"}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup" title="Tutup">
            <X size={13} />
          </button>
        </div>
        <p className="caption" style={{ marginBottom: 8 }}>
          {column === "item"
            ? "Baris sudah diisi nilai sekarang — edit lalu Terapkan buat overwrite baris tabel sesuai posisi. Baris tambahan di bawah jadi item baru."
            : `Baris sudah diisi artis sekarang — edit lalu Terapkan buat overwrite (baris kosong = lepas semua assignment). Bisa lebih dari 1 artis per baris, pisah koma. Nama harus cocok exact dengan nickname atau username salah satu dari ${users.length} member.`}
        </p>
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} style={{ width: "100%" }} />
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
          <span className="caption">{filledCount} baris terisi</span>
          <button className="btn btn-primary" onClick={() => (column === "item" ? onSubmitItems(lines) : onSubmitArtists(lines))}>
            Terapkan (Overwrite)
          </button>
        </div>
      </div>
    </div>
  );
}

function SlackViewPreview({
  project,
  itemIds,
  onClose,
  onConfirm,
}: {
  project: Project;
  itemIds: string[];
  onClose: () => void;
  onConfirm: (channelId: string, channelName: string) => void;
}) {
  const items = project.items.filter((i) => itemIds.includes(i.id));
  // Default = channel yang di-set pas project dibuat, tapi bisa diganti khusus buat kiriman ini
  // (gak nimpa channel default project-nya).
  const [channels, setChannels] = useState<SlackChannel[]>([{ id: project.channel_id, name: project.channel_name, isPrivate: false }]);
  const [channelId, setChannelId] = useState(project.channel_id);
  const [loadingChannels, setLoadingChannels] = useState(true);

  useEffect(() => {
    window.api.slack
      .listChannels()
      .then((list) => {
        // Pastikan channel default project selalu ada di daftar walau (jarang) gak balik dari API.
        setChannels(list.some((c) => c.id === project.channel_id) ? list : [{ id: project.channel_id, name: project.channel_name, isPrivate: false }, ...list]);
      })
      // Poin revisi (bug dilaporkan: gagal fetch channel nongolin alert() native jelek, "seakan
      // nge-block input") — gagal (mis. timeout koneksi Slack) TETAP biarin daftar default
      // (channel project doang, dari initial state) kepake, toast doang bukan alert blocking.
      .catch((err) => showToast(err instanceof Error ? err.message : "Gagal ambil daftar channel Slack — pakai channel default project.", "error"))
      .finally(() => setLoadingChannels(false));
  }, [project.channel_id, project.channel_name]);

  const selectedChannel = channels.find((c) => c.id === channelId);

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 25, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ padding: 16, width: 480, maxHeight: "80vh", display: "flex", flexDirection: "column", background: "var(--surface)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <h3>
            <Eye size={14} style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }} /> Slack View Preview
          </h3>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup" title="Tutup">
            <X size={13} />
          </button>
        </div>
        <div style={{ marginBottom: 8 }}>
          <div className="label" style={{ marginBottom: 4 }}>
            Kirim ke channel
          </div>
          <ChannelPicker channels={channels} value={channelId} loading={loadingChannels} onChange={(c) => setChannelId(c.id)} />
        </div>
        <p className="caption" style={{ marginBottom: 8 }}>
          Preview kasar tampilan di channel # {selectedChannel?.name || project.channel_name}. Ini bukan render Slack asli, cuma gambaran struktur pesan.
        </p>
        <div style={{ flex: 1, overflow: "auto" }} className="scrollbar-thin">
          {items.map((item) => (
            <div key={item.id} className="card" style={{ padding: 10, marginBottom: 8 }}>
              <div style={{ fontWeight: 600 }}>{item.name}</div>
              {item.artists.length > 0 && (
                <div className="caption">{item.artists.map((a) => `@${a.artist_name || a.artist_id}`).join(" ")}</div>
              )}
              {item.replies.map((r) => (
                <div key={r.id} className="caption">
                  <strong>{r.title}:</strong> {[r.text_value, r.files.length ? `${r.files.length} file` : null].filter(Boolean).join(" — ")}
                </div>
              ))}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
          <button className="btn" onClick={onClose}>
            Batal
          </button>
          <button className="btn btn-primary" onClick={() => onConfirm(channelId, selectedChannel?.name || project.channel_name)}>
            <Send size={14} /> Kirim Sekarang
          </button>
        </div>
      </div>
    </div>
  );
}

function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const shortcuts = [
    ["Ctrl+Z", "Undo"],
    ["Ctrl+Shift+Z / Ctrl+Y", "Redo"],
    ["Ctrl+A", "Pilih semua item"],
    ["Delete", "Hapus item terpilih"],
  ];
  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ padding: 16, width: 320, background: "var(--surface)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <h3>Keyboard Shortcuts</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup" title="Tutup">
            <X size={13} />
          </button>
        </div>
        {shortcuts.map(([key, label]) => (
          <div key={key} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
            <span className="caption">{label}</span>
            <span className="badge" style={{ background: "var(--surface-hover)", color: "var(--text-secondary)" }}>
              {key}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// B4 — klik header kolom Reply (bubble) di Tab Table buka ini: pilih Template, langsung
// diterapkan ke SEMUA item sekaligus (bukan per-item lewat Tab Reply). Field template yang
// sudah ada reply-nya di item tertentu TETAP nambah field baru (bukan nimpa) — sama perilakunya
// kayak applyTemplate per-item di Drawer, cuma di-loop ke semua item.
function TemplateAllModal({ project, onClose, onApplied }: { project: Project; onClose: () => void; onApplied: () => void }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    window.api.template.list().then(setTemplates);
  }, []);

  async function applyToAll(template: Template) {
    if (!confirm(`Terapkan template "${template.name}" (${template.fields.length} field) ke SEMUA ${project.items.length} item di project ini?`)) return;
    setApplying(true);
    try {
      await window.api.template.applyAll(project.id, template.id);
      onApplied();
    } catch (err) { showToast(err instanceof Error ? err.message : "Gagal menerapkan template.", "error"); }
    finally { setApplying(false); }
  }

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ padding: 16, width: 340, background: "var(--surface)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <h3>Template ke Semua Item</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup" title="Tutup">
            <X size={13} />
          </button>
        </div>
        <p className="caption" style={{ marginBottom: 10 }}>
          Pilih template — field-nya ditambahkan ke SEMUA {project.items.length} item di project ini sekaligus.
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {templates.map((t) => (
            <button key={t.id} className="btn" style={{ justifyContent: "flex-start" }} disabled={applying} onClick={() => applyToAll(t)}>
              <LayoutTemplate size={14} /> {t.name}
              <span className="caption" style={{ marginLeft: "auto" }}>
                {t.fields.length} field
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function HyperlinkManager({ onClose }: { onClose: () => void }) {
  const [presets, setPresets] = useState<HyperlinkPreset[]>([]);
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [touched, setTouched] = useState(false);

  function refresh() {
    window.api.hyperlink.list().then(setPresets);
  }
  useEffect(refresh, []);

  async function save() {
    if (!label.trim() || !url.trim()) {
      setTouched(true);
      return;
    }
    await window.api.hyperlink.save({ label: label.trim(), url: url.trim() });
    setLabel("");
    setUrl("");
    setTouched(false);
    refresh();
  }

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ padding: 16, width: 360, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 32px)", overflowY: "auto", background: "var(--surface)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <h3>Hyperlink Preset</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup" title="Tutup">
            <X size={13} />
          </button>
        </div>
        {presets.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, padding: "4px 0" }}>
            <div style={{ flex: 1, minWidth: 0 }} title={`${p.label}\n${p.url}`}>
              <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.label}</div>
              <div className="caption" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.url}</div>
            </div>
            <button className="icon-btn" style={{ flexShrink: 0 }} onClick={() => window.api.hyperlink.delete(p.id).then(refresh)} aria-label="Hapus hyperlink" title="Hapus hyperlink">
              <X size={12} />
            </button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <input
            placeholder="Label"
            aria-label="Nama preset hyperlink"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={touched && !label.trim() ? "input-error" : ""}
            style={{ width: 90 }}
          />
          <input
            placeholder="URL"
            aria-label="URL preset hyperlink"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className={touched && !url.trim() ? "input-error" : ""}
            style={{ flex: 1, minWidth: 0 }}
          />
          <button className="icon-btn" style={{ flexShrink: 0 }} onClick={save} aria-label="Tambah hyperlink" title="Tambah hyperlink">
            <Plus size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}
