# Panduan Project — Slack Intake Apps

> Dokumen ini adalah ringkasan menyeluruh: apa aplikasi ini, konsep dasarnya, apa yang sudah
> dan belum dikerjakan, plus panduan install/build. Diperbarui 2026-09-23, versi app `0.3.10`.
> Untuk detail teknis mendalam per fitur lihat [rancangan-desain.md](rancangan-desain.md)
> (log desain) dan [CARA-TES-BEDAH-COMMAND-BUILDER.md](CARA-TES-BEDAH-COMMAND-BUILDER.md)
> (checklist tes manual per fitur, sangat panjang/detail).

## 1. Apa aplikasi ini

**Slack Intake Apps** adalah aplikasi desktop (Electron + React/TypeScript, Windows & macOS)
buat Koordinator/SPV Herald Entertainment mengirim thread task produksi ke Slack — mention
artis, lampirkan file, kirim reply — **atas nama akun Slack asli Koor itu sendiri** (User OAuth
Token), bukan sebagai bot.

**Kenapa dibikin (gantiin HejBot, bot Google Apps Script lama):**
- Pesan HejBot tercatat sebagai "App" di Slack, bukan Koor yang bersangkutan.
- GAS punya timeout 6 menit/eksekusi + quota harian — hilang total begitu pindah ke app lokal.
- Bagian dari migrasi besar Herald Entertainment ke Prod.Breakdown → Leadsheet → Prod.Tracker +
  Slack Intake yang saling terhubung — dirancang bisa dikembangkan lebih lanjut, bukan sistem
  tertutup.

**Basis referensi:** UI/alur kerja diambil dari *Command Builder* (web app GAS lama), logika
kirim Slack awal diambil dari `../Phase 0/` (POC yang sudah terbukti jalan, masih ada di
workspace ini sebagai arsip/referensi — folder terpisah, aplikasi berbeda, jangan tertukar).

**Siapa penggunanya:** Koordinator/SPV (bukan animator/artis — mereka cuma penerima
mention/file/reaction di Slack).

## 2. Konsep dasar / fundamental

Baca bagian ini dulu sebelum menyentuh kode — banyak keputusan desain yang gak keliatan dari
membaca 1 file doang.

### 2.1 Arsitektur

- **Electron 2 proses**: `electron/main.cjs` (Node, akses penuh: SQLite, filesystem, Slack API)
  dan renderer (React 18 + TypeScript + Vite, di `src/`) yang **tidak** boleh akses Node/OS
  langsung — semua lewat `electron/preload.cjs` (contextBridge, `contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`).
- **Setiap panggilan IPC punya guard `validateAccess`** di main.cjs — mengecek ID yang dikirim
  renderer benar-benar milik project/item/reply akun yang sedang login (`ownsProject`,
  `ownsItem`, `ownsReply`, dst di `projects.cjs`). Ini lapisan pertahanan kalau ada bug UI yang
  mengirim ID yang salah — jangan pernah hilangkan validasi ini demi "mempercepat" fitur baru.
- **Data 100% lokal per-device** — SQLite (`node:sqlite` bawaan Node, di `electron/db.cjs`),
  tidak ada server/backend pusat. Konsekuensi: Message Log, status online/offline, dst semuanya
  **per-device**, tidak lintas-Koor (lihat §4 "Software Admin" di bawah).
- **Auth**: Slack OAuth 2.0 dengan **PKCE** (sudah diaktifkan, bukan lagi "confidential client")
  — artinya **tidak ada `SLACK_CLIENT_SECRET` yang perlu didistribusikan** ke instalasi mana pun
  lagi. Redirect pakai custom URI scheme `slackintakeapps://callback` (bukan
  `http://localhost`, itu ditolak kebijakan distribusi Slack). Token disimpan terenkripsi lewat
  Electron `safeStorage` (OS keychain), auto-refresh kalau expired (lihat `slack.cjs`
  `refreshAccessToken`).

