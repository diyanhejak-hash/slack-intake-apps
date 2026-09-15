# Rancangan — Slack Intake Apps

Log diskusi desain untuk software pengganti "Slack Intake POC" (`../Phase 0/`), dibuat lebih lengkap & bisa di-install banyak Koordinator/SPV di Windows & macOS. Diperbarui tiap ada keputusan baru — bukan spec statis.

## Konteks & tujuan

- **Referensi UI/fitur utama: Command Builder** ([`HB to V5/Web App`](../../Other/HB%20to%20V5/Web%20App)). **Reframe penting (2026-09-14): Slack Intake Apps pada dasarnya adalah migrasi Command Builder ke aplikasi lokal (Electron), bukan sekadar "POC + beberapa fitur HB5 pilihan".** Alur kerja, fitur, dan UI diambil dari Command Builder — penyesuaian yang dilakukan murni karena konteks lokal (bukan web app GAS dua-project lagi), plus ada hal spesifik yang disempurnakan atau dihilangkan (dicatat progresif di bawah tiap kali muncul, lihat "Pemetaan fitur Command Builder" di poin 4).
- **Referensi perilaku bot**: [HB5 bot (`Code.js`)](../../Other/HB%20to%20V5/HB%20v4%20+%20Web%20App%20Integration) — jadi acuan perilaku pengiriman Slack (thread, mention, reply, file), tapi bukan referensi arsitektur backend. Slack Intake Apps **tidak** replikasi job queue/GAS-nya — app lokal manggil Slack API langsung (lihat insight di poin 2).
- **Basis kode awal**: [Phase 0](../Phase%200) — POC yang sudah terbukti jalan (OAuth user token, `chat.postMessage` + `files.uploadV2` sebagai thread, `data/threads.json` buat konsistensi reply). Logika inti (`lib/slack-send.js`, `lib/slack-login.js`) jadi starting point teknis buat komunikasi ke Slack, sementara UI/alur kerja ikut Command Builder.
- **Target platform**: Electron, harus jalan di Windows & macOS, didistribusikan sebagai installer ke Koor lain (bukan cuma dijalankan dari source seperti Phase 0).

## Keputusan yang sudah diambil (2026-09-14)

### Setup & koneksi Slack
- **Satu Slack App shared**, Client ID + Client Secret **di-embed di dalam aplikasi** (bukan diisi manual tiap Koor seperti Phase 0). Trade-off yang diterima: secret bisa diekstrak dari binary oleh yang niat — acceptable untuk tool internal 1 workspace (Herald Entertainment), bukan app publik multi-tenant.
- Alur login tetap OAuth browser flow (mirip `Phase 0/lib/slack-login.js`): klik "Login ke Slack" → browser terbuka → authorize → redirect ke `localhost:<port fixed>/callback` → token tertangkap otomatis. Koor tidak perlu isi Client ID/Secret/port sama sekali.
- Token disimpan via **Electron `safeStorage`** (encrypted, pakai OS keychain di belakang layar) — bukan `token.json` plain text seperti Phase 0.

### Distribusi
- Packaging pakai `electron-builder` → `.exe`/NSIS (Windows), `.dmg`/`.app` (macOS).
- **macOS: unsigned, gratis** (bukan daftar Apple Developer Program $99/tahun). Konsekuensi: tiap install & tiap versi baru, user Mac harus klik kanan → Open sekali (warning "unidentified developer"). Diterima karena user butuh gratis dan tim Mac terbatas.
- Auto-update otomatis **belum diputuskan/dirancang** — dicatat sebagai gap, bukan blocker sekarang.

### Struktur folder (workspace ini)
```
Slack Intake Local user\        ← root workspace, tidak diubah namanya
├── Phase 0\                    ← POC lengkap (arsip/referensi, masih bisa dipakai buat kirim batch episode)
└── Slack Intake Apps\          ← project baru, di folder inilah dibangun
```

## Kerangka rancangan (dibahas satu per satu)

Status: ⬜ belum dibahas · 🟨 sebagian (ada keputusan terkait tapi belum lengkap) · ✅ selesai

| # | Yang dibahas | Pertanyaan utama | Status |
|---|---|---|---|
| 1 | Tujuan aplikasi | Masalah apa yang diselesaikan? Siapa penggunanya? Apa ukuran keberhasilannya? | ⬜ |
| 2 | Ruang lingkup versi pertama | Fitur apa yang wajib tersedia? Apa yang bisa ditunda? | ✅ (lihat pemetaan lengkap di poin 4 — hampir full parity Command Builder) |
| 3 | Alur penggunaan | Dari membuka aplikasi sampai menyelesaikan pekerjaan, pengguna melakukan apa? Bagaimana jika terjadi kesalahan? | ✅ |
| 4 | Struktur layar | Layar apa saja yang dibutuhkan? Bagaimana navigasi dan susunan informasinya? | ✅ |
| 5 | Data dan penyimpanan | Data apa yang disimpan? Lokal atau server? Perlu offline, sinkronisasi, ekspor, dan backup? | ✅ |
| 6 | Kebutuhan desktop | Windows saja atau juga macOS/Linux? Perlu tray, notifikasi, shortcut, akses file, atau berjalan di latar belakang? | ✅ |
| 7 | Arsitektur dan keamanan | Bagian mana mengurus tampilan, operasi sistem, dan komunikasi server? Bagaimana akses sensitif dibatasi? | ✅ |
| 8 | Tampilan dan interaksi | Bagaimana gaya visual, ukuran teks, feedback, serta kondisi loading, kosong, dan error? | ✅ |
| 9 | Distribusi dan pemeliharaan | Bagaimana instalasi, pembaruan, laporan error, dan pemulihan data dilakukan? | ✅ |
| 10 | Kriteria selesai | Perilaku apa yang harus terbukti berjalan? Berapa target waktu buka dan penggunaan memori? | ✅ |

Isi tiap poin ditulis sebagai subbab di bawah begitu selesai dibahas.

---

## 1. Tujuan Aplikasi ✅

**Masalah yang diselesaikan:** Mengganti HejBot (bot Slack berbasis Google Apps Script) yang saat ini dipakai Koordinator/SPV untuk membuat Slack thread per item task produksi (mention artis, lampirkan file). Tiga alasan utama gantinya:
- **Identitas asli** — pesan HejBot tercatat sebagai "App", bukan Koor yang bersangkutan. Slack Intake Apps pakai User OAuth Token supaya pesan benar-benar atas nama Koor (sudah diputuskan & terbukti di Phase 0).
- **Keterbatasan Google Apps Script** — timeout 6 menit/eksekusi, quota UrlFetch harian, batas yang mengikuti infra Google. Hilang total begitu pindah ke software lokal (Electron/Node).
- **Arsitektur ke depan** — bukan cuma soal HejBot itu sendiri, tapi bagian dari migrasi besar Herald Entertainment ke Prod.Breakdown → Leadsheet → Prod.Tracker + Slack Intake yang saling terhubung. Dibangun supaya bisa dikembangkan & diintegrasikan ke software lain nantinya, bukan sistem tertutup seperti HejBot.

**Pengguna:** Koordinator/SPV Herald Entertainment (bukan animator/artis — mereka cuma penerima mention/file).

**Ukuran keberhasilan v1:**
- **Cepat & tepat** — pemrosesan instan, tidak nyasar (salah thread/salah kirim).
- **Error jelas** — kalau gagal, Koor tahu persis kenapa, bukan silent fail atau pesan generik.
- **Tidak ada "double limit"** — bebas dari batasan lama ala GAS (ukuran file, kuota harian, timeout) *dan* jangan sampai arsitektur baru malah nambah batasan baru (mis. kalau nanti ada backend/server perantara).

---

## 2. Ruang Lingkup Versi Pertama ✅

**Insight arsitektur kunci:** HB5 *menerima* request dari Slack (slash command) sehingga wajib punya job queue rumit (respons ≤3 detik vs GAS timeout 6 menit). Slack Intake Apps tidak menerima apa-apa dari Slack — app yang memanggil keluar ke Slack API dari UI-nya sendiri. Job queue ala HB5 **tidak diperlukan** — pengurangan besar yang otomatis, bukan pilihan desain.

