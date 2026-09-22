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

-- Cache direktori Slack dipisah total dari preset/assignment artis. Profil disimpan per
-- workspace; keanggotaan disimpan per workspace+channel dan cuma dipakai sebagai filter UI.
CREATE TABLE IF NOT EXISTS slack_user_cache (
  team_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  avatar TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS slack_channel_member_cache (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (team_id, channel_id, user_id)
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
  image_path TEXT,
  -- Karakter emoji standar (poin revisi) -- CUMA keisi kalau preset-nya emoji unicode biasa
  -- (bukan custom/PNG), biar tetep kepreview beneran abis reload (bukan cuma teks shortcode-nya
  -- doang). image_path dan kolom ini mutually exclusive (satu keisi, satunya null).
  unicode_value TEXT
);

-- Mode assign Mention/React (poin revisi — GLOBAL buat SEMUA artis, bukan per-artis/per-item
-- lagi). Singleton 1 baris (id selalu 1). Riwayat: mode TEXT tunggal ('mention'|'react'|'both'|
-- 'none') -> disederhanain jadi mutually-exclusive ('mention'|'react'|'none', 'both' dihapus) ->
-- poin revisi TERBARU: balik lagi bisa DUA-duanya aktif bareng, sekarang 2 flag independen
-- (mention_enabled/react_enabled) bukan 1 kolom mode lagi. Kolom mode (TEXT) lama DIBIARIN
-- nganggur (pola migrasi yang sama kayak di tempat lain file ini) — kode baru gak baca dari situ lagi.
CREATE TABLE IF NOT EXISTS artist_assign_mode (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'mention',
  mention_enabled INTEGER NOT NULL DEFAULT 1,
  react_enabled INTEGER NOT NULL DEFAULT 0,
  multi_enabled INTEGER NOT NULL DEFAULT 1
);
-- Cuma kolom LAMA (id, mode) di INSERT ini (poin revisi, bug: "table has no column named
-- mention_enabled") -- di DB yang UDAH ADA dari sebelum kolom baru ini, CREATE TABLE IF NOT
-- EXISTS di atas jadi NO-OP (tabelnya udah ada), jadi kolom mention_enabled/react_enabled BELUM
-- tentu ada di titik ini -- baru ditambah nanti lewat ALTER TABLE migrasi di bawah file ini.
-- DB fresh: kolom itu udah kebentuk dari CREATE TABLE barusan dengan DEFAULT yang bener (1/0).
INSERT OR IGNORE INTO artist_assign_mode (id, mode) VALUES (1, 'mention');

-- Toggle global matiin Instant Intake + Instant Reaction di SEMUA tab/sesi (poin revisi) — TIDAK
-- mempengaruhi tombol "Add React" (ItemReactionBar), cuma QuickSendButton + InstantReactionOverlay.
-- Singleton 1 baris, pola sama kayak artist_assign_mode. Default OFF (poin revisi, diminta user)
-- -- cuma ngefek instalasi/DB BARU, install yang udah ada TETAP pilihan mereka sendiri.
CREATE TABLE IF NOT EXISTS instant_intake_setting (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO instant_intake_setting (id, enabled) VALUES (1, 0);

-- Otomasi Kata Kunci (poin revisi — awalnya hardcode "@WIP" -> status "Working on it" doang,
-- digeneralisasi jadi preset bebas: user tentuin sendiri kata kunci apa aja + target-nya (Status
-- ATAU Artis)). Kata kunci diketik SIAPA PUN sebagai reply di thread item -- otomatis set status
-- ITU atau assign artis ITU ke item-nya. Butuh Socket Mode (sama App-Level Token kayak sync 2
-- arah reaction) + event message.channels/message.groups di-subscribe. Toggle master OFF by
-- default (singleton, pola sama instant_intake_setting) -- gak ngefek apa pun walau ada baris di
-- keyword_automations kalau togglenya OFF. 1 keyword BOLEH punya beberapa baris (misal kata yang
-- sama mau trigger status DAN artis sekaligus) -- makanya bukan UNIQUE, gak ada batasan gitu.
CREATE TABLE IF NOT EXISTS keyword_automation_setting (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO keyword_automation_setting (id, enabled) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS keyword_automations (
  id TEXT PRIMARY KEY,
  keyword TEXT NOT NULL,
  target_type TEXT NOT NULL, -- 'status' | 'artist'
  target_id TEXT NOT NULL,   -- status_presets.id (target_type='status') ATAU Slack member_id (target_type='artist')
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Multi-artist per item (poin revisi) — items.artist_id/artist_name (singular, di atas) DIBIARIN
-- nganggur (pola sama kayak catatan migrasi assign-mode di bawah file ini), diganti tabel
-- many-to-many ini. UNIQUE(item_id, artist_id) — 1 artis gak boleh keassign dobel di item yang
-- sama (dropdown/chip toggle ngandelin ini buat nentuin add vs remove).
CREATE TABLE IF NOT EXISTS item_artists (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  artist_id TEXT NOT NULL,
  artist_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (item_id, artist_id)
);

-- Preset Status (poin revisi, fitur "Status" per item) — GLOBAL, daftar bebas (bukan 1 per
-- member kayak artist_presets), tiap baris punya nama tampilan + code_name (shortcode custom
-- emoji Slack buat reactions.add). PNG opsional cuma buat preview lokal, sama pola artist_presets.
CREATE TABLE IF NOT EXISTS status_presets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code_name TEXT NOT NULL,
  image_path TEXT,
  -- Sama alasan kayak artist_presets.unicode_value -- preview emoji standar biar gak balik jadi
  -- teks shortcode doang abis disimpan/reload.
  unicode_value TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- Status AKTIF per item (poin revisi) — CUMA 1 status per item (dropdown, bukan multi kayak
-- item_artists), dikirim sebagai 1 REACTION di pesan root. sent_shortcode nyimpen shortcode yang
-- LAGI live di Slack SAAT INI (bisa beda dari status_presets.code_name kalau status baru DIGANTI
-- tapi belum sempat di-reconcile ke Slack) -- reconcile baca ulang dua-duanya, hapus reaction lama
-- kalau beda dari yang seharusnya, baru pasang yang baru. SENGAJA tabel terpisah dari item_reactions
-- (bukan digabung) -- reconcileItemAssignState (mode react artis) bersihin SEMUA reaction 'sent'
-- yang gak cocok artis manapun, kalau status ikut nebeng di situ bisa kehapus gak sengaja.
CREATE TABLE IF NOT EXISTS item_status (
  item_id TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
  status_id TEXT REFERENCES status_presets(id) ON DELETE SET NULL,
  sent_shortcode TEXT,
  updated_at TEXT NOT NULL
);

-- Toggle global "sesi assign artis realtime" (poin revisi) — pas ON, tiap tambah/hapus artis di
-- ArtistPicker (Tab Table MAUPUN Tab Reply, satu state yang sama) langsung sinkron ke Slack:
-- mode react -> reactions.add/remove LANGSUNG ke pesan root; mode mention -> chat.postMessage
-- (pertama kali) atau chat.update (abis itu) ke SATU pesan assignment per item, teks-nya daftar
-- @mention terkini (atau "Belum di tugaskan" kalau kosong). Butuh item UDAH PERNAH dikirim (ada
-- thread) — sama persis precondition InstantReactionOverlay, kalau belum ada thread ya error
-- jelas, BUKAN auto-bikin pesan baru. Singleton 1 baris, pola sama kayak instant_intake_setting.
CREATE TABLE IF NOT EXISTS artist_realtime_assign (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  enabled INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO artist_realtime_assign (id, enabled) VALUES (1, 0);

-- Satu pesan "assignment" per item (poin revisi, mode mention) — di-edit di tempat (chat.update)
-- tiap daftar artis berubah, BUKAN post baru/delete tiap kali. Dipakai baik pas realtime ON
-- (edit langsung tiap perubahan) MAUPUN pas fase "artist" di batch kirim biasa (pastiin teksnya
-- akurat sama daftar artis TERKINI saat itu, idempoten -- post kalau belum ada row, update kalau
-- udah ada).
-- PRIMARY KEY (item_id, channel_id) -- poin revisi audit D01, lihat migrasi di bawah kenapa
-- BUKAN item_id doang (assignment kudu ikut channel tujuan TERKINI, bukan channel pertama kali).
CREATE TABLE IF NOT EXISTS item_assign_messages (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  message_ts TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (item_id, channel_id)
);

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

-- Reaction per item (poin revisi) — awalnya PENDING, nunggu "Kirim ke Slack" biasa (urutan:
-- pesan utama -> semua reply -> reaction). Beda dari reaction INSTAN (overlay hover pil item)
-- yang fire-and-forget, gak pernah nyentuh tabel ini sama sekali.
-- Kolom sent (poin revisi, bug dilaporkan: "chip react hilang abis kekirim, ambigu keliatan
-- kayak gak ada react") — baris ini DULU dihapus begitu reactions.add sukses, sekarang DIBIARIN, cuma
-- ditandain sent=1. Chip TETAP kelihatan (beda gaya visual dikit) sebagai cerminan react yang
-- BENERAN ada di Slack — klik chip yang udah sent = reactions.remove beneran ke Slack (lihat
-- itemReaction:remove, main.cjs), BUKAN cuma ilang dari tabel lokal doang.
CREATE TABLE IF NOT EXISTS item_reactions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  emoji_type TEXT NOT NULL, -- 'unicode' | 'custom'
  emoji_value TEXT NOT NULL,
  slack_shortcode TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  sent INTEGER NOT NULL DEFAULT 0
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
// Tahap alur kerja Setup/Input (poin revisi, diminta user; nama lama "Assign") — 'setup' = lagi
// nyusun daftar item (kolom Artis/Status/Pull/Push disembunyiin, belum relevan), 'input' = udah
// nugasin artis/status/reply (kolom lengkap muncul, tombol "Kirim ke Slack" diganti Pull/Push/
// Toggle). DEFAULT 'input' di ALTER TABLE ini SENGAJA beda dari default project BARU ('setup',
// lihat projects.cjs createProject) -- project yang UDAH ADA sebelum kolom ini ditambah harus
// TETAP kelihatan lengkap (gak boleh tiba-tiba ke-sembunyiin Artis/Status/Pull/Push punya user).
if (!projectColumns.includes("phase")) db.exec(`ALTER TABLE projects ADD COLUMN phase TEXT NOT NULL DEFAULT 'input'`);

// sent_at (poin revisi, diminta user) — field/reply yang UDAH PERNAH kekirim ke Slack dikunci
// read-only di Tab Input (isi Slack gak ikut ke-update kalau diedit belakangan, lihat diskusi
// rename item yang gak nyampe ke pesan root). NULL = belum pernah kekirim.
const replyColumns = db.prepare(`PRAGMA table_info(replies)`).all().map((c) => c.name);
if (!replyColumns.includes("sent_at")) db.exec(`ALTER TABLE replies ADD COLUMN sent_at TEXT`);
// Identitas akun Slack yang benar-benar mengirim field. Field lama tetap NULL; getProject()
// memberi fallback ke akun aktif supaya UI masih bisa menampilkan pengirim yang masuk akal.
if (!replyColumns.includes("sent_by_user_id")) db.exec(`ALTER TABLE replies ADD COLUMN sent_by_user_id TEXT`);

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

// Poin revisi (bug ditemukan lewat audit, D01) — item_assign_messages PK dulu item_id DOANG,
// gak keyed sama channel kayak threads (item_name+channel_id). Kalau item pernah kekirim ke CA
// terus tujuan diganti ke CB (mis. override channel di Slack View Preview), pesan assign lama di
// CA tetap ke-chat.update -- CB gak pernah dapet pesan assign-nya sendiri. Migrasi PK jadi
// (item_id, channel_id), sama pola persis kayak threads di atas.
const assignMsgPk = db.prepare(`PRAGMA table_info(item_assign_messages)`).all().filter((c) => c.pk).map((c) => c.name);
if (assignMsgPk.length === 1 && assignMsgPk[0] === "item_id") {
  db.exec(`
    BEGIN;
    ALTER TABLE item_assign_messages RENAME TO item_assign_messages_legacy;
    CREATE TABLE item_assign_messages (
      item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL,
      message_ts TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (item_id, channel_id)
    );
    INSERT INTO item_assign_messages (item_id, channel_id, message_ts, updated_at) SELECT item_id, channel_id, message_ts, updated_at FROM item_assign_messages_legacy;
    DROP TABLE item_assign_messages_legacy;
    COMMIT;
  `);
}

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

if (!db.prepare('PRAGMA table_info(item_reactions)').all().some((c) => c.name === 'sent')) db.exec('ALTER TABLE item_reactions ADD COLUMN sent INTEGER NOT NULL DEFAULT 0');

// unicode_value (poin revisi, bug dilaporkan: "abis Simpan, emoji standar balik jadi teks kode
// nama lagi") -- preset emoji unicode biasa (bukan custom/PNG) gak punya cara kesimpen buat
// dipreview ulang abis reload, cuma code_name (shortcode) doang. status_presets baru dibikin
// SESI INI JUGA (bukan lama), tapi tetep butuh migrasi ALTER TABLE (bukan cuma edit CREATE TABLE
// di atas) -- kalau usernya UDAH sempat jalanin app abis tabel ini ada, CREATE TABLE IF NOT
// EXISTS bakal no-op, kolom baru gak pernah nambah (pola bug yang sama kayak artist_assign_mode).
if (!db.prepare('PRAGMA table_info(artist_presets)').all().some((c) => c.name === 'unicode_value')) db.exec('ALTER TABLE artist_presets ADD COLUMN unicode_value TEXT');
if (!db.prepare('PRAGMA table_info(status_presets)').all().some((c) => c.name === 'unicode_value')) db.exec('ALTER TABLE status_presets ADD COLUMN unicode_value TEXT');

// Poin revisi: mention_enabled/react_enabled (2 flag independen, GANTI kolom `mode` tunggal) --
// migrasi sekali dari `mode` lama biar preferensi yang udah diset gak ilang begitu app di-update.
if (!db.prepare('PRAGMA table_info(artist_assign_mode)').all().some((c) => c.name === 'mention_enabled')) {
  db.exec('ALTER TABLE artist_assign_mode ADD COLUMN mention_enabled INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE artist_assign_mode ADD COLUMN react_enabled INTEGER NOT NULL DEFAULT 0');
  db.exec(`UPDATE artist_assign_mode SET mention_enabled = CASE WHEN mode = 'mention' THEN 1 ELSE 0 END, react_enabled = CASE WHEN mode = 'react' THEN 1 ELSE 0 END WHERE id = 1`);
}
if (!db.prepare('PRAGMA table_info(artist_assign_mode)').all().some((c) => c.name === 'multi_enabled')) {
  db.exec('ALTER TABLE artist_assign_mode ADD COLUMN multi_enabled INTEGER NOT NULL DEFAULT 1');
}

// Mode assign Mention/React (poin revisi) — udah 2x pindah tempat sepanjang development:
// items.artist_mode (per-item) -> artist_presets.mode (per-artis) -> artist_assign_mode (GLOBAL,
// final). Kolom/tabel lama dibiarin nganggur di DB dev yang sempat kena migrasi itu (DROP COLUMN
// beresiko, gak worth-it buat kolom mati doang) — TIDAK dipakai kode manapun lagi.

// Migrasi sekali jalan: items.artist_id/artist_name (singular, lama) -> item_artists (banyak,
// poin revisi multi-artist). INSERT OR IGNORE + guard UNIQUE(item_id,artist_id) bikin ini aman
// dijalanin ulang tiap start app (no-op kalau udah pernah kemigrasi). Kolom lama TETAP DIBIARIN
// nganggur (pola sama kayak migrasi assign-mode di atas), kode baru gak baca dari situ lagi.
db.exec(`
  INSERT OR IGNORE INTO item_artists (id, item_id, artist_id, artist_name, sort_order)
  SELECT lower(hex(randomblob(16))), id, artist_id, artist_name, 0 FROM items WHERE artist_id IS NOT NULL AND artist_id != ''
`);

module.exports = { db, dataDir };
