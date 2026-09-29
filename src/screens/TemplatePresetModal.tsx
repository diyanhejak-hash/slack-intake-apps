import { useEffect, useState } from "react";
import { Plus, Trash2, X } from "lucide-react";
import type { Template, TemplateField } from "../global";
import { formatErrorMessage } from "../lib/toast";

export default function TemplatePresetModal({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [editing, setEditing] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [fields, setFields] = useState<TemplateField[]>([{ label: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    window.api.template.list().then(setTemplates).catch((err) => setError(err instanceof Error ? err.message : "Gagal memuat template."));
  }, []);

  function resetForm() {
    setEditing(null);
    setName("");
    setFields([{ label: "" }]);
  }

  function edit(template: Template) {
    if (template.is_builtin) return;
    setEditing(template);
    setName(template.name);
    setFields(template.fields.map((field) => ({ label: field.label })));
    setError(null);
  }

  async function save() {
    const cleanName = name.trim();
    const cleanFields = fields.map((field) => ({ label: field.label.trim() }));
    if (!cleanName || !cleanFields.length || cleanFields.some((field) => !field.label)) {
      setError("Isi nama template dan minimal satu label field.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await window.api.template.save({ id: editing?.id, name: cleanName, fields: cleanFields });
      setTemplates(await window.api.template.list());
      resetForm();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menyimpan template.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(template: Template) {
    if (template.is_builtin || !confirm(`Hapus template "${template.name}"?`)) return;
    setBusy(true);
    setError(null);
    try {
      await window.api.template.delete(template.id);
      setTemplates(await window.api.template.list());
      if (editing?.id === template.id) resetForm();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menghapus template.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Template Reply" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={onClose}>
      <div className="card scrollbar-thin" style={{ width: 560, maxHeight: "82vh", overflow: "auto", padding: 16, background: "var(--surface)" }} onClick={(event) => event.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
          <h3>Template Reply</h3>
          <button className="icon-btn" aria-label="Tutup" onClick={onClose}><X size={14} /></button>
        </div>
        <p className="caption" style={{ margin: "0 0 12px" }}>Kelola susunan field yang bisa diterapkan ke item. Template bawaan tidak bisa diubah.</p>
        {error && <p role="alert" className="caption" style={{ color: "var(--danger)" }}>{formatErrorMessage(error)}</p>}
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
          {templates.map((template) => (
            <div key={template.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 8px", border: "1px solid var(--border)", borderRadius: "var(--radius)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong>{template.name}</strong>{template.is_builtin ? <span className="caption"> · Bawaan</span> : null}
                <div className="caption">{template.fields.map((field) => field.label).join(" · ")}</div>
              </div>
              {!template.is_builtin && (
                <>
                  <button className="btn" disabled={busy} onClick={() => edit(template)}>Edit</button>
                  <button className="icon-btn" disabled={busy} aria-label={`Hapus ${template.name}`} title="Hapus template" onClick={() => remove(template)}><Trash2 size={14} /></button>
                </>
              )}
            </div>
          ))}
        </div>
        <div className="label" style={{ marginBottom: 6 }}>{editing ? `Edit ${editing.name}` : "Template Baru"}</div>
        <input aria-label="Nama template" placeholder="Nama template" value={name} onChange={(event) => setName(event.target.value)} style={{ width: "100%", marginBottom: 8 }} />
        {fields.map((field, index) => (
          <div key={index} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <input aria-label={`Label field ${index + 1}`} placeholder="Label field" value={field.label} onChange={(event) => setFields((current) => current.map((value, i) => i === index ? { label: event.target.value } : value))} style={{ flex: 1 }} />
            <button className="icon-btn" disabled={fields.length === 1} aria-label={`Hapus field ${index + 1}`} onClick={() => setFields((current) => current.filter((_, i) => i !== index))}><X size={13} /></button>
          </div>
        ))}
        <button className="btn" onClick={() => setFields((current) => [...current, { label: "" }])}><Plus size={13} /> Field</button>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button className="btn btn-primary" disabled={busy} onClick={save}>{busy ? "Menyimpan…" : editing ? "Simpan Perubahan" : "Buat Template"}</button>
          {editing && <button className="btn" disabled={busy} onClick={resetForm}>Batal Edit</button>}
        </div>
      </div>
    </div>
  );
}
