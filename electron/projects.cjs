const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { db, dataDir } = require("./db.cjs");

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
let activeScope = { userId: null, teamId: null };
const deletedItems = new Map();
const mergedItems = new Map();
let fileTransaction = null;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

function setScope(userId, teamId, adoptLegacy = false) {
  if (activeScope.userId !== userId || activeScope.teamId !== teamId) {
    deletedItems.clear();
    mergedItems.clear();
  }
  activeScope = { userId: userId || null, teamId: teamId || null };
}

function transaction(fn) {
  if (fileTransaction) return fn();
  const files = { created: [], removed: [] };
  db.exec("BEGIN IMMEDIATE");
  fileTransaction = files;
  let result;
  try {
    result = fn();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    fileTransaction = null;
    for (const file of files.created) removeStoredFile(file);
    throw error;
  } finally {
    fileTransaction = null;
  }
  // Cleanup failure must never roll back bytes already committed to the database.
  for (const file of files.removed) removeStoredFile(file);
  return result;
}

function projectIdForItem(itemId) {
  return db.prepare(`SELECT project_id FROM items WHERE id=?`).get(itemId)?.project_id;
}

function safeFilename(filename) {
  if (typeof filename !== "string" || !filename || path.basename(filename) !== filename || filename === "." || filename === ".." || /[<>:"/\\|?*\x00-\x1f]/.test(filename)) {
    throw new Error("Nama file tidak valid.");
  }
  if (/[. ]$/.test(filename) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) throw new Error("Nama file tidak didukung Windows.");
  return filename;
}

function storagePath(file) {
  try {
    const root = fs.realpathSync(path.join(dataDir, "attachments"));
    const real = fs.realpathSync(file);
    const relative = path.relative(root, real);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) && fs.statSync(real).isFile() ? real : null;
  } catch { return null; }
}

function referencedFile(file) {
  for (const table of ["project_files", "item_files", "reply_files"]) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE stored_path=?`).get(file)) return true;
  }
  if (db.prepare(`SELECT 1 FROM batch_files WHERE path=?`).get(file) || db.prepare(`SELECT 1 FROM emoji_presets WHERE image_path=?`).get(file) || db.prepare(`SELECT 1 FROM artist_presets WHERE image_path=?`).get(file)) return true;
  return [...deletedItems.values(), ...mergedItems.values()].some((s) => JSON.stringify(s).includes(JSON.stringify(file)));
}

function removeStoredFile(storedPath) {
  if (!storedPath) return;
  if (fileTransaction) { fileTransaction.removed.push(storedPath); return; }
  const resolved = storagePath(storedPath);
  if (!resolved || referencedFile(resolved)) return;
  try {
    fs.unlinkSync(resolved);
    try { fs.rmdirSync(path.dirname(resolved)); } catch { /* shared or nonempty directory */ }
  } catch (error) { console.error("Attachment cleanup:", error.message); }
}

function isManagedFile(filePath) {
  if (typeof filePath !== "string") return false;
  const resolved = storagePath(filePath);
  if (!resolved || !activeScope.userId || !activeScope.teamId) return false;
  const scoped = [
    `SELECT 1 FROM project_files f JOIN projects p ON p.id=f.project_id WHERE f.stored_path=? AND p.owner_user_id=? AND p.owner_team_id=?`,
    `SELECT 1 FROM item_files f JOIN items i ON i.id=f.item_id JOIN projects p ON p.id=i.project_id WHERE f.stored_path=? AND p.owner_user_id=? AND p.owner_team_id=?`,
    `SELECT 1 FROM reply_files f JOIN replies r ON r.id=f.reply_id JOIN items i ON i.id=r.item_id JOIN projects p ON p.id=i.project_id WHERE f.stored_path=? AND p.owner_user_id=? AND p.owner_team_id=?`,
  ].some((sql) => db.prepare(sql).get(resolved, activeScope.userId, activeScope.teamId));
  if (scoped) return true;
  // emoji_presets/artist_presets GLOBAL (gak ada owner_user_id/owner_team_id, pola sama kayak
  // hyperlink_presets) — bug yang pernah ketauan (poin revisi): thumbnail custom emoji gagal
  // kebaca terus-terusan ("File tidak terdaftar di project") gara-gara tabel ini kelewat di-cek
  // di atas. artist_presets.image_path ikut ditambah dari awal biar gak kena bug yang sama.
  return !!db.prepare(`SELECT 1 FROM emoji_presets WHERE image_path = ?`).get(resolved)
    || !!db.prepare(`SELECT 1 FROM artist_presets WHERE image_path = ?`).get(resolved);
}

function ownsProject(id) { return !!getProject(id); }
function ownsItem(id) {
  return !!db.prepare(`SELECT 1 FROM items i JOIN projects p ON p.id=i.project_id WHERE i.id=? AND p.owner_user_id=? AND p.owner_team_id=?`).get(id, activeScope.userId, activeScope.teamId);
}
function ownsReply(id) {
  return !!db.prepare(`SELECT 1 FROM replies r JOIN items i ON i.id=r.item_id JOIN projects p ON p.id=i.project_id WHERE r.id=? AND p.owner_user_id=? AND p.owner_team_id=?`).get(id, activeScope.userId, activeScope.teamId);
}
function ownsFile(id) {
  return [
    `SELECT 1 FROM project_files f JOIN projects p ON p.id=f.project_id WHERE f.id=? AND p.owner_user_id=? AND p.owner_team_id=?`,
    `SELECT 1 FROM item_files f JOIN items i ON i.id=f.item_id JOIN projects p ON p.id=i.project_id WHERE f.id=? AND p.owner_user_id=? AND p.owner_team_id=?`,
    `SELECT 1 FROM reply_files f JOIN replies r ON r.id=f.reply_id JOIN items i ON i.id=r.item_id JOIN projects p ON p.id=i.project_id WHERE f.id=? AND p.owner_user_id=? AND p.owner_team_id=?`,
  ].some((sql) => db.prepare(sql).get(id, activeScope.userId, activeScope.teamId));
}

function createProject({ name, channelId, channelName }) {
  if (!activeScope.userId || !activeScope.teamId) throw new Error("Sesi Slack tidak valid.");
  const id = uuid();
  db.prepare(
    `INSERT INTO projects (id, owner_user_id, owner_team_id, name, channel_id, channel_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, activeScope.userId, activeScope.teamId, name, channelId, channelName, now(), now());
  return getProject(id);
}

function listProjects() {
  if (!activeScope.userId || !activeScope.teamId) return [];
  return db.prepare(`SELECT * FROM projects WHERE owner_user_id=? AND owner_team_id=? ORDER BY updated_at DESC`).all(activeScope.userId, activeScope.teamId);
}

function getProject(id) {
  const project = db.prepare(`SELECT * FROM projects WHERE id = ? AND owner_user_id=? AND owner_team_id=?`).get(id, activeScope.userId, activeScope.teamId);
  if (!project) return null;
  const items = db.prepare(`SELECT * FROM items WHERE project_id = ? ORDER BY sort_order ASC`).all(id);
  for (const item of items) {
    item.reactions = listItemReactions(item.id);
    item.files = db.prepare(`SELECT * FROM item_files WHERE item_id = ? ORDER BY sort_order ASC`).all(item.id);
    item.replies = db.prepare(`SELECT * FROM replies WHERE item_id = ? ORDER BY sort_order ASC`).all(item.id);
    for (const reply of item.replies) {
      reply.files = db.prepare(`SELECT * FROM reply_files WHERE reply_id = ?`).all(reply.id);
    }
  }
  // General Display (project_files) — beda dari item.files, lihat catatan skema di db.cjs.
  const files = db.prepare(`SELECT * FROM project_files WHERE project_id = ? ORDER BY sort_order ASC`).all(id);
  return { ...project, items, files };
}

function touchProject(id) {
  db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run(now(), id);
}

function deleteProject(id) {
  const project = getProject(id);
  if (!project) return;
  releaseUndo(id);
  const paths = [...project.files, ...project.items.flatMap((i) => [...i.files, ...i.replies.flatMap((r) => r.files)])].map((f) => f.stored_path);
  paths.push(...listBatchSections(id).flatMap((s) => s.files.map((f) => f.path)));
  db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  for (const storedPath of paths) removeStoredFile(storedPath);
}

