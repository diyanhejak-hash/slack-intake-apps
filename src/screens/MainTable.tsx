import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Send, Square, CheckSquare, X, Loader2, MessageSquare, Eye, Plus, ClipboardPaste, Users, ExternalLink, Link as LinkIcon, LayoutTemplate } from "lucide-react";
import type { ArtistGroup, HyperlinkPreset, Project, ProjectItem, SendResult, SlackChannel, SlackUser, Template } from "../global";
const Drawer = lazy(() => import("./Drawer"));
import BatchFileModal from "./BatchFileModal";
import MessageLogPanel from "./MessageLogPanel";
import { Sidebar, MenuBar, type MenuName } from "./Chrome";
import PromptModal from "./PromptModal";
import SendRecovery from "./SendRecovery";
import ChannelPicker from "./ChannelPicker";
import QuickSendButton from "./QuickSendButton";
import EmojiPresetModal from "./EmojiPresetModal";
import EmojiPicker from "./EmojiPicker";
import { refreshEmojiPresetCache } from "../lib/emojiPresetStore";

interface UndoCommand {
  undo: () => Promise<void>;
  redo: () => Promise<void>;
}

const PALETTE = ["#2F6FEB", "#F59E0B", "#16A34A", "#DC2626", "#7C3AED", "#0EA5E9", "#DB2777", "#65A30D"];