**Wajib ada (MVP v1):**
- Buat thread (parent message) + mention artis + kirim file — fondasi, sudah ada logikanya di Phase 0 (`lib/slack-send.js`).
- Reply ke thread yang sama untuk item yang sudah ada (revisi/tambahan file) — juga sudah ada di Phase 0 lewat `data/threads.json`.
- **Multi-file per reply** — beda dari HB5 yang hardcode `MULTI_FILE_MAX_PER_REPLY = 5` (batas bisnis arbitrer), Slack Intake Apps ikut **batas asli Slack** apa adanya, bukan angka buatan sendiri. Perlu dicek batas teknis `files.uploadV2` per pesan pas implementasi.
- **Stop/Cancel saat batch berjalan** — jauh lebih simpel dari `/stop_execution` HB5 (yang butuh job lock per-channel di server). Di sini cukup tombol Cancel di UI yang menghentikan loop pengiriman batch lokal saat itu juga.

**Otomatis tidak perlu dibangun (bukan "ditunda", tapi memang tidak relevan):**
- **Edit pesan** — HB5 punya shortcut Edit karena pesannya milik Bot. Di Slack Intake Apps pesan terkirim sebagai akun asli Koor, jadi Koor sudah bisa edit/hapus langsung lewat Slack UI tanpa app terlibat.
- **Command Builder terpisah** — di HB5 itu web app proxy yang beda. Di app desktop, fungsinya otomatis melebur jadi satu UI aplikasi, tidak ada komponen terpisah yang perlu dibangun.

**Sengaja ditunda / di luar scope v1:**
- **Dashboard/filter status task** — sesuai batasan awal Slack Intake sejak POC: baca-balik status task itu tanggung jawab Prod.Tracker nanti, bukan Slack Intake.
- **Notifikasi DM ke artis** (selain mention di channel) — tidak dipilih sebagai wajib v1, bisa ditambah belakangan kalau ternyata dibutuhkan.

**Belum diputuskan (dibahas ulang di poin 5 — Mapping Artis):**
- Auto-fetch artis dari Slack workspace (`users:read`) vs tetap mapping manual seperti Phase 0.

---

## 3. Alur Penggunaan ✅

**Dua mode input, keduanya wajib ada dari awal v1 (bukan salah satu duluan):**

### Mode A — Batch folder (scan otomatis)
Reuse logika `send-batch.js`. Untuk kirim banyak file sekaligus dari 1 folder hasil render — pola pakai yang sudah terbukti dipakai untuk kirim episode.
```
1. Pilih folder → app scan file yang cocok pola nama (HT_EPxx_SCyyy)
2. Tampil daftar preview: nama item hasil parse, file yang match, baru vs reply ke thread lama
3. Koor klik "Kirim Semua" (bisa uncheck item tertentu untuk skip)
4. Progress per item + tombol Cancel
5. Ringkasan hasil akhir: ✅/❌ per item + alasan kalau gagal
```

### Mode B — Manual satu-satu (isi form)
Reuse logika `send-test.js`/form Electron Phase 0. Untuk item dadakan di luar batch render.
```
1. Ketik nama item, pilih artis, pilih file
2. Klik Kirim → langsung terkirim (reply ke thread lama otomatis kalau nama item sudah pernah dikirim)
```

**Kalau 1 item gagal di tengah batch:** lanjut ke item berikutnya, dicatat di ringkasan akhir dengan alasan jelas — batch tidak berhenti total gara-gara 1 error (selaras dengan target "cepat & error jelas" di poin 1).

**Login/setup (sekali di awal pemakaian):** sudah dibahas di "Setup & koneksi Slack" — klik Login sekali, browser authorize, selesai.

> **Catatan:** poin 3 di atas ditulis sebelum reframe "migrasi Command Builder". Konsep Mode A/Mode B (2 tab terpisah) di atas **digantikan** oleh 1 tabel gabungan di poin 4 di bawah — "Import dari Folder" dan "+ Tambah Item" jadi dua cara ngisi tabel yang sama, bukan dua layar terpisah.

---

## 4. Struktur Layar 🟨

**Alur navigasi (mirip Command Builder, disesuaikan konteks lokal):**
```
[Login ke Slack — sekali seumur pakai]
        ↓
[Start Menu] — New Project (pilih channel Slack tujuan) / Load Project (lanjutin yang lama)
        ↓
[Halaman Utama — tabel Item + Artis + Reply preview]
        ↓ (klik baris / kolom Reply)
[Drawer/panel detail per item] — isi reply (teks/file), pilih template
        ↓
[Modal Kirim ke Slack] — ringkasan, pilih mode, konfirmasi
        ↓
progress real-time + tombol Stop → ringkasan hasil akhir
```

### Pemetaan fitur Command Builder → Slack Intake Apps (FINAL, dikonfirmasi user via checklist 2026-09-14)

| Fitur di Command Builder | Status v1 | Catatan |
|---|---|---|
| Start Menu, New/Load Project, autosave | ✅ Masuk v1 | |
| Verifikasi Akun (email + OTP via DM Slack) | ❌ Tidak relevan | Gating multi-user buat web app bersama — app lokal sudah tergate lewat login OAuth Slack per-Koor (poin 7). |
| "Project cuma kelihatan buat pembuatnya sendiri" | ✅ Otomatis | Project tersimpan di disk lokal Koor — privasi per-akun sudah default. |
| Tabel utama (Item, Artis, Reply preview) | ✅ Masuk v1 | Pola inti. |
| Artis autocomplete dari roster (sheet Members di Command Builder) | ✅ Masuk v1, sumber diganti | Dari `users.list` Slack API (`users:read`), bukan Google Sheet. |
| Dropdown Setup → "Grup Artis" custom | ✅ Masuk v1 | Slice/template roster buatan user sendiri. |
| Generate Item | ✅ Masuk v1 | |
| Merge Item | ✅ Masuk v1 | |
| Bulk paste (klik header kolom) | ✅ Masuk v1 | |
| Broadcast per-reply | ✅ Masuk v1 | |
| Template reply (Default/Animation/custom) | ✅ Masuk v1 | |
| Field reply unified (1 field teks+file bareng) | ✅ Masuk v1 | |
| Clear field terpilih (bulk clear) | ✅ Masuk v1 | |
| Copy Paste Upload (drag-drop/paste clipboard) | ✅ Masuk v1 | |
| Rich text editor (bold/italic/hyperlink/list) | ✅ Masuk v1 | |
| Emoji picker + shortcode | ✅ Masuk v1 | |
| Hyperlink Dropdown preset | ✅ Masuk v1 | |
| Advanced Display — video player frame-by-frame | ✅ Masuk v1 | |
| Advanced Display — PDF viewer | ✅ Masuk v1 | |
| Advanced Display — General Display (file referensi statis) | ✅ Masuk v1 | |
| Capture (crop area viewer jadi gambar) | ✅ Masuk v1 | |
| Capture Teks (extract teks dari PDF) | 🔗 Integrasi eksternal | **Bukan dibangun native** — user mau adaptasi dari software lain miliknya yang sudah punya fitur ini. Detail integrasi (nama software, caranya) belum dibahas — follow-up item. |
| Matching Batch File Upload | ✅ Masuk v1 | Ini bentuknya "Import dari Folder" — sudah jadi alur inti sejak awal (`send-batch.js`), bukan fitur tambahan terpisah. |
| Mode kirim (Semua/Thread saja/Reply saja) | ❌ Tidak perlu | Dikonfirmasi user tidak perlu. |
| **Text Command** (preview command mentah `/task_thread`) | ❌ Dihilangkan — arsitektur | Command Builder generate teks command buat bot GAS parse. Slack Intake Apps manggil Slack API langsung, tidak ada "command text" yang di-generate sama sekali. |
| **Slack View** (preview visual sebelum kirim) | ✅ Masuk v1, cara beda | Render preview dari data tabel/drawer langsung, tanpa command-text intermediate. |
| Progress real-time halus per sub-step | ✅ Masuk v1 | |
| Stop Intake | ✅ Masuk v1, disederhanakan | Stop langsung (tanpa countdown 5 detik) — app lokal sync, tidak butuh job-lock server seperti Command Builder/HB5. |
| Hapus File Terkirim (dari Drive) | ❌ Tidak relevan | Command Builder staging file di Google Drive dulu. Slack Intake Apps upload langsung dari disk lokal ke Slack (seperti Phase 0), tidak ada staging yang perlu dibersihkan. |
| Undo/Redo | ✅ Masuk v1 | |
| Find (Ctrl+F) | ⬜ Tidak dipilih untuk v1 | Bisa ditambah belakangan kalau ternyata dibutuhkan. |
| Zoom | ⬜ Tidak dipilih untuk v1 | Bisa ditambah belakangan. |
| Tema terang/gelap | ⬜ Tidak dipilih untuk v1 | Bisa ditambah belakangan. |
| Workload Distribution (chart jumlah item per artis) | ✅ Masuk v1 | **Bukan** "Dashboard" yang dibatasi di poin 2 — itu soal *baca-balik status dari Slack* (real-time, tanggung jawab Prod.Tracker). Chart ini cuma visualisasi data project yang lagi disusun secara lokal, tidak baca apa pun dari Slack. Tidak melanggar batasan. |
| Keyboard shortcuts lengkap | ✅ Masuk v1 | |
| Save As / Rename / Delete Project (varian lengkap) | ✅ Masuk v1 | |