function renameProject(id, name) {
  db.prepare(`UPDATE projects SET name = ?, updated_at = ? WHERE id = ? AND owner_user_id=? AND owner_team_id=?`).run(name, now(), id, activeScope.userId, activeScope.teamId);
}

function addItem(projectId, { name, artistId, artistName, source }) {
  const id = uuid();
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM items WHERE project_id = ?`).get(projectId).m;
  db.prepare(
    `INSERT INTO items (id, project_id, name, artist_id, artist_name, sort_order, source) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, projectId, name, artistId || null, artistName || null, maxOrder + 1, source || "manual");
  touchProject(projectId);
  return id;
}

function updateItem(itemId, patch) {
  const fields = [];
  const values = [];
  for (const [k, v] of Object.entries(patch)) {
    const col = { artistId: "artist_id", artistName: "artist_name", name: "name" }[k];
    if (col) {
      fields.push(`${col} = ?`);
      values.push(v);
    }
  }
  if (!fields.length) return;
  values.push(itemId);
  db.prepare(`UPDATE items SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  const projectId = projectIdForItem(itemId);
  if (projectId) touchProject(projectId);
}

function removeItem(itemId) {
  const projectId = projectIdForItem(itemId);
  if (!ownsItem(itemId)) throw new Error("Item tidak ditemukan.");
  deletedItems.set(itemId, getProject(projectId).items.find((i) => i.id === itemId));
  Object.assign(deletedItems.get(itemId), undoRelations(itemId));
  db.prepare(`DELETE FROM items WHERE id = ?`).run(itemId);
  if (projectId) touchProject(projectId);
}

// Restore item persis dari snapshot (dipakai Undo setelah remove) — id file/reply dipakai ulang,
// aman karena removeItem cuma hapus baris DB, TIDAK hapus file fisik di disk (lihat stageFile).
function restoreItem(snapshot) {
  snapshot = deletedItems.get(snapshot?.id);
  if (!snapshot || !ownsProject(snapshot.project_id)) throw new Error("Snapshot undo tidak tersedia untuk sesi ini.");
  db.prepare(
    `INSERT INTO items (id, project_id, name, artist_id, artist_name, sort_order, source) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(snapshot.id, snapshot.project_id, snapshot.name, snapshot.artist_id, snapshot.artist_name, snapshot.sort_order, snapshot.source);
  for (const f of snapshot.files) {
    db.prepare(`INSERT INTO item_files (id, item_id, stored_path, original_name, sort_order) VALUES (?, ?, ?, ?, ?)`).run(f.id, snapshot.id, f.stored_path, f.original_name, f.sort_order);
  }
  for (const r of snapshot.replies) {
    db.prepare(
      `INSERT INTO replies (id, item_id, category, type, title, text_value, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(r.id, snapshot.id, r.category, r.type, r.title, r.text_value, r.sort_order);
    for (const rf of r.files) {
      db.prepare(`INSERT INTO reply_files (id, reply_id, stored_path, original_name) VALUES (?, ?, ?, ?)`).run(rf.id, r.id, rf.stored_path, rf.original_name);
    }
  }
  restoreRelations(snapshot);
}

function undoRelations(itemId) {
  return {
    reactions: listItemReactions(itemId),
    applications: db.prepare('SELECT * FROM batch_applications WHERE item_id=?').all(itemId),
    targets: db.prepare('SELECT * FROM batch_targets WHERE item_id=?').all(itemId),
  };
}

function restoreRelations(item) {
  for (const r of item.reactions || []) db.prepare('INSERT OR IGNORE INTO item_reactions(id,item_id,emoji_type,emoji_value,slack_shortcode,sort_order) VALUES(?,?,?,?,?,?)').run(r.id, item.id, r.emoji_type, r.emoji_value, r.slack_shortcode, r.sort_order);
  for (const a of item.applications || []) if (a.reply_file_id && db.prepare('SELECT 1 FROM batch_files WHERE id=?').get(a.file_id) && db.prepare('SELECT 1 FROM reply_files WHERE id=?').get(a.reply_file_id)) db.prepare('INSERT OR REPLACE INTO batch_applications(file_id,item_id,reply_file_id) VALUES(?,?,?)').run(a.file_id, item.id, a.reply_file_id);
  for (const t of item.targets || []) if (db.prepare('SELECT 1 FROM batch_sections WHERE id=?').get(t.section_id) && db.prepare('SELECT 1 FROM replies WHERE id=?').get(t.reply_id)) db.prepare('INSERT OR REPLACE INTO batch_targets(section_id,item_id,reply_id) VALUES(?,?,?)').run(t.section_id, item.id, t.reply_id);
}

// Nama hasil merge: "dash" butuh semua item prefix sama + akhiran angka (buat scene
// berurutan, mis. FinalTest_0050 + FinalTest_0100 -> FinalTest_0050-0100). "comma" gabung
// apa adanya, urutan bebas. Lempar error jelas kalau dash dipaksa ke item yang gak cocok pola.
function computeMergedName(rows, separator) {
  if (separator === "-") {
    const parsed = rows.map((r) => {
      const m = r.name.match(/^(.*?)(\d+)$/);
      return m ? { prefix: m[1], numStr: m[2], num: parseInt(m[2], 10) } : null;
    });
    const prefixes = new Set(parsed.map((p) => p?.prefix));
    if (parsed.some((p) => !p) || prefixes.size > 1) {
      throw new Error("Merge dash butuh semua item prefix sama dan berakhiran angka (buat scene berurutan). Pakai koma kalau nama beda.");
    }
    const nums = parsed.map((p) => p.num);
    // A3 — step antar angka harus konsisten (semua +1, atau semua +10, dst) sebelum boleh
    // dikompres jadi rentang min-max. Gak divalidasi sebelumnya, jadi tegakan resiko nyamarin
    // scene yang sebenernya gak ada (mis. cuma ada 001/005/009 tapi hasilnya kebaca "001-009").
    const sorted = [...nums].sort((a, b) => a - b);
    const steps = new Set();
    for (let i = 1; i < sorted.length; i++) steps.add(sorted[i] - sorted[i - 1]);
    if (steps.size > 1) {
      throw new Error("Merge dash butuh selisih angka antar item KONSISTEN (mis. semua +1 atau semua +10) — pola sekarang gak rata. Pakai koma kalau nomornya gak beraturan.");
    }
    const width = parsed[0].numStr.length;
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    return `${parsed[0].prefix}${String(min).padStart(width, "0")}-${String(max).padStart(width, "0")}`;
  }
  return rows.map((r) => r.name).join(", ");
}

function snapshotItemDeep(row) {
  return {
    ...undoRelations(row.id),
    files: db.prepare('SELECT * FROM item_files WHERE item_id=?').all(row.id),
    id: row.id,
    project_id: row.project_id,
    name: row.name,
    artist_id: row.artist_id,
    artist_name: row.artist_name,
    sort_order: row.sort_order,
    source: row.source,
    fileIds: db.prepare(`SELECT id FROM item_files WHERE item_id = ?`).all(row.id).map((x) => x.id),
    replies: db
      .prepare(`SELECT * FROM replies WHERE item_id = ?`)
      .all(row.id)
      .map((rep) => ({ ...rep, files: db.prepare(`SELECT * FROM reply_files WHERE reply_id = ?`).all(rep.id) })),
  };
}

// Merge Item: gabung nama (dash/comma, lihat computeMergedName), pindahin file/reply item
// lain ke item yang dipertahankan (sort_order paling kecil), hapus sisanya. Reply kategori
// SAMA di item yang digabung ikut dikonsolidasi jadi 1 (teks disambung baris baru, file
// digabung 1 list) — bukan cuma dipindah gitu aja. Snapshot pre-merge disimpan dalam-dalam
// (termasuk isi reply sebelum konsolidasi) biar Undo bisa balikin persis, bukan cuma id.
function mergeItems(itemIds, separator = ", ") {
  if (!Array.isArray(itemIds) || new Set(itemIds).size !== itemIds.length || !itemIds.every(ownsItem) || new Set(itemIds.map(projectIdForItem)).size !== 1) throw new Error("Merge hanya boleh untuk item berbeda dalam satu project.");
  if (itemIds.length < 2) return { keepId: itemIds[0], snapshot: null };
  const rows = itemIds.map((id) => db.prepare(`SELECT * FROM items WHERE id = ?`).get(id)).filter(Boolean);
  rows.sort((a, b) => a.sort_order - b.sort_order);
  const keep = rows[0];
  const rest = rows.slice(1);
  const mergedName = computeMergedName(rows, separator);

  const snapshot = {
    undoId: uuid(),
    keepId: keep.id,
    keepOriginalName: keep.name,
    separator,
    itemIds: rows.map((r) => r.id),
    items: rows.map(snapshotItemDeep),
  };

  db.prepare(`UPDATE items SET name = ? WHERE id = ?`).run(mergedName, keep.id);
  for (const r of rest) {
    db.prepare(`UPDATE item_files SET item_id = ? WHERE item_id = ?`).run(keep.id, r.id);
    db.prepare(`UPDATE replies SET item_id = ? WHERE item_id = ?`).run(keep.id, r.id);
    db.prepare(`DELETE FROM items WHERE id = ?`).run(r.id);
  }

  // Konsolidasi reply kategori sama jadi 1 di bawah keep.id.
  const replies = db.prepare(`SELECT * FROM replies WHERE item_id = ?`).all(keep.id);
  const byCategory = new Map();
  for (const r of replies) {
    if (!byCategory.has(r.category)) byCategory.set(r.category, []);
    byCategory.get(r.category).push(r);
  }
  for (const group of byCategory.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.sort_order - b.sort_order);
    const primary = group[0];
    const combinedText = group.map((g) => g.text_value).filter(Boolean).join("\n") || null;
    db.prepare(`UPDATE replies SET text_value = ? WHERE id = ?`).run(combinedText, primary.id);
    for (const dup of group.slice(1)) {
      db.prepare(`UPDATE reply_files SET reply_id = ? WHERE reply_id = ?`).run(primary.id, dup.id);
      db.prepare(`DELETE FROM replies WHERE id = ?`).run(dup.id);
    }
  }

  mergedItems.set(snapshot.undoId, snapshot);
  return { keepId: keep.id, snapshot };
}

// Kebalikan mergeItems persis: hapus total reply keep.id yang sekarang (hasil konsolidasi),
// recreate baris item yang dihapus, lalu tulis ulang SEMUA reply asli (punya keep maupun
// item lain) dari snapshot dalam — id file/reply dipakai ulang, aman (lihat restoreItem).
function unmergeItems(snapshot) {
  if (!snapshot) return;
  snapshot = mergedItems.get(snapshot.undoId);
  if (!snapshot || !snapshot.items.every((i) => ownsProject(i.project_id))) throw new Error("Snapshot merge tidak tersedia untuk sesi ini.");
  db.prepare('DELETE FROM item_files WHERE item_id=?').run(snapshot.keepId);
  for (const r of db.prepare(`SELECT id FROM replies WHERE item_id = ?`).all(snapshot.keepId)) {
    db.prepare(`DELETE FROM replies WHERE id = ?`).run(r.id);
  }
  db.prepare(`UPDATE items SET name = ? WHERE id = ?`).run(snapshot.keepOriginalName, snapshot.keepId);

  for (const item of snapshot.items) {
    if (item.id !== snapshot.keepId) {
      db.prepare(
        `INSERT INTO items (id, project_id, name, artist_id, artist_name, sort_order, source) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(item.id, item.project_id, item.name, item.artist_id, item.artist_name, item.sort_order, item.source);
    }
    for (const f of item.files) db.prepare('INSERT INTO item_files(id,item_id,stored_path,original_name,sort_order) VALUES(?,?,?,?,?)').run(f.id, item.id, f.stored_path, f.original_name, f.sort_order);
    for (const rep of item.replies) {
      db.prepare(
        `INSERT INTO replies (id, item_id, category, type, title, text_value, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(rep.id, item.id, rep.category, rep.type, rep.title, rep.text_value, rep.sort_order);
      for (const f of rep.files) {
        db.prepare(`INSERT INTO reply_files (id, reply_id, stored_path, original_name) VALUES (?, ?, ?, ?)`).run(f.id, rep.id, f.stored_path, f.original_name);
      }
    }
    restoreRelations(item);
  }
}

// Attachment di-copy ke folder lokal app begitu di-attach (poin 5 rancangan) — bukan cuma simpan
// path asli, supaya project gak rusak kalau file sumber dipindah/dihapus user setelahnya. Folder
// unik PER FILE (uuid jadi nama folder, bukan prefix nama file) — biar `original_name` yang
// ketulis di DB/UI/disk tetap nama aslinya persis, gak ada kode nempel di depan nama file.
function uniqueAttachmentDir(ownerId) {
  const safeOwner = String(ownerId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  const destDir = path.join(dataDir, "attachments", safeOwner, uuid());
  fs.mkdirSync(destDir, { recursive: true });
  // realpath SEKARANG (bukan cuma pas dibandingin nanti) — `storagePath()`/`isManagedFile()`
  // selalu realpath-in path yang MAU DICEK sebelum query DB, tapi stored_path yang disimpan di
  // sini sebelumnya gak di-realpath duluan. Di Windows dua-duanya kebetulan sama (jarang ada
  // symlink di path lokal biasa), TAPI di macOS `/var` itu symlink ke `/private/var` (dan
  // `os.tmpdir()` sering di bawah situ) — stored_path mentah vs versi realpath jadi 2 STRING
  // BEDA, lookup DB gagal walau file-nya sama persis. Realpath SEKALI di sini bikin keduanya
  // konsisten dari awal, gak peduli platform.
  return fs.realpathSync(destDir);
}

function stageFile(ownerId, sourcePath) {
  const originalName = safeFilename(path.basename(sourcePath));
  const storedPath = stageCopy(ownerId, sourcePath, originalName);
  return { storedPath, originalName };
}

// Sama kayak stageFile tapi buat copy dari file yang SUDAH ada di storage kita sendiri (Broadcast,
// Merge, Save As) — originalName dikasih eksplisit (bukan basename ulang dari storedPath lama
// yang folder-nya sekarang uuid, bukan nama file).
function stageCopy(ownerId, sourcePath, originalName) {
  safeFilename(originalName);
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Attachment harus berupa file maksimal 100 MB.");
  const storedPath = path.join(uniqueAttachmentDir(ownerId), originalName);
  fileTransaction?.created.push(storedPath);
  fs.copyFileSync(sourcePath, storedPath);
  return storedPath;
}

function stageWrite(ownerId, buffer, filename) {
  safeFilename(filename);
  if (buffer.length > MAX_FILE_BYTES) throw new Error("Attachment maksimal 100 MB.");
  const storedPath = path.join(uniqueAttachmentDir(ownerId), filename);
  fileTransaction?.created.push(storedPath);
  fs.writeFileSync(storedPath, buffer);
  return storedPath;
}

// File langsung di item (alur inti kirim v1 — beda dari reply/template yang masih stub).
function addItemFiles(itemId, sourcePaths) {
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM item_files WHERE item_id = ?`).get(itemId).m;
  const insert = db.prepare(`INSERT INTO item_files (id, item_id, stored_path, original_name, sort_order) VALUES (?, ?, ?, ?, ?)`);
  sourcePaths.forEach((p, i) => {
    const { storedPath, originalName } = stageFile(itemId, p);
    insert.run(uuid(), itemId, storedPath, originalName, maxOrder + 1 + i);
  });
  const projectId = projectIdForItem(itemId);
  if (projectId) touchProject(projectId);
}

function removeItemFile(fileId) {
  const row = db.prepare(`SELECT stored_path, item_id FROM item_files WHERE id=?`).get(fileId);
  db.prepare(`DELETE FROM item_files WHERE id = ?`).run(fileId);
  removeStoredFile(row?.stored_path);
  const projectId = row && projectIdForItem(row.item_id);
  if (projectId) touchProject(projectId);
}

function listItemFiles(itemId) {
  return db.prepare(`SELECT * FROM item_files WHERE item_id = ? ORDER BY sort_order ASC`).all(itemId);
}

// General Display (project_files) — file referensi level PROJECT, sengaja gak reset pas ganti
// item (beda dari item_files yang per-item, lihat catatan skema di db.cjs).
function addProjectFiles(projectId, sourcePaths) {
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM project_files WHERE project_id = ?`).get(projectId).m;
  const insert = db.prepare(`INSERT INTO project_files (id, project_id, stored_path, original_name, sort_order) VALUES (?, ?, ?, ?, ?)`);
  sourcePaths.forEach((p, i) => {
    const { storedPath, originalName } = stageFile(projectId, p);
    insert.run(uuid(), projectId, storedPath, originalName, maxOrder + 1 + i);
  });
  touchProject(projectId);
}

function removeProjectFile(fileId) {
  const row = db.prepare(`SELECT stored_path, project_id FROM project_files WHERE id=?`).get(fileId);
  db.prepare(`DELETE FROM project_files WHERE id = ?`).run(fileId);
  removeStoredFile(row?.stored_path);
  if (row?.project_id) touchProject(row.project_id);
}

// Judul opsional — reply tanpa judul pakai id-nya sendiri sebagai category (bukan string
// kosong), biar dijamin gak pernah ke-match reply tanpa judul LAIN di Broadcast/Merge (yang
// keduanya cocokkan by category). Reply berjudul tetap category = judulnya, sama seperti dulu.
function addReplyWithFiles(itemId, { title, textValue, filePaths = [] }) {
  const id = uuid();
  const category = (title || "").trim() || id;
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM replies WHERE item_id = ?`).get(itemId).m;
  // Kolom `type` di skema masih ada (legacy, dipertahankan biar gak perlu migrasi tabel) tapi
  // gak dipakai buat behavior apa pun lagi — reply unified, 1 field bisa isi teks+file bareng.
  db.prepare(
    `INSERT INTO replies (id, item_id, category, type, title, text_value, sort_order) VALUES (?, ?, ?, 'text', ?, ?, ?)`
  ).run(id, itemId, category, title || "", textValue || null, maxOrder + 1);

  for (const p of filePaths) {
    const { storedPath, originalName } = stageFile(itemId, p);
    db.prepare(`INSERT INTO reply_files (id, reply_id, stored_path, original_name) VALUES (?, ?, ?, ?)`).run(
      uuid(),
      id,
      storedPath,
      originalName
    );
  }
  const projectId = projectIdForItem(itemId);
  if (projectId) touchProject(projectId);
  return id;
}

function updateReply(replyId, { title, textValue }) {
  const fields = [];
  const values = [];
  if (title !== undefined) {
    fields.push("title = ?");
    values.push(title);
    fields.push("category = ?");
    values.push(String(title).trim() || replyId);
  }
  if (textValue !== undefined) {
    fields.push("text_value = ?");
    values.push(textValue);
  }
  if (!fields.length) return;
  values.push(replyId);
  db.prepare(`UPDATE replies SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  const row = db.prepare(`SELECT item_id FROM replies WHERE id=?`).get(replyId);
  const projectId = row && projectIdForItem(row.item_id);
  if (projectId) touchProject(projectId);
}

function removeReply(replyId) {
  const row = db.prepare(`SELECT item_id FROM replies WHERE id=?`).get(replyId);
  const paths = db.prepare(`SELECT stored_path FROM reply_files WHERE reply_id=?`).all(replyId).map((f) => f.stored_path);
  db.prepare(`DELETE FROM replies WHERE id = ?`).run(replyId);
  for (const storedPath of paths) removeStoredFile(storedPath);
  const projectId = row && projectIdForItem(row.item_id);
  if (projectId) touchProject(projectId);
}

function removeReplies(replyIds) {
  for (const id of replyIds) removeReply(id);
}

// Hapus SATU file dari reply (bukan seluruh reply) — reply unified (D1) bisa punya banyak file
// bareng, jadi butuh cara lepas satu tanpa ngehapus field-nya total.
function removeReplyFile(fileId) {
  const row = db.prepare(`SELECT rf.stored_path, r.item_id FROM reply_files rf JOIN replies r ON r.id=rf.reply_id WHERE rf.id=?`).get(fileId);
  db.prepare(`DELETE FROM reply_files WHERE id = ?`).run(fileId);
  removeStoredFile(row?.stored_path);
}

// Drag-reorder reply (poin C4) — cuma nulis ulang sort_order sesuai urutan baru dari client.
function reorderReplies(itemId, orderedReplyIds) {
  const stmt = db.prepare(`UPDATE replies SET sort_order = ? WHERE id = ? AND item_id = ?`);
  orderedReplyIds.forEach((id, i) => stmt.run(i, id, itemId));
  const projectId = projectIdForItem(itemId);
  if (projectId) touchProject(projectId);
}

// Clear field scope "semua item" (poin C6) — hapus semua reply di SELURUH project yang
// category-nya cocok (bukan cuma id yang dicentang di 1 item). Reply tanpa judul aman —
// category-nya udah unik per-reply (id sendiri, lihat addReplyWithFiles), jadi otomatis gak
// ke-match reply tanpa judul lain.
function removeRepliesByCategory(projectId, categories) {
  for (const category of categories) {
    const ids = db.prepare(`SELECT id FROM replies WHERE category = ? AND item_id IN (SELECT id FROM items WHERE project_id = ?)`).all(category, projectId);
    for (const { id } of ids) removeReply(id);
  }
}

function addFilesToReply(replyId, itemId, sourcePaths) {
  if (db.prepare('SELECT item_id FROM replies WHERE id=?').get(replyId)?.item_id !== itemId) throw new Error("Reply tidak berada dalam item ini.");
  for (const p of sourcePaths) {
    const { storedPath, originalName } = stageFile(itemId, p);
    db.prepare(`INSERT INTO reply_files (id, reply_id, stored_path, original_name) VALUES (?, ?, ?, ?)`).run(uuid(), replyId, storedPath, originalName);
  }
  const projectId = projectIdForItem(itemId);
  if (projectId) touchProject(projectId);
}

// Broadcast per-reply: konten reply ini (kategori sama) diterapkan ke semua item lain
// di project yang sama — reply existing dengan kategori sama ditimpa, kalau belum ada dibikin baru.
function broadcastReply(replyId, projectId) {
  if (!ownsReply(replyId) || !ownsProject(projectId)) throw new Error("Project atau reply tidak ditemukan untuk akun ini.");
  const source = db.prepare(`SELECT * FROM replies WHERE id = ?`).get(replyId);
  if (!source) return;
  const sourceFiles = db.prepare(`SELECT * FROM reply_files WHERE reply_id = ?`).all(replyId);
  const otherItems = db.prepare(`SELECT id FROM items WHERE project_id = ? AND id != ?`).all(projectId, source.item_id);

  const staged = [];
  const oldPaths = [];
  try {
    // Salin semua bytes dulu. Jika satu gagal, database dan file tujuan lama tetap utuh.
    for (const { id: itemId } of otherItems) {
      for (const f of sourceFiles) staged.push({ itemId, source: f, storedPath: stageCopy(itemId, f.stored_path, f.original_name) });
    }
    transaction(() => {
      for (const { id: itemId } of otherItems) {
        const existing = db.prepare(`SELECT * FROM replies WHERE item_id = ? AND category = ?`).get(itemId, source.category);
        const targetReplyId = existing ? existing.id : uuid();
        if (existing) {
          oldPaths.push(...db.prepare(`SELECT stored_path FROM reply_files WHERE reply_id=?`).all(existing.id).map((r) => r.stored_path));
          db.prepare(`UPDATE replies SET title = ?, type = ?, text_value = ? WHERE id = ?`).run(source.title, source.type, source.text_value, existing.id);
          db.prepare(`DELETE FROM reply_files WHERE reply_id = ?`).run(existing.id);
        } else {
          const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM replies WHERE item_id = ?`).get(itemId).m;
          db.prepare(`INSERT INTO replies (id, item_id, category, type, title, text_value, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(targetReplyId, itemId, source.category, source.type, source.title, source.text_value, maxOrder + 1);
        }
        for (const f of staged.filter((x) => x.itemId === itemId)) {
          db.prepare(`INSERT INTO reply_files (id, reply_id, stored_path, original_name) VALUES (?, ?, ?, ?)`).run(uuid(), targetReplyId, f.storedPath, f.source.original_name);
        }
      }
      touchProject(projectId);
    });
    for (const storedPath of oldPaths) removeStoredFile(storedPath);
  } catch (error) {
    for (const f of staged) removeStoredFile(f.storedPath);
    throw error;
  }
}

// Capture (crop gambar/frame video) sekarang mampir ke "pool" di renderer dulu (in-memory,
// belum ada di disk) — baru ditulis ke disk pas user drag ke tujuannya. Dua tujuan: drop ke
// reply file yang sudah ada (addCapturedFileToReply), atau drop ke area kosong = reply baru
// kategori "capture" (addCapturedFile, dipertahankan sama seperti sebelumnya).
function writeDataUrlFile_(itemId, dataUrl, filename) {
  if (typeof dataUrl !== "string" || dataUrl.length > Math.ceil(MAX_FILE_BYTES * 4 / 3) + 256) throw new Error("Capture terlalu besar.");
  if (typeof dataUrl !== "string" || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) throw new Error("Data capture tidak valid.");
  const base64 = dataUrl.split(",")[1] || "";
  if (base64.length > 40 * 1024 * 1024) throw new Error("Capture terlalu besar.");
  return stageWrite(itemId, Buffer.from(base64, "base64"), filename);
}

function addCapturedFile(itemId, dataUrl, filename) {
  const storedPath = writeDataUrlFile_(itemId, dataUrl, filename);
  const replyId = uuid();
  const maxOrder = db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM replies WHERE item_id = ?`).get(itemId).m;
  db.prepare(
    `INSERT INTO replies (id, item_id, category, type, title, text_value, sort_order) VALUES (?, ?, 'capture', 'file', 'Capture', NULL, ?)`
  ).run(replyId, itemId, maxOrder + 1);
  db.prepare(`INSERT INTO reply_files (id, reply_id, stored_path, original_name) VALUES (?, ?, ?, ?)`).run(uuid(), replyId, storedPath, filename);
  const projectId = projectIdForItem(itemId);
  if (projectId) touchProject(projectId);
  return replyId;
}

function addCapturedFileToReply(replyId, itemId, dataUrl, filename) {
  if (db.prepare('SELECT item_id FROM replies WHERE id=?').get(replyId)?.item_id !== itemId) throw new Error("Reply tidak berada dalam item ini.");
  const storedPath = writeDataUrlFile_(itemId, dataUrl, filename);
  db.prepare(`INSERT INTO reply_files (id, reply_id, stored_path, original_name) VALUES (?, ?, ?, ?)`).run(uuid(), replyId, storedPath, filename);
  const projectId = projectIdForItem(itemId);
  if (projectId) touchProject(projectId);
}

// Sesi Batch File per project (kategori + file + koneksi ke item) — persist biar user bisa
// "sync ulang" nambah file baru ke kategori yang sama tanpa ngulang dari nol.
function listBatchSections(projectId) {
  const sections = db.prepare(`SELECT * FROM batch_sections WHERE project_id = ? ORDER BY sort_order ASC`).all(projectId);
  for (const s of sections) {
    s.files = db
      .prepare(`SELECT * FROM batch_files WHERE section_id = ? ORDER BY sort_order ASC`)
      .all(s.id)
      .map((f) => ({ ...f, connectedItemIds: JSON.parse(f.connected_item_ids_json) }));
  }
  return sections;
}

// Wholesale replace — renderer kirim seluruh state sesi tiap ada perubahan, lebih simpel
// daripada CRUD granular buat struktur yang emang selalu diedit-ulang bareng-bareng di UI.
function saveBatchSections(projectId, sections) {
  if (!ownsProject(projectId)) throw new Error("Project tidak ditemukan.");
  if (!Array.isArray(sections)) throw new Error("Data batch tidak valid.");
  transaction(() => {
    const sectionIds = new Set(sections.map((s) => s.id));
    const existing = db.prepare(`SELECT id FROM batch_sections WHERE project_id = ?`).all(projectId);
    for (const s of existing) if (!sectionIds.has(s.id)) db.prepare(`DELETE FROM batch_sections WHERE id = ?`).run(s.id);
    sections.forEach((section, si) => {
      if (!section?.id || !String(section.name || "").trim() || !Array.isArray(section.files)) throw new Error("Data kategori batch tidak valid.");
      const priorSection = db.prepare('SELECT project_id FROM batch_sections WHERE id=?').get(section.id);
      if (priorSection && priorSection.project_id !== projectId) throw new Error("Kategori batch milik project lain.");
      db.prepare(`INSERT INTO batch_sections (id, project_id, name, sort_order) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, sort_order=excluded.sort_order`).run(section.id, projectId, section.name, si);
      const fileIds = new Set(section.files.map((f) => f.id));
      for (const f of db.prepare(`SELECT id FROM batch_files WHERE section_id=?`).all(section.id)) if (!fileIds.has(f.id)) db.prepare(`DELETE FROM batch_files WHERE id=?`).run(f.id);
      section.files.forEach((file, fi) => {
        if (!file?.id || typeof file.path !== "string" || typeof file.filename !== "string" || !Array.isArray(file.connectedItemIds)) throw new Error("Data file batch tidak valid.");
        const prior = db.prepare('SELECT * FROM batch_files WHERE id=?').get(file.id);
        if (prior && prior.section_id !== section.id) throw new Error("File batch milik kategori lain.");
        if (!file.connectedItemIds.every((id) => projectIdForItem(id) === projectId)) throw new Error("Item batch milik project lain.");
        let storedPath = prior?.path;
        if (!prior || (file.path !== prior.path && file.path !== prior.source_path)) {
          storedPath = stageFile(projectId, file.path).storedPath;
          if (prior) {
            for (const applied of db.prepare('SELECT reply_file_id FROM batch_applications WHERE file_id=?').all(file.id)) if (applied.reply_file_id) removeReplyFile(applied.reply_file_id);
            db.prepare('DELETE FROM batch_applications WHERE file_id=?').run(file.id);
            removeStoredFile(prior.path);
          }
        }
        db.prepare(`INSERT INTO batch_files (id, section_id, path, filename, connected_item_ids_json, sort_order) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET path=excluded.path, filename=excluded.filename, connected_item_ids_json=excluded.connected_item_ids_json, sort_order=excluded.sort_order`
        ).run(file.id, section.id, storedPath, safeFilename(file.filename), JSON.stringify([...new Set(file.connectedItemIds)]), fi);
        db.prepare('UPDATE batch_files SET source_path=? WHERE id=?').run(prior?.source_path || file.path, file.id);
      });
    });
    touchProject(projectId);
  });
}

function applyBatchSections(projectId) {
  const sections = listBatchSections(projectId);
  const staged = [];
  try {
    for (const section of sections) {
      for (const file of section.files) {
        for (const itemId of file.connectedItemIds) {
          const item = db.prepare(`SELECT id FROM items WHERE id=? AND project_id=?`).get(itemId, projectId);
          if (!item) continue;
          const application = db.prepare(`SELECT * FROM batch_applications WHERE file_id=? AND item_id=?`).get(file.id, itemId);
          if (application?.reply_file_id && db.prepare('SELECT 1 FROM reply_files WHERE id=?').get(application.reply_file_id)) continue;
          if (application && !application.reply_file_id) throw new Error("Relasi batch versi lama tidak pasti. Hapus file dari sesi batch, periksa attachment lama, lalu tambahkan ulang file yang belum diterapkan.");
          if (application) db.prepare('DELETE FROM batch_applications WHERE file_id=? AND item_id=?').run(file.id, itemId);
          staged.push({ section, file, itemId, storedPath: stageFile(itemId, file.path).storedPath });
        }
      }
    }
    transaction(() => {
      for (const entry of staged) {
        let target = db.prepare(`SELECT reply_id FROM batch_targets WHERE section_id=? AND item_id=?`).get(entry.section.id, entry.itemId);
        if (!target || !db.prepare(`SELECT 1 FROM replies WHERE id=?`).get(target.reply_id)) {
          const replyId = addReplyWithFiles(entry.itemId, { title: entry.section.name });
          db.prepare(`INSERT INTO batch_targets(section_id,item_id,reply_id) VALUES(?,?,?) ON CONFLICT(section_id,item_id) DO UPDATE SET reply_id=excluded.reply_id`).run(entry.section.id, entry.itemId, replyId);
          target = { reply_id: replyId };
        }
        const replyFileId = uuid();
        db.prepare(`INSERT INTO reply_files(id,reply_id,stored_path,original_name) VALUES(?,?,?,?)`).run(replyFileId, target.reply_id, entry.storedPath, entry.file.filename);
        db.prepare(`INSERT INTO batch_applications(file_id,item_id,reply_file_id) VALUES(?,?,?)`).run(entry.file.id, entry.itemId, replyFileId);
      }
      touchProject(projectId);
    });
    return { added: staged.length };
  } catch (error) {
    for (const entry of staged) removeStoredFile(entry.storedPath);
    throw error;
  }
}

function listHyperlinkPresets() {
  return db.prepare(`SELECT * FROM hyperlink_presets`).all();
}

function saveHyperlinkPreset({ id, label, url }) {
  const pid = id || uuid();
  db.prepare(
    `INSERT INTO hyperlink_presets (id, label, url) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, url = excluded.url`
  ).run(pid, label, url);
  return pid;
}

function deleteHyperlinkPreset(id) {
  db.prepare(`DELETE FROM hyperlink_presets WHERE id = ?`).run(id);
}

function listEmojiPresets() {
  return db.prepare(`SELECT * FROM emoji_presets ORDER BY sort_order, rowid`).all();
}

function nextEmojiPresetOrder() {
  return (db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM emoji_presets`).get().m ?? -1) + 1;
}

// `shortcode` (poin revisi: fitur Reaction) — nama Slack TANPA titik dua, dari field `colons`
// picker mr-emoji (contoh emoji.colons ":grinning:" -> disimpan "grinning"). Opsional buat jaga
// kompatibilitas kalau ada caller lama yang belum ngasih, tapi SEMUA pemanggil baru wajib ngasih
// biar preset ini bisa dipakai jadi reaction.
function addUnicodeEmojiPreset(char, shortcode) {
  if (!char) throw new Error("Emoji kosong.");
  if (db.prepare(`SELECT 1 FROM emoji_presets WHERE type = 'unicode' AND value = ?`).get(char)) return null; // udah ada, gak dobel
  const id = uuid();
  const clean = shortcode ? String(shortcode).replace(/:/g, "") : null;
  db.prepare(`INSERT INTO emoji_presets (id, type, value, slack_shortcode, sort_order) VALUES (?, 'unicode', ?, ?, ?)`).run(id, char, clean, nextEmojiPresetOrder());
  return id;
}

// Custom emoji ala Slack (poin revisi) — cuma nyimpen NAMA + PNG buat preview picker lokal, gak
// pernah divalidasi/di-upload ke Slack beneran. Insert ke text field-nya berupa teks ":nama:"
// (jalur SLACK_TRANSFORMERS/mrkdwn biasa) — kalau workspace Slack tujuan kebetulan punya custom
// emoji nama sama, otomatis kerender; kalau enggak, ya tampil apa adanya, SENGAJA gak ditolak.
// `slack_shortcode` = nama-nya sendiri (dipakai juga buat reaction — kalau workspace Slack tujuan
// gak punya custom emoji nama sama, reactions.add bakal gagal jelas dengan error dari Slack).
function addCustomEmojiPreset(name, sourcePath) {
  const cleanName = String(name || "").trim().toLowerCase().replace(/[^a-z0-9_+-]/g, "");
  if (!cleanName) throw new Error("Nama emoji custom gak valid (huruf kecil/angka/_/-/+ doang).");
  if (db.prepare(`SELECT 1 FROM emoji_presets WHERE type = 'custom' AND value = ?`).get(cleanName)) {
    throw new Error(`Emoji custom ":${cleanName}:" udah ada.`);
  }
  const { storedPath } = stageFile("emoji-presets", sourcePath);
  const id = uuid();
  db.prepare(`INSERT INTO emoji_presets (id, type, value, image_path, slack_shortcode, sort_order) VALUES (?, 'custom', ?, ?, ?, ?)`).run(id, cleanName, storedPath, cleanName, nextEmojiPresetOrder());
  return id;
}

function removeEmojiPreset(id) {
  const row = db.prepare(`SELECT image_path FROM emoji_presets WHERE id = ?`).get(id);
  if (row?.image_path) removeStoredFile(row.image_path);
  db.prepare(`DELETE FROM emoji_presets WHERE id = ?`).run(id);
}

// ---------- Artis Preset (poin revisi) ----------
// GLOBAL, satu preset per Slack member_id — lihat catatan skema di db.cjs.
function listArtistPresets() {
  return db.prepare(`SELECT * FROM artist_presets`).all();
}

// Upsert (bukan add-only) — satu preset per member_id, wajar untuk EDIT ulang nickname/code
// name/PNG-nya. `id` dikasih = update baris yang ada; gak dikasih = insert baru (member_id WAJIB
// belum punya preset). `sourcePath` opsional — gak diisi = PNG lama (kalau ada) dipertahankan.
function saveArtistPreset({ id, memberId, nickname, codeName, sourcePath }) {
  if (!memberId) throw new Error("Member Slack wajib dipilih.");
  const cleanCodeName = codeName ? String(codeName).trim().toLowerCase().replace(/[^a-z0-9_+-]/g, "") : null;
  const cleanNickname = nickname ? String(nickname).trim() : null;
  const existing = id ? db.prepare(`SELECT * FROM artist_presets WHERE id = ?`).get(id) : null;
  if (id && !existing) throw new Error("Preset artis tidak ditemukan.");
  let imagePath = existing?.image_path || null;
  if (sourcePath) {
    const staged = stageFile("artist-presets", sourcePath);
    if (existing?.image_path) removeStoredFile(existing.image_path);
    imagePath = staged.storedPath;
  }
  if (existing) {
    db.prepare(`UPDATE artist_presets SET member_id=?, nickname=?, code_name=?, image_path=? WHERE id=?`).run(memberId, cleanNickname, cleanCodeName, imagePath, id);
    return id;
  }
  if (db.prepare(`SELECT 1 FROM artist_presets WHERE member_id = ?`).get(memberId)) {
    throw new Error("Member ini udah punya preset artis.");
  }
  const newId = uuid();
  db.prepare(`INSERT INTO artist_presets (id, member_id, nickname, code_name, image_path) VALUES (?, ?, ?, ?, ?)`).run(newId, memberId, cleanNickname, cleanCodeName, imagePath);
  return newId;
}

function removeArtistPreset(id) {
  const row = db.prepare(`SELECT image_path FROM artist_presets WHERE id = ?`).get(id);
  if (row?.image_path) removeStoredFile(row.image_path);
  db.prepare(`DELETE FROM artist_presets WHERE id = ?`).run(id);
}

const ARTIST_ASSIGN_MODES = ["mention", "react", "both", "none"];

// Mode assign Mention/React (poin revisi) — GLOBAL buat SEMUA artis (bukan per-artis/per-item
// lagi). Singleton 1 baris di artist_assign_mode (id selalu 1, di-seed 'mention' pas migrasi).
function getArtistAssignMode() {
  return db.prepare(`SELECT mode FROM artist_assign_mode WHERE id = 1`).get()?.mode || "mention";
}

function setArtistAssignMode(mode) {
  if (!ARTIST_ASSIGN_MODES.includes(mode)) throw new Error("Mode assign gak valid.");
  db.prepare(`UPDATE artist_assign_mode SET mode = ? WHERE id = 1`).run(mode);
  return mode;
}

// Toggle global Instant Intake/Instant Reaction (poin revisi) — singleton, gak mempengaruhi
// tombol "Add React" (jalur pending biasa).
function getInstantIntakeEnabled() {
  return !!db.prepare(`SELECT enabled FROM instant_intake_setting WHERE id = 1`).get()?.enabled;
}

function setInstantIntakeEnabled(enabled) {
  db.prepare(`UPDATE instant_intake_setting SET enabled = ? WHERE id = 1`).run(enabled ? 1 : 0);
  return !!enabled;
}

// ---------- Reaction (poin revisi) ----------
// PENDING per item, nunggu dikirim bareng lewat "Kirim ke Slack" biasa (beda dari reaction
// INSTAN overlay hover pil item — itu fire-and-forget, gak pernah nyentuh tabel ini).
function listItemReactions(itemId) {
  return db.prepare(`SELECT * FROM item_reactions WHERE item_id = ? ORDER BY sort_order, rowid`).all(itemId);
}

function addItemReaction(itemId, { emojiType, emojiValue, slackShortcode }) {
  if (!slackShortcode) throw new Error("Emoji ini gak punya kode Slack (shortcode).");
  // Dedupe per item+shortcode — reaction yang sama gak perlu diantre 2x.
  if (db.prepare(`SELECT 1 FROM item_reactions WHERE item_id = ? AND slack_shortcode = ?`).get(itemId, slackShortcode)) return null;
  const id = uuid();
  const maxOrder = (db.prepare(`SELECT COALESCE(MAX(sort_order), -1) AS m FROM item_reactions WHERE item_id = ?`).get(itemId).m ?? -1) + 1;
  db.prepare(`INSERT INTO item_reactions (id, item_id, emoji_type, emoji_value, slack_shortcode, sort_order) VALUES (?, ?, ?, ?, ?, ?)`).run(
    id,
    itemId,
    emojiType,
    emojiValue,
    slackShortcode,
    maxOrder
  );
  return id;
}

function removeItemReaction(id) {
  db.prepare(`DELETE FROM item_reactions WHERE id = ?`).run(id);
}

// Poin revisi: "React semua Item, atau React hanya item ini" — antre reaction yang SAMA ke
// SEMUA item di project sekaligus (bukan instan, tetap lewat jalur PENDING biasa — dedupe
// per-item bawaan `addItemReaction` udah nyegah dobel kalau dipanggil berkali-kali).
function addReactionToAllItems(projectId, payload) {
  const itemIds = db.prepare(`SELECT id FROM items WHERE project_id = ?`).all(projectId).map((r) => r.id);
  let added = 0;
  for (const itemId of itemIds) if (addItemReaction(itemId, payload)) added++;
  return { total: itemIds.length, added };
}

function ownsItemReaction(id) {
  return !!db
    .prepare(`SELECT 1 FROM item_reactions r JOIN items i ON i.id=r.item_id JOIN projects p ON p.id=i.project_id WHERE r.id=? AND p.owner_user_id=? AND p.owner_team_id=?`)
    .get(id, activeScope.userId, activeScope.teamId);
}

function deleteTemplate(id) {
  db.prepare(`DELETE FROM templates WHERE id = ? AND is_builtin = 0`).run(id);
}

// Save As: duplikat project + semua item/file/reply-nya jadi project baru terpisah.
function duplicateProject(projectId, newName) {
  const id = importProject(exportProject(projectId));
  renameProject(id, newName);
  return id;
}

function addLog(level, message) {
  db.prepare(`INSERT INTO logs (id, level, message, created_at) VALUES (?, ?, ?, ?)`).run(uuid(), level, message, now());
}

function listLogs(limit = 200) {
  return db.prepare(`SELECT * FROM logs ORDER BY created_at DESC LIMIT ?`).all(limit);
}

function clearLogs() {
  db.prepare(`DELETE FROM logs`).run();
}

function listArtistGroups() {
  return db.prepare(`SELECT * FROM artist_groups`).all().map((g) => ({ ...g, memberIds: JSON.parse(g.member_ids_json) }));
}

function saveArtistGroup({ id, name, memberIds }) {
  const gid = id || uuid();
  db.prepare(
    `INSERT INTO artist_groups (id, name, member_ids_json) VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, member_ids_json = excluded.member_ids_json`
  ).run(gid, name, JSON.stringify(memberIds));
  return gid;
}

function deleteArtistGroup(id) {
  db.prepare(`DELETE FROM artist_groups WHERE id = ?`).run(id);
}

function listTemplates() {
  return db.prepare(`SELECT * FROM templates`).all().map((t) => ({ ...t, fields: JSON.parse(t.fields_json) }));
}

function saveTemplate({ id, name, fields }) {
  const tid = id || uuid();
  db.prepare(
    `INSERT INTO templates (id, name, is_builtin, fields_json) VALUES (?, ?, 0, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, fields_json = excluded.fields_json`
  ).run(tid, name, JSON.stringify(fields));
  return tid;
}

// Export: 1 file JSON self-contained (attachment di-embed base64) — ponytail: hindari nambah
// dependency zip cuma buat ini, cukup stdlib fs + JSON. Bisa membengkak untuk file besar,
// upgrade ke format zip kalau ternyata jadi masalah nyata.
function exportProject(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error("Project tidak ditemukan.");
  // project.files (General Display), item.files (attach langsung) DAN reply.files (Drawer)
  // semuanya perlu di-embed.
  project.batchSections = listBatchSections(projectId);
  for (const section of project.batchSections) for (const file of section.files) {
    file.applied = db.prepare('SELECT item_id,reply_file_id FROM batch_applications WHERE file_id=? AND reply_file_id IS NOT NULL').all(file.id);
    if (!fs.existsSync(file.path)) {
      const fallback = db.prepare('SELECT rf.stored_path FROM batch_applications a JOIN reply_files rf ON rf.id=a.reply_file_id WHERE a.file_id=? LIMIT 1').get(file.id);
      if (fallback) file.path = fallback.stored_path;
    }
  }
  const files = [...project.files, ...project.items.flatMap((i) => [...i.files, ...i.replies.flatMap((r) => r.files)])];
  const paths = [...files.map((f) => f.stored_path), ...project.batchSections.flatMap((s) => s.files.map((f) => f.path))];
  if (!files.every((file) => isManagedFile(file.stored_path))) throw new Error("Attachment berada di luar penyimpanan aplikasi. Pilih ulang file tersebut.");
  if (paths.reduce((total, file) => total + fs.statSync(file).size, 0) > MAX_FILE_BYTES) throw new Error("Total export maksimal 100 MB.");
  for (const file of project.files) {
    file.dataBase64 = fs.readFileSync(file.stored_path).toString("base64");
  }
  for (const item of project.items) {
    for (const file of item.files) {
      file.dataBase64 = fs.readFileSync(file.stored_path).toString("base64");
    }
    for (const reply of item.replies) {
      for (const file of reply.files) {
        file.dataBase64 = fs.readFileSync(file.stored_path).toString("base64");
      }
    }
  }
  for (const section of project.batchSections) {
    for (const file of section.files) {
      if (!fs.existsSync(file.path)) throw new Error(`File sumber batch tidak ditemukan: ${file.filename}`);
      file.dataBase64 = fs.readFileSync(file.path).toString("base64");
    }
  }
  return { formatVersion: 1, exportedAt: now(), project };
}

function importProject(payload) {
  if (!payload || payload.formatVersion !== 1 || !payload.project || !Array.isArray(payload.project.items) || !Array.isArray(payload.project.files || [])) {
    throw new Error("Format file export tidak valid.");
  }
  const src = payload.project;
  if (!Array.isArray(src.batchSections || []) || src.items.length > 10000) throw new Error("Struktur project terlalu besar atau tidak valid.");
  if (typeof src.name !== "string" || typeof src.channel_id !== "string" || typeof src.channel_name !== "string") throw new Error("Data project tidak valid.");
  const allFiles = [
    ...(src.files || []),
    ...src.items.flatMap((item) => [...(item.files || []), ...(item.replies || []).flatMap((reply) => reply.files || [])]),
    ...(src.batchSections || []).flatMap((section) => section.files || []),
  ];
  let decodedBytes = 0;
  for (const file of allFiles) {
    safeFilename(file?.original_name || file?.filename);
    if (typeof file.dataBase64 !== "string" || !/^[a-zA-Z0-9+/]*={0,2}$/.test(file.dataBase64)) throw new Error("Isi attachment tidak valid.");
    decodedBytes += Math.floor(file.dataBase64.length * 3 / 4);
    if (decodedBytes > MAX_FILE_BYTES) throw new Error("Total attachment import melebihi 100 MB.");
  }
  const staged = [];
  let newProjectId;
  try {
    transaction(() => {
      const newProject = createProject({ name: `${src.name} (import)`, channelId: src.channel_id, channelName: src.channel_name });
      newProjectId = newProject.id;
      for (const file of src.files || []) {
        const storedPath = stageWrite(newProject.id, Buffer.from(file.dataBase64, "base64"), file.original_name); staged.push(storedPath);
        db.prepare(`INSERT INTO project_files (id, project_id, stored_path, original_name, sort_order) VALUES (?, ?, ?, ?, ?)`).run(uuid(), newProject.id, storedPath, file.original_name, file.sort_order || 0);
      }
      const itemMap = new Map();
      const replyFileMap = new Map();
      for (const item of src.items) {
        if (!item || typeof item.name !== "string" || !Array.isArray(item.replies || [])) throw new Error("Data item tidak valid.");
        const newItemId = addItem(newProject.id, { name: item.name, artistId: item.artist_id, artistName: item.artist_name, source: item.source });
        itemMap.set(item.id, newItemId);
        for (const reaction of item.reactions || []) addItemReaction(newItemId, { emojiType: reaction.emoji_type, emojiValue: reaction.emoji_value, slackShortcode: reaction.slack_shortcode });
        for (const file of item.files || []) {
          const storedPath = stageWrite(newItemId, Buffer.from(file.dataBase64, "base64"), file.original_name); staged.push(storedPath);
          db.prepare(`INSERT INTO item_files (id, item_id, stored_path, original_name, sort_order) VALUES (?, ?, ?, ?, ?)`).run(uuid(), newItemId, storedPath, file.original_name, file.sort_order || 0);
        }
        for (const reply of item.replies || []) {
          if (!reply || !Array.isArray(reply.files || [])) throw new Error("Data reply tidak valid.");
          const newReplyId = uuid();
          db.prepare(`INSERT INTO replies (id, item_id, category, type, title, text_value, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(newReplyId, newItemId, reply.category || newReplyId, reply.type || "text", reply.title || "", reply.text_value || null, reply.sort_order || 0);
          for (const file of reply.files || []) {
            const storedPath = stageWrite(newItemId, Buffer.from(file.dataBase64, "base64"), file.original_name); staged.push(storedPath);
            const newFileId = uuid();
            replyFileMap.set(file.id, { id: newFileId, replyId: newReplyId, itemId: newItemId });
            db.prepare(`INSERT INTO reply_files (id, reply_id, stored_path, original_name) VALUES (?, ?, ?, ?)`).run(newFileId, newReplyId, storedPath, file.original_name);
          }
        }
      }
      if (Array.isArray(src.batchSections)) {
        const sections = src.batchSections.map((section) => ({
          ...section,
          id: uuid(),
          files: (section.files || []).map((file) => {
            const importedPath = stageWrite(newProject.id, Buffer.from(file.dataBase64, "base64"), file.filename); staged.push(importedPath);
            return { ...file, id: uuid(), path: importedPath, connectedItemIds: (file.connectedItemIds || []).map((id) => itemMap.get(id)).filter(Boolean) };
          }),
        }));
        sections.forEach((section, si) => {
          db.prepare(`INSERT INTO batch_sections(id,project_id,name,sort_order) VALUES(?,?,?,?)`).run(section.id, newProject.id, section.name, si);
          section.files.forEach((file, fi) => db.prepare(`INSERT INTO batch_files(id,section_id,path,filename,connected_item_ids_json,sort_order) VALUES(?,?,?,?,?,?)`)
            .run(file.id, section.id, file.path, file.filename, JSON.stringify(file.connectedItemIds), fi));
          for (const file of section.files) for (const applied of file.applied || []) {
            const target = replyFileMap.get(applied.reply_file_id), itemId = itemMap.get(applied.item_id);
            if (!target || target.itemId !== itemId || !file.connectedItemIds.includes(itemId)) throw new Error("Relasi batch export tidak valid.");
            db.prepare('INSERT INTO batch_applications(file_id,item_id,reply_file_id) VALUES(?,?,?)').run(file.id, itemId, target.id);
            db.prepare('INSERT INTO batch_targets(section_id,item_id,reply_id) VALUES(?,?,?) ON CONFLICT(section_id,item_id) DO NOTHING').run(section.id, itemId, target.replyId);
          }
        });
      }
    });
    return newProjectId;
  } catch (error) {
    for (const storedPath of staged) removeStoredFile(storedPath);
    throw error;
  }
}

