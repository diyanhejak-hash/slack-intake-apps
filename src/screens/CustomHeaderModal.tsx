import { useEffect, useState } from "react";
import { ChevronDown, ChevronUp, Plus, Trash2, X } from "lucide-react";
import type { CustomHeader, CustomHeaderOption } from "../global";
import type { EmojiChoice } from "../lib/emojiCatalog";
import { useFileBlobUrl } from "../lib/fileUrl";
import { UniversalEmojiPicker } from "./EmojiPicker";

export default function CustomHeaderModal({ projectId, onClose, onChanged }: { projectId: string; onClose: () => void; onChanged: () => void }) {
  const [headers, setHeaders] = useState<CustomHeader[]>([]);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  async function refresh() { setHeaders(await window.api.customHeader.list(projectId)); }
  useEffect(() => { refresh(); }, [projectId]);

  async function addHeader() {
    if (!newName.trim()) return;
    setBusy(true);
    try { await window.api.customHeader.save({ projectId, name: newName.trim() }); setNewName(""); await refresh(); onChanged(); }
    catch (error) { alert(error instanceof Error ? error.message : "Gagal menambah header."); }
    finally { setBusy(false); }
  }

  async function moveHeader(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= headers.length) return;
    const ids = headers.map((header) => header.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await window.api.customHeader.reorder(projectId, ids); await refresh(); onChanged();
  }

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div className="card" style={{ width: 560, maxHeight: "84vh", padding: 16, background: "var(--surface)", display: "flex", flexDirection: "column" }} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
          <h3>Kelola Header</h3>
          <button className="icon-btn" onClick={onClose} title="Tutup"><X size={14} /></button>
        </div>
        <p className="caption" style={{ margin: "0 0 10px" }}>Setiap header menjadi kolom single-select dan dikirim sebagai reaction di pesan utama Slack.</p>
        <div className="scrollbar-thin" style={{ overflow: "auto", flex: 1 }}>
          {headers.map((header, index) => (
            <HeaderEditor
              key={header.id}
              projectId={projectId}
              header={header}
              canUp={index > 0}
              canDown={index < headers.length - 1}
              onMove={(direction) => moveHeader(index, direction)}
              onChanged={async () => { await refresh(); onChanged(); }}
            />
          ))}
          {!headers.length && <p className="caption muted">Belum ada custom header.</p>}
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input value={newName} onChange={(event) => setNewName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") addHeader(); }} placeholder="Nama header, mis. Grade" style={{ flex: 1 }} />
          <button className="btn btn-primary" disabled={busy || !newName.trim()} onClick={addHeader}><Plus size={13} /> Header</button>
        </div>
      </div>
    </div>
  );
}

function HeaderEditor({ projectId, header, canUp, canDown, onMove, onChanged }: {
  projectId: string; header: CustomHeader; canUp: boolean; canDown: boolean;
  onMove: (direction: -1 | 1) => void; onChanged: () => void;
}) {
  const [name, setName] = useState(header.name);
  const [adding, setAdding] = useState(false);

  async function saveName() {
    if (!name.trim() || name.trim() === header.name) return;
    await window.api.customHeader.save({ projectId, id: header.id, name: name.trim() }); onChanged();
  }
  async function removeHeader() {
    if (!confirm(`Hapus header "${header.name}" beserta semua nilainya?`)) return;
    await window.api.customHeader.remove(projectId, header.id); onChanged();
  }
  async function moveOption(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= header.options.length) return;
    const ids = header.options.map((option) => option.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await window.api.customHeader.reorderOptions(projectId, header.id, ids); onChanged();
  }

  return (
    <section style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 10, marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <button className="icon-btn" disabled={!canUp} onClick={() => onMove(-1)} title="Naik"><ChevronUp size={13} /></button>
        <button className="icon-btn" disabled={!canDown} onClick={() => onMove(1)} title="Turun"><ChevronDown size={13} /></button>
        <input value={name} onChange={(event) => setName(event.target.value)} onBlur={saveName} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} style={{ flex: 1, fontWeight: 600 }} />
        <button className="icon-btn" onClick={removeHeader} title="Hapus header"><Trash2 size={13} /></button>
      </div>
      <div style={{ marginTop: 6 }}>
        {header.options.map((option, index) => (
          <OptionRow key={option.id} projectId={projectId} headerId={header.id} option={option} canUp={index > 0} canDown={index < header.options.length - 1} onMove={(direction) => moveOption(index, direction)} onChanged={onChanged} />
        ))}
        {adding
          ? <OptionForm projectId={projectId} headerId={header.id} onDone={() => { setAdding(false); onChanged(); }} onCancel={() => setAdding(false)} />
          : <button className="btn" style={{ width: "100%", justifyContent: "center", marginTop: 6 }} onClick={() => setAdding(true)}><Plus size={12} /> Pilihan</button>}
      </div>
    </section>
  );
}

