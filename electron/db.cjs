const { app } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const dataDir = app.getPath("userData");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, "attachments"), { recursive: true });

// node:sqlite (built-in Node, bukan better-sqlite3) — hindari kompilasi native
// yang gagal di toolchain LLVM mesin dev ini. API sinkron, cukup mirip.
const db = new DatabaseSync(path.join(dataDir, "slack-intake-apps.db"));
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  owner_team_id TEXT,
  name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  artist_id TEXT,
  artist_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual' -- 'manual' | 'folder-import'
);

-- File yang langsung nempel ke item buat dikirim (alur inti v1 — folder-import & manual add).
-- Terpisah dari replies/reply_files (sistem Template/Drawer lengkap, masih stub di v1 pass ini).
CREATE TABLE IF NOT EXISTS item_files (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  stored_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- General Display (Tab Reply, panel kiri) — file referensi level PROJECT, sengaja terpisah dari
-- item_files: harus tetap kelihatan sama pas ganti-ganti item (gak boleh reset), beda dari
-- item_files yang tetap per-item (dipakai buat lampiran "Main Thread" tiap item).
CREATE TABLE IF NOT EXISTS project_files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stored_path TEXT NOT NULL,
  original_name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS replies (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text', -- 'text' | 'file'
  title TEXT NOT NULL,
  text_value TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reply_files (
  id TEXT PRIMARY KEY,
  reply_id TEXT NOT NULL REFERENCES replies(id) ON DELETE CASCADE,
  stored_path TEXT NOT NULL,
  original_name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  fields_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artist_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  member_ids_json TEXT NOT NULL
);

-- Artis Preset (poin revisi) — GLOBAL buat seluruh app (pola sama kayak emoji_presets/
-- hyperlink_presets), satu baris per Slack member_id (users.list). nickname = ganti tampilan
-- nama di dropdown Artis (fallback ke nama Slack asli kalau NULL). code_name = shortcode custom
-- emoji (TANPA titik dua) buat workflow "assign via reaction" — dipakai persis kayak
-- emoji_presets.slack_shortcode pas reactions.add, DIASUMSIKAN custom emoji itu udah ada beneran
-- di workspace Slack tujuan (gak divalidasi app ini). image_path = PNG lokal, preview doang di
-- app kita (chip/manajemen preset) — sama sekali gak disinkronkan ke emoji asli di Slack.
CREATE TABLE IF NOT EXISTS artist_presets (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL UNIQUE,
  nickname TEXT,
  code_name TEXT,
  image_path TEXT
);

-- Mode assign Mention/React (poin revisi — GLOBAL buat SEMUA artis, bukan per-artis/per-item
-- lagi, koreksi dari percobaan sebelumnya). Singleton 1 baris (id selalu 1) — 'mention' | 'react'
-- | 'both' | 'none'.
CREATE TABLE IF NOT EXISTS artist_assign_mode (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'mention'
);
INSERT OR IGNORE INTO artist_assign_mode (id, mode) VALUES (1, 'mention');

CREATE TABLE IF NOT EXISTS threads (
  item_name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  -- Durable (BUKAN ephemeral kayak send_attempts.artist_sent yang ke-clear tiap sendItem() kelar)
  -- — dibutuhin sejak Instant Intake bisa bikin thread TANPA mention artis (scope "item"), jadi
  -- "thread ada" udah gak bisa lagi dianggap otomatis "artis udah pernah di-mention".
  artist_sent INTEGER NOT NULL DEFAULT 0,
  -- Link permalink pesan item (poin revisi: "simpan link pesan itemnya") — biar "buka di Slack"
  -- gak cuma keliatan pas sesi kirim yang sama, tapi tersimpan permanen per item+channel.
  permalink TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (item_name, channel_id)
);

CREATE TABLE IF NOT EXISTS send_attempts (
  item_name TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  thread_ts TEXT NOT NULL,
  artist_sent INTEGER NOT NULL DEFAULT 0,
  next_post INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (item_name, channel_id)
);

CREATE TABLE IF NOT EXISTS hyperlink_presets (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  url TEXT NOT NULL
);

-- Preset Emoji (poin revisi) — global buat SELURUH app (bukan per-project, pola sama kayak
-- hyperlink_presets di atas). "unicode" = emoji unicode biasa (value = karakternya sendiri).
-- "custom" = ala custom emoji Slack (value = nama TANPA titik dua, image_path = PNG lokal buat
-- preview picker doang — dipilih jadi teks shortcode ":nama:" pas di-insert, BUKAN gambarnya,
-- gak divalidasi ke Slack asli sama sekali).
-- slack_shortcode (poin revisi: fitur Reaction) — nama emoji ala Slack TANPA titik dua, dibutuhin
-- buat manggil reactions.add (Slack API butuh "name", bukan karakter unicode/gambar). Unicode:
-- diambil dari field colons yang dikasih picker mr-emoji pas milih (contoh "grinning" buat 😀).
-- Custom: sama persis kayak value-nya sendiri (nama custom emoji-nya).
CREATE TABLE IF NOT EXISTS emoji_presets (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- 'unicode' | 'custom'
  value TEXT NOT NULL,
  image_path TEXT,
  slack_shortcode TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Reaction PENDING per item (poin revisi) — belum dikirim ke Slack, nunggu "Kirim ke Slack" biasa
-- (urutan: pesan utama -> semua reply -> reaction). Beda dari reaction INSTAN (overlay hover pil
-- item) yang fire-and-forget, gak pernah nyentuh tabel ini sama sekali.
CREATE TABLE IF NOT EXISTS item_reactions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  emoji_type TEXT NOT NULL, -- 'unicode' | 'custom'
  emoji_value TEXT NOT NULL,
  slack_shortcode TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Sesi Batch File per project — sengaja TETAP DISIMPAN walau sesi sudah "Selesai"/"Lewati",
-- biar user bisa buka lagi buat sync ulang (nambah file baru ke kategori yang sama) tanpa
-- ngulang dari nol.
CREATE TABLE IF NOT EXISTS batch_sections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS batch_files (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES batch_sections(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  filename TEXT NOT NULL,
  connected_item_ids_json TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS batch_targets (
  section_id TEXT NOT NULL REFERENCES batch_sections(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  reply_id TEXT NOT NULL REFERENCES replies(id) ON DELETE CASCADE,
  PRIMARY KEY (section_id, item_id)
);

CREATE TABLE IF NOT EXISTS batch_applications (
  file_id TEXT NOT NULL REFERENCES batch_files(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY (file_id, item_id)
);

CREATE TABLE IF NOT EXISTS logs (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL, -- 'info' | 'error'
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

// Migrasi ringan untuk database versi awal. SQLite tidak bisa mengubah PRIMARY KEY
// langsung, jadi tabel thread lama disalin ke bentuk composite-key satu kali.
const projectColumns = db.prepare(`PRAGMA table_info(projects)`).all().map((c) => c.name);
if (!projectColumns.includes("owner_user_id")) db.exec(`ALTER TABLE projects ADD COLUMN owner_user_id TEXT`);
if (!projectColumns.includes("owner_team_id")) db.exec(`ALTER TABLE projects ADD COLUMN owner_team_id TEXT`);

// threadPk DULU (rename-recreate buat PK lama), BARU cek kolom artist_sent/permalink — kalau
// dibalik, rename-recreate di bawah bakal bikin ulang tabel threads TANPA 2 kolom itu (hardcoded
// SELECT-nya cuma 4 kolom lama), nge-invalidate ALTER yang baru aja jalan di atasnya.
const threadPk = db.prepare(`PRAGMA table_info(threads)`).all().filter((c) => c.pk).map((c) => c.name);
if (threadPk.length === 1 && threadPk[0] === "item_name") {
  db.exec(`
    BEGIN;
    ALTER TABLE threads RENAME TO threads_legacy;
    CREATE TABLE threads (
      item_name TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      artist_sent INTEGER NOT NULL DEFAULT 0,
      permalink TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (item_name, channel_id)
    );
    INSERT INTO threads (item_name, channel_id, thread_ts, updated_at) SELECT item_name, channel_id, thread_ts, updated_at FROM threads_legacy;
    DROP TABLE threads_legacy;
    COMMIT;
  `);
}

const threadColumns = db.prepare(`PRAGMA table_info(threads)`).all().map((c) => c.name);
if (!threadColumns.includes("artist_sent")) db.exec(`ALTER TABLE threads ADD COLUMN artist_sent INTEGER NOT NULL DEFAULT 0`);
if (!threadColumns.includes("permalink")) db.exec(`ALTER TABLE threads ADD COLUMN permalink TEXT`);

const emojiPresetColumns = db.prepare(`PRAGMA table_info(emoji_presets)`).all().map((c) => c.name);
if (!emojiPresetColumns.includes("slack_shortcode")) db.exec(`ALTER TABLE emoji_presets ADD COLUMN slack_shortcode TEXT`);

const seedBuiltinTemplate = db.prepare(
  `INSERT OR IGNORE INTO templates (id, name, is_builtin, fields_json) VALUES (?, ?, 1, ?)`
);
// Field reply unified (poin D1 rancangan) — gak ada lagi pembeda tipe Teks/File per field,
// 1 field bisa isi teks DAN lampirkan file bareng. Field template cukup label.
seedBuiltinTemplate.run("tpl-default", "Default", JSON.stringify([{ label: "Catatan" }]));
seedBuiltinTemplate.run(
  "tpl-animation",
  "Animation",
  JSON.stringify([
    { label: "Animatic" },
    { label: "TBH" },
    { label: "Char" },
    { label: "BG" },
    { label: "Prop" },
    { label: "Inset" },
    { label: "FX" },
    { label: "Referensi" },
  ])
);

if (!db.prepare('PRAGMA table_info(batch_applications)').all().some((c) => c.name === 'reply_file_id')) {
  db.exec('ALTER TABLE batch_applications ADD COLUMN reply_file_id TEXT REFERENCES reply_files(id) ON DELETE CASCADE');
  // Bind old applications only when their target file can be identified unambiguously.
  db.exec(`UPDATE batch_applications SET reply_file_id=(
    SELECT MIN(rf.id) FROM batch_targets t JOIN reply_files rf ON rf.reply_id=t.reply_id
    JOIN batch_files bf ON bf.section_id=t.section_id
    WHERE bf.id=batch_applications.file_id AND t.item_id=batch_applications.item_id AND rf.original_name=bf.filename
    HAVING COUNT(*)=1
  )`);
}
if (!db.prepare('PRAGMA table_info(batch_files)').all().some((c) => c.name === 'source_path')) db.exec('ALTER TABLE batch_files ADD COLUMN source_path TEXT');

if (!db.prepare('PRAGMA table_info(send_attempts)').all().some((c) => c.name === 'pending_phase')) db.exec('ALTER TABLE send_attempts ADD COLUMN pending_phase TEXT');

// Mode assign Mention/React (poin revisi) — udah 2x pindah tempat sepanjang development:
// items.artist_mode (per-item) -> artist_presets.mode (per-artis) -> artist_assign_mode (GLOBAL,
// final). Kolom/tabel lama dibiarin nganggur di DB dev yang sempat kena migrasi itu (DROP COLUMN
// beresiko, gak worth-it buat kolom mati doang) — TIDAK dipakai kode manapun lagi.

module.exports = { db, dataDir };