function applyTemplate(projectId, templateId) {
  if (!ownsProject(projectId)) throw new Error("Project tidak ditemukan.");
  const template = listTemplates().find((t) => t.id === templateId);
  if (!template) throw new Error("Template tidak ditemukan.");
  return transaction(() => {
    for (const item of getProject(projectId).items) for (const field of template.fields) addReplyWithFiles(item.id, { title: field.label });
  });
}

function legacyCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM projects WHERE owner_user_id IS NULL').get().n;
}

function recoverLegacyProjects() {
  if (!activeScope.userId || !activeScope.teamId) throw new Error("Login terlebih dahulu.");
  return transaction(() => db.prepare('UPDATE projects SET owner_user_id=?,owner_team_id=? WHERE owner_user_id IS NULL').run(activeScope.userId, activeScope.teamId).changes);
}

function releaseUndo(projectId) {
  for (const [id, snapshot] of deletedItems) if (snapshot.project_id === projectId) deletedItems.delete(id);
  for (const [id, snapshot] of mergedItems) if (snapshot.items[0]?.project_id === projectId) mergedItems.delete(id);
  const root = path.resolve(dataDir, 'attachments');
  function visit(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      // Never follow junctions or symlinks during collection.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(file);
      else removeStoredFile(file);
    }
    if (dir !== root) try { fs.rmdirSync(dir); } catch { /* still referenced */ }
  }
  visit(root);
}

