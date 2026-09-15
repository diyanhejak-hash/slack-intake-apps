import { useEffect, useRef } from "react";
import { Wand2, Combine, Users, Trash2, FileStack, Link as LinkIcon, HelpCircle } from "lucide-react";
import slackButtonImg from "../assets/SlackButton.png";

export interface SidebarActions {
  onGenerateItem: () => void;
  onMerge: () => void;
  canMerge: boolean;
  onGroupEditor: () => void;
  onRemoveSelected: () => void;
  canRemove: boolean;
  onBatchFile: () => void;
  onHyperlinkManager: () => void;
  onHelp: () => void;
}

// Sidebar ikon vertikal, niru posisi Command Builder — M = Merge, langsung eksekusi merge
// pakai separator aktif (default "-"), BUKAN buka menu Edit lagi. "Tambah Item" dihapus dari
// sini, pindah jadi baris "+" di dalam tabel (lihat MainTable).
export function Sidebar(a: SidebarActions) {
  const items: Array<{ icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }> = [
    { icon: <Wand2 size={16} />, label: "Generate Item", onClick: a.onGenerateItem },
    { icon: <FileStack size={16} />, label: "Batch File", onClick: a.onBatchFile },
    { icon: <Combine size={16} />, label: "Merge (M)", onClick: a.onMerge, disabled: !a.canMerge },
    { icon: <Users size={16} />, label: "Grup Artis", onClick: a.onGroupEditor },
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
      <div style={{ flex: 1 }} />
      <button className="icon-btn" title="Keyboard Shortcuts" onClick={a.onHelp} style={{ width: 34, height: 34 }}>
        <HelpCircle size={16} />
      </button>
    </div>
  );
}

export interface MenuBarActions {
  onImportProject: () => void;
  onExportProject: () => void;
  onSaveAs: () => void;
  onDeleteProject: () => void;
  onBackToStartMenu: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onRemoveSelected: () => void;
  mergeSeparator: "," | "-";
  onMergeSeparatorChange: (separator: "," | "-") => void;
  onToggleWorkload: () => void;
  onToggleLog: () => void;
  onGroupEditor: () => void;
  onHyperlinkManager: () => void;
  onEmojiPresetManager: () => void;
  onHelp: () => void;
  openMenu: MenuName | null;
  onOpenMenuChange: (m: MenuName | null) => void;
  /** Tombol "Kirim ke Slack" — dipindah ke sini (poin revisi UI), tetap rata kanan. */
  onSendClick: () => void;
  sendDisabled: boolean;
  sendTitle: string;
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
      { label: "Undo (Ctrl+Z)", onClick: a.onUndo },
      { label: "Redo (Ctrl+Shift+Z)", onClick: a.onRedo },
      { label: "Hapus Item Terpilih (Delete)", onClick: a.onRemoveSelected },
      { label: "Preset Emoji...", onClick: a.onEmojiPresetManager },
    ],
    View: [
      { label: "Workload Distribution", onClick: a.onToggleWorkload },
      { label: "Message Log", onClick: a.onToggleLog },
    ],
    Settings: [
      { label: "Grup Artis", onClick: a.onGroupEditor },
      { label: "Hyperlink Preset", onClick: a.onHyperlinkManager },
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
      <button
        className="btn"
        onClick={a.onSendClick}
        disabled={a.sendDisabled}
        title={a.sendTitle}
        style={{ marginLeft: "auto", background: "#fff", borderRadius: 999, padding: "3px 12px", border: "1px solid var(--border-strong)" }}
      >
        <img src={slackButtonImg} alt="Kirim ke Slack" style={{ height: 20, display: "block" }} />
      </button>
    </div>
  );
}