export default function MainTable({ projectId, onBackToStartMenu, onOpenProject }: { projectId: string; onBackToStartMenu: () => void; onOpenProject: (id: string) => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [users, setUsers] = useState<SlackUser[]>([]);
  const [groups, setGroups] = useState<ArtistGroup[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string>("");
  const [showGroupEditor, setShowGroupEditor] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<{ index: number; total: number; itemName: string } | null>(null);
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
  const [showEmojiPresetManager, setShowEmojiPresetManager] = useState(false);
  const [showSaveAs, setShowSaveAs] = useState(false);
  const [showTemplateAll, setShowTemplateAll] = useState(false);
  const [openMenu, setOpenMenu] = useState<MenuName | null>(null);
  const [mergeSeparator, setMergeSeparator] = useState<"," | "-">("-");
  const [editingName, setEditingName] = useState(false);
  const [bulkPasteCol, setBulkPasteCol] = useState<"item" | "artis" | null>(null);
  // Overlay Instant Intake per-row DISABLE selama user lagi edit input/dropdown di cell itu (poin
  // revisi) — dropdown Artis kebuka misalnya, overlay yang numpuk di pojok bisa ganggu klik opsi.
  // Cuma per (item, kolom) yang lagi fokus, bukan seluruh tabel.
  const [editingCell, setEditingCell] = useState<{ itemId: string; col: "item" | "artist" } | null>(null);

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
    window.api.slack.listUsers().then(setUsers);
    window.api.artistGroup.list().then(setGroups);
    // Cache preset custom emoji (poin revisi) — di-load sedini mungkin biar pas Tab Reply
    // dibuka, EmojiImageNode udah bisa langsung parse ":nama:" tersimpan jadi gambar (bukan
    // nunggu field-nya sendiri yang fetch).
    refreshEmojiPresetCache();
    const offProgress = window.api.send.onProgress((data) => { if (data.projectId === projectId) { setProgress(data); setSending(true); } });
    const offDone = window.api.send.onDone(({ results, projectId: completedProject }) => {
      if (completedProject !== projectId) return;
      setResults(results);
      setSending(false);
      setProgress(null);
      refresh();
    });
    return () => {
      offProgress();
      offDone();
      void window.api.project.releaseUndo(projectId).catch(() => undefined);
    };
  }, [projectId]);

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
    } catch (err) { alert(err instanceof Error ? err.message : "Gagal undo."); }
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
    } catch (err) { alert(err instanceof Error ? err.message : "Gagal redo."); }
    finally { historyBusy.current = false; }
  }

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || document.querySelector('[aria-modal="true"]') ||
        showGroupEditor || showGenerate || showWorkload || showHelp || showPreview || showBatchFile ||
        showLog || showHyperlinkManager || showEmojiPresetManager || showSaveAs || showTemplateAll || openMenu || bulkPasteCol) return;
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

  const visibleUsers = useMemo(() => {
    if (!activeGroupId) return users;
    const g = groups.find((g) => g.id === activeGroupId);
    if (!g) return users;
    return users.filter((u) => g.memberIds.includes(u.id));
  }, [users, groups, activeGroupId]);

  const workload = useMemo(() => {
    if (!project) return [];
    const counts = new Map<string, number>();
    for (const item of project.items) {
      const name = item.artist_name || "Belum ditugaskan";
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [project]);
  const workloadTotal = workload.reduce((s, [, c]) => s + c, 0) || 1;

  // Lebar kolom Item/Artis ngikutin panjang teks TERPANJANG di masing-masing (poin revisi: hemat
  // ruang kalau nilainya pendek), pakai satuan `ch` (perkiraan lebar 1 karakter di font aktif —
  // gak butuh ngukur pixel presisi, cukup buat heuristik ini). Rasio Item:Artis di-CLAMP (poin
  // revisi: "jangan terlalu jauh perbandingannya, apalagi pas fullscreen") — Item paling lebar
  // 1.6x Artis, tapi tetap dijamin sedikit lebih lebar dari Artis (+2ch) biar gak kebalik.
  const columnWidths = useMemo(() => {
    if (!project) return { item: "auto", artist: "auto" };
    const itemChars = Math.max(8, ...project.items.map((i) => (i.name || "").length));
    const artistChars = Math.max(8, ...project.items.map((i) => (i.artist_name || "Belum ditugaskan").length));
    const cappedItemChars = Math.max(Math.min(itemChars, artistChars * 1.6), artistChars + 2);
    return { item: `${cappedItemChars + 4}ch`, artist: `${artistChars + 4}ch` };
  }, [project]);

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

  async function handleArtistChange(item: ProjectItem, artistId: string) {
    const u = users.find((u) => u.id === artistId);
    const oldArtistId = item.artist_id;
    const oldArtistName = item.artist_name;
    await window.api.item.update(item.id, { artistId: artistId || null, artistName: u?.name || null });
    pushUndo({
      undo: () => window.api.item.update(item.id, { artistId: oldArtistId, artistName: oldArtistName }),
      redo: () => window.api.item.update(item.id, { artistId: artistId || null, artistName: u?.name || null }),
    });
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
      alert(err instanceof Error ? err.message : "Gagal merge.");
    }
  }

  async function handleExport() {
    await window.api.project.export(projectId);
  }

  async function handleImportProject() {
    const res = await window.api.project.import();
    if (!res.canceled) alert("Project berhasil di-import. Buka dari Start Menu.");
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
  async function quickSendColumn(scope: "item" | "artist" | "replies", label: string) {
    const ids = effectiveItemIds;
    if (!ids.length || !project) return;
    const target = selected.size === 0 ? "SEMUA item" : `${ids.length} item terpilih`;
    if (!confirm(`Instant Intake — kirim kolom "${label}" ke ${target}?`)) return;
    doSend(ids, project.channel_id, scope);
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

  // Gak ada yang dicentang = kirim SEMUA item (bukan gak ada yang dikirim); sebagian dicentang
  // = kirim yang dicentang aja. Tombol cuma disabled kalau tabelnya beneran kosong.
  const effectiveItemIds = selected.size > 0 ? Array.from(selected) : project.items.map((i) => i.id);

  // "Instant Intake" (poin revisi) — overlay pesawat, kirim LANGSUNG (gak ada modal preview/
  // channel-picker lagi kayak percobaan sebelumnya), scoped ke SEBAGIAN item doang lewat
  // send:quick (lihat main.cjs). channelId SENGAJA gak dikasih dari sini — biar backend yang
  // nentuin (channel tempat item ini SUDAH punya thread kalau ada, baru fallback ke default
  // project; nyegah bikin thread duplikat di channel yang salah, bug yang dilaporkan user).
  function quickSend(itemId: string, scope: "item" | "artist" | "replies" | "field", replyId?: string) {
    return window.api.send.quick({ projectId, itemId, scope, replyId }).then(() => refresh()).catch((err) => {
      setResults([{ itemId, itemName: project?.items.find((i) => i.id === itemId)?.name || itemId, status: "gagal", reason: err.message }]);
      throw err;
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
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
        onUndo={handleUndo}
        onRedo={handleRedo}
        onRemoveSelected={handleRemoveSelected}
        mergeSeparator={mergeSeparator}
        onMergeSeparatorChange={setMergeSeparator}
        onToggleWorkload={() => setShowWorkload((v) => !v)}
        onToggleLog={() => setShowLog((v) => !v)}
        onGroupEditor={() => setShowGroupEditor(true)}
        onHyperlinkManager={() => setShowHyperlinkManager(true)}
        onEmojiPresetManager={() => setShowEmojiPresetManager(true)}
        onHelp={() => setShowHelp(true)}
        onSendClick={() => setShowPreview(true)}
        sendDisabled={project.items.length === 0 || sending}
        sendTitle={`Preview & Kirim (${effectiveItemIds.length}${selected.size === 0 && project.items.length > 0 ? " — semua" : ""})`}
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
          canMerge={selected.size >= 2}
          onGroupEditor={() => setShowGroupEditor(true)}
          onRemoveSelected={handleRemoveSelected}
          canRemove={selected.size > 0}
          onBatchFile={() => setShowBatchFile(true)}
          onHyperlinkManager={() => setShowHyperlinkManager(true)}
          onHelp={() => setShowHelp(true)}
        />

        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div className="folder-tabbar">
            <button className={`folder-tab ${activeTab === "table" ? "active" : ""}`} onClick={() => setActiveTab("table")}>
              Table
            </button>
            <button className={`folder-tab ${activeTab === "reply" ? "active" : ""}`} onClick={() => setActiveTab("reply")}>
              Reply
            </button>
          </div>

          {activeTab === "reply" ? (
            <div className="folder-panel">
              {activeItem ? (
                <Suspense fallback={<div className="placeholder-box"><span className="caption">Memuat editor…</span></div>}>
                <Drawer
                  item={activeItem}
                  projectId={projectId}
                  projectFiles={project.files}
                  onChanged={refresh}
                  onPrev={() => setActiveItemId(project.items[activeIndex - 1].id)}
                  onNext={() => setActiveItemId(project.items[activeIndex + 1].id)}
                  canPrev={activeIndex > 0}
                  canNext={activeIndex >= 0 && activeIndex < project.items.length - 1}
                  users={visibleUsers}
                  onArtistChange={handleArtistChange}
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
                  <th style={{ width: columnWidths.item, position: "relative" }} onClick={() => setBulkPasteCol("item")} title="Klik buat bulk paste">
                    Item <ClipboardPaste size={10} style={{ display: "inline", verticalAlign: "-1px" }} />
                    <QuickSendButton title="Instant Intake — kirim nama SEMUA item (gak ada artis/reply)" onClick={() => quickSendColumn("item", "Item")} />
                  </th>
                  <th style={{ width: columnWidths.artist, position: "relative" }} onClick={() => setBulkPasteCol("artis")} title="Klik buat bulk paste">
                    Artis <ClipboardPaste size={10} style={{ display: "inline", verticalAlign: "-1px" }} />
                    <QuickSendButton title="Instant Intake — mention artis SEMUA item" onClick={() => quickSendColumn("artist", "Artis")} />
                  </th>
                  {/* B4 — klik header kolom Reply (bubble icon) = pilih Template buat diterapkan
                      ke SEMUA item sekaligus, bukan cuma per-item lewat Tab Reply. Reply dipindah
                      ke sebelum X (poin revisi urutan kolom: ..., Artis, Reply, X). */}
                  <th style={{ width: 50, maxWidth: 50, position: "relative", textAlign: "center" }} onClick={() => setShowTemplateAll(true)} title="Terapkan Template ke SEMUA item">
                    <LayoutTemplate size={12} style={{ display: "inline" }} />
                    <QuickSendButton title="Instant Intake — kirim semua reply/field SEMUA item" onClick={() => quickSendColumn("replies", "Reply")} />
                  </th>
                  <th style={{ width: 40, maxWidth: 40 }} />
                </tr>
              </thead>
              <tbody>
                {project.items.map((item, index) => {
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
                        {index + 1}
                      </td>
                      <td style={{ position: "relative" }}>
                        <input
                          // key ikut item.name: input uncontrolled (defaultValue) gak update
                          // sendiri kalau nilainya berubah dari LUAR (merge/bulk-paste/undo) —
                          // React reuse DOM node yang sama karena item.id gak berubah, jadi
                          // defaultValue lama nyangkut sampai remount. Paksa remount kalau nama
                          // berubah dari luar, ini bug yang dilaporkan ("baru kelihatan bener
                          // setelah reopen project").
                          key={`${item.id}:${item.name}`}
                          defaultValue={item.name}
                          placeholder="Nama item…"
                          style={{ border: "none", width: "100%", padding: "4px 0", cursor: "pointer" }}
                          onFocus={() => setEditingCell({ itemId: item.id, col: "item" })}
                          onBlur={(e) => {
                            setEditingCell((c) => (c?.itemId === item.id && c.col === "item" ? null : c));
                            if (e.target.value !== item.name) handleRenameItem(item, e.target.value);
                          }}
                        />
                        {!(editingCell?.itemId === item.id && editingCell.col === "item") && (
                          <QuickSendButton title="Instant Intake — kirim nama item ini aja (gak ada artis/reply)" onClick={() => quickSend(item.id, "item")} />
                        )}
                      </td>
                      <td style={{ position: "relative" }}>
                        <select
                          value={item.artist_id || ""}
                          onChange={(e) => handleArtistChange(item, e.target.value)}
                          onFocus={() => setEditingCell({ itemId: item.id, col: "artist" })}
                          onBlur={() => setEditingCell((c) => (c?.itemId === item.id && c.col === "artist" ? null : c))}
                          style={{ width: "100%" }}
                        >
                          <option value="">Belum ditugaskan</option>
                          {visibleUsers.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                            </option>
                          ))}
                        </select>
                        {!(editingCell?.itemId === item.id && editingCell.col === "artist") && (
                          <QuickSendButton title="Instant Intake — mention artis ini aja" onClick={() => quickSend(item.id, "artist")} />
                        )}
                      </td>
                      <td style={{ position: "relative" }}>
                        <button
                          className="icon-btn"
                          title={item.replies.length ? `${item.replies.length} reply` : "Belum ada reply"}
                          onClick={() => openReplyTab(item.id)}
                          style={{ position: "relative" }}
                        >
                          <MessageSquare size={16} className={item.replies.length ? "" : "muted"} fill={item.replies.length ? "var(--accent-soft)" : "none"} />
                          {item.replies.length > 0 && (
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
                              {item.replies.length}
                            </span>
                          )}
                        </button>
                        <QuickSendButton title="Instant Intake — kirim semua reply/field item ini aja" onClick={() => quickSend(item.id, "replies")} />
                      </td>
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
                  <span className="caption">
                    <Loader2 size={12} className="spin" style={{ display: "inline", verticalAlign: "-2px", marginRight: 4 }} />
                    Mengirim {progress.index + 1}/{progress.total}: {progress.itemName}
                  </span>
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
        <div className="card scrollbar-thin" style={{ position: "fixed", right: 16, bottom: 70, width: 320, padding: 14, maxHeight: 300, overflow: "auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <h3>Ringkasan Hasil</h3>
            <button className="icon-btn" onClick={() => setResults(null)}>
              <X size={13} />
            </button>
          </div>
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

      {showGroupEditor && (
        <ArtistGroupModal
          users={users}
          groups={groups}
          activeGroupId={activeGroupId}
          onSelectGroup={setActiveGroupId}
          onClose={() => setShowGroupEditor(false)}
          onSaved={(gs) => setGroups(gs)}
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
            const rows = project.items;
            const changes: Array<{ id: string; oldArtistId: string | null; oldArtistName: string | null; newArtistId: string | null; newArtistName: string | null }> = [];
            for (let i = 0; i < Math.min(lines.length, rows.length); i++) {
              const line = lines[i].trim();
              const u = line ? users.find((u) => u.name.toLowerCase() === line.toLowerCase()) : null;
              if (line && !u) continue; // nama gak ketemu di roster, dibiarin (gak nulis data salah)
              const newArtistId = u ? u.id : null;
              const newArtistName = u ? u.name : null;
              if (rows[i].artist_id !== newArtistId) {
                changes.push({ id: rows[i].id, oldArtistId: rows[i].artist_id, oldArtistName: rows[i].artist_name, newArtistId, newArtistName });
                await window.api.item.update(rows[i].id, { artistId: newArtistId, artistName: newArtistName });
              }
            }
            pushUndo({
              undo: async () => {
                for (const c of changes) await window.api.item.update(c.id, { artistId: c.oldArtistId, artistName: c.oldArtistName });
              },
              redo: async () => {
                for (const c of changes) await window.api.item.update(c.id, { artistId: c.newArtistId, artistName: c.newArtistName });
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

      {showEmojiPresetManager && <EmojiPresetModal onClose={() => setShowEmojiPresetManager(false)} />}

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
          <button className="icon-btn" onClick={onClose}>
            <X size={13} />
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {/* Poin revisi: emoji picker di Prefix — insert = tempel di UJUNG teks prefix (input
              polos, bukan rich editor, gak ada tracking posisi kursor). */}
          <div style={{ display: "flex", gap: 4 }}>
            <input placeholder="Prefix, mis. HT5_" value={prefix} onChange={(e) => setPrefix(e.target.value)} style={{ flex: 1 }} />
            <EmojiPicker onPick={(text) => setPrefix((p) => p + text)} />
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
  onClose,
  onSubmitItems,
  onSubmitArtists,
}: {
  column: "item" | "artis";
  project: Project;
  users: SlackUser[];
  onClose: () => void;
  onSubmitItems: (lines: string[]) => void;
  onSubmitArtists: (lines: string[]) => void;
}) {
  // Prefill dari nilai item yang sekarang (poin 3) — user tinggal edit, "Terapkan" nge-overwrite
  // baris tabel sesuai posisi baris teks, bukan selalu nambah item baru.
  const [text, setText] = useState(() =>
    column === "item" ? project.items.map((i) => i.name).join("\n") : project.items.map((i) => i.artist_name || "").join("\n")
  );
  const lines = text.split("\n");
  const filledCount = lines.filter((l) => l.trim()).length;

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 25, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ padding: 16, width: 420, background: "var(--surface)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
          <h3>Bulk Paste — {column === "item" ? "Item" : "Artis"}</h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={13} />
          </button>
        </div>
        <p className="caption" style={{ marginBottom: 8 }}>
          {column === "item"
            ? "Baris sudah diisi nilai sekarang — edit lalu Terapkan buat overwrite baris tabel sesuai posisi. Baris tambahan di bawah jadi item baru."
            : `Baris sudah diisi artis sekarang — edit lalu Terapkan buat overwrite (baris kosong = lepas assignment). Nama harus cocok exact dengan salah satu dari ${users.length} member.`}
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
          <button className="icon-btn" onClick={onClose}>
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
              {item.artist_name && <div className="caption">@{item.artist_name}</div>}
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
          <button className="icon-btn" onClick={onClose}>
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
    } catch (err) { alert(err instanceof Error ? err.message : "Gagal menerapkan template."); }
    finally { setApplying(false); }
  }

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ padding: 16, width: 340, background: "var(--surface)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <h3>Template ke Semua Item</h3>
          <button className="icon-btn" onClick={onClose}>
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
      <div className="card" style={{ padding: 16, width: 360, background: "var(--surface)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <h3>Hyperlink Preset</h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={13} />
          </button>
        </div>
        {presets.map((p) => (
          <div key={p.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "4px 0" }}>
            <div>
              <div style={{ fontSize: 13 }}>{p.label}</div>
              <div className="caption">{p.url}</div>
            </div>
            <button className="icon-btn" onClick={() => window.api.hyperlink.delete(p.id).then(refresh)}>
              <X size={12} />
            </button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
          <input
            placeholder="Label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={touched && !label.trim() ? "input-error" : ""}
            style={{ width: 90 }}
          />
          <input
            placeholder="URL"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className={touched && !url.trim() ? "input-error" : ""}
            style={{ flex: 1 }}
          />
          <button className="icon-btn" onClick={save}>
            <Plus size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

// Gabungan "pilih filter dropdown artis" + "bikin grup baru", 1 modal (poin 1 — sebelumnya
// filter-nya row terpisah di luar, sekarang jadi bagian dari modal Grup Artis ini).
function ArtistGroupModal({
  users,
  groups,
  activeGroupId,
  onSelectGroup,
  onClose,
  onSaved,
}: {
  users: SlackUser[];
  groups: ArtistGroup[];
  activeGroupId: string;
  onSelectGroup: (id: string) => void;
  onClose: () => void;
  onSaved: (groups: ArtistGroup[]) => void;
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
    onSaved(updated);
    setName("");
    setMemberIds(new Set());
    setTouched(false);
    setCreating(false);
  }

  function pick(id: string) {
    onSelectGroup(id);
    onClose();
  }

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ padding: 16, width: 380, background: "var(--surface)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
          <Users size={16} className="muted" />
          <h3 style={{ flex: 1 }}>Dropdown Artis</h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={13} />
          </button>
        </div>

        <button className="btn" style={{ width: "100%", justifyContent: "flex-start", marginBottom: 4 }} onClick={() => pick("")}>
          {activeGroupId === "" ? <CheckSquare size={14} /> : <Square size={14} />} Semua Artis ({users.length})
        </button>
        {groups.map((g) => (
          <button key={g.id} className="btn" style={{ width: "100%", justifyContent: "flex-start", marginBottom: 4 }} onClick={() => pick(g.id)}>
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
    </div>
  );
}
