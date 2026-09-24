import { useEffect, useMemo, useState } from "react";
import { X, Plus, Check, FileWarning, UploadCloud } from "lucide-react";
import type { Project, BatchSection as Section, BatchFileEntry as BatchFile } from "../global";

const PRESET_CATEGORIES = ["Animatic", "TBH", "Char", "BG", "Prop"];

function stripExt(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

// Poin revisi (diminta user) — item hasil Merge dash (Sidebar "Merge (M)", projects.cjs
// computeMergedName) namanya JADI RANGE, bukan daftar lengkap: "BF44_0150" + "BF44_0160" + ... +
// "BF44_0200" (step 10) merge jadi "BF44_0150-0200" doang — angka di TENGAH range (0160, 0170,
// dst) gak nyisa di mana pun (item aslinya udah kehapus pas merge). Jadi satu-satunya cara batch
// file "BF44_0160.mp4" masih bisa ke-connect ke item gabungan itu adalah cek NUMERIK: prefix +
// lebar digit sama, angka file-nya masuk rentang [min, max] item — regex-nya SENGAJA sama persis
// pola yang dipakai computeMergedName buat bikin nama itu, biar simetris (yang bisa dibikin, bisa
// dicocokin balik).
function parseRangeItemName(name: string): { prefix: string; min: number; max: number; width: number } | null {
  const m = name.match(/^(.*?)(\d+)-(\d+)$/);
  if (!m) return null;
  const [, prefix, minStr, maxStr] = m;
  if (minStr.length !== maxStr.length) return null; // computeMergedName selalu pad rata, beda lebar = bukan hasil merge kita
  const min = parseInt(minStr, 10);
  const max = parseInt(maxStr, 10);
  if (min > max) return null;
  return { prefix: prefix.toLowerCase(), min, max, width: minStr.length };
}

function matchesRangeItem(fileKey: string, itemName: string): boolean {
  const range = parseRangeItemName(itemName);
  if (!range) return false;
  const m = fileKey.match(/^(.*?)(\d+)$/);
  if (!m) return false;
  const [, filePrefix, numStr] = m;
  if (filePrefix.toLowerCase() !== range.prefix) return false;
  if (numStr.length !== range.width) return false; // "150" (3 digit) TIDAK dianggap masuk range "0150-0200" (4 digit)
  const num = parseInt(numStr, 10);
  return num >= range.min && num <= range.max;
}

// Poin revisi (diminta user) — Merge koma (computeMergedName, separator BUKAN "-") beda dari
// dash: dia LITERAL nyimpen SEMUA nama asli, digabung ", " (hardcoded di computeMergedName, bukan
// separator apa pun yang dipilih user) -- gak collapse jadi range, gak ada yang ilang. Jadi
// tinggal pecah nama item by ", " terus cek TIAP potongan pakai aturan yang SAMA (exact ATAU
// range) -- pola "same rule, recursed per segment" ini juga otomatis nutup kombinasi jarang
// (item hasil dash-merge yang belakangan ikut di-comma-merge lagi sama item lain).
function matchesItemName(fileKey: string, itemName: string): boolean {
  const parts = itemName.includes(", ") ? itemName.split(", ") : [itemName];
  return parts.some((part) => {
    const p = part.trim().toLowerCase();
    return p === fileKey || matchesRangeItem(fileKey, part.trim());
  });
}

export default function BatchFileModal({ project, onClose, onApplied, onProjectChanged }: { project: Project; onClose: () => void; onApplied: () => void; onProjectChanged: () => void | Promise<void> }) {
  const [sections, setSections] = useState<Section[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [categoryTouched, setCategoryTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function submitNewCategory() {
    if (!newCategoryName.trim()) {
      setCategoryTouched(true);
      return;
    }
    addSection(newCategoryName.trim());
    setNewCategoryName("");
    setCategoryTouched(false);
    setShowNewCategory(false);
  }

  // Sesi Batch File persist per project (poin baru: "tetap simpan sesi ... buat sync ulang") —
  // load dulu sebelum boleh nulis, biar gak ke-overwrite kosong sebelum data lama kebaca.
  useEffect(() => {
    window.api.batchFile.listSections(project.id).then((s) => {
      setSections(s);
      setLoaded(true);
    }).catch((err) => setError(err instanceof Error ? err.message : "Gagal memuat sesi. Tutup dan buka kembali."));
  }, [project.id]);

  useEffect(() => {
    if (!loaded) return;
    window.api.batchFile.saveSections(project.id, sections).catch((err) => setError(err instanceof Error ? err.message : "Gagal menyimpan sesi batch."));
  }, [sections, loaded, project.id]);

  const active = sections[activeIdx] || null;

  function addSection(name: string) {
    if (sections.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      setActiveIdx(sections.findIndex((s) => s.name.toLowerCase() === name.toLowerCase()));
      return;
    }
    setSections((prev) => {
      const next = [...prev, { id: crypto.randomUUID(), name, files: [] }];
      setActiveIdx(next.length - 1);
      return next;
    });
  }

  function addFilesToActiveSection(paths: string[]) {
    if (!active || !paths.length) return;
    const newFiles: BatchFile[] = paths.map((p) => {
      const filename = p.split(/[\\/]/).pop() || p;
      const key = stripExt(filename).toLowerCase();
      // Strict match (poin 2): nama file TANPA ekstensi harus persis sama nama item — sekarang
      // ditangani matchesItemName, yang JUGA cek hasil Merge dash (range) DAN Merge koma (daftar
      // nama asli dipisah ", ").
      const matched = project.items.filter((i) => matchesItemName(key, i.name));
      return { id: crypto.randomUUID(), path: p, filename, connectedItemIds: matched.map((i) => i.id) };
    });
    setSections((prev) => prev.map((s, i) => (i === activeIdx ? { ...s, files: [...s.files, ...newFiles] } : s)));
  }

  async function pickFilesForActiveSection() {
    if (!active) return;
    const paths = await window.api.batchFile.pickFiles();
    addFilesToActiveSection(paths);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    if (!active) return;
    // File dari drag-drop native Electron punya .path (bukan Web File API biasa) — langsung
    // dapat absolute path tanpa perlu lewat dialog IPC.
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.api.file.getPathForFile(f))
      .filter((p): p is string => !!p);
    addFilesToActiveSection(paths);
  }

  function removeFile(fileIdx: number) {
    setSections((prev) => prev.map((s, i) => (i === activeIdx ? { ...s, files: s.files.filter((_, fi) => fi !== fileIdx) } : s)));
  }

  function connectFile(fileIdx: number, itemId: string) {
    if (!itemId) return;
    setSections((prev) =>
      prev.map((s, i) =>
        i === activeIdx
          ? {
              ...s,
              files: s.files.map((f, fi) => (fi === fileIdx && !f.connectedItemIds.includes(itemId) ? { ...f, connectedItemIds: [...f.connectedItemIds, itemId] } : f)),
            }
          : s
      )
    );
  }

  function disconnectFile(fileIdx: number, itemId: string) {
    setSections((prev) =>
      prev.map((s, i) => (i === activeIdx ? { ...s, files: s.files.map((f, fi) => (fi === fileIdx ? { ...f, connectedItemIds: f.connectedItemIds.filter((id) => id !== itemId) } : f)) } : s))
    );
  }

  // Reset (poin revisi, diminta user — "reset ini juga mereset uploaded file, jadi bersih seperti
  // di awal") — bersihin TOTAL daftar file kategori aktif (bukan cuma koneksinya), balik persis
  // kayak kategori baru dibikin, belum ada file dipilih sama sekali. File yang UDAH di-apply ke
  // Slack (reply_files/reply) TIDAK ikut kesentuh -- ini cuma daftar staging di modal ini, belum
  // tentu semuanya udah di-apply.
  function resetActiveSection() {
    if (!active || !active.files.length) return;
    if (!confirm(`Reset kategori "${active.name}"? Semua file yang udah dipilih di sini bakal dihapus dari daftar (perlu diupload ulang kalau mau dipakai lagi).`)) return;
    setSections((prev) => prev.map((s, i) => (i === activeIdx ? { ...s, files: [] } : s)));
  }

  const totalConnections = sections.reduce((sum, s) => sum + s.files.reduce((s2, f) => s2 + f.connectedItemIds.length, 0), 0);
  const generatableItemCount = useMemo(() => {
    const names = new Set<string>();
    for (const section of sections) {
      for (const file of section.files) {
        if (file.connectedItemIds.length) continue;
        const name = stripExt(file.filename).trim();
        if (!name || project.items.some((item) => matchesItemName(name.toLowerCase(), item.name))) continue;
        names.add(name.toLowerCase());
      }
    }
    return names.size;
  }, [project.items, sections]);

  async function generateItems() {
    if (!generatableItemCount || project.phase !== "setup" || generating) return;
    setGenerating(true);
    setError(null);
    try {
      await window.api.batchFile.saveSections(project.id, sections);
      await window.api.batchFile.generateItems(project.id);
      setSections(await window.api.batchFile.listSections(project.id));
      await onProjectChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal membuat item dari Batch File.");
    } finally {
      setGenerating(false);
    }
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      await window.api.batchFile.saveSections(project.id, sections);
      await window.api.batchFile.apply(project.id);
      onApplied();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gagal menerapkan batch.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ padding: 20, width: 640, maxHeight: "85vh", display: "flex", flexDirection: "column", background: "var(--surface)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <h2>Batch File Setup</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Tutup" title="Tutup">
            <X size={15} />
          </button>
        </div>
        <p className="caption" style={{ marginBottom: 12 }}>
          Upload banyak file per kategori. Nama file yang cocok persis nama item auto-kesambung, sisanya hubungkan manual.
        </p>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {sections.map((s, i) => (
            <button
              key={s.id}
              className="btn"
              style={{ padding: "5px 12px", ...(i === activeIdx ? { borderColor: "var(--accent)", color: "var(--accent)" } : {}) }}
              onClick={() => setActiveIdx(i)}
            >
              {s.name} ({s.files.length})
            </button>
          ))}
          {PRESET_CATEGORIES.filter((c) => !sections.some((s) => s.name === c)).map((c) => (
            <button key={c} className="btn" style={{ padding: "5px 12px", opacity: 0.6 }} onClick={() => addSection(c)}>
              <Plus size={12} /> {c}
            </button>
          ))}
          {showNewCategory ? (
            <div style={{ display: "flex", gap: 4 }}>
              <input
                autoFocus
                placeholder="Nama kategori"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                className={categoryTouched && !newCategoryName.trim() ? "input-error" : ""}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitNewCategory();
                }}
                style={{ width: 120 }}
              />
              <button className="icon-btn" onClick={submitNewCategory}>
                <Check size={13} />
              </button>
            </div>
          ) : (
            <button className="btn" style={{ padding: "5px 12px" }} onClick={() => setShowNewCategory(true)}>
              <Plus size={12} /> kategori
            </button>
          )}
        </div>

        {active ? (
          <>
            <div
              className="placeholder-box"
              style={{ marginBottom: 10, cursor: "pointer", borderColor: "var(--accent)" }}
              onClick={pickFilesForActiveSection}
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
            >
              <UploadCloud size={20} className="muted" />
              <span className="caption">
                Drop file di sini, atau klik buat pilih file untuk "{active.name}" (boleh banyak sekaligus)
              </span>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginBottom: 6 }}>
              <button
                className="btn"
                style={{ padding: "3px 10px", fontSize: 12 }}
                onClick={generateItems}
                disabled={!generatableItemCount || project.phase !== "setup" || generating}
                title={project.phase !== "setup" ? "Generate Item hanya tersedia pada tahap Setup" : "Buat item dari seluruh nama file Batch yang belum menemukan pasangan"}
              >
                {generating ? "Membuat item..." : generatableItemCount ? `Generate ${generatableItemCount} Item` : "Generate Item"}
              </button>
              <button
                className="btn"
                style={{ padding: "3px 10px", fontSize: 12 }}
                onClick={resetActiveSection}
                disabled={!active.files.length}
                title="Bersihin total daftar file kategori ini, balik kayak baru dibikin"
              >
                Reset
              </button>
            </div>
            <div style={{ flex: 1, overflow: "auto" }} className="scrollbar-thin">
              {active.files.length === 0 && (
                <div className="placeholder-box">
                  <span className="caption">Belum ada file di kategori ini.</span>
                </div>
              )}
              {active.files.map((f, fi) => (
                <div key={f.id} className="card" style={{ padding: 8, marginBottom: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span className="caption">
                      {f.connectedItemIds.length > 0 ? (
                        <span style={{ color: "var(--success)", fontWeight: 600 }}>{f.connectedItemIds.map((id) => project.items.find((i) => i.id === id)?.name).join(", ")}</span>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>[ ]</span>
                      )}{" "}
                      &lt;&gt; {f.filename}
                    </span>
                    <button className="icon-btn" onClick={() => removeFile(fi)}>
                      <X size={12} />
                    </button>
                  </div>
                  {f.connectedItemIds.length > 0 && (
                    <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
                      {f.connectedItemIds.map((id) => (
                        <span key={id} className="badge" style={{ background: "var(--success-soft)", color: "var(--success)" }}>
                          {project.items.find((i) => i.id === id)?.name}
                          <X size={9} style={{ cursor: "pointer" }} onClick={() => disconnectFile(fi, id)} />
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <select
                      defaultValue=""
                      onChange={(e) => {
                        connectFile(fi, e.target.value);
                        e.target.value = "";
                      }}
                      style={{ flex: 1 }}
                    >
                      <option value="">Pilih item…</option>
                      {project.items
                        .filter((i) => !f.connectedItemIds.includes(i.id))
                        .map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name}
                          </option>
                        ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="placeholder-box">
            <FileWarning size={20} />
            <span className="caption">Pilih atau buat kategori dulu di atas.</span>
          </div>
        )}

        {error && <span className="caption" style={{ color: "var(--danger)" }}>{error}</span>}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 14 }}>
          <span className="caption">{totalConnections} koneksi file→item siap diterapkan</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn" onClick={onClose}>
              Lewati
            </button>
            <button className="btn btn-primary" onClick={finish} disabled={!totalConnections || busy}>
              {busy ? "Menerapkan…" : "Selesai"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