### 2.2 Model data inti

- **Project** → punya `channel_id`/`channel_name` tujuan, `phase` (`setup` atau `input` — one-way
  door, sekali pindah ke `input` gak bisa balik ke `setup` lagi karena item sudah mulai kekirim
  ke Slack), owner (`user_id`+`team_id`, buat pisah data antar akun/workspace di device yang
  sama).
- **Item** → 1 task produksi = 1 Slack thread (`*nama item*` sebagai pesan root). Punya
  `artists` (multi-artist), `status` (dari Status Preset), `has_thread` (udah pernah kekirim atau
  belum).
- **Reply** (field) → unit konten di dalam thread sebuah item: teks + file sekaligus (1 field
  bisa isi keduanya). Field yang **sudah terkirim ke Slack dikunci read-only**
  (`sent_at`/`reply.sent`) — gak bisa diedit lagi karena Slack gak ikut ke-update. Field terkunci
  sekarang punya tombol **"buka gembok"** (unlock) buat override manual kalau ternyata field itu
  gagal terkirim (lihat §3, fitur terbaru).
- **Thread identity**: `(item_name_key, channel_id)` — item yang tujuannya diganti (override
  channel di Slack View Preview) dianggap thread BARU, bukan menimpa thread lama.

### 2.3 Alur kirim ke Slack (4 fase, `send:start`)

Kirim batch jalan **per-fase lintas semua item terpilih** (bukan per-item semua fase dulu baru
pindah item berikutnya): 1) pesan root semua item dulu, 2) assign artis (mention/react) semua
item, 3) react lain (Add React manual), 4) reply/file lain per item. Item yang gagal di 1 fase
di-skip di fase-fase berikutnya (gak nge-block item lain), ditandai gagal di ringkasan akhir,
bisa dicoba lagi manual.

**Instant Intake** (`send:quick`) = kirim langsung 1 aksi klik, scope sebagian (`item`/
`artist`/`replies`/`field`) — dipakai overlay pesawat di kolom tabel atau tombol kirim per-field
di Drawer. Filosofinya beda dari batch: "isi TERKINI selalu benar", jadi lebih longgar soal
retry (lihat komentar `resolveAttempt` di `slack.cjs`).

**Field/post independen** (poin revisi terbaru) — tiap field (attach + tiap reply) sekarang
dikirim lewat panggilan Slack API **terpisah**, bukan digabung 1 array. Kalau 1 field gagal
(misal hasil pecahan Merge >10 file), field lain TETAP dicoba dan field yang sukses TETAP
di-lock — gak ada lagi 1 field gagal bikin field lain ikut ke-skip atau salah ke-lock.

### 2.4 Sistem Owner / Admin / Member

**Ini SERING disalahpahami — role ditentukan oleh AKUN SLACK yang login, BUKAN oleh installer
atau akun Windows.** Semua orang pakai installer yang SAMA persis.

- **Owner** = akun Slack dengan email tertentu (hardcoded di `electron/adminAccess.cjs`,
  `OWNER_EMAIL`). Owner bisa buka menu "Manage Member Admin" (undang/cabut anggota channel privat
  `#hb-adm`).
- **Admin Member** = siapa pun yang jadi anggota channel privat Slack bernama `hb-adm` (dicek
  lewat `users.conversations` — channel privat cuma nongol ke anggotanya sendiri, jadi keanggotaan
  channel INI yang jadi "database" access control, bukan data custom di app). Admin member
  otomatis dapat akses: toggle Sync Realtime, Otomasi Kata Kunci, ganti App-Level Token Slack
  Socket Mode.
- **User biasa** = siapa pun yang login tapi BUKAN owner dan BUKAN anggota `#hb-adm` — cuma bisa
  akses fitur inti (bikin project, kirim item, dst), gak lihat menu admin sama sekali.
- Setelah ditambah/dicabut dari channel admin, **user itu harus logout lalu login ulang** biar
  app scan ulang keanggotaannya (`adminAccess.invalidateCache()` dipanggil otomatis saat
  login/logout).