**Catatan jujur (ponytail):** ini bukan lagi "MVP ramping" — hampir semua fitur Command Builder masuk v1, cuma beberapa yang gugur karena murni gak relevan secara arsitektur (Verifikasi Akun, Text Command, Hapus File Drive) atau eksplisit ditolak user (Mode kirim, Find, Zoom, Tema). Effort v1 realistisnya setara membangun ulang Command Builder secara lokal, bukan versi kecil dulu. Dicatat apa adanya, bukan didebat lagi — ini keputusan user yang eksplisit.

---

## 5. Data dan Penyimpanan ✅

**Entitas data:** Project (nama, channel tujuan) → Item (nama, artis) → Reply (tipe, judul field, isi/file, kategori) — 1-ke-banyak dari Item ke Reply. Plus: Template (built-in + custom), Roster Artis (cache dari `users.list`), Grup Artis (slice custom), Hyperlink preset, Thread mapping (item → `thread_ts`, lanjutan `data/threads.json` Phase 0).

**Engine: SQLite** (`better-sqlite3`) — naik level dari JSON Phase 0 karena data sekarang relasional (project → item → reply → template), bukan objek flat. JSON bakal nyiksa begitu ada banyak project & butuh query silang (mis. "semua item pakai artis X").

**File attachment**: **di-copy ke folder lokal app** begitu di-attach (bukan cuma nyimpen path file asli) — supaya project gak rusak kalau file sumber dipindah/dihapus user setelahnya. Ini peran setara "staging Drive" di Command Builder, versi lokal.

**Lokasi**: folder standar OS via `app.getPath('userData')` Electron — otomatis benar di Windows & macOS.

**Sinkronisasi lintas Koor/mesin: tidak perlu.** Resolusi buat gap lama yang belum terjawab — ternyata otomatis kejawab lewat prinsip "mirror Command Builder": di sana pun **project private per pembuatnya**, tidak ada sharing antar user. 1 Koor = 1 project = data lokal miliknya sendiri.

**Offline**: 100% kerja nyusun tabel/reply/template offline. Cuma langkah "Kirim ke Slack" yang butuh internet.

**Export/Import Project**: **masuk v1** — tombol Export (jadi 1 file) & Import (buka file itu lagi). Pengganti langsung buat keamanan data yang di Command Builder otomatis didapat gratis lewat Google Drive (di sini data lokal, jadi perlu cara manual buat backup/pindah device).

---

## 6. Kebutuhan Desktop ✅

- **Platform**: Windows & macOS (sudah diputuskan sejak awal). Linux tidak disebut kebutuhan — tidak masuk scope kecuali ada Koor yang butuh nanti.
- **Tray icon**: **masuk v1** — minimize ke system tray, batch besar tetap jalan di background sementara Koor kerja di aplikasi lain.
- **Notifikasi OS native**: **masuk v1** — popup notifikasi Windows/Mac begitu batch kirim selesai, terutama berguna dikombinasikan dengan tray (Koor gak perlu balik ke app buat tahu prosesnya kelar).
- **Auto-launch saat komputer nyala**: **tidak perlu**. App dibuka manual pas Koor butuh kirim — bukan bot yang harus selalu standby.
- **Akses file**: drag-drop dari Explorer/Finder + dialog pilih file/folder native (sudah tercakup dari Copy Paste Upload & Import dari Folder di poin 4).

---

## 7. Arsitektur dan Keamanan ✅

```
┌─────────────────────────────┐        IPC (contextBridge, preload.js)
│  Renderer (UI)                │◄──────────────────────────────┐
│  Tabel, Drawer, Editor,       │                                │
│  Chart, dll — TIDAK PERNAH    │                                │
│  pegang token/secret langsung │                                │
└───────────────┬───────────────┘                                │
                 │ IPC (request aksi: "kirim item X", "buka folder", dll)
                 ▼                                                │
┌─────────────────────────────────────────────────────────────────┴──┐
│  Main process                                                       │
│  - Slack API client (@slack/web-api) — pegang token & Client Secret │
│  - SQLite (better-sqlite3) — Project/Item/Reply/Template/dst        │
│  - safeStorage — encrypt/decrypt token OAuth                        │
│  - File system — staging attachment, export/import project          │
│  - OAuth local server (localhost callback) + shell.openExternal      │
│  - Tray, notifikasi OS                                               │
└──────────────────────────────┬──────────────────────────────────────┘
                                 │ HTTPS
                                 ▼
                          Slack Web API (slack.com)
```

**Prinsip pembatasan akses:**
- **Renderer tidak pernah pegang token, Client Secret, atau akses filesystem langsung** — sesuai default aman Electron (`contextIsolation: true`, `nodeIntegration: false`, sandboxed renderer). Semua operasi sensitif lewat IPC ke main process, yang validasi & eksekusi.
- **OAuth login pakai browser sistem** (`shell.openExternal`), bukan embedded webview di dalam app — mencegah app "melihat" kredensial Slack user secara langsung (pola yang sama seperti Phase 0 sekarang, sudah teruji aman).
- **Client Secret & token cuma hidup di main process** — persis pola `lib/slack-login.js`/`lib/slack-send.js` Phase 0 sekarang, dilanjutkan bukan ditulis ulang.
- **CSP ketat** di renderer (tidak load remote script/resource apa pun — semuanya lokal/bundled).

**Catatan teknis (bukan keputusan produk, cuma info implementasi):** dengan scope UI sebesar ini (tabel, drawer, rich text editor, video/PDF preview, chart), renderer kemungkinan besar perlu framework UI (React) — vanilla JS seperti `electron/renderer/renderer.js` Phase 0 sekarang bakal sulit dikelola di skala ini. Ini keputusan teknis saya ambil sendiri pas mulai coding nanti, gak perlu persetujuanmu kecuali kamu punya preferensi lain.

---

## 8. Tampilan dan Interaksi ✅

- **Gaya visual: desain baru** — tidak niru tampilan Command Builder, cuma alur & fiturnya yang sama (sudah dipetakan lengkap di poin 4).
- **Tema: terang (light) saja**, tetap — tidak ada toggle (sudah diputuskan di poin 4, Tema terang/gelap gak masuk v1).
- **Standar kualitas (2026-09-14, permintaan eksplisit): simpel, ikon gak murahan (minimal setara Command Builder), hindari "AI slop".** Command Builder sendiri pakai **SVG stroke-icon custom** (viewBox 24×24, `stroke-width 2`, round linecap/linejoin — gaya Lucide/Feather Icons), bukan emoji atau campuran icon-font, konsisten di semua tombol. Itu jadi tolok ukur, bukan sekadar "harus bagus":
  - **Ikon**: 1 sistem SVG stroke icon yang konsisten di seluruh app — rekomendasi pakai library **Lucide** (open-source, MIT, gaya visualnya persis yang dipakai Command Builder) daripada gambar ulang manual atau download icon pack random yang gaya campur-aduk.
  - **Hindari ciri "AI slop"**: gradient ungu-biru generik, glassmorphism berlebihan, drop shadow menumpuk/neumorphism, emoji dipakai sebagai icon fungsional, ilustrasi dekoratif tanpa fungsi, font default tanpa hierarki (semua ukuran/berat sama).
  - **Tipografi**: satu font stack sistem yang bersih, hierarki jelas (ukuran & berat beda buat judul/label/isi/caption) — bukan sekadar 1 ukuran font di mana-mana.
  - **Spacing & warna**: whitespace lega, palet warna terbatas & konsisten (bukan warna-warni per fitur), border/shadow tipis & fungsional (nandain elevasi/interaktivitas), bukan dekorasi.