function OptionRow({ projectId, headerId, option, canUp, canDown, onMove, onChanged }: {
  projectId: string; headerId: string; option: CustomHeaderOption; canUp: boolean; canDown: boolean;
  onMove: (direction: -1 | 1) => void; onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const imageUrl = useFileBlobUrl(option.image_path);
  if (editing) return <OptionForm projectId={projectId} headerId={headerId} option={option} onDone={() => { setEditing(false); onChanged(); }} onCancel={() => setEditing(false)} />;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 0", borderBottom: "1px solid var(--border)" }}>
      <button className="icon-btn" disabled={!canUp} onClick={() => onMove(-1)}><ChevronUp size={11} /></button>
      <button className="icon-btn" disabled={!canDown} onClick={() => onMove(1)}><ChevronDown size={11} /></button>
      <span style={{ width: 18 }}>{imageUrl ? <img src={imageUrl} alt="" style={{ width: 16, height: 16, objectFit: "contain" }} /> : option.unicode_value}</span>
      <span className="caption" style={{ flex: 1 }}>{option.name}</span>
      <span className="caption muted">:{option.code_name}:</span>
      <button className="btn" style={{ padding: "3px 7px", fontSize: 11 }} onClick={() => setEditing(true)}>Edit</button>
      <button className="icon-btn" title="Hapus pilihan" onClick={async () => { if (confirm(`Hapus pilihan "${option.name}"?`)) { await window.api.customHeader.removeOption(projectId, option.id); onChanged(); } }}><Trash2 size={12} /></button>
    </div>
  );
}

function OptionForm({ projectId, headerId, option, onDone, onCancel }: { projectId: string; headerId: string; option?: CustomHeaderOption; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState(option?.name || "");
  const [codeName, setCodeName] = useState(option?.code_name || "");
  const [sourcePath, setSourcePath] = useState<string | undefined>();
  const [unicodeValue, setUnicodeValue] = useState(option?.unicode_value || undefined);
  const [busy, setBusy] = useState(false);
  async function pick(emoji: EmojiChoice) {
    setCodeName(emoji.shortcode);
    if (emoji.type === "unicode") { setUnicodeValue(emoji.value); setSourcePath(undefined); return; }
    setBusy(true);
    try { setSourcePath(await window.api.slack.downloadEmojiImage(emoji.imageUrl || "")); setUnicodeValue(undefined); }
    finally { setBusy(false); }
  }
  async function save() {
    setBusy(true);
    try {
      await window.api.customHeader.saveOption({ projectId, headerId, id: option?.id, name: name.trim(), codeName, sourcePath, unicodeValue });
      onDone();
    } catch (error) { alert(error instanceof Error ? error.message : "Gagal menyimpan pilihan."); }
    finally { setBusy(false); }
  }
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "6px 0" }}>
      <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Nama pilihan" style={{ flex: 1 }} />
      <span className="caption muted">{codeName ? `:${codeName}:` : "Pilih emoji"}</span>
      <UniversalEmojiPicker onPick={pick} disabled={busy} title="Pilih reaction" />
      <button className="btn btn-primary" disabled={busy || !name.trim() || !codeName} onClick={save}>Simpan</button>
      <button className="btn" disabled={busy} onClick={onCancel}>Batal</button>
    </div>
  );
}