### 2.5 Sync Realtime & Otomasi (fitur besar, ditambah sesi ini)

- **Sync 2 arah reaction** (Slack → App): react/lepas react MANUAL di Slack pakai emoji yang
  cocok `code_name` preset Artis/Status → otomatis assign artis / set status di app. Butuh Socket
  Mode (App-Level Token `xapp-...`, diisi admin lewat modal "Sync & Otomasi Slack").
  Toggle ON/OFF di `artistRealtimeAssign`.
- **Otomasi Kata Kunci** (`KeywordAutomationModal`) — user bikin mapping "kata kunci di reply
  thread item" → "set status ATAU assign artis", dieksekusi tiap ada pesan Slack yang cocok
  lewat koneksi Socket Mode yang sama. OFF by default.
- Keduanya numpang **1 koneksi WebSocket** yang sama (`electron/slackSocket.cjs`) — App-Level
  Token itu rahasia level WORKSPACE APP (beda dari token OAuth login per-user), sengaja gak lewat
  proses build/installer, diisi manual sekali oleh admin di device masing-masing.

## 3. Yang sudah dikerjakan (highlight, bukan daftar lengkap)

Fitur v1 sudah mendekati full-parity Command Builder (generate item, merge, bulk paste, undo/
redo, template, capture gambar/video/PDF, hyperlink preset, dsb — lihat pemetaan lengkap di
`rancangan-desain.md` §4). Yang ditambahkan/diperbaiki setelah v1:

- **Sistem Admin/Member** berbasis channel privat (§2.4).
- **Sync Realtime 2 arah + Otomasi Kata Kunci** (§2.5).
- **Migrasi emoji picker** dari library vendor (`mr-emoji`, sudah dihapus total) ke `emoji-mart` +
  **Preset Emoji custom** (upload PNG lokal ala custom emoji Slack).
- **Batch File**: cap 10 file per field (lebih dari itu otomatis jadi field baru), tombol Reset
  yang membersihkan total pilihan/upload (bukan cuma koneksi ke item).
- **Merge item**: reply gabungan yang lewat 10 file dipecah otomatis jadi reply baru; field
  independen saat kirim (§2.3).
- **Tombol "buka gembok"** per-field (baru) — override manual reply yang terlanjur terkunci
  padahal gagal terkirim.
- **27 temuan audit eksternal diperbaiki** (`AUDIT_PROJECT_2026-09-20.md`, temuan D01–D18/
  U01–U05/Q01–Q03) — mencakup: identitas thread & assign message per channel, kunci reply gak
  tertimpa broadcast/restore, auto-retry token Slack expired di tengah batch, race pacing
  paralel, socket gagal start gak dianggap "running", guard admin di semua handler sensitif,
  smoke test gak lagi mengubah registry OS, serta rangkaian perbaikan aksesibilitas (dialog/
  keyboard/aria-label) dan kontrol video yang overflow di window minimum (900×600).
- **alert() native yang mengganggu diganti toast** non-blocking untuk kegagalan fetch channel/
  user Slack (timeout dsb tetap bisa terjadi kalau koneksi lambat, tapi UI gak lagi ke-block).
- Total **113 automated regression test** (`node test/regression.cjs`) + 1 smoke test Electron
  sungguhan (`npm run test:smoke`) — semua lulus per commit terakhir.

## 4. Yang BELUM dikerjakan / rencana ke depan

### 4.1 Sengaja ditunda/tidak dipilih (keputusan desain, bukan bug)

- **Software Admin lintas-device** — app terpisah buat lihat aktivitas SEMUA Koor lintas device
  (log tiap user, siapa online, dll). Butuh server/backend pusat — app sekarang murni lokal
  per-device, gak ada server sama sekali. Ini **perubahan arsitektur besar**, bukan fitur
  tambahan biasa — perlu dibahas ulang dari nol (server di mana, siapa yang akses, data apa yang
  dikirim) kalau saatnya tiba.