- **Kondisi loading/kosong/error** (turunan langsung dari keputusan poin 2-5, gak perlu keputusan baru):
  - Tabel kosong di awal → ajakan jelas: "Import dari Folder" atau "+ Tambah Item" buat mulai.
  - Loading roster artis dari Slack → indikator loading di dropdown Artis, bukan bikin seluruh app nge-freeze.
  - Kirim batch → progress real-time per sub-step + tombol Cancel (poin 2, 4).
  - Gagal per item → ditandai jelas di baris tabel + alasan spesifik di ringkasan akhir (poin 1, 3) — bukan silent fail atau pesan generik.

---

## 9. Distribusi dan Pemeliharaan ✅

- **Instalasi**: `electron-builder` → `.exe`/NSIS (Windows), `.dmg`/`.app` (macOS), **unsigned/gratis** (sudah diputuskan — konsekuensi: klik kanan → Open sekali tiap versi baru di Mac).
- **Update**: **cek versi otomatis, install manual.** App cek versi terbaru pas dibuka → banner/notif kalau ada yang baru + link download. Bukan auto-update diam-diam (gak bisa, karena unsigned di Mac).
- **Hosting rilis**: **GitHub Releases, repo private** — konsisten dengan pola HB5 (`hejakbersama-a11y`), gratis, `electron-builder` punya dukungan publish bawaan ke GitHub Releases.
- **Laporan error**: log lokal ke file (folder `userData`, sama seperti lokasi data poin 5) — Koor bisa share file log itu kalau lapor bug. Tidak ada remote crash-reporting/telemetry (internal tool, jaga privasi, gak perlu infra tambahan).
- **Pemulihan data**: lewat Export/Import Project yang sudah diputuskan di poin 5 — bukan mekanisme baru.

---

## 10. Kriteria Selesai ✅

**Checklist fungsional** (dicek langsung di Slack/app, bukan cuma dari log — pola sama seperti kriteria sukses Phase 0):
- [ ] Login sekali → token persisten, gak perlu login ulang tiap buka app
- [ ] Pesan Slack terbukti sebagai identitas Koor asli (nama/foto), bukan bot
- [ ] Import dari Folder mengisi tabel otomatis sesuai pola nama file
- [ ] Tambah item manual berfungsi di tabel yang sama
- [ ] Kirim item yang nama-nya sudah pernah dikirim → reply ke thread lama, bukan bikin baru
- [ ] Multi-file per reply terkirim sesuai batas asli Slack
- [ ] 1 item gagal di tengah batch → sisanya lanjut, alasan gagal jelas di ringkasan
- [ ] Tombol Cancel benar-benar menghentikan batch yang sedang jalan
- [ ] Notifikasi OS + tray muncul saat batch selesai di background
- [ ] Export Project → Import Project di device/instalasi lain → data utuh
- [ ] Banner "versi baru tersedia" muncul kalau ada rilis baru di GitHub Releases
- [ ] App jalan penuh tanpa internet sampai tombol "Kirim ke Slack" ditekan
- [ ] Terinstall & jalan normal di Windows dan macOS (termasuk alur klik-kanan-Open di Mac)

**Target performa:**
- Waktu buka app (klik icon → halaman utama siap pakai): **< 3 detik**
- Penggunaan memori saat idle: **< 300MB**

---

## Status: kerangka rancangan selesai (2026-09-14)

Semua 10 poin di kerangka sudah dibahas & diputuskan.

## Status build (2026-09-15)

**Round 1** — fondasi (Electron + React/TS + `node:sqlite` + OAuth + IPC aman) + alur inti (login, project, import folder, tambah manual, kirim, cancel, reply ke thread lama, export/import, tray+notifikasi).

**Round 2** — hampir seluruh sisa pemetaan fitur Command Builder di tabel atas sudah dibangun: Generate Item, Merge Item, Bulk paste, Undo/Redo + shortcut keyboard, Workload Distribution chart, Rename/Save As/Delete Project, Preview & Kirim (Slack View), dan Drawer lengkap (Template built-in+custom, reply teks dengan toolbar format Slack, emoji picker, hyperlink preset, Advanced Display gambar/PDF/video, Capture crop gambar & frame video, Broadcast per-reply, Clear field terpilih) — plus fitur baru yang diminta di tengah jalan: buat channel privat + invite member. Yang benar-benar tersisa cuma yang memang sengaja tidak dipilih (Mode kirim, Find, Zoom, Tema, Text Command) dan Capture Teks (mau diintegrasikan dari software lain user, bukan dibangun native).

Semua lolos syntax check (`.cjs`), `tsc --noEmit`, Vite build, dan cross-check kesesuaian channel IPC preload↔main. Window GUI-nya tetap perlu dites langsung di device user (sandbox tool ini gak bisa buka window beneran). Lihat [CARA-TES.md](CARA-TES.md) untuk checklist tes lengkap & daftar simplifikasi yang disengaja (ditandai `ponytail:` di kode).

## Rencana masa depan — BELUM dikerjakan (2026-09-16)

Dicatat biar diingatkan lagi nanti, bukan untuk dikerjakan sekarang:

- **Software Admin** — aplikasi terpisah buat lihat aktivitas semua Koor lintas device: log tiap user (bukan cuma Message Log lokal per-device yang sudah ada), siapa yang lagi online, dll. Ini butuh semacam server/backend pusat (app sekarang murni lokal per-device, gak ada server — lihat poin 7 rancangan), jadi bakal jadi perubahan arsitektur besar, bukan cuma fitur tambahan di app yang sudah ada. Perlu dibahas ulang dari awal (server-nya di mana, siapa yang bisa akses, data apa aja yang dikirim ke situ) kalau saatnya tiba.

---

## Bedah Lanjutan Command Builder — Temuan Detail (2026-09-16)

Poin 4 di atas ("Pemetaan fitur Command Builder", 2026-09-14) **tetap berlaku** — ini bukan mengulang dari nol, tapi pass kedua yang lebih dalam: baca langsung source code Command Builder (`Index.html`/`JavaScript.html`/`Stylesheet.html`, bukan cuma dokumen MD-nya yang kadang ketinggalan dari implementasi asli — sudah kejadian sekali, brief desain Reply tab ternyata jauh lebih sederhana dari yang akhirnya di-ship). Dua kategori temuan:

- **(A) Gap** — hal yang di poin 4 tertulis "✅ Masuk v1" tapi implementasi kita saat ini ternyata belum/beda persis dari aslinya.
- **(B) Temuan baru** — detail yang gak muncul sama sekali di pass pertama (poin 4 dulu levelnya masih arsitektural, belum sampai ke nuance UX sedetail ini).

**Cara isi:** tiap baris punya 3 pilihan `[ ] Adopsi` / `[ ] Adopsi dimodif` / `[ ] Buang` — tulis `[x]` di salah satu (isi catatan di kolom modifikasi kalau pilih "dimodif"). Sama pola kayak `CARA-TES.md`.

### A. Gap — "sudah diputuskan ✅" vs yang beneran ada di app sekarang