module.exports = {
  legacyCount,
  recoverLegacyProjects,
  releaseUndo,
  applyTemplate,
  setScope,
  isManagedFile,
  ownsProject,
  ownsItem,
  ownsReply,
  ownsFile,
  createProject,
  listProjects,
  getProject,
  touchProject,
  deleteProject,
  renameProject,
  duplicateProject,
  addItem,
  updateItem,
  removeItem,
  restoreItem,
  mergeItems,
  unmergeItems,
  addLog,
  listLogs,
  clearLogs,
  listBatchSections,
  saveBatchSections,
  applyBatchSections,
  addItemFiles,
  removeItemFile,
  listItemFiles,
  addProjectFiles,
  removeProjectFile,
  addReplyWithFiles,
  updateReply,
  removeReply,
  removeReplies,
  removeReplyFile,
  removeRepliesByCategory,
  reorderReplies,
  addFilesToReply,
  broadcastReply,
  addCapturedFile,
  addCapturedFileToReply,
  stageFile,
  listArtistGroups,
  saveArtistGroup,
  deleteArtistGroup,
  listTemplates,
  saveTemplate,
  deleteTemplate,
  listHyperlinkPresets,
  saveHyperlinkPreset,
  deleteHyperlinkPreset,
  listEmojiPresets,
  addUnicodeEmojiPreset,
  addCustomEmojiPreset,
  removeEmojiPreset,
  listArtistPresets,
  saveArtistPreset,
  removeArtistPreset,
  getArtistAssignMode,
  setArtistAssignMode,
  getInstantIntakeEnabled,
  setInstantIntakeEnabled,
  listItemReactions,
  addItemReaction,
  addReactionToAllItems,
  removeItemReaction,
  ownsItemReaction,
  exportProject,
  importProject,
};

// Synchronous nested mutations share their outer transaction and staged files.
for (const name of [
  "addItemFiles", "addProjectFiles", "addReplyWithFiles", "addFilesToReply",
  "addCapturedFile", "addCapturedFileToReply", "restoreItem", "mergeItems", "unmergeItems",
  "removeItem", "deleteProject", "removeReply", "removeReplies", "removeRepliesByCategory",
  "broadcastReply", "saveBatchSections", "applyBatchSections", "importProject", "duplicateProject",
  "addCustomEmojiPreset", "removeEmojiPreset", "saveArtistPreset", "removeArtistPreset"
]) {
  const mutate = module.exports[name];
  module.exports[name] = (...args) => transaction(() => mutate(...args));
}