- Dari Command Builder, **sengaja tidak diadopsi**: Mode kirim alternatif, Find, Zoom, Tema,
  Text Command.
- **Capture Teks** — rencana diintegrasikan dari software lain milik user, bukan dibangun native
  di sini.
- Auto-update: mekanisme cek-update versi sudah ada (`GITHUB_REPO`/`GITHUB_RELEASES_TOKEN`,
  `updater.cjs`), tapi **auto-download-dan-install belum dirancang** — saat ini cuma
  memberitahu ada versi baru, user download manual dari GitHub Release.

### 4.2 Risiko yang diketahui tapi belum dikonfirmasi sebagai bug pasti

(dari `AUDIT_PROJECT_2026-09-20.md`, bagian "Risiko tambahan" — belum ada reproduksi pasti,
tapi layak diperhatikan kalau muncul laporan terkait)

1. **Memori file besar** — export/duplicate project menyusun base64 seluruh attachment + JSON
   di memori sekaligus; preview video baca seluruh file lewat Blob + auto-detect FPS baca lagi.
   Belum di-stress-test dengan file produksi berukuran besar (video/PSD gede). Perbaikan yang
   tepat: streaming/chunking, BUKAN menurunkan batas file yang sudah diminta user.
2. **Preview gagal kurang jelas** — `useFileBlobUrl` return null + `console.error` doang kalau
   baca file gagal (file hilang/permission denied/corrupt/>500MB); beberapa layar bisa
   terlihat "loading terus" tanpa pesan jelas ke user.
3. **`GITHUB_RELEASES_TOKEN` ikut ter-bundle** ke `runtime-config.json` dalam installer kalau
   env terisi (buat fitur cek-update baca repo GitHub privat). Token bisa dibaca siapa pun yang
   install app-nya sendiri. Scope token HARUS fine-grained PAT (Contents: Read-only, scoped ke
   repo `slack-intake-apps` doang) — sudah didokumentasikan, tapi validasi scope aktual di token
   yang benar-benar dipakai belum diverifikasi ulang.
4. **Lifecycle logout** — logout belum menghentikan koneksi Socket Mode atau mereset semua cache
   status HB/admin secara menyeluruh (D18 sudah menutup celah cache admin, tapi race
   refresh-token/job Pull-Push yang masih berjalan pas pergantian akun belum diuji khusus).
5. **Pull replay keyword** — "Pull manual" (Slack → App) replay SELURUH histori reply tanpa
   checkpoint; keyword lama berpotensi menimpa status yang sudah diubah manual belakangan. Perlu
   keputusan produk dulu (prioritas reaction manual vs histori keyword) sebelum ada fix.
6. **Performa skala** — `getProject` melakukan banyak query per item/reply; `releaseUndo`
   menyisir storage attachment secara sinkron; tabel render semua baris sekaligus (PDF sudah
   punya virtualisasi, tabel item belum). Belum diukur di project dengan ribuan item/file.

### 4.3 Dokumen lama yang belum direview ulang sesi ini

File-file di root workspace (`../AUDIT_REPORT.md`, `AUDIT_REPORT_2026-09-16.md`,
`AUDIT_STATUS_2026-09-17.md`, `REMEDIATION_REPORT.md`, `SECURITY_AUDIT_2026-09-17.md`) semuanya
sudah **SUPERSEDED** oleh `AUDIT_PROJECT_2026-09-20.md` (yang 27 temuannya sudah diperbaiki semua
di sesi ini) — dipertahankan sebagai riwayat/arsip, bukan status terkini. Tidak perlu dibaca
ulang kecuali untuk konteks sejarah keputusan (mis. kenapa PKCE diadopsi, kenapa `#hb-adm`
harus privat).

## 5. Cara install & jalankan (development)