| # | Fitur asli (Command Builder) | Kondisi di app kita sekarang | Pilihan |
|---|---|---|---|
| A1 | **Delete Project 2 mode**: (a) hapus project + semua file permanen, (b) cuma hapus file-nya doang, project & item tetap ada | Cuma ada mode (a) — hapus project + semua data sekaligus, gak ada opsi "bersihin file doang" | `[x]` **Buang** — cukup 1 mode kayak sekarang (keputusan 2026-09-16) |
| A2 | **Generate Item ada 2 mode**: Number (kode+angka berurut, format lebar 00/000/0000, mulai dari & kelipatan bebas) DAN Text (paste daftar manual) | Cuma ada mode Number — mode Text gak ada, tapi Bulk Paste kolom Item sudah menutupi kebutuhan paste-manual secara terpisah | `[x]` **Buang** — Bulk Paste udah cukup, gak perlu duplikat jalur (keputusan 2026-09-16) |
| A3 | **Merge dash — validasi step konsisten**: Command Builder MEWAJIBKAN selisih antar angka konsisten (step 10 semua, atau +1 semua) baru dianggap rentang valid, dikompres jadi `_0080-0100`; kalau step-nya gak konsisten, DITOLAK (harus pakai koma) | **Sudah dicek, beda arah**: punya kita justru lebih longgar — `computeMergedName` cuma ambil `min`/`max` dari semua angka, TANPA validasi step sama sekali. Efeknya: `_001, _005, _009` (gap gak rata) di kita tetap kompres jadi `_001-009` (nyamarin ada scene 002/003/004/006/007/008 yang sebenernya gak ada), sedangkan Command Builder bakal nolak kombinasi ini | `[x]` **Adopsi** — ketatin, validasi step konsisten kayak Command Builder (keputusan 2026-09-16) |
| ~~A4~~ | ~~Merge gak wajib bersebelahan~~ | **Sudah dicek, SUDAH SAMA** — `canMerge={selected.size >= 2}` di kita gak ada syarat posisi bersebelahan sama sekali, backend `mergeItems` juga cuma sort by `sort_order` dari itemIds yang dikasih. Gak perlu tindakan. | *(selesai, gak perlu diisi)* |
| ~~A5~~ | ~~Bulk paste — baris kosong tengah dipertahankan~~ | **Sudah dicek, SUDAH SAMA** — `onSubmitItems`/`onSubmitArtists` proses `lines` mentah by index (`rows[i]` match posisi), baris kosong di tengah gak difilter duluan (buat Artis malah eksplisit jadi "lepas assignment", sesuai teks hint di modal). Gak perlu tindakan. | *(selesai, gak perlu diisi)* |

**A3 sudah dieksekusi (2026-09-16)** — diverifikasi via self-check Node standalone (4 skenario). Lihat `CARA-TES-BEDAH-COMMAND-BUILDER.md` §4.

### B. Temuan baru — belum pernah dibahas eksplisit

| # | Fitur asli (Command Builder) | Kenapa relevan buat kita | Pilihan |
|---|---|---|---|
| B1 | **Auto-retry item macet saat kirim** — item yang gagal/macet digeser ke BELAKANG antrean (bukan langsung gagal), item lain tetap lanjut duluan, dicoba ulang max 3x sebelum ditandai gagal permanen. Progress nampilin "macet, dicoba ulang (percobaan N/3)" | Kita udah punya progress+cancel, tapi belum ada retry otomatis — 1 item gagal (network sekejap, dll) langsung ditandai gagal, gak dicoba lagi otomatis | `[x]` **Buang** — alasan macet-nya Command Builder spesifik keterbatasan GAS (timeout, kuota UrlFetch); app lokal manggil Slack API langsung, kemungkinan macet jauh lebih kecil (keputusan 2026-09-16) |
| B2 | **Warning "berisiko macet"** buat file ≥25MB atau reply dengan ≥4 file sekaligus — muncul pas attach (toast), badge di pool Batch File, dan rincian di layar konfirmasi sebelum kirim. Bukan blocking, cuma peringatan | Threshold asli (25MB/GAS 50MB cap) gak relevan buat kita (Slack asli via API langsung, limit ~1GB) | `[x]` **Buang** (keputusan 2026-09-16) |
| B3 | **Sistem toast (pojok kanan bawah, auto-hilang) + modal konfirmasi custom** (`showConfirmModal` — bisa bawa checkbox atau radio opsional, 1 API dipanggil ulang di banyak tempat) gantiin `alert()`/`confirm()` bawaan browser | Kita sekarang masih pakai `confirm()` browser (sudah kebukti jalan di Electron) buat konfirmasi, dan alert() polos buat notifikasi sukses/gagal | `[x]` **Buang** — `confirm()`/`alert()` bawaan browser udah cukup, cuma `prompt()` yang genuinely broken & sudah diganti `PromptModal` (keputusan 2026-09-16) |
| B4 | **Klik header kolom "Reply" di tabel utama → langsung buka pemilihan Template buat diterapkan ke SEMUA item sekaligus** (bukan cuma per-item lewat drawer) | Kita sekarang cuma bisa pilih Template per-item (waktu reply item itu masih kosong). Gak ada shortcut buat "set 1 template ke seluruh tabel sekaligus" dari luar drawer | `[x]` **Adopsi** (keputusan 2026-09-16) — **sudah dieksekusi**, lihat `TemplateAllModal` di `MainTable.tsx` |
| B5 | **Hyperlink preset bisa dikelompokkan jadi BEBERAPA template/grup** (bukan 1 daftar flat), user pilih grup mana yang aktif per-project | Punya kita sekarang 1 daftar flat aja, gak ada pengelompokan | `[x]` **Buang** — flat list cukup di skala studio kita (keputusan 2026-09-16) |
| B6 | **Kolom NO** (nomor urut baris otomatis, bukan data tersimpan) di paling kiri tabel, sebelum Item | Tabel kita sekarang gak ada nomor urut | `[x]` **Adopsi** (keputusan 2026-09-16) |
| B7 | **Polish visual tabel**: zebra-stripe tipis (baris genap beda shade dikit), isi sel center-align, header tabel dikasih tint warna brand + center-align teksnya | Tabel kita sekarang left-align polos, gak ada zebra-stripe/tint header | `[x]` **Adopsi** (keputusan 2026-09-16) |
| B8 | **Presence indicator** ("Kamu satu-satunya online" / "X sedang online, harap koordinasi" / "Ada perintah lagi diproses") — 3 status warna di pojok menu bar, update tiap ~7 detik | Butuh server/backend bersama buat semua Koor | `[x]` **Buang total** (keputusan 2026-09-16) — fitur spesifik ini dicoret, TIDAK masuk lingkup rencana Software Admin sekalipun nanti dikerjakan. Rencana Software Admin sendiri (log per user, dll) tetap dicatat terpisah di bawah, gak ikut tercoret. |

**B4, B6, B7 sudah dieksekusi (2026-09-16)** — lihat `CARA-TES-BEDAH-COMMAND-BUILDER.md` §4 buat checklist tes.

**Yang SUDAH pasti gak relevan buat kita** (arsitektur beda total, gak perlu masuk tabel pilihan di atas — dicatat biar gak muncul lagi di pass berikutnya):
- **Job lock per channel** ("satu channel = satu job aktif, kiriman baru ditolak total kalau ada yang jalan") — di Command Builder ini nahan tabrakan lintas-user karena semua kirim lewat 1 bot/server bersama. App kita tiap Koor jalan sendiri-sendiri dari device masing-masing, gak ada proses bersama yang bisa tabrakan di sisi kita — sudah disinggung juga di poin 4 ("app lokal sync, tidak butuh job-lock server").
- **Stop Intake dengan countdown 5 detik** — sudah diputuskan di poin 4 disederhanakan jadi stop langsung tanpa countdown (alasan sama: gak ada job-lock server yang perlu di-release dengan hati-hati).
- **Hapus File Terkirim (dari Google Drive)** — kita upload langsung dari disk lokal ke Slack, gak ada staging Drive yang perlu dibersihin setelah kirim (sudah diputuskan di poin 4).

### C. Tab Reply — detail struktur & alur (2026-09-16, follow-up setelah tab dibangun)

Tab Reply kita (dibangun round ini: folder-tab, bubble-icon+badge trigger, Prev/Next, composer chat, capture pool) ternyata masih beda struktural cukup besar dari Reply tab asli Command Builder. Dibedah ulang & dikonfirmasi satu-satu:

| # | Fitur asli (Command Builder) | Kondisi di app kita sekarang | Pilihan |
|---|---|---|---|
| C1 | **Layout 2 kolom**: `display-pane` (kiri, panel media terpadu — chip semua file dari SEMUA reply di item itu, 1 viewer bersama buat preview video/gambar/PDF) + `form-pane` (kanan, input artis + daftar reply + composer) | Cuma 1 kolom — tiap reply card preview file-nya sendiri-sendiri inline (`FilePreview` per reply), gak ada panel media terpadu | `[x]` **Adopsi** — restrukturisasi jadi display-pane + form-pane (keputusan 2026-09-16) |
| C2 | **General Display** — slot file referensi statis per-item (color script, model sheet, dll) yang GAK nempel ke reply/kategori manapun, selalu kelihatan di display-pane tanpa perlu buka reply dulu | Gak ada konsep ini — file referensi harus ditaruh jadi reply biasa | `[x]` **Adopsi** (keputusan 2026-09-16) |
| C3 | **Gaya kartu reply**: bubble chat — avatar "HejBot" jadi drag-handle, badge "⇄ semua" kalau lagi status broadcast, aksi (checkbox/menu ⋮/hapus) baru muncul pas di-hover, klik bubble buat masuk mode edit (bukan selalu-edit) | Card kita selalu dalam mode edit — checkbox+title+toolbar+textarea SELALU kelihatan, gak ada avatar/badge/hover-reveal | `[x]` **Adopsi** — ganti jadi mode baca (bubble) vs mode edit (keputusan 2026-09-16) |
| C4 | **Drag-reorder reply** — drag dari avatar buat ubah urutan reply dalam 1 item | Gak ada, urutan tetap sesuai `sort_order` pas dibuat | `[x]` **Adopsi** (keputusan 2026-09-16) |
| C5 | **Broadcast 2 varian**: kirim ke semua item TANPA file, atau DENGAN file (pilih dari menu) | 1 tombol, selalu include file | `[x]` **Buang** — biarin 1 tombol always-include-file, kalau gak mau file-nya tinggal dihapus manual di reply hasil broadcast (keputusan 2026-09-16) |
| C6 | **Clear field terpilih — scope tambahan**: bisa pilih "hapus di item ini aja" ATAU "hapus field kategori sama di SEMUA item sekaligus" | Cuma hapus di item yang lagi dibuka (Tab Reply aktif) | `[x]` **Adopsi** — tambah pilihan scope semua item (keputusan 2026-09-16) |
| C7 | **Input Artis di dalam drawer/Tab Reply** — field ganti artis langsung di situ, data sama persis dengan kolom Artis di tabel (sinkron otomatis, bukan field terpisah) | Ganti artis cuma bisa dari Tab Table | `[x]` **Adopsi** — tambah dropdown Artis di header Tab Reply (keputusan 2026-09-16) |
| C8 | **Fullscreen mode** — display-pane (media) melebar penuh, form-pane (reply list) tetap fix 420px; muncul mini workload chart pas fullscreen doang | Gak ada fullscreen sama sekali di Tab Reply | `[x]` **Adopsi** — masuk akal seiring layout 2-kolom baru (C1) (keputusan 2026-09-16) |
| C9 | **Keyboard shortcut scoped ke Tab Reply**: panah kiri/kanan pindah item (bukan cuma klik tombol Prev/Next), `C`/`.`/`,`/`T` buat capture & frame-step video/PDF pas viewer kelihatan — semua nonaktif kalau lagi fokus di field teks | Cuma bisa klik tombol Prev/Next, gak ada shortcut keyboard sama sekali di Tab Reply | `[x]` **Adopsi** — pola guard sama kayak shortcut lain yang udah ada (nonaktif saat mengetik) (keputusan 2026-09-16) |

**Ringkasan**: 7 dari 9 poin Adopsi (C1, C2, C3, C4, C6, C7, C8, C9 — cuma C5 yang Buang).

**Sudah dieksekusi (2026-09-16)** — lihat `CARA-TES-BEDAH-COMMAND-BUILDER.md` §2b buat checklist tes lengkap. C3 dieksekusi versi disederhanakan: gaya bubble + hover-reveal aksi diadopsi, tapi mode baca-vs-edit terpisah (klik buat masuk edit) **tidak dibangun** — card tetap selalu bisa langsung diedit, cuma visualnya yang bubble. Dicatat sebagai penyederhanaan sengaja, bukan penyimpangan diam-diam.

### D. Reply unified field — keputusan model data (2026-09-16, dampak besar)

Ditemukan pas user tanya langsung: apakah reply di Command Builder dibagi tipe Teks/File?

**Jawaban: TIDAK, di versi LIVE sekarang.** `makeBlankReply()` (JavaScript.html):
```js
function makeBlankReply() {
  return { id: uid(), category: '', emoji: '📝', fileId: '', fileName: '', mimeType: '', text: '', broadcast: 'this' };
}
```
Gak ada field `type` — `fileId`/`fileName` dan `text` ada di objek YANG SAMA, bisa keisi bareng. Dikonfirmasi juga tekstual di User Guide asli: *"Field reply unified — satu field bisa isi teks DAN lampirkan file bareng (gak ada lagi pembeda tipe File/Teks)."* (Catatan: dokumen PROTOTIPE lama, `Command-Builder-Dokumentasi-Web-App.md` §2.5, sempat punya toggle eksplisit 📎/T File-vs-Teks — itu desain awal yang sudah diganti unified, bukan yang jalan di versi sekarang.)

**Beda dari app kita**: skema kita `replies.type TEXT NOT NULL DEFAULT 'text'` ('text'|'file'), dan UI (`ReplyRow`) branching mutually-exclusive — 1 field HARUS pilih salah satu, gak bisa dua-duanya.

| # | Temuan | Pilihan |
|---|---|---|
| D1 | **Reply unified** — 1 field bisa isi teks + lampirkan file bareng, gak perlu pilih tipe dulu | `[x]` **Adopsi** (keputusan 2026-09-16) |

**Dampak implementasi (dicatat biar gak kelupaan pas eksekusi, bukan keputusan tambahan)**: skema DB (`replies.type` kemungkinan dihapus/gak dipakai lagi), `ReplyRow` (render textarea DAN file-list bareng, bukan branch), composer (hapus dropdown Teks/File, textarea+attach-file selalu ada bareng), `TemplateBuilder` (field cuma butuh label, gak perlu pilih tipe per-field lagi), `applyTemplate`, `broadcastReply`, `mergeItems` konsolidasi kategori, capture-pool drop-target logic (`addCapturedFileToReply`) — semua nyentuh konsep `type` reply, perlu disweep ulang.

### E. Video player & PDF/Image viewer (2026-09-16)

Viewer kita sekarang jauh lebih sederhana dari aslinya: video = `<video>` native + play/pause + step-frame asumsi 24fps tetap + tombol Capture; gambar = `<img>` + Capture; PDF = `<iframe>` polos (gak bisa capture sama sekali). Dibedah detail & dikonfirmasi:

| # | Fitur asli (Command Builder) | Kondisi di app kita sekarang | Pilihan |
|---|---|---|---|
| E1 | **FPS video** — Command Builder input manual (gak bisa auto, keterbatasan browser: `HTMLVideoElement` gak expose frame rate). Dipakai buat step-frame DAN timecode readout, bukan cuma tampilan | Asumsi tetap 24fps, gak bisa diubah | `[x]` **Adopsi, DITINGKATKAN** — auto-detect dari metadata file (`.mp4`/`.mov` via library ringan semacam `mp4box.js`, baca box `mvhd`/`stts`, TANPA bundle FFmpeg yang berat) dengan fallback input manual (default 24) kalau deteksi gagal/format gak didukung. Ini lebih baik dari Command Builder sendiri — mereka gak bisa auto-detect sama sekali karena keterbatasan browser, kita di Electron punya akses filesystem/Node.js (keputusan 2026-09-16) |
| E2 | **Loop range** — set titik `[awal`/`akhir]` dari posisi playhead, checkbox Loop, otomatis lompat balik ke awal pas nyampe akhir (dicek via `timeupdate`, terus main) | Gak ada, cuma play/pause + step-frame manual | `[x]` **Adopsi** (keputusan 2026-09-16) |
| E3 | **Speed control** — dropdown 0.25x/0.5x/1x/1.5x/2x, native `video.playbackRate` | Gak ada, selalu 1x | `[x]` **Adopsi** (keputusan 2026-09-16) |
| E4 | **Fullscreen** (video/PDF/gambar) — Fullscreen API browser asli, kontrol overlay auto-hide (nongol pas `mousemove`, sembunyi otomatis 2.5 detik) | Gak ada fullscreen di viewer manapun | `[x]` **Adopsi** — konsisten sama C8 (fullscreen Tab Reply) yang sudah diputuskan (keputusan 2026-09-16) |
| E5 | **Persist playback state lintas navigasi** (`mediaElementCache`) — elemen video/canvas DIPINDAH (bukan dibuat ulang) pas ganti item/tab, jadi video yang lagi main tetap jalan & posisinya gak reset | Video re-render dari awal tiap kali pindah context | `[x]` **Adopsi** — perlu buat dukung navigasi Prev/Next (C9) & fullscreen (C8/E4) yang sudah diputuskan, tanpa ini pengalaman review video keputus tiap ganti item (keputusan 2026-09-16) |
| E6 | **PDF viewer** — render custom ke `<canvas>` pakai pdf.js (CDN, v3.11.174), continuous-scroll SEMUA halaman ditumpuk vertikal (di-render sekali di awal, sengaja bukan lazy-render — trade-off "kedip sekali di awal" vs "kedip tiap ganti halaman"), zoom bertumpu di posisi kursor (scroll-zoom/dblclick/tombol, batas 20%-800% dari fit), pan drag-to-scroll di mana pun (fix `margin:auto` biar sisi kiri gak mentok pas zoom), BISA capture/crop area jadi gambar | Cuma `<iframe>` — PDF gak bisa di-capture sama sekali | `[x]` **Adopsi penuh** — satu-satunya cara PDF bisa ikut fitur capture (sekarang cuma gambar & video yang bisa capture) (keputusan 2026-09-16) |
| E7 | **Capture quality dropdown 1x-4x** (khusus PDF) — render ulang halaman independen di resolusi lebih tinggi via pdf.js pas capture, biar hasil crop tetap tajam walau viewer lagi di-zoom-out. Gambar gak kepengaruh (selalu native resolution) | N/A (PDF belum bisa capture) | `[x]` **Adopsi** — otomatis relevan begitu E6 (PDF canvas) di-adopsi (keputusan 2026-09-16) |

**Catatan**: Capture Teks (extract teks dari PDF, tombol `captureTextBtn` di Command Builder) **tetap seperti keputusan sebelumnya** di poin 4 — bukan dibangun native, integrasi dari software eksternal user, gak berubah oleh bedah ini.

**Ringkasan**: SEMUA 7 poin di-Adopsi (E1 malah ditingkatkan, bukan cuma ditiru) — video/PDF/image viewer bakal jadi salah satu bagian paling besar direstrukturisasi, terutama E6 (PDF total ganti dari iframe ke canvas+pdf.js).

**Sudah dieksekusi (2026-09-16)** — lihat `CARA-TES-BEDAH-COMMAND-BUILDER.md` §3. Satu gap sadar: **E5 (persist playback state lintas navigasi) TIDAK dibangun** — butuh video jadi elemen DOM ter-reparent di luar siklus render React, bentrok sama keputusan `key={activeItem.id}` (Drawer full-remount tiap ganti item, sengaja dipilih sebelumnya buat hindari bug stale-state). Video/PDF sekarang reset tiap ganti item/tab.

### F. PDF viewer — perbandingan tambahan dengan Hej Pro Breakdown (2026-09-16)

