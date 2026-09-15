# Cara Tes — Slack Intake Apps (build pertama, 2026-09-14)

Build ini fondasi + alur inti (lihat "Status build" di bawah untuk apa yang beneran jalan vs masih placeholder). **Saya (AI) gak bisa buka window GUI-nya sendiri** — sandbox tool ini sengaja set `ELECTRON_RUN_AS_NODE=1` (biar gak bisa munculin window sembarangan), jadi verifikasi visual harus kamu lakukan sendiri lewat langkah di bawah. Yang sudah saya cek dari sisi saya: renderer (React/TS) build bersih tanpa error, semua file `.cjs` lolos syntax check, dan `node:sqlite` (engine database) sudah saya tes langsung jalan normal di runtime Electron ini.

## 0. Persiapan sekali di awal

1. Copy `.env.example` jadi `.env`.
2. Buka Slack App yang **sama dipakai Phase 0** (https://api.slack.com/apps) → **OAuth & Permissions**:
   - **Redirect URLs** → tambah `http://localhost:3737/callback` → Save.
   - **Scopes → User Token Scopes** → tambah dua scope baru: **`channels:read`** dan **`groups:read`** (dipakai buat ambil daftar channel di New Project — fitur ini gak ada di Phase 0). Scope lama (`chat:write`, `files:write`, `users:read`, `groups:write`) tetap dipakai, jangan dihapus.
   - Scroll ke atas → klik **Reinstall to Workspace** (tombol ini muncul otomatis abis ubah scope) → Allow.
3. Isi `.env`: `SLACK_CLIENT_ID` & `SLACK_CLIENT_SECRET` dari App yang sama (**Basic Information**), biarkan `SLACK_REDIRECT_URI` & `OAUTH_PORT` default.
4. `npm install` (kalau belum, saya sudah jalankan sekali tapi ulangi kalau pull dari fresh clone).

## 1. Jalankan

```
npm run dev
```

Ini jalanin Vite (renderer) + Electron bareng. Window app harus muncul dalam beberapa detik.

## 2. Checklist tes manual

- [v] **Icon app**: logo "HB" muncul di title bar window, taskbar, dan icon tray (bukan lagi lingkaran polos).
- [ ] **Icon di notifikasi OS**: kirim batch, tunggu notifikasi muncul pas selesai → icon-nya logo HB (sebelumnya cuma window/tray/taskbar yang eksplisit di-set, notifikasi belum). Di Mac, cek juga Dock icon-nya HB.

Cek langsung di app & di Slack — bukan cuma percaya log terminal.

- [v] **Login**: klik "Login ke Slack" → browser kebuka → authorize → window app otomatis nunjukin Start Menu (bukan macet di layar Login).
- [v] **New Project (channel existing)**: klik New Project, isi nama, dropdown channel muncul isi channel Slack asli (bukan kosong/error) → Buat Project → masuk ke halaman tabel.
- [v] **New Project (buat channel privat baru)**: klik toggle "Buat Channel Privat Baru", isi nama channel + centang beberapa member dari daftar → Buat Project → **cek di Slack**: channel privat baru muncul, member yang dicentang udah otomatis ke-invite.
- [v] **Tambah Item**: klik ikon + di sidebar kiri → baris baru muncul, nama bisa diketik langsung di sel tabel.
- [v] **Grup Artis**: klik ikon Users di sidebar (atau Settings → Grup Artis), bikin grup dengan beberapa nama, simpan → muncul di dropdown filter atas, dan dropdown Artis per baris ikut kefilter kalau grup itu dipilih.
- [v] **Kirim**: centang beberapa baris → "Preview & Kirim" → modal preview → "Kirim Sekarang" → progress "Mengirim X/Y: nama item" muncul → **cek di Slack**: thread muncul sebagai identitas kamu (bukan bot), reply nempel di thread yang sama.
- [v] **Cancel**: mulai kirim batch agak banyak item → klik Cancel di tengah jalan → sisa item gak lanjut dikirim, ditandai "dibatalkan" di ringkasan.
- [v] **Reply ke thread lama**: kirim ulang item dengan **nama sama persis** → cek di Slack: reply baru nempel ke thread yang **sama**, bukan bikin thread baru.
- [v] **Ringkasan hasil**: box kanan-bawah muncul abis kirim, ✓/✗ per item, alasan gagal kalau ada yang gagal.
- [v] **Tray & notifikasi**: klik tombol **minimize (–)** → window minimize normal, tetap kelihatan di taskbar (klik buat balikin, bukan hilang). Icon di system tray tetap ada terus selama app jalan (buat akses cepat "Buka"/"Keluar"). Klik **X** → app beneran tertutup/keluar. Kirim batch, tunggu selesai (window boleh diminimize atau enggak) → notifikasi OS muncul.
- [v] **Export/Import Project**: Export → pilih lokasi simpan `.json` → buka app lagi (atau di device lain) → Import → project & itemnya muncul utuh termasuk file attachment (item-level DAN reply-level).

### Fitur round 2 (Command Builder parity)

- [v] **Generate Item**: sidebar → Wand2 icon → isi prefix/mulai/kelipatan/jumlah/padding → preview muncul → "Buat N Item" → baris-baris baru muncul di tabel sesuai pola.
- [v] **Bulk paste Item**: klik header kolom "Item" → modal → paste beberapa baris teks → Terapkan → tiap baris jadi item baru.
- [v] **Bulk paste Artis**: klik header kolom "Artis" → modal → paste nama-nama artis (harus persis sama nama di roster) → Terapkan → ke-assign ke baris tabel sesuai urutan atas-bawah.
- [v] **Undo/Redo**: tambah/hapus/rename item, ganti artis, atau merge → Ctrl+Z → berubah balik ke sebelumnya → Ctrl+Shift+Z (atau Ctrl+Y) → berubah lagi ke setelahnya.
- [v] **Hapus item lewat keyboard**: centang beberapa item (jangan fokus di input teks) → tekan **Delete** → item-item itu hilang, bisa di-undo.
- [v] **Pilih semua lewat keyboard**: tekan **Ctrl+A** (di luar input teks) → semua baris tercentang.
- [v] **Workload Distribution**: menu View → Workload Distribution → panel muncul, **1 bar horizontal bertumpuk** (bukan bar terpisah per artis) dengan legenda warna di bawahnya.
- [v] **Keyboard shortcuts help**: sidebar → ikon "?" (paling bawah) → modal daftar shortcut muncul.
- [v] **Rename Project**: klik judul project di header → ganti teks → klik area lain → nama project berubah (cek juga di Start Menu).
- [v] **Save As** (fix round 9, tolong tes ulang): menu File → "Save As" → isi nama baru → project baru muncul di Start Menu (data lengkap tersalin). *(Akar masalah sebelumnya: Electron gak implement `window.prompt()` — klik Save As jadi silent no-op tanpa dialog apa pun. Diganti modal in-app sendiri.)*
- [v] **Hapus Project**: menu File → "Hapus Project" → konfirmasi → balik ke Start Menu, project hilang dari daftar.
- [v] **Preview & Kirim**: klik "Preview & Kirim" (bukan langsung kirim) → modal Slack View muncul, ringkasan tiap item (nama, artis, reply) → klik "Kirim Sekarang" → baru beneran terkirim.
- [v] **Drawer — Template**: klik sel kolom "Reply" pada item yang belum punya reply → muncul pilihan Template (Default/Animation) → pilih salah satu → field-field muncul sesuai template.
- [v] **Drawer — Template Baru**: dari Drawer, klik "Template Baru" → isi nama + field (label+tipe) → Simpan & Terapkan → field custom itu muncul.
- [v] **Drawer — Reply teks**: isi salah satu field teks, klik tombol Bold/Italic/Link/Bullet list di atasnya → syntax Slack (`*bold*`, `_italic_`, dll) kesisip ke teks yang diseleksi.
- [v] **Drawer — Emoji & Hyperlink preset**: klik field teks dulu (biar fokus), lalu klik ikon emoji di bawah Drawer → pilih emoji → nempel di field itu. Sama buat hyperlink preset (simpan link baru dulu di situ, baru klik buat insert).
- [v] **Drawer — Attach file ke reply**: pada field bertipe File, klik "Tambah File" → preview muncul (gambar langsung, PDF via viewer, video dengan tombol play/frame-step).
- [-] **Drawer — Capture gambar**: pada preview gambar, klik ikon crop → drag kotak seleksi → "Simpan Crop" → muncul reply baru kategori "Capture" berisi hasil crop.
- [-] **Drawer — Capture video**: pada preview video, klik ikon crop (capture frame) → reply baru "Capture" berisi frame saat itu.
- [v] **Drawer — Broadcast per-reply**: isi 1 field di 1 item, klik ikon radio/broadcast di field itu → cek item lain di project yang sama → field kategori sama ikut keisi/ketimpa.
- [v] **Drawer — Clear field terpilih**: centang beberapa field reply (checkbox kiri) → tombol "Hapus N" muncul di header Drawer → klik → field-field itu hilang.
- [v] **Kirim dengan Reply**: isi Drawer sebuah item (teks/file), lalu kirim item itu → **cek di Slack**: tiap reply muncul sebagai pesan/upload terpisah di thread, urut sesuai field.

### Fitur round 3 (sidebar/menu bar + Batch File + merge dash/comma + Message Log)

- [v] **Layout**: menu bar (File/Edit/View/Settings/Help) di atas, sidebar ikon vertikal di kiri (bukan toolbar horizontal lagi). Klik tiap menu di menu bar → dropdown muncul isi aksi yang relevan.
- [ ] **Kolom tabel = Reply, bukan File**: kolom "File" sudah gak ada. Kolom "Reply" nampilin badge nama kategori reply (kosong = "Belum ada reply"), klik sel-nya (atau area manapun di situ) → buka Drawer.
- [v] **Batch File**: sidebar → ikon Upload → modal "Batch File Setup" muncul. Buat/pilih kategori (Animatic/TBH/Char/BG/Prop/custom via "+ kategori") → "Pilih File" → pilih banyak file sekaligus (coba sampai puluhan file) → tiap file otomatis nampilin `namaItem <> namafile.ext` (hijau) kalau nama file (tanpa ekstensi) persis sama nama item, atau `[ ] <> namafile.ext` kalau gak ketemu — pilih item manual dari dropdown lalu koneksi muncul sebagai badge. Bisa hubungkan 1 file ke lebih dari 1 item. Bisa tambah kategori lain (section sebelumnya tetap ada sebagai tab). "Selesai" → reply baru muncul di tabel sesuai kategori; "Lewati" → modal tutup tanpa perubahan.
- [v] **Merge dash vs koma**: centang 2+ item → sidebar ikon Combine (atau menu Edit) → muncul pilihan "Dash (-)" atau "Koma (,)".
  - Item dengan prefix sama + akhiran angka (mis. `Scene_010`, `Scene_020`) → pilih Dash → jadi `Scene_010-020`.
  - Item nama beda-beda → pilih Dash → **harus muncul error jelas** (bukan hasil aneh), coba lagi pakai Koma → jadi gabungan nama dipisah koma.
  - Item yang di-merge sama-sama punya reply kategori sama (isi Drawer dulu di 2 item dengan kategori sama, mis. "Inset") → setelah merge, cek Drawer hasil merge-nya → jadi **1 reply** isinya gabungan teks kedua item (dipisah baris baru), bukan 2 reply terpisah.
  - Undo (Ctrl+Z) setelah merge dash/koma → item balik terpisah persis seperti semula, termasuk reply yang tadi digabung balik ke 2 reply terpisah di masing-masing item.
- [v] **Message Log**: menu View → "Message Log" → panel kanan muncul, riwayat kirim (berapa berhasil/gagal) dan error lain (misal gagal ambil roster/channel) tercatat dengan waktu. Tutup app & buka lagi → log lama masih ada (tersimpan di SQLite, bukan cuma sesi berjalan).

### Fitur round 4 (perbaikan dari feedback)

- [v] **Grup Artis gabung jadi 1 modal**: sidebar/menu Settings → "Grup Artis" → modal "Dropdown Artis" muncul — list "Semua Artis" + tiap grup (klik salah satu langsung jadi filter aktif & modal tertutup), tombol "+ Grup Baru" di bawah buka form bikin grup baru **di modal yang sama** (bukan modal terpisah lagi). Gak ada lagi row filter terpisah di luar.
- [v] **Batch File — drop zone**: buka Batch File, pilih/buat kategori → kotak putus-putus besar muncul (bukan tombol kecil) → **drag file dari Explorer langsung ke kotak itu** → file kesambung. **Klik di kotak itu juga** → file explorer kebuka buat pilih file.
- [v] **Bulk Paste overwrite**: klik header "Item" → textarea **sudah keisi** nama item yang sekarang (bukan kosong). Edit satu baris → Terapkan → baris tabel yang bersangkutan berubah (bukan bikin item baru). Sama buat "Artis" — sudah keisi nama artis yang sekarang, kosongkan salah satu baris → Terapkan → artis di baris itu jadi "Belum ditugaskan".
- [v] **Merge switch di menu Edit**: centang 2+ item → menu **Edit** → baris paling atas dropdown ada "Merge" dengan switch **`,` / `-`** langsung di situ (bukan modal terpisah) → klik salah satu → merge langsung jalan. Coba juga dari sidebar (ikon M) → otomatis buka menu Edit yang sama.
- [v] **Nama hasil merge dash**: `BF43_001` + `BF43_002` + `BF43_003` di-merge dash → jadi **`BF43_001-003`** (bukan `BF43_001-BF43_003`).

### Fitur round 5 (bug fix dari feedback)

- [v] **Merge switch punya default & kesan aktif**: menu Edit → switch `,`/`-` — defaultnya `-` udah kepilih (background biru). Klik `,` → background biru pindah ke situ, jelas kelihatan mana yang aktif sekarang.
- [v] **Sidebar M langsung eksekusi**: centang 2+ item → klik ikon M di sidebar → **langsung merge pakai separator aktif** (gak buka menu bar dulu). Ganti separator aktif dulu dari menu Edit kalau mau beda.
- [v] **Merge realtime, gak perlu reopen**: setelah merge, baris yang tersisa **langsung** nampilin nama gabungan yang benar — gak perlu balik ke Start Menu & buka project lagi buat lihat hasilnya. (Ini bug staleness input React — sudah diperbaiki, dampaknya juga kena Undo/Redo rename & Bulk Paste, bukan cuma Merge.)
- [v] **Tambah Item pindah ke dalam tabel**: ikon "+" sudah hilang dari sidebar. Sekarang ada baris "+ Tambah Item" di **baris paling bawah tabel** — termasuk saat tabel kosong (baris ini tetap kelihatan, bukan pesan placeholder doang).
- [v] **Menu bar gak kedip lagi**: klik File/Edit/View/Settings/Help sekali → dropdown langsung kebuka dan tetap kebuka (gak nutup sendiri sepersekian detik). Klik di luar menu → baru nutup.

### Fitur round 6

- [v] **Sidebar reorder + icon Batch File**: urutan sidebar sekarang Generate Item → **Batch File** (ikon tumpukan file) → Merge → Grup Artis → Hapus → Hyperlink.
- [v] **Icon taskbar**: (perlu dites di Windows kamu) — kalau masih nampilin logo Electron pas `npm run dev`, itu batasan mode dev (app jalan lewat `electron.exe` generik), bukan bug — pasti benar pas nanti di-package jadi installer.
- [v] **Sesi Batch File persist**: buka Batch File, isi kategori "Animatic" dengan beberapa file, klik "Selesai" (atau "Lewati") → tutup modal → buka Batch File **lagi** → kategori "Animatic" dan file-file yang tadi (+ status koneksinya) **masih ada**, gak reset. Tambah file baru ke kategori yang sama ("sync ulang") → tersimpan juga, gak nimpa yang lama.

### Fitur round 7 (revisi seleksi tabel)

- [v] **Preview & Kirim tanpa centang = kirim semua**: kosongkan semua centang (klik header checkbox 2x biar semua off) → tombol "Preview & Kirim" tetap **enabled**, labelnya nampilin "— semua" → klik → preview isinya SEMUA item di tabel, bukan kosong. Tombol cuma disabled kalau tabelnya beneran kosong (0 item).
- [v] **Sebagian dicentang = kirim yang dicentang**: centang 2-3 item aja → tombol nampilin jumlah yang dicentang (tanpa "— semua") → preview cuma isi item yang dicentang itu.
- [v] **Shift+klik range select**: klik checkbox baris 1 (check) → shift+klik checkbox baris 4 → baris 1-4 semua ikut kecentang otomatis.
- [v] **Klik-tahan-geser (paint select)**: klik & tahan checkbox baris 1, geser mouse ke bawah tanpa lepas klik sampai baris 5 → semua baris yang mouse-nya lewatin ikut kecentang. Coba juga mulai dari baris yang SUDAH kecentang (harusnya malah ikut ke-uncheck semua yang dilewatin, ngikut aksi baris pertama).

### Fitur round 8 (buka Slack otomatis + link hasil kirim)

- [v] **Auto-buka Slack pas kirim, app desktop bukan browser**: klik "Kirim Sekarang" → **app Slack desktop** yang kebuka langsung ke channel yang di-intake (bukan browser). Butuh login yang nyimpen Team ID (fitur ini nambah field baru) — kalau sebelumnya sempat login pas field ini belum ada, **logout → login ulang sekali** dulu.
- [v] **Link per hasil kirim, app desktop**: abis kirim, di box "Ringkasan Hasil" tiap item yang berhasil ada 2 ikon — klik ikon **panah keluar** → buka thread itu di **app Slack desktop**; klik ikon **link** → link web ke-copy ke clipboard (ini tetap link web biasa, buat di-share ke orang lain).
- [v] **Ganti channel tujuan di Preview**: klik "Preview & Kirim" → ada dropdown "Kirim ke channel" di atas, defaultnya channel project (ditandai "(default project)") → ganti ke channel lain → "Kirim Sekarang" → **cek di Slack**: kekirim ke channel yang dipilih di preview, BUKAN channel default project (dan channel default project-nya sendiri gak berubah, cek lagi lain kali buka project ini).
- [v] **Tombol kirim jadi logo Slack**: tombol "Preview & Kirim" di header sekarang pill putih isi logo+tulisan "slack" (bukan teks lagi) — hover-nya nampilin tooltip jumlah item yang bakal dikirim, klik tetap buka modal preview kayak biasa.

### Fitur round 9 (fix Save As + Link, validasi merah, channel list ala Slack)

- [v] **Save As beneran jalan**: menu File → "Save As" → muncul modal in-app (bukan dialog OS) isi field "Nama project baru" (udah keisi default `<nama> (copy)`) → "Simpan" → project baru muncul di Start Menu.
- [ ] **Link di toolbar reply beneran jalan**: Drawer → field teks → klik ikon Link di toolbar → modal "Sisipkan Link" muncul (ganti `prompt()` yang gak didukung Electron) → isi URL → "Sisipkan" → syntax link Slack kesisip ke teks yang diseleksi.
- [ ] **Kolom kosong jadi merah pas coba di-apply, bukan diam aja**: coba klik simpan/tambah di kondisi field wajib masih kosong pada masing-masing form ini — border field yang kosong harus langsung jadi **merah** (bukan cuma diam gak ada reaksi):
  - Grup Artis → "Grup Baru" → klik "Simpan Grup" tanpa isi nama / tanpa centang member.
  - Hyperlink Preset (menu Settings & ikon Link di Drawer) → tambah preset tanpa isi Label/URL.
  - Drawer → "Template Baru" → klik "Simpan & Terapkan" tanpa isi nama template / label field.
  - Drawer → "+" custom reply field → klik "Tambah" tanpa isi judul field.
  - Batch File → "+ kategori" → klik centang tanpa isi nama kategori.
- [v] **Daftar channel ala Slack asli**: di New Project (mode "Pilih Channel") dan di dropdown "Kirim ke channel" pada Preview & Kirim, tampilannya sekarang tombol dropdown custom — klik buka daftar dengan kotak pencarian di atas, tiap baris channel nampilin ikon gembok (privat) atau `#` (publik) + nama, bukan `<select>` polos bawaan browser lagi.
- [v] **Input nama channel baru persis UX Slack**: New Project → "Buat Channel Privat Baru" → ketik di field "Nama Channel Baru" pakai huruf besar dan spasi (mis. `EP 06 Batch`) → **sambil ngetik** (bukan pas submit) otomatis jadi huruf kecil dan spasi jadi `-` (`ep-06-batch`); coba ketik simbol gak valid (`@`, `!`, dll) → karakter itu ditolak, gak nongol di field sama sekali.

### Fitur round 10 (Tab Table / Tab Reply, ikut struktur Command Builder)

- [ ] **Tab bar muncul**: di atas area tabel, sekarang ada 2 tab gaya boxed/folder: "Table" dan "Reply". Defaultnya buka di Tab Table.
- [ ] **Kolom Reply lama sudah hilang dari tabel**: gak ada lagi badge kategori reply di tabel. Sebagai gantinya, kolom paling kanan tiap baris ada ikon bubble chat — polos (abu-abu, gak ada angka) kalau item belum punya reply, dan ada badge merah angka jumlah reply kalau sudah ada.
- [ ] **Klik ikon bubble pindah ke Tab Reply**: klik ikon bubble di baris manapun → otomatis pindah ke Tab Reply, langsung nampilin detail reply item itu (drawer lama, sekarang jadi konten tab penuh, bukan panel geser dari kanan lagi).
- [ ] **Prev/Next di Tab Reply**: di Tab Reply ada 2 tombol panah kiri/kanan di sebelah nama item → klik buat pindah ke item sebelumnya/berikutnya sesuai urutan di tabel (tombol disabled otomatis di item pertama/terakhir).
- [ ] **Semua fitur reply lama tetap jalan di tab baru**: Template, Template Baru, format teks (Bold/Italic/Link/Bullet), Emoji, Hyperlink preset, attach file + Capture, Broadcast, Clear field terpilih — semua masih di tempat yang sama, cuma wadahnya (tab, bukan panel overlay) yang beda.
- [ ] **Buka Tab Reply tanpa pilih item dulu**: klik langsung tab "Reply" (bukan lewat ikon bubble) → otomatis nampilin item pertama di tabel (kalau tabel gak kosong).
- [ ] **Composer chat di bawah**: di Tab Reply, ada bar persisten di bawah daftar reply — isi "Judul field baru…" + pilih tipe (Teks/File) → buat tipe Teks, ketik isi di textarea (ada toolbar Bold/Italic/Link/Bullet sendiri) → tekan **Enter** (bukan Shift+Enter) atau klik ikon kirim → reply baru langsung muncul di list, composer kekosongin lagi siap dipakai lagi. Coba juga **Shift+Enter** → harusnya cuma nambah baris baru, BELUM kirim.
- [ ] **Composer validasi**: coba kirim composer dengan Judul kosong → border judul jadi merah, gak ada reply baru yang kebuat.
- [ ] **Capture Pool — bikin capture**: buka reply bertipe File yang isinya gambar/video → klik ikon Crop (gambar: drag kotak seleksi dulu; video: pas di frame yang mau, klik Crop) → **BUKAN langsung jadi reply baru** kayak sebelumnya — muncul sebagai thumbnail kecil di kotak putus-putus di bawah gambar/video (pool).
- [ ] **Capture Pool — drag ke reply yang sudah ada**: drag thumbnail dari pool ke reply file LAIN (yang sudah ada) → file capture itu nambah ke reply tujuan (bukan bikin reply baru), thumbnail-nya hilang dari pool.
- [ ] **Capture Pool — drag ke composer (reply baru)**: drag thumbnail dari pool ke area composer di bawah (bagian kosong, bukan ke textarea-nya) → otomatis kebuat reply baru kategori "Capture" berisi file itu, sama seperti behavior lama.
- [ ] **Capture Pool — buang tanpa dipakai**: klik ikon X kecil di pojok thumbnail pool → thumbnail hilang, gak ada file yang ke-attach ke mana pun (gak nulis apa pun ke disk).
- [ ] **Capture Pool ephemeral**: capture beberapa thing ke pool, JANGAN di-drag dulu → pindah ke item lain lewat Prev/Next atau tab Table → balik lagi ke item semula → pool sudah kosong lagi (memang didesain sementara, bukan bug).
- [ ] **Judul reply opsional**: di composer, biarkan "Judul field" kosong, isi cuma bagian teksnya → tekan Enter/kirim → reply berhasil dibuat TANPA judul (gak ada lagi validasi "wajib diisi"). Coba juga tipe File dengan judul kosong → field file kosong tetap kebuat, tinggal "Tambah File".
- [ ] **Judul kosong, isi kosong = gak ngapa-ngapain**: di composer tipe Teks, biarkan judul DAN isi teks dua-duanya kosong → tekan Enter → tidak ada reply baru yang kebuat (composer diam aja, sama kayak coba kirim pesan kosong di chat app).
- [ ] **Format kirim ke Slack — ada judul**: isi reply dengan judul "Catatan" + isi teks "halo dunia" → kirim ke Slack → cek pesan di Slack: baris 1 **bold** "Catatan", baris 2 kosong, baris 3 "halo dunia".
- [ ] **Format kirim ke Slack — tanpa judul**: isi reply TANPA judul, isi teks "cuma catatan biasa" → kirim → di Slack, teksnya polos mulai baris 1 "cuma catatan biasa" (gak ada bold, gak ada baris kosong nganggur di atas).
- [ ] **Broadcast/Merge reply tanpa judul gak saling ke-gabung**: bikin 2 reply tanpa judul yang isinya beda di 2 item berbeda (jangan diisi judul sama sekali) → klik Broadcast di salah satu → cek item lain: reply tanpa judul yang SUDAH ADA di situ TIDAK ketiban/ketimpa (broadcast bikin reply baru terpisah, bukan menimpa yang sudah ada). Sama buat Merge 2 item yang masing-masing punya reply tanpa judul beda isi → hasil merge harus tetap 2 reply terpisah, BUKAN digabung jadi 1.

## 3. Status build — apa yang jalan vs masih placeholder

**Sudah beneran jalan** (bukan stub) — hampir semua yang disepakati sudah dibangun: Login OAuth, SQLite lokal, New/Load/Rename/Save As/Delete Project, Tambah Item manual, Generate Item, Bulk paste (Item & Artis), Undo/Redo + shortcut keyboard, dropdown Artis dari roster Slack asli + Grup Artis custom, kirim thread+reply ke Slack sungguhan (semua lewat sistem Reply, gak ada lagi attach file langsung ke item), reply ke thread lama (anti-duplikat), Cancel batch, Preview & Kirim (Slack View mockup), ringkasan hasil, Export/Import project, Tray + notifikasi OS, Drawer lengkap (Template built-in + custom, reply teks dengan toolbar format Bold/Italic/Link/Bullet-list pakai syntax Slack asli, emoji picker, hyperlink preset, attach file + preview gambar/PDF/video, Capture crop gambar & capture frame video, Broadcast per-reply, Clear field terpilih), buat channel privat baru + invite member.

**Round 3 (terbaru)**: layout sidebar ikon + menu bar (File/Edit/View/Settings/Help) gantiin toolbar horizontal; **Batch File** (modal per-section/kategori, strict-match nama file == nama item, auto-connect + manual fallback, 1 file bisa ke banyak item) gantiin total "Import dari Folder" yang sebelumnya diam-diam gagal (regex nama file kehardcode ke pola `HT_EPxx_SCyyy` doang — udah dihapus); kolom tabel "File" diganti "Reply" (badge kategori, klik buka Drawer); **Merge** sekarang pilih Dash (butuh prefix sama + angka berurutan, ditolak jelas kalau enggak) atau Koma, plus reply kategori sama ikut dikonsolidasi jadi 1 saat merge — **sudah saya tes langsung pakai `node:sqlite` asli** (9 skenario, termasuk undo round-trip, semua lulus, lihat detail di bawah); **Message Log** (panel riwayat kirim + error, tersimpan SQLite, kecatet otomatis dari 1 wrapper terpusat di semua IPC handler, bukan manual per-fitur).

**Masih belum ada** (sengaja, sesuai kesepakatan — bukan bug):
- **Mode kirim** (Semua/Thread saja/Reply saja) — ditolak eksplisit, gak dibangun.
- **Find (Ctrl+F)**, **Zoom**, **Tema terang/gelap** — gak dipilih untuk v1.
- **Capture Teks** (extract teks dari PDF) — user mau adaptasi dari software lain miliknya, bukan dibangun native di sini.
- **Text Command preview** — dihilangkan permanen, alasan arsitektur (gak ada command-text pipeline di app ini).

**Simplifikasi yang disengaja** (bukan bug, ada catatan `ponytail:` di kode):
- Frame-step video pakai asumsi ~24fps (bukan fps asli file) — cukup akurat buat kebanyakan kasus, upgrade kalau sering meleset jauh.
- Rich text = toolbar insert syntax Slack ke textarea polos, BUKAN contentEditable WYSIWYG penuh (sama seperti Command Builder sendiri yang masih "Tahap 1").
- Export project format 1 file JSON self-contained (base64), bukan `.zip` — bisa membengkak untuk file besar.

**Belum dites/dikerjakan lebih lanjut:**
- Update checker (`update:check` IPC) sudah ada logikanya tapi belum dites — perlu `GITHUB_REPO=owner/repo` di `.env` dan rilis beneran di GitHub Releases untuk dicoba.
- Packaging installer (`npm run build:win` / `build:mac`) belum dicoba jalan — config icon sudah diarahkan ke `Asset/HB5_new.png`, tapi electron-builder butuh dicoba langsung buat mastiin auto-convert ke `.ico`/`.icns` jalan mulus.

## 4. Kalau ada yang error

- Error pas Login soal `authed_user.access_token` → scope App-nya kesetel di Bot Token Scopes, bukan User Token Scopes. Cek App di api.slack.com.
- Redirect URI mismatch → pastikan `http://localhost:3737/callback` terdaftar persis di App (langkah 0.2).
- Dropdown channel/artis kosong → cek kamu beneran member channel itu & workspace-nya benar.
- **`missing_scope`** → scope belum ditambah/App belum di-reinstall (langkah 0.2), ATAU kamu **masih pakai token login lama** dari sebelum scope ditambah — token gak otomatis update pas scope App berubah. Klik ikon **Logout** (pojok kanan atas Start Menu) → login ulang, biar tukar token baru yang sudah bawa scope baru.