```bash
git clone https://github.com/diyanhejak-hash/slack-intake-apps.git
cd slack-intake-apps
npm install
cp .env.example .env   # isi SLACK_CLIENT_ID (App Slack yang sama dipakai Phase 0, PKCE aktif)
npm run dev             # Vite dev server + Electron, hot-reload renderer
```

**Catatan penting** (sering bikin bingung pas testing versi dev): perubahan di file **renderer**
(`src/**`) auto-reload lewat Vite HMR. Perubahan di file **Electron main process**
(`electron/main.cjs`, `electron/*.cjs`, `electron/preload.cjs`) **TIDAK** ikut hot-reload —
harus matikan (`Ctrl+C`) dan `npm run dev` ulang dari awal biar kepakai.

Verifikasi sebelum commit/build: `npm run check` (typecheck + 113 regression test + smoke test
Electron sungguhan + build renderer — persis yang dipakai CI).

## 6. Cara build & install installer lokal (Windows)

```bash
npm run build:win
```

Hasilnya: `release/Slack Intake Apps Setup <versi>.exe` (~135 MB, NSIS installer).

**Ini installer PER-USER** (`oneClick: true, perMachine: false` — default electron-builder,
tidak ada admin rights yang dibutuhkan): terpasang ke `%LOCALAPPDATA%\Programs\Slack Intake
Apps` milik akun Windows yang menjalankan installer, data app (`%APPDATA%\Slack Intake Apps`)
juga per-akun-Windows.

### "Instalasi untuk owner/admin" vs "instalasi untuk user biasa" — TIDAK butuh installer beda

Karena role ditentukan oleh **akun Slack yang login** (§2.4), bukan oleh installer:

- **1 installer yang sama** dipakai semua orang, termasuk owner.
- Untuk **test kedua role di 1 PC yang sama** secara bergantian: install sekali, lalu logout/
  login-ganti akun Slack di dalam app itu sendiri (Start Menu → menu akun) — tidak perlu
  install ulang atau bikin akun Windows baru.
- Untuk test **kedua role BERSAMAAN** (dua window kebuka sekaligus, dua akun Slack login
  bersamaan): app data tersimpan per-akun-Windows, jadi butuh **2 akun Windows lokal berbeda**
  di PC yang sama, masing-masing jalankan installer yang sama sendiri-sendiri (otomatis dapat
  folder data terpisah). Tidak ada build/installer khusus "versi owner" — kalau suatu saat
  benar-benar dibutuhkan mode ini secara rutin, itu permintaan fitur baru (multi-profile dalam 1
  window), bukan sekadar config build.

## 7. Cara rilis resmi (GitHub, otomatis build Win + Mac)

Sudah ada pipeline CI (`.github/workflows/release.yml`) yang otomatis build **Windows DAN
macOS sekaligus** begitu tag versi baru di-push (macOS gak bisa dibuild dari mesin Windows lokal
— ini satu-satunya jalur dapat installer Mac):

```powershell
$version = (Get-Content package.json | ConvertFrom-Json).version
git tag "v$version"
git push origin "v$version"
```

Pipeline menjalankan `npm run check` (sama seperti lokal) lalu publish installer sebagai GitHub
Release kalau lulus. Bisa juga dipicu manual tanpa tag lewat tab **Actions → Build & Release →
Run workflow** (build jalan tapi publish di-skip otomatis karena bukan tag).

Secrets yang dibutuhkan sudah dikonfigurasi di GitHub repo settings (`SLACK_CLIENT_ID`,
`SLACK_REDIRECT_URI`, `RELEASE_REPO`, `RELEASES_TOKEN`) — tidak perlu diisi ulang kecuali App
Slack diganti.

## 8. Repo & status GitHub

- Repo: https://github.com/diyanhejak-hash/slack-intake-apps (privat).
- Semua commit sesi ini (sistem Admin/Member, Sync Realtime, migrasi emoji-mart, 27 perbaikan
  audit, fitur buka-gembok, dsb) sudah di-push ke `master`.