Referensi tambahan: `D:\01. HERALD JAKARTA\Development\Hej Pro Breakdown\App\` (`renderer/js/pdfViewer.js`, project breakdown storyboard terpisah, PDF viewer-nya lebih matang/battle-tested — status "Selesai + banyak penyempurnaan" di project itu sendiri). Dibedah buat perkaya cara EKSEKUSI poin E6 (bukan poin baru terpisah, nyambung langsung ke keputusan E6 "Adopsi penuh" di atas).

| # | Command Builder | Hej Pro Breakdown | Pilihan |
|---|---|---|---|
| F1 | Render SEMUA halaman sekaligus di awal (simpel, 1x kedip) | **Virtualisasi** (`IntersectionObserver`, ±800px) — cuma render halaman deket viewport, placeholder jaga tinggi scroll | `[x]` **Pakai pola Command Builder** — render semua sekaligus, gak usah virtualisasi (keputusan 2026-09-16) |
| F2 | Render 1 tahap, `RENDER_QUALITY=2` upfront | **Render 2-tahap** (low-res cepat → full-res) + **double-buffer** (gambar ke canvas offscreen dulu, baru "tempel" sinkron tanpa `await` di antara — teknik nol-kedip yang lebih matang) | `[x]` **Pakai pola Hej Pro Breakdown** — render 2-tahap + double-buffer (keputusan 2026-09-16) |
| F3 | Sistem Marker | Persistent marker nempel ke data (sekarang disederhanakan jadi "link 1 halaman penuh ke Scene", drag-to-create custom SUDAH DIHAPUS dari kode-nya sendiri — lagi dirancang ulang di project asalnya) | `[x]` **Buang** — beda domain (breakdown/anotasi jangka panjang vs compose+kirim Slack kita), capture standalone drag-select bebas (pola Command Builder, sudah di-Adopsi di E6/E7) sudah cukup (keputusan 2026-09-16) |
| F4 | Gak ada — cuma readout nomor halaman + input pindah manual | **Page rail** — strip vertikal di sisi kiri viewer, 1 bulatan bernomor per halaman (klik = smooth-scroll langsung ke situ, bulatan halaman aktif terisi warna accent). Hover di AREA rail (bukan per-bulatan) → SEMUA judul halaman muncul bersamaan sebagai label di kanan rail. Judul = item teks berfont TERBESAR di halaman itu (heuristik heading, bukan baris pertama yang sering cuma running-header/nomor halaman), fallback "Halaman N" kalau kosong. Judul di-prefetch background begitu rail dibangun (gak nunggu hover), tapi cuma label buat bulatan yang BENERAN kelihatan (gak ke-scroll keluar) yang ditampilkan | `[x]` **Adopsi** — instruksi langsung user, bukan pertanyaan (keputusan 2026-09-16) |

**Detail implementasi tambahan yang ikut diadopsi bareng F2** (bukan poin pilihan terpisah, satu paket sama F2):
- **Throttle 150ms khusus di render mahal** (2-tahap tadi) saat scroll-zoom terus-menerus — resize CSS tetap instan tiap tick wheel (murah), tapi render ulang baru dieksekusi 150ms setelah wheel berhenti (debounce, di-reset tiap tick baru).
- **pdf.js WAJIB bundled lokal, bukan CDN** — ini bukan pilihan gaya (Command Builder pakai CDN v3.11.174), tapi konsekuensi otomatis dari kebijakan CSP kita sendiri yang sudah diputuskan sejak awal (poin 7 rancangan: "tidak load remote script apa pun, semuanya lokal/bundled"). Hej Pro Breakdown sudah bundled lokal (`pdfjs-dist` v6.2.108 dari `node_modules`, worker/cmap di-resolve via `import.meta.url`) — pola inilah yang dipakai, bukan approach Command Builder.
- **Matikan zoom native Electron** (`webContents.setVisualZoomLevelLimits(1,1)`) supaya `Ctrl+scroll`/`Ctrl+Plus/Minus` gak nge-zoom SELURUH window bentrok sama zoom custom di dalam viewer PDF — perlu diterapkan begitu fitur zoom PDF (E6) dibangun.

### G. Video player — perbandingan tambahan dengan Hej Pro Breakdown (2026-09-16)

Sama sumber (`renderer/js/videoPlayer.js`, `timeline.js`). **Koreksi beberapa asumsi awal** setelah dibaca langsung: `Space` ternyata TIDAK ada shortcut-nya di situ (cuma klik tombol); `S` bukan "Split" tapi **"Save"** (simpan rentang I/O jadi Scene baru); `,`/`.` BUKAN frame-step (itu tugas `←`/`→`), tapi navigasi ke Scene tersimpan sebelumnya/berikutnya. Filosofi player-nya juga beda total dari kita: ini alat **editing/breakdown** (I/O/S/L nempel ke entitas data "Scene" permanen), bukan player review-only kayak kita — jadi gak semua bisa di-port mentah-mentah.

| # | Temuan | Kenapa relevan | Pilihan |
|---|---|---|---|
| G1 | **Matematika seek presisi**: `frameFromTime` pakai epsilon `+0.001` (hindari floating-point salah bulatin turun 1 frame), `seekToFrame` nembak ke frame **tengah** bukan tepi (hindari browser bulatkan ke frame sebelumnya) | Perbaikan teknis murni, gak ada trade-off | `[x]` **Adopsi** — otomatis, bukan soal selera (keputusan 2026-09-16) |
| G2 | **`requestVideoFrameCallback`** buat lacak frame yang BENERAN tampil di layar (lebih akurat dari baca `currentTime` via timer polling), fallback `requestAnimationFrame` kalau API gak didukung | Command Builder cuma pakai timer polling biasa — ini upgrade akurasi murni | `[x]` **Adopsi** — otomatis, bukan soal selera (keputusan 2026-09-16) |
| G3 | **Shift+panah kiri/kanan** = lompat 10 frame (panah biasa tetap 1 frame) | Kita belum punya, berguna buat scrub cepat | `[x]` **Adopsi** (keputusan 2026-09-16) |
| G4 | **Home/End** = lompat ke frame pertama/terakhir | Kita belum punya | `[x]` **Adopsi** (keputusan 2026-09-16) |
| G5 | **Shortcut keyboard I/O** buat set titik awal/akhir Loop range (E2) tanpa klik tombol | Bisa mempercepat alur set loop range yang sudah diputuskan | `[x]` **Buang** — tombol klik yang sudah diputuskan di E2 sudah cukup (keputusan 2026-09-16) |

**Yang SUDAH pasti gak relevan** (dicatat biar gak muncul lagi di pass berikutnya):
- **Cluster I/O/S/L/,/.** — nempel ke entitas "Scene" permanen (beda domain, kita gak punya konsep Scene-breakdown). Loop range kita (E2) tetap versi sederhana: tombol [awal]/[akhir] + checkbox Loop, bukan alat authoring Scene.
- **Fullscreen** — Hej Pro Breakdown SENGAJA belum bangun ini sama sekali (ditunda ke fase depan project itu sendiri), jadi gak ada info tambahan buat dibandingkan. Command Builder tetap satu-satunya referensi (sudah diputuskan Adopsi di E4).
- **mediaElementCache-equivalent** — pola sama persis (video di-reparent DOM, bukan dibuat ulang) sudah dikonfirmasi ada di kedua project — memperkuat keputusan E5 (Adopsi), bukan info baru.

**Sudah dieksekusi (2026-09-16)** — G1-G4 masuk ke video player (`FilePreview` di `Drawer.tsx`) bareng E1-E5. Lihat `CARA-TES-BEDAH-COMMAND-BUILDER.md` §3.

### H. Rich text editor — WYSIWYG pakai Lexical (2026-09-16)

Muncul di tengah eksekusi (bukan dari bedah Command Builder/Hej Pro Breakdown) — user tanya langsung apakah toolbar format teks (Bold/Italic/Link/Bullet) bisa pakai plugin editor daripada manipulasi string manual di `<textarea>` polos yang sekarang (`src/lib/textFormat.ts`).

**Kondisi sekarang**: bukan WYSIWYG — toolbar nyisipin syntax Slack mrkdwn mentah langsung ke teks (`*bold*`, `_italic_`, dst.), user lihat tanda bintangnya, bukan teks bold beneran. Ini SAMA PERSIS pendekatan Command Builder sendiri ("Tahap 1" — WYSIWYG eksplisit ditunda sebagai "Tahap 2, investasi effort besar").

**Kenapa gak instan "install & selesai"**: Tiptap/Lexical keduanya WYSIWYG (contentEditable), tapi TIDAK ADA yang punya serializer bawaan ke Slack mrkdwn (`*bold*` bukan `**bold**` standar Markdown, link `<url|label>` bukan `[label](url)`) — btw dua arah (render dokumen editor → string Slack, DAN parse string Slack lama → dokumen editor pas buka reply yang sudah ada) perlu ditulis custom, apa pun library-nya.

| # | Pilihan | Alasan |
|---|---|---|
| H1 | **Upgrade ke WYSIWYG pakai Lexical** (bukan Tiptap, bukan tetap textarea) | Lexical dipilih karena sistem `@lexical/markdown`-nya memang didesain buat di-custom simbolnya (bukan hardcode ke CommonMark `**`) — lebih dekat "konfigurasi" ke Slack mrkdwn dibanding `tiptap-markdown` yang berorientasi CommonMark standar dan perlu serializer dari nol lebih banyak (keputusan 2026-09-16) |

**Dampak implementasi** (dicatat biar gak kelupaan pas eksekusi):
- Dependency baru: `lexical` + `@lexical/react` (+ plugin terkait: rich-text, list, link).
- Custom transformer 2 arah: dokumen Lexical ↔ string Slack mrkdwn (BOLD `*x*`, ITALIC `_x_`, bullet list `- `, link `<url|label>`) — pengganti `applyBold`/`applyItalic`/`applyBulletList`/`applyLink` di `src/lib/textFormat.ts`.
- Mengganti SEMUA pemakaian textarea+toolbar format: `ReplyRow` (field reply) DAN composer chat di `Drawer.tsx` — dua-duanya sama-sama pindah ke Lexical, bukan cuma salah satu.
- **Digabung ke eksekusi Fase 2** (restrukturisasi Tab Reply, C1-C9) — bukan fase terpisah, karena `ReplyRow` sudah pasti ditulis ulang total di Fase 2 buat gaya bubble+hover-reveal (C3); sekalian pasang Lexical di situ daripada bangun textarea dulu baru dirombak lagi ke Lexical belakangan.
- `insertIntoActiveField`/`activeTextareaRef` (buat tombol Emoji & Hyperlink preset global di bawah Drawer) perlu diadaptasi — gak lagi manipulasi `HTMLTextAreaElement`, tapi manipulasi editor Lexical yang lagi fokus.

**Sudah dieksekusi (2026-09-16)** — komponen baru `src/screens/RichTextEditor.tsx` + transformer `src/lib/slackMarkdown.ts`. `src/lib/textFormat.ts` sudah dihapus total (gak dipakai lagi). Diverifikasi via self-check headless (`@lexical/headless`) 7 skenario round-trip mrkdwn, semua lulus. Lihat `CARA-TES-BEDAH-COMMAND-BUILDER.md` §2a.

## Status eksekusi keseluruhan bedah lanjutan (2026-09-16)

Semua poin A-H yang diputuskan Adopsi (A3, B4, B6, B7, C1-C4+C6-C9, D1, E1-E7, F1-F2+F4, G1-G4, H1) **sudah dieksekusi & terverifikasi otomatis** (`tsc`, build, `node -c`, cross-check IPC, self-check standalone buat logic non-trivial). Checklist tes manual lengkap ada di `CARA-TES-BEDAH-COMMAND-BUILDER.md` (§1-§4), belum ditest langsung di GUI oleh user (sandbox tool ini gak bisa buka window beneran).

**Penyederhanaan/gap yang disengaja, dicatat biar transparan**:
- **C3** — mode baca-vs-edit terpisah TIDAK dibangun, cuma visual bubble+hover-reveal. Card tetap selalu bisa langsung diedit.
- **E5** — persist playback state lintas navigasi TIDAK dibangun, bentrok sama keputusan `key={activeItem.id}` Drawer. Video/PDF reset tiap ganti item/tab.
- **F1** — sesuai keputusan awal (pola Command Builder, bukan virtualisasi Hej Pro Breakdown) — bukan gap, ini memang pilihan yang diambil.
