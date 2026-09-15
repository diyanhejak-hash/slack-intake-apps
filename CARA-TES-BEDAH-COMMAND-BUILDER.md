# Cara Tes — Bedah Command Builder (eksekusi bertahap, 2026-09-16)

File test terpisah dari `CARA-TES.md` (yang isinya alur inti/fondasi) — ini khusus buat melacak eksekusi seluruh temuan "Bedah Lanjutan Command Builder" di `rancangan-desain.md` (bagian A-G). Notasi sama: `[v]` = terbukti jalan, `[x]` = terbukti gak jalan/ada bug, `[ ]` = belum ditest, `[-]` = sengaja belum ditest.

Setiap kali satu fase dikerjakan, checklist fase itu diisi & status di poin 0 di-update.

## 0. Status eksekusi per fase

| Fase | Isi | Status |
|---|---|---|
| 1 | D1 — Reply unified field | ✅ Selesai (2026-09-16), lihat §1 |
| 2a | H1 — WYSIWYG Lexical (bagian dari Fase 2) | ✅ Selesai (2026-09-16), lihat §2 |
| 2b | C1-C9 — Restrukturisasi Tab Reply (sisa Fase 2) | ✅ Selesai (2026-09-16), lihat §2 |
| 3 | E1-E7, F1-F4, G1-G4 — Video/PDF/image viewer | ✅ Selesai (2026-09-16), lihat §3 |
| 4 | A3, B4, B6, B7 — Polish tabel & merge | ✅ Selesai (2026-09-16), lihat §4 |

Referensi lengkap tiap poin (kenapa diputuskan, detail dari mana) ada di `rancangan-desain.md` bagian "Bedah Lanjutan Command Builder — Temuan Detail (2026-09-16)".

---

## 1. Fase 1 — D1: Reply unified field ✅ (siap dites)

**Sebelum**: reply punya `type: "text" | "file"`, 1 field HARUS pilih salah satu (gak bisa dua-duanya).
**Sesudah**: field unified — 1 field reply bisa isi teks DAN lampirkan file sekaligus, gak ada lagi pemilihan tipe di mana pun.

Perubahan kode: `electron/db.cjs` (seed template built-in gak lagi punya `type` per field), `electron/projects.cjs` (`addReplyWithFiles` gak terima param `type` lagi, category fallback ke id kalau judul kosong — sudah ada sebelumnya, tetap jalan), `src/screens/Drawer.tsx` (`ReplyRow` render textarea+file-list SEKALIGUS bukan branch, composer gak ada dropdown Teks/File lagi, `TemplateBuilder` field cuma butuh label), `src/screens/MainTable.tsx` (`SlackViewPreview` tampilin teks+jumlah file bareng, bukan pilih salah satu), `src/global.d.ts` (`TemplateField`/`Reply.type` dihapus dari tipe).

**Sudah diverifikasi otomatis** (bukan lewat GUI, lewat kode): `tsc --noEmit` bersih, `npm run build:renderer` bersih, `node -c` di `db.cjs`+`projects.cjs` bersih, dan standalone test `node:sqlite` (3 skenario: field unified nyimpen title+text+file bareng, judul kosong fallback category ke id sendiri, 2 reply tanpa judul beda item TIDAK share category) — semua lulus.

Checklist manual (perlu kamu tes langsung di app):

- [ ] **Composer bisa isi judul + teks tanpa mikirin tipe**: buka Tab Reply, di composer bawah cuma ada 1 input judul + 1 textarea (gak ada dropdown Teks/File lagi) → isi judul + teks → Enter → reply baru muncul.
- [ ] **Field hasil composer bisa DITAMBAHIN file juga**: pada reply yang baru dibuat dari composer (yang ada teksnya) → klik "Tambah File" di bawah textarea-nya → pilih file → file nempel ke field YANG SAMA (bukan bikin field baru) → cek juga: teks yang tadi diisi masih ada, gak ketimpa.
- [ ] **Template Baru gak nanya tipe lagi**: Drawer → "Template Baru" → form field cuma ada input Label (gak ada dropdown Teks/File) → isi beberapa field → Simpan & Terapkan → field-field muncul, semua bisa diisi teks DAN file (coba salah satu: isi teksnya, lalu tambah file juga).
- [ ] **Reply lama (dibuat sebelum update ini) masih kebaca normal**: buka project lama yang sudah ada reply-nya dari sebelum round ini → semua field tetap tampil & bisa diedit (teks & file section-nya keduanya selalu ada di tiap field sekarang, bukan cuma salah satu kayak dulu).
- [ ] **Kirim ke Slack — field yang punya teks+file bareng**: isi 1 field dengan teks DAN file sekaligus → kirim ke Slack → cek di Slack: 1 pesan/upload dengan caption teksnya, bukan 2 pesan terpisah.
- [ ] **Broadcast & Merge reply tanpa judul tetap gak saling ke-gabung** (regression check — logic ini gak diubah round ini tapi ikut kesentuh file-nya): ulang test yang sama dari round sebelumnya kalau belum sempat — 2 reply tanpa judul beda isi di 2 item beda → Broadcast salah satu → cek yang satu lagi TIDAK ketiban.

---

## 2. Fase 2 — C1-C9 + H1: Restrukturisasi Tab Reply

### 2a. H1 — WYSIWYG Lexical ✅ (siap dites)

Toolbar Bold/Italic/Link/Bullet di `ReplyRow` DAN composer sekarang WYSIWYG beneran (pakai `lexical`+`@lexical/react`, komponen baru `src/screens/RichTextEditor.tsx`), bukan lagi textarea polos + insert-syntax-mentah (`src/lib/textFormat.ts` sudah dihapus, sudah gak dipakai). Data yang tersimpan/terkirim ke Slack **tetap string mrkdwn murni** — cuma lapisan tampilannya yang beda, lihat transformer custom di `src/lib/slackMarkdown.ts` (Bold `*`, Italic `_` reuse bawaan Lexical, Bullet `- ` reuse bawaan, Link custom `<url|label>`).

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih, dan self-check headless (`@lexical/headless`, tanpa DOM) round-trip 7 skenario (bold, italic, campur bold+italic, link, bullet list 3 item, teks polos, teks dengan baris kosong di tengah) — **semua pass persis** (input mrkdwn == output mrkdwn setelah parse→lexical→serialize ulang).

Checklist manual:

- [ ] **Bold/Italic keliatan BENERAN bold/italic pas ngetik** (bukan tanda bintang mentah lagi): di reply field mana pun atau composer, select teks → klik Bold → teksnya jadi TEBAL di layar (bukan `*teks*` literal). Sama buat Italic.
- [ ] **Bullet list**: klik tombol Bullet → baris jadi list bertitik visual (bukan `- ` literal di layar).
- [ ] **Link**: klik tombol Link → isi URL di modal → teks yang diseleksi (atau URL-nya sendiri kalau gak ada seleksi) jadi link biru bergaris bawah, BUKAN teks `<url|label>` mentah.
- [ ] **Reply LAMA (mrkdwn tersimpan dari sebelum H1) kebaca benar**: buka reply yang sudah ada isinya dari sebelum update ini (ada `*bold*`/`_italic_`/link/bullet di teksnya) → pas dibuka, tampil WYSIWYG (bold beneran bold, dst.), bukan tanda baca mentah nyangkut di layar.
- [ ] **Simpan & kirim ke Slack tetap akurat**: edit reply pakai WYSIWYG (bold beberapa kata, tambah link) → kirim ke Slack → cek pesannya di Slack: bold/italic/link kebaca benar sebagai formatting Slack asli (bukan tanda bintang/underscore/kurung-sudut mentah muncul di pesan).
- [ ] **Emoji & Hyperlink preset toolbar (global, bawah Drawer) masih nyambung ke field yang lagi fokus**: klik salah satu field/composer dulu (biar "aktif"), lalu klik emoji di toolbar bawah → emoji nempel di situ. Sama buat Hyperlink preset — klik preset yang sudah disimpan → **link beneran (biru, bergaris bawah)** nempel di field yang tadi aktif, bukan teks `<url|label>` mentah.
- [ ] **Composer Enter/Shift+Enter tetap jalan**: ketik di composer → Enter → reply baru terkirim & composer kosong lagi (siap dipakai lagi, WYSIWYG-nya juga ke-reset bersih). Shift+Enter → cuma nambah baris baru, belum submit.
- [ ] **Undo/Redo dalam 1 field** (bawaan history Lexical, fitur baru yang gak ada di textarea manual dulu): ketik beberapa kata di 1 field → Ctrl+Z (fokus di field itu) → teks balik ke sebelumnya. Ini LOKAL ke field itu doang, beda dari Undo/Redo besar punya app (Ctrl+Z global buat perubahan struktural item/merge/dst.) — cek juga dua-duanya gak saling ganggu (Ctrl+Z pas fokus di field teks harusnya cuma pengaruh ke teks itu, bukan ikut undo perubahan struktural tabel).

### 2b. C1-C9 — Restrukturisasi Tab Reply ✅ (siap dites)

Layout Tab Reply sekarang 2 kolom: `DisplayPane` (kiri, panel media terpadu) + `.form-pane` (kanan, artis + daftar reply + composer, lebar tetap 420px). Backend baru: IPC `item:removeFile` (General Display), `reply:removeManyEverywhere` (clear scope semua item), `reply:reorder` (drag-reorder) — semua nge-reuse tabel/fungsi yang sudah ada (`item_files` ternyata sudah lama ada dari alur "attach langsung", cuma belum ke-surface di UI sebagai General Display).

**Satu penyederhanaan sengaja dari rencana awal (dicatat, bukan disembunyikan)**: C3 aslinya juga minta mode BACA (bubble ringkas) vs mode EDIT (klik dulu baru field kebuka) — bagian itu **tidak dibangun**. Card reply sekarang selalu bisa langsung diedit (gak ada toggle read/edit), cuma bagian VISUAL (bubble + avatar drag-handle + hover-reveal aksi) yang diadopsi. Alasan: mode baca butuh renderer markdown-ke-tampilan-ringkas terpisah yang beresiko kalau digarap buru-buru; always-edit juga sudah dikonfirmasi sebagai opsi valid sebelumnya (bukan mundur dari kesepakatan, cuma scope lebih kecil dari yang diminta).

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih, `node -c` di semua `.cjs`, cross-check channel IPC main↔preload cocok semua.

Checklist manual:

- [ ] **Layout 2 kolom muncul**: buka Tab Reply → kiri ada panel media (chip file + area preview), kanan ada Artis + daftar reply + composer (lebar tetap, gak ngikut lebar window).
- [ ] **General Display — tambah file referensi**: di panel kiri, klik ikon "+" di pojok kiri chip-bar → pilih file (gambar/video/PDF apa aja) → chip baru muncul dengan ikon pin (nandain "General", beda dari file yang datang dari reply) → klik chip itu → file-nya tampil di area preview.
- [ ] **General Display — hapus**: hover/lihat chip General Display → klik ikon X kecil di chip itu → chip hilang, gak ngefek ke reply manapun.
- [ ] **Chip dari reply juga muncul di panel kiri**: attach file ke salah satu reply (lewat "Tambah File") → balik ke panel kiri → chip baru muncul (tanpa ikon pin, gak bisa dihapus dari sini — cuma dari reply-nya).
- [ ] **Klik chip = ganti preview**: klik beda-beda chip → area preview di bawah ganti sesuai file yang diklik, chip yang aktif kelihatan beda (border warna accent).
- [ ] **Artis bisa diganti dari Tab Reply**: dropdown Artis di atas daftar reply (kanan) → ganti artis → cek balik ke Tab Table, kolom Artis ikut berubah (data sama, cuma 2 pintu).
- [ ] **Gaya bubble + hover-reveal**: card reply — avatar bulat (ikon drag) di kiri header. Hover ke card → checkbox/tombol Broadcast/Hapus baru kelihatan jelas (sebelumnya samar/opacity rendah). Centang salah satu reply → actions-nya tetap kelihatan jelas walau mouse udah gak di atas card itu (gara-gara lagi "selected").
- [ ] **Drag-reorder reply**: drag avatar salah satu reply card, drop di atas reply card lain → urutannya pindah, dan urutan itu tetap kepake pas project ditutup-buka lagi (bukan cuma sementara di layar).
- [ ] **Clear field terpilih — 2 tombol**: centang beberapa reply field → muncul 2 tombol: "Hapus N" (biasa) dan "Hapus di Semua Item". Klik "Hapus N" → cuma field di item ini yang hilang. Centang lagi di item lain (field kategori SAMA persis nama judulnya) → klik "Hapus di Semua Item" → muncul konfirmasi → OK → field itu ilang di SEMUA item yang kategorinya sama (termasuk yang di item lain), field yang kategorinya beda tetap aman.
- [ ] **Fullscreen**: klik ikon expand di header Tab Reply → Drawer melebar nutupin seluruh window (termasuk nutup sidebar/menu bar) → klik ikon lagi (sekarang collapse) → balik ke ukuran normal di dalam Tab Reply.
- [ ] **Panah kiri/kanan pindah item**: di Tab Reply, JANGAN fokus di field teks manapun → tekan panah kanan → pindah ke item berikutnya (drawer refresh nampilin item itu). Panah kiri → balik. Coba juga pas fokus lagi di salah satu field reply (WYSIWYG) → panah kiri/kanan harusnya JADI navigasi kursor teks biasa, BUKAN ganti item.
- [ ] **Shortcut Capture (`C`) & frame-step (`,`/`.`) di file yang lagi dipreview**: pilih chip video di panel kiri → tekan `,`/`.` (gak lagi fokus di field teks) → video mundur/maju 1 frame. Tekan `C` → trigger capture frame (masuk ke Capture Pool, sama kayak klik tombol Crop manual). Ganti ke chip gambar → tekan `C` → toggle mode crop (drag-select kotak) nyala/mati.

---

## 3. Fase 3 — E1-E7, F1-F4, G1-G4: Video/PDF/Image viewer ✅ (siap dites)

Dependency baru: `mp4box` (auto-detect FPS), `pdfjs-dist` (PDF render) — dua-duanya bundled lokal via npm/Vite, BUKAN CDN (konsekuensi kebijakan CSP kita sendiri, lihat poin F di rancangan). Komponen baru `src/screens/PdfViewer.tsx` (viewer PDF penuh: zoom-di-kursor, pan drag, capture quality 1x-4x, page rail) dan `src/lib/videoFps.ts` (fetch bytes + parse mp4box, fallback `null` kalau gagal). Video player di `FilePreview` (Drawer.tsx) dapat FPS auto-detect, Loop range, Speed control, readout frame presisi via `requestVideoFrameCallback`.

**E5 (persist playback state lintas navigasi) SENGAJA TIDAK dibangun** — butuh restrukturisasi besar (video jadi elemen DOM yang di-reparent di luar siklus render React, bukan komponen biasa) yang bentrok sama keputusan `key={activeItem.id}` di MainTable (dipilih sengaja sebelumnya buat hindari bug stale-state pas ganti item). Video/PDF sekarang reset ke awal tiap ganti item/tab — dicatat sebagai gap yang sadar, bukan lupa.

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih (bundle naik ke ~1.2MB + worker pdf.js ~2.2MB terpisah — wajar buat app desktop lokal, gak dikejar code-splitting), `node -c` semua `.cjs`, cross-check IPC cocok, plus self-check matematika seek (G1) via Node standalone — 4 skenario (termasuk kasus klasik floating-point 5.0×24fps yang biasa salah bulat) semua lulus.

Checklist manual:

- [ ] **FPS auto-detect video MP4/MOV**: buka reply dengan file video MP4 → cek indikator "auto" di sebelah input FPS → angkanya masuk akal (24/25/30/dst, bukan default 24 kalau video aslinya beda). Coba juga video format lain (MOV, atau video hasil ekspor aneh) → kalau auto-detect gagal, field FPS tetap bisa diisi manual (default 24), gak nge-block apa pun.
- [ ] **Loop range**: di video, klik "[ awal" di satu posisi, geser video maju, klik "akhir ]" di posisi lain → centang Loop → play → video otomatis lompat balik ke titik awal begitu nyampe titik akhir, terus muter (bukan berhenti).
- [ ] **Speed control**: pilih 2x → video main 2x lebih cepat. Pilih 0.25x → super lambat. Balik ke 1x → normal.
- [ ] **Step frame presisi**: klik panah kiri/kanan di kontrol video → maju/mundur PERSIS 1 frame (angka "Frame N" di caption naik/turun 1 tiap klik, gak meleset/lompat 2).
- [ ] **PDF sekarang bisa di-capture**: buka reply dengan file PDF → BUKAN lagi kotak putih polos (iframe) — ada toolbar zoom + tombol Crop. Klik Crop → toggle mode capture → drag kotak di salah satu halaman → lepas → thumbnail masuk ke Capture Pool (sama kayak capture gambar/video).
- [ ] **PDF zoom bertumpu di kursor**: scroll dengan Ctrl ditahan di atas PDF → PDF zoom in/out, dan titik yang di bawah kursor TETAP di posisi yang sama di layar (gak "kabur" ke pojok). Tombol +/- di toolbar juga jalan. Tombol "Fit" balikin ke ukuran awal.
- [ ] **PDF pan (drag buat geser)**: pas PDF di-zoom sampai lebih besar dari area viewport (perlu di-scroll) → klik-tahan-geser di mana pun di area PDF (bukan lagi mode Crop) → PDF ikut geser ngikutin mouse.
- [ ] **PDF multi-halaman render semua sekaligus**: buka PDF beberapa halaman → scroll ke bawah → semua halaman kebaca, bukan cuma halaman 1 doang atau kosong pas discroll cepat.
- [ ] **Page rail (F4)**: di sisi kiri viewer PDF ada strip bulatan bernomor. Klik salah satu → scroll otomatis ke halaman itu. Hover di area bulatan (bukan cuma satu, di mana pun di strip-nya) → semua judul halaman muncul sebagai label (judul diambil dari teks terbesar di tiap halaman, atau "Halaman N" kalau PDF-nya scan gambar tanpa teks).
- [ ] **Capture quality PDF**: toggle mode Crop → muncul dropdown kualitas 1x-4x → pilih 4x → capture area kecil → hasilnya tetap tajam walau PDF-nya lagi di-zoom out jauh (dibanding coba di 1x, hasilnya lebih buram di area yang sama).
- [ ] **Shift+panah = 10 frame, Home/End = awal/akhir**: fokus di video yang lagi dipreview (bukan fokus di field teks) → Shift+panah kanan → lompat 10 frame sekaligus. Tekan Home → langsung ke frame 0. Tekan End → langsung ke frame terakhir video.
- [ ] **Zoom native Electron gak bentrok**: di dalam viewer PDF, Ctrl+scroll HARUS cuma zoom PDF-nya doang — pastikan SELURUH window app (menu, sidebar, dst.) TIDAK ikut membesar/mengecil bareng.

---

## 4. Fase 4 — A3, B4, B6, B7: Polish tabel & merge ✅ (siap dites)

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih, `node -c projects.cjs` bersih, plus self-check standalone Node buat A3 (4 skenario: step +1 konsisten, step +10 konsisten, step BENERAN gak rata harus ditolak, mode koma tetap jalan walau gak rata) — semua lulus.

Checklist manual:

- [ ] **A3 — Merge dash tolak step gak rata**: centang 3 item dengan nomor gak berpola rata (mis. `X_001`, `X_003`, `X_009` — selisihnya 2 lalu 6) → pilih Merge dash → HARUS muncul error jelas (bukan hasil `X_001-009` yang nyamarin), sarankan pakai koma.
- [ ] **A3 — Merge dash tetap terima step rata**: centang item dengan step KONSISTEN walau bukan +1 (mis. `SC_0080`, `SC_0090`, `SC_0100`, step +10 semua) → Merge dash → berhasil jadi `SC_0080-0100`.
- [ ] **B4 — Template ke semua item**: di Tab Table, klik header kolom paling kanan (ikon template kecil) → modal "Template ke Semua Item" muncul, daftar template built-in+custom → pilih salah satu → muncul konfirmasi jumlah item → OK → field-field template itu muncul di SEMUA item project ini (cek beberapa item beda, bukan cuma yang lagi aktif).
- [ ] **B6 — Kolom NO**: tabel utama sekarang ada kolom "No" di antara checkbox dan Item, isinya nomor urut 1, 2, 3, dst mengikuti urutan baris.
- [ ] **B7 — Polish visual**: header tabel ada tint warna (background beda dari body, teks warna accent, center-align). Baris genap (2, 4, 6, ...) punya shade background beda tipis dari baris ganjil (zebra-stripe) — kecuali pas di-hover, yang tetap ambil alih warna hover seperti biasa. Isi sel (Item/Artis/Status/dst) rata tengah.

---

## 5. Perbaikan layout Tab Reply — susulan feedback screenshot (2026-09-16) ✅ (siap dites)

User kirim screenshot app beneran (bukan asumsi) yang nunjukin layout masih berantakan dibanding referensi `Asset/Ref/ui-ux.png` — kontrol video numpuk jadi 1 baris (timecode ketiban nama file, checkbox Loop ketutupan), dan yang paling parah: viewer video LENGKAP (kontrol capture, dll) ke-render DOBEL — sekali di panel kiri (DisplayPane), sekali lagi di kartu reply kanan.

**Perbaikan**:
- **Kartu reply kanan sekarang cuma nampilin file compact** (`FileChip` baru — thumbnail kecil + nama + × hapus 1 baris), BUKAN lagi viewer lengkap. Viewer lengkap (kontrol play/capture/dst.) SEKARANG CUMA ADA di panel kiri (DisplayPane).
- Tambah IPC baru `reply:removeFile` — sebelumnya gak ada cara hapus SATU file dari reply yang punya banyak file, cuma bisa hapus reply-nya total.
- Video player dirombak: letterbox hitam + tombol play besar di tengah (nyala pas pause), seek bar (slider drag-scrub) + timecode format `HH:MM:SS:FF`, kontrol dipecah jadi 2 baris rapi (bar transport, lalu bar Loop/FPS/Speed) — bukan numpuk 1 baris kayak sebelumnya.
- Chip di panel kiri (DisplayPane) sekarang truncate rapi (`...` kalau nama kepanjangan) + background biru muda pas aktif, sesuai referensi.
- Kartu reply background jadi bubble abu-abu lembut (bukan kotak bergaris), tambah label "Replies (N)" di atas daftar.

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih, `node -c` semua `.cjs`, cross-check IPC cocok.

Checklist manual:

- [ ] **Gak ada lagi video/gambar dobel**: buka Tab Reply pada item yang reply-nya punya file — video/gambar viewer LENGKAP (kontrol play, dll) cuma nongol SEKALI di panel kiri. Di kartu reply kanan, file itu cuma tampil sebagai 1 baris kecil (thumbnail + nama + ×).
- [ ] **Hapus 1 file dari kartu reply**: klik × di baris file compact (kartu kanan) → file itu ilang dari reply-nya (kalau reply itu punya file lain, sisanya tetap ada; teks reply-nya juga gak kesentuh).
- [ ] **Video player rapi, gak numpuk**: buka reply dengan video di panel kiri — ada letterbox hitam + tombol play besar di tengah pas video di-pause. Kontrol di bawahnya kebagi jelas 2 baris (bar transport dengan seek-slider+timecode di baris 1, Loop/FPS/Speed di baris 2) — TIDAK ada teks/kontrol yang numpuk/ketiban satu sama lain.
- [ ] **Seek bar bisa di-drag**: drag slider di bar transport video → video ikut lompat ke posisi itu.
- [ ] **Timecode format jelas**: format `00:00:00:04 / 00:00:01:16` (jam:menit:detik:frame), bukan angka desimal mentah.
- [ ] **Chip DisplayPane truncate rapi**: kalau nama file kepanjangan, chip di panel kiri kepotong jadi "..." (hover buat lihat nama lengkap), bukan bikin baris chip jadi lebar banget/berantakan. Chip yang lagi aktif ada background biru muda, bukan cuma garis tepi doang.

---

## 6. Restrukturisasi lanjutan sesuai penjelasan detail ref UI (2026-09-16) ✅ (siap dites)

Setelah §5, user minta konfirmasi pemahaman referensi `Asset/Ref/ui-ux.png` dulu (dijelasin region-per-region), lalu instruksi: "aplikasikan semua, kecuali panah besar kiri dan kanan". Panah navigasi besar di tepi luar panel (kiri/kanan seluruh Tab Reply) **sengaja TIDAK dibangun** sesuai instruksi eksplisit itu — panah kecil di header item-nav (`‹ ITEM n/N ›`) sudah cukup buat navigasi.

**Perbaikan struktural**:
- **Header item-nav pindah ke DisplayPane** (panel kiri), bukan lagi di header Drawer yang melebar full-width. Sekarang isinya: `‹` / "ITEM n/N" / `›` di kiri, pill nama item (bisa diedit — klik ikon pensil) + ikon fullscreen + ikon X (tutup, balik ke Tab Table) di kanan. Nama item disimpan lewat `window.api.item.update` yang sudah ada.
- **Baris "Replies (N)" sekarang punya 2 ikon** di sampingnya: kotak centang (pilih semua/batal — toggle) dan tong sampah (hapus field yang lagi dicentang di item ini). Tombol "Hapus di Semua Item" (scope lebih destruktif, sudah ada dari round sebelumnya) tetap ada, muncul di bawahnya begitu ada yang dicentang.
- **Kartu reply direstrukturisasi**: avatar drag-handle + checkbox + tombol Broadcast/Hapus sekarang di LUAR bubble (baris tipis di atasnya), bukan di dalam kotak abu-abu lagi — bubble di bawahnya cuma isi judul (baris pertama, tetap bisa diedit inline) + konten teks + daftar file, sesuai referensi (avatar+aksi nempel di atas, bubble cuma isi konten).
- CSS: scope hover-reveal aksi (`.reply-actions`) pindah dari `.reply-bubble` ke `.reply-block` (wrapper baru yang bungkus header-luar + bubble), soalnya aksinya sekarang di luar bubble.

**Sengaja tidak diikuti dari referensi** (dicatat, bukan lupa):
- Panah navigasi besar di tepi kiri/kanan panel — skip sesuai instruksi user.
- Teks nama "HejBot" (avatar+nama poster) di atas tiap bubble — referensi nunjukin nama bot statis, tapi app ini gak punya konsep "poster identity" per-reply di data model-nya (semua reply dari 1 user aplikasi yang sama). Nambahnya berarti bikin field baru yang gak representasikan data asli — avatar (drag-handle) tetap ada, cuma teks nama-nya di-skip. Kalau nanti mau nampilin nama artist/user pengirim di situ, kasih tau field mana yang mau dipakai.
- Skin gelap penuh pada seluruh widget video (video+transport+loop-row+capture-strip jadi 1 kotak gelap seragam) — bagian letterbox video sendiri sudah gelap (dari §5), tapi baris kontrol di bawahnya tetap terang (konsisten sama tema app secara keseluruhan) — warna gelap total butuh keputusan desain baru (kontras teks, dst.) yang belum diminta eksplisit.

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih.

Checklist manual:

- [ ] **Header item-nav ada di panel kiri (bukan full-width lagi)**: buka Tab Reply — baris `‹ ITEM n/N ›` + pill nama item cuma selebar panel kiri (DisplayPane), bukan lagi membentang penuh di atas kedua kolom.
- [ ] **Rename item dari pill**: klik ikon pensil di sebelah pill nama item → pill jadi input, ubah nama → klik di luar (blur) atau Enter → nama item berubah (cek juga kebawa ke Tab Table).
- [ ] **Fullscreen & Close jalan dari lokasi baru**: klik ikon expand di header DisplayPane → Drawer fullscreen. Klik ikon X → balik ke Tab Table.
- [ ] **Pilih-semua & hapus dari baris Replies (N)**: klik ikon kotak-centang di sebelah label "Replies (N)" → semua reply di item ini kecentang (ikon berubah jadi centang-terisi). Klik lagi → batal semua. Centang beberapa manual, klik ikon tong sampah di baris itu → cuma yang dicentang yang hilang.
- [ ] **Avatar/aksi di luar bubble**: tiap kartu reply — baris tipis di ATAS kotak abu-abu berisi avatar bulat (drag-handle), checkbox, tombol Broadcast & Hapus. Kotak abu-abu di bawahnya cuma isi judul (baris pertama, bold) + teks + file — TIDAK ada checkbox/avatar/broadcast/hapus di dalam kotak abu-abu itu.
- [ ] **Hover-reveal aksi tetap jalan di posisi baru**: hover ke kartu reply (area avatar ATAU bubble) → tombol Broadcast/Hapus & checkbox jadi jelas kelihatan. Center salah satu → actions tetap jelas walau mouse pindah (karena "selected").
- [ ] **Drag-reorder masih jalan**: drag avatar (sekarang di baris luar) ke kartu lain → urutan reply pindah, persist setelah tutup-buka project.

---

## 7. Revisi UI detail — feedback poin-per-poin (2026-09-16) ✅ (siap dites)

User kasih feedback super detail per bagian UI setelah §6 ("masih banyak yang salah"), termasuk beberapa hal yang **membalikkan keputusan §6** — dicatat eksplisit biar gak bingung baca riwayatnya:
- **§6 nambah pensil/fullscreen/X di header item-nav DisplayPane → sekarang DIHAPUS LAGI.** Header "Item" sekarang baris terpisah di ATAS `Display | Field` (bukan di dalam DisplayPane), isinya cuma nav kiri/kanan + nama item center, bersih gak ada ikon lain.
- **§6 mindahin avatar/checkbox/broadcast/hapus ke LUAR bubble → sekarang BALIK ke DALAM**, 1 baris bareng judul: Drag, Judul, Checkbox, Broadcast, Trash (urutan sesuai instruksi terbaru).

**Perubahan lain (baru, bukan pembalikan)**:
- **Backend**: tabel baru `project_files` (beda dari `item_files`) — General Display sekarang level PROJECT, IPC baru `project:attachFiles`/`project:removeFile`. Semua fungsi staging file (`stageFile`/`stageCopy`/`stageWrite` di `projects.cjs`) dirombak: folder tujuan sekarang UNIK PER FILE (uuid jadi nama folder), bukan lagi prefix di depan nama file — jadi nama file yang kesimpen/ketampil PERSIS nama asli, gak ada kode nempel di depan.
- **Item bar**: nav kiri/kanan + nama item center, bersih (lihat pembalikan §6 di atas).
- **DisplayPane**: video sekarang `object-fit:contain` ngisi flex penuh section (bukan `max-height:420` tetap) — fit ke ukuran section apa pun. Loop/FPS/Speed disembunyikan default, cuma nongol pas video di-fullscreen (tombol expand baru di transport bar, KHUSUS video ini — beda dari fullscreen Drawer yang udah dihapus). Capture sekarang "sniping tool": klik Capture → modal drag-select area → preview hasil crop → confirm baru masuk pool (`CaptureModal`, ganti `CropOverlay` lama yang capture instan).
- **Field (reply card)**: border sekarang KELIHATAN JELAS (bukan transparent lagi) biar antar-field ke-lihat batasnya. Tool text (Bold/Italic/Link/Bullet/Number-list baru/Emoji/Tambah-file) disembunyikan default, CUMA nongol pas klik ke text area-nya (`:focus-within`). Text area sekarang bisa terima drag-drop file native dari luar (highlight border pas ditarik di atasnya) DAN paste gambar/file langsung. Tombol "Tambah File" lama di bawah textarea dihapus (pindah jadi ikon di toolbar). Composer chat di bawah list dihapus total, ganti tombol simpel "+ Field" yang bikin field kosong. File yang attached di tiap field sekarang bisa DIKLIK buat buka preview-nya di DisplayPane kiri.
- **General revisi**: keterangan channel (`# nama-channel`) di header project dihapus. Tombol "Kirim ke Slack" pindah ke ujung kanan MenuBar (baris File/Edit/View/Settings/Help), ukurannya dikecilin biar pas di baris menu.

**Sengaja tidak diikuti** (dicatat, bukan lupa):
- Panah navigasi BESAR di tepi kiri/kanan seluruh panel — user secara eksplisit gak minta ini di revisi manapun (dan diminta skip di instruksi sebelumnya), jadi tetap belum dibangun.
- Preset Hyperlink (picker cepat pilih link tersimpan) yang dulu ada di toolbar bawah Drawer — dihapus dari toolbar per-field karena daftar tool eksplisit yang diminta cuma "Bold, italic, Link, list, number list, Emoji, Tambah file" (gak nyebut preset). Fitur KELOLA preset (simpan/hapus link) masih ada normal lewat menu Settings → Hyperlink Preset (`HyperlinkManager` di `MainTable.tsx`, gak disentuh) — cuma jalur INSERT cepat dari dalam field yang dihapus.

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih, `node -c` semua `.cjs`, cross-check channel IPC main↔preload cocok semua (termasuk 2 channel baru `project:attachFiles`/`project:removeFile`).

Checklist manual:

- [ ] **Item bar bersih**: baris paling atas Tab Reply — cuma nav `‹`/`›` (kiri-kanan) + nama item center, gak ada ikon lain (pensil/fullscreen/X).
- [ ] **General Display gak reset pas ganti item**: tambah file lewat "+" di panel kiri → pindah ke item lain (pakai nav) → chip General Display (ikon pin) yang tadi masih ada, gak ilang.
- [ ] **Nama file bersih**: attach file baru (General Display ATAU lewat toolbar field) → nama yang tampil di chip/file-row PERSIS nama file aslinya, gak ada kode/uuid nempel di depan.
- [ ] **Video fit ke section**: buka video di panel kiri — video ngisi penuh lebar/tinggi section (letterbox nyesuaiin), gak kepotong/gak nyisa area kosong gede.
- [ ] **Loop/FPS/Speed cuma pas fullscreen**: video NORMAL (gak fullscreen) — cuma ada baris transport (play/step/capture/seek/timecode/expand), TANPA baris Loop/FPS/Speed. Klik ikon expand di ujung kanan transport → video fullscreen, baris Loop/FPS/Speed muncul. Klik lagi → balik normal, baris itu ilang lagi.
- [ ] **Capture ala sniping tool**: klik ikon Capture (video atau gambar) → modal kebuka nampilin source-nya → drag pilih area → lepas mouse → modal ganti tampilan jadi PREVIEW hasil crop-nya (bukan langsung masuk pool) → klik "Simpan ke Pool" baru masuk. Tombol "Ulangi" balik ke mode pilih area lagi.
- [ ] **Field ada border jelas**: tiap kartu reply kelihatan garis pembatasnya (bukan nyatu tanpa batas kayak sebelumnya).
- [ ] **Urutan header field**: drag-handle, lalu input judul, lalu checkbox, lalu ikon Broadcast, lalu ikon Hapus — semua 1 baris.
- [ ] **Tool text muncul pas fokus**: klik ke area teks field (bukan ke judul) → baris toolbar (Bold/Italic/Link/Bullet/Number-list/Emoji/Tambah-file) baru muncul. Klik di luar field → toolbar ilang lagi. Klik salah satu tombol toolbar (mis. Bold) → toolbar TETAP kelihatan (gak collapse duluan sebelum sempat diklik).
- [ ] **Drag-drop file native ke field**: buka File Explorer, drag 1 file ke atas salah satu field → field itu keliatan ke-highlight (border biru) selama file ditarik di atasnya → lepas → file otomatis ke-attach ke field itu.
- [ ] **Paste gambar ke field**: copy gambar (mis. screenshot) → klik ke text area field → Ctrl+V → gambar ke-attach ke field itu (bukan malah ke-paste sebagai teks/gagal).
- [ ] **Tombol "+ Field"**: di bawah daftar reply (pengganti composer lama) → klik → 1 field kosong baru muncul di list, siap diisi judul/teks/file langsung di card-nya.
- [ ] **Klik file attached buka preview**: di salah satu field yang punya file, klik baris file-nya (bukan tombol ×) → panel kiri (DisplayPane) ganti nampilin file itu.
- [ ] **Channel gak nongol di header**: header project (nama project) TIDAK ada lagi teks "# nama-channel" di bawahnya.
- [ ] **Tombol Kirim di MenuBar**: tombol "Kirim ke Slack" sekarang ada di ujung kanan baris menu (File/Edit/View/Settings/Help), bukan lagi di header atas.
- [ ] **Thumbnail gambar di file attached**: field yang attach file gambar (bukan video/PDF) → baris file-nya nampilin THUMBNAIL kecil gambar itu (bukan cuma ikon generik).

---

## 8. Bug fix ronde §7 — screenshot + testing manual pertama (2026-09-16) ✅ (siap dites)

User coba §7 langsung dan nemu beberapa bug nyata + 2 poin yang butuh source code eksternal (belum ada di project ini, nunggu user kasih).

**Root cause paling penting — drag-drop file gak jalan sama sekali**: Electron 32+ SUDAH GAK nempelin `.path` otomatis ke `File` object hasil drag-drop lagi (dihapus demi keamanan) — kode round sebelumnya masih pakai cara lama `(file as any).path` yang sekarang selalu `undefined`. Fix: expose `webUtils.getPathForFile()` (API resmi pengganti) lewat `preload.cjs` sebagai `window.api.file.getPathForFile()`, dipakai di semua jalur drag-drop & paste-file.

**Fix lain**:
- **Drag-highlight kedip-kedip**: dragenter/dragleave nembak ulang tiap kali kursor pindah ke elemen ANAK di dalam card (event bubbling) — fix pakai counter (`dragCounter`), bukan boolean langsung. Area deteksi juga dipindah ke SELURUH card field (bukan cuma text area), sesuai instruksi.
- **Emoji gak ke-insert pas text area kosong**: klik tombol toolbar (termasuk Emoji) narik fokus DOM keluar dari editor SEBELUM handler `onClick`-nya jalan → Lexical baca selection `null` → insert gagal diam-diam. Fix: `onMouseDown={(e) => e.preventDefault()}` di semua tombol toolbar per-field + tombol Emoji (pola standar toolbar Lexical).
- **Spacing editor kegedean + teks mulai kebawah dari placeholder**: Lexical bungkus tiap baris jadi `<p>` dengan margin browser default (~1em) — reset ke `margin:0`, sekalian benerin align sama posisi placeholder.
- **Placeholder "Klik buat mulai nulis…" dihapus** — kotak kosong aja sesuai instruksi.
- **Video "gak bisa diputar"**: kemungkinan besar root cause-nya video collapse ke tinggi 0px (chain flex `minHeight:0` di round sebelumnya rawan collapse kalau ada 1 mata rantai yang meleset) — sekarang dikasih `minHeight` ANGKA (bukan 0) sebagai jaring pengaman, video tetap kelihatan/keklik minimal seukuran itu, tetap bisa membesar (flex:1) kalau section-nya lebih besar.
- **PDF "gak muncul"**: PdfViewer sebenernya udah ngatur tinggi-nya sendiri (`height:420` fixed di dalam komponennya) — pembungkus flex:1 yang ditambah round lalu gak perlu dan berisiko, sekarang dibalikin ke pembungkus polos (gak gantung ke chain-height parent).
- **Capture "mentah dan gak bekerja"**: drag-select di `CaptureModal` cuma dengar event di dalam `<div>`-nya sendiri — kalau mouse gerak cepat sampai keluar batas div (gampang banget pas narik area capture), mousemove/mouseup gak ke-capture, drag jadi nyangkut. Fix: pindah listener ke `window` (pola yang sama persis kayak pan-drag `PdfViewer` yang udah terbukti jalan). Modal juga dikasih header + tombol X biar gak keliatan "mentah".
- **Ikon file attached masih polos**: dikasih kotak ikon 22×22 konsisten (border + background), thumbnail beneran buat gambar, ikon beda buat video (`FileVideo`) vs file lain.
- **Ikon drag diganti**: `GripVertical` (titik-titik vertikal panjang) → `Grip` (kotak titik lebih kompak/simpel).
- **Auto-format LIVE pas ngetik** (poin "-+spasi auto Bullet, dst."): ditambah `MarkdownShortcutPlugin` dari `@lexical/react`, pakai transformer YANG SAMA (`SLACK_TRANSFORMERS`) dengan yang dipakai buat convert markdown tersimpan — jadi ketik `- ` di awal baris beneran auto-jadi bullet, `1. ` jadi numbered list, dst., real-time pas ngetik (bukan cuma pas convert tersimpan).

**BELUM dikerjakan — nunggu user**: "pakai code dari Command Builder" (text editor) dan "video player/PDF viewer dari Hej Pro" — sudah dicek ke seluruh folder project, gak ada source code Command Builder/Hej Pro tersimpan di mana pun (cuma ada gambar referensi di `Asset/Ref/`). User akan kasih source-nya biar bisa di-port perilakunya persis, bukan cuma ditebak-tebak.

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih, `node -c` semua `.cjs`.

Checklist manual:

- [ ] **Drag-drop file dari luar BENERAN nempel**: drag 1 file dari File Explorer ke atas card field mana pun → lepas → file itu muncul di daftar file field itu (bukan cuma highlight doang lalu gak ada apa-apa).
- [ ] **Drag-highlight gak kedip-kedip**: pas narik file di atas SATU card field (gerakin mouse ke berbagai titik di dalam card itu) → border highlight-nya STABIL nyala terus, gak nyala-mati-nyala-mati.
- [ ] **Emoji ke-insert walau field masih kosong**: klik field kosong (baru dari "+ Field") → langsung klik ikon Emoji → pilih 1 emoji → emoji itu BENERAN muncul di text area (sebelumnya: gak ada apa-apa yang ke-insert).
- [ ] **Spacing editor rapat**: ketik 2-3 baris (Shift+Enter tiap baris baru) → jarak antar baris normal/rapat, gak ada gap gede kayak sebelumnya. Baris pertama mulai persis di posisi placeholder biasanya nongol.
- [ ] **Kotak kosong tanpa placeholder**: field baru yang belum diisi apa-apa → text area-nya BENERAN kosong visual, gak ada teks abu-abu "Klik buat mulai nulis...".
- [ ] **Video bisa diputar**: buka video di panel kiri → keliatan jelas (gak collapse/ilang), klik tombol play (atau video-nya langsung) → video BENERAN jalan.
- [ ] **PDF muncul**: buka file PDF di panel kiri → halaman PDF-nya render, bukan kotak kosong.
- [ ] **Capture jalan penuh**: klik ikon Capture (video/gambar) → modal kebuka → drag pilih area (termasuk drag CEPAT / sampe keluar batas gambar dikit) → lepas mouse → preview hasil crop MUNCUL → klik "Simpan ke Pool" → thumbnail-nya nongol di capture pool strip.
- [ ] **Auto-bullet pas ngetik**: di text area kosong, ketik `- ` (strip lalu spasi) → baris itu otomatis jadi bullet list point (bukan nunggu blur/convert). Coba juga `1. ` → jadi numbered list.
- [ ] **Ikon file attached & drag-handle**: baris file di tiap field ada kotak ikon rapi (bukan ikon polos nempel doang), dan ikon drag di kiri card sekarang bentuknya kotak titik kompak (bukan titik-titik vertikal panjang).

---

## 9. Port dari source asli Command Builder & Hej Pro Breakdown (2026-09-16) ✅ (siap dites)

User kasih 2 folder source code asli buat di-scan menyeluruh: `Hej Pro Breakdown/App` (Electron, video player + PDF viewer) dan `Other/HB to V5/Web App` (Google Apps Script, "Command Builder" — text editor/toolbar/emoji/video player-nya sendiri). Ketemu & dibaca lengkap: `renderer/js/videoPlayer.js` + `renderer/js/pdfViewer.js` (Hej Pro), `JavaScript.html` 6600+ baris (Command Builder, bagian RICH TEXT TOOLBAR ~3888-4420 & video player ~5060-5300).

**Temuan penting #1 — root cause asli "PDF tidak muncul"**: komentar Hej Pro sendiri, PERSIS soal ini: *"pdfjs-dist mencoba fetch()/XHR untuk skema file:// yang perilakunya TIDAK KONSISTEN di Electron dengan contextIsolation. Kirim bytes-nya langsung jauh lebih andal."* Kode kita sebelumnya (`PdfViewer.tsx`) pakai `fetch(file://...)` persis pola yang mereka bilang gak andal itu. **Di-port**: IPC baru `file:readBytes` (main process baca lewat `fs.readFileSync`, dikirim ke renderer sebagai bytes) — dipakai di `PdfViewer.tsx` DAN `src/lib/videoFps.ts` (auto-detect FPS video ternyata pakai pola `fetch()` yang sama, dibungkus try/catch yang nelen error diam-diam — kemungkinan besar diam-diam SELALU gagal & jatuh ke fallback manual 24fps tanpa ada yang sadar).

**Temuan #2 — video/PDF player kita udah cocok strukturnya**: video player Command Builder (JavaScript.html ~5060-5300) PERSIS 2-baris (bar1: play/step/capture/seek/timecode/fullscreen, bar2: loop/fps/speed) — struktur yang sama persis udah kita bangun round sebelumnya. Bedanya: mereka pakai REAL browser Fullscreen API (`element.requestFullscreen()`), bukan simulasi CSS `position:fixed` kayak kita — **belum di-port** (nice-to-have, beda kecil, catat sebagai gap kalau nanti user mau exact match).

**Temuan #3 — capture "sniping tool" ternyata bukan modal terpisah**: drag-select-nya LANGSUNG di atas video/gambar yang lagi ditampilin (toggle captureMode dulu — video auto-pause — baru drag di situ), preview HASIL crop-nya baru muncul di modal setelahnya. **Di-port persis**: `FilePreview` sekarang punya `stageRef`+`onStageMouseDown`+drag di window (bukan lagi drag di dalam modal terpisah kayak round sebelumnya), matematika letterbox-offset (`computeContentRect`) di-port dari `videoContentRect_` Hej Pro/Command Builder biar crop akurat walau video/gambar ada bar hitam di kiri-kanan. Modal (`CapturePreviewModal`) sekarang CUMA preview+confirm, gak ada drag-select lagi di dalamnya.

**Temuan #4 — text editor Command Builder pakai `contentEditable`+`execCommand`, BUKAN library kayak Lexical**: dibaca lengkap (`serializeRichText_`, `richTextToHtml_`, auto-bullet keydown handler, dst.) — TAPI ini pendekatan yang lebih rapuh (execCommand deprecated, kode-nya sendiri penuh komentar defensif soal quirk tiap browser). Keputusan: **TIDAK ditiru arsitekturnya** (tetap pakai Lexical, lebih robust), tapi 2 PERILAKU KONKRET-nya di-port:
  - Auto-bullet "- "+spasi & "1. "+spasi — sudah di-port round sebelumnya via `MarkdownShortcutPlugin` (behavior Lexical native, setara).
  - **BARU**: highlight tombol toolbar (Bold/Italic/Bullet/Number) pas kursor ada di teks yang formatnya aktif — port dari `updateToolbarActiveState_` (mereka pakai `document.queryCommandState`, kita pakai `selection.hasFormat()`/cek ancestor `ListNode` — `ActiveFormatsPlugin` baru di `RichTextEditor.tsx`).

**BELUM di-port** (dicatat, bukan lupa — beda-beda alasan):
- Real browser Fullscreen API buat video (masih simulasi CSS).
- Emoji shortcode auto-convert (":fire:" → 🔥 pas blur/paste) — fitur nyata di Command Builder, tapi gak eksplisit diminta ("emoji juga" ditafsirkan sebagai "emoji harus jalan bener", yang udah dibenerin di §8).
- Preset Hyperlink Setup terintegrasi ke popover Link (Command Builder nampilin dropdown preset LANGSUNG di popover link) — dijelasin di §8 kenapa ini di luar scope toolbar per-field sekarang.
- Fitur PDF viewer lanjutan Hej Pro (continuous-scroll virtualized, text-layer selectable, Find/Ctrl+F, pan Space+drag, annotation system) — di luar scope laporan bug "PDF tidak muncul" (itu udah kefix via `file:readBytes`), dan annotation system-nya terikat ke data model Breakdown tool (scene/reference) yang gak ada padanannya di app ini.

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih, `node -c` semua `.cjs`, cross-check IPC cocok (termasuk channel baru `file:readBytes`).

Checklist manual:

- [ ] **PDF beneran muncul sekarang**: buka file PDF di panel kiri → halaman render (bukan kotak kosong/gagal), termasuk buka LAGI PDF yang sebelumnya gagal.
- [ ] **FPS auto-detect video kepakai** (regression check — kemungkinan diam-diam gak pernah jalan sebelumnya): buka video MP4/MOV yang FPS-nya BUKAN 24 (kalau ada) → cek label "auto" muncul di sebelah kolom FPS, bukan cuma manual 24 terus.
- [ ] **Capture drag LANGSUNG di video/gambar, bukan di modal**: klik ikon Capture → kursor jadi crosshair LANGSUNG di atas video/gambar yang lagi tampil (video otomatis pause kalau lagi main) → drag pilih area → lepas → modal preview muncul dengan hasil crop-nya.
- [ ] **Capture akurat walau video ada letterbox** (video beda aspect ratio dari kotak playernya, jadi ada bar hitam kiri-kanan/atas-bawah) → drag pilih area yang jelas-jelas cuma di bagian video-nya (bukan area hitam) → hasil crop di preview modal PERSIS area itu, bukan geser/salah posisi.
- [ ] **Tombol toolbar nyala pas kursor di teks berformat**: di field mana pun, ketik teks lalu Bold-kan sebagian → klik lagi di TENGAH teks yang bold itu (tanpa select apa-apa) → tombol Bold di toolbar keliatan aktif (background biru muda). Pindah kursor ke teks biasa → tombol Bold balik gak aktif. Coba juga Italic dan cursor di dalam bullet/numbered list (tombol List/Number ikut nyala).

---

## 10. Rebuild total Video Player & PDF Viewer (2026-09-16) ✅ (siap dites)

User laporan lagi (screenshot): video masih gak bisa diputar, PDF masih "rusak" — minta REBUILD TOTAL dari nol, full adopsi dari Hej Pro Breakdown, pastikan video jalan.

**Ketemu bukti KONKRET root cause PDF** — `src/index.html` punya CSP `default-src 'self'` TANPA `connect-src` override. `fetch()`/XHR (yang dipakai versi lama buat baca PDF & auto-detect FPS video) ke skema `file://` KENA BLOKIR CSP ini (`connect-src` jatuh ke `default-src 'self'`, `file://` bukan `'self'`). Ini PERSIS penyebab yang diomongin Hej Pro di komentar kode mereka sendiri, dan sekarang ke-konfirmasi ada bukti nyata di app ini juga (bukan cuma dugaan). Fix `file:readBytes` IPC dari §9 memang akar yang benar — PDF/FPS-detect baca lewat main process (`fs.readFileSync`), sama sekali gak lewat `fetch()`/CSP `connect-src`.
**Video BEDA** — CSP `media-src 'self' blob: file:` EKSPLISIT ngizinin `file:`, jadi `<video src="file://...">` gak diblokir CSP. Root cause video belum bisa dipastikan 100% tanpa test langsung — kemungkinan besar masih soal sizing/collapse dari fix sebelumnya yang ternyata belum cukup, atau isu lain yang belum ketauan. **Makanya ditambah**: video sekarang punya `onError` yang nampilin PESAN ERROR JELAS di atas video kalau gagal muat (kode `MediaError` di-terjemahin ke Bahasa Indonesia — file gak kebaca, format/codec gak didukung, dll) — SEBELUMNYA gagal itu DIAM-DIAM (video item hitam kosong, klik gak ngapa-ngapain, gak ada petunjuk kenapa). Kalau masih gagal abis rebuild ini, sekarang bakal ada pesan JELAS yang bisa langsung nunjukin akar masalahnya buat fix presisi (bukan tebak-tebak lagi).

**Rebuild — video** (`src/screens/VideoPlayer.tsx`, file baru, dipisah dari `Drawer.tsx`): `frameFromTime`/`seekToFrame`/`formatTimecode`/tracking-frame via `requestVideoFrameCallback` di-port PERSIS dari Hej Pro (`videoPlayer.js`). Konsep "Scene" (In/Out/Save Scene, loncat-scene) DIHAPUS — gak ada padanannya di data model app ini. Fullscreen sekarang REAL browser Fullscreen API (`element.requestFullscreen()`), bukan simulasi CSS lagi. Capture (sniping, drag langsung di video), Loop manual awal/akhir + FPS override tetap dipertahankan (fitur kita sendiri, gak konflik sama core engine Hej Pro).

**Rebuild — PDF** (`src/screens/PdfViewer.tsx`, ditulis ulang total): adopsi struktur Hej Pro (`pdfViewer.js`) — continuous scroll + VIRTUALISASI via `IntersectionObserver` (cuma halaman dekat viewport yang beneran dirender, bukan render SEMUA 33 halaman sekaligus kayak sebelumnya), render 2-tahap low-res→full-res tetap dipertahankan, zoom-ke-kursor, pan (tahan Space + drag, baru). **Robustness kunci yang di-port**: tiap halaman di-render dalam try/catch SENDIRI-SENDIRI — kalau versi SEBELUMNYA satu halaman gagal render (di tengah loop `for` async tanpa try/catch per-halaman), SEMUA halaman setelahnya ikut berhenti render diam-diam (silent abort). Ini kandidat kuat root cause "PDF rusak" versi sebelumnya buat dokumen banyak halaman (33 halaman, kayak di screenshot user). Annotation system, page-extend, Find, marker/reference system Hej Pro TIDAK diikutin (fitur breakdown-tool terikat data model scene/reference yang gak ada di app ini).

**Bug tambahan yang ke-fix pas rebuild**: `renderCell` PDF sebelumnya (draft awal rebuild ini) baca `scale` langsung dari closure — halaman yang BARU kelihatan (discroll) SETELAH user zoom bakal ke-render pakai scale LAMA (closure `IntersectionObserver` beku di scale pas observer dibuat, effect-nya cuma re-run pas `numPages` berubah, bukan pas `scale` berubah). Ketauan & di-fix sebelum sempat kepakai — sekarang baca scale dari `scaleRef` (ref, selalu ke-update ke nilai terbaru).

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih, `node -c` semua `.cjs`.

Checklist manual:

- [ ] **Video benar-benar bisa diputar**: buka video di panel kiri → klik tombol play (atau video-nya langsung) → video BENERAN jalan (gambar bergerak, audio kedengeran kalau ada).
- [ ] **KALAU MASIH GAGAL — pesan error muncul**: video gagal dimuat → SEKARANG ada pesan error jelas di atas video (bukan kotak hitam kosong diam-diam) → **kirim screenshot pesan errornya** biar bisa di-diagnosa presisi apa akar masalahnya.
- [ ] **Fullscreen video beneran fullscreen OS-level**: klik ikon expand → video nutupin SELURUH layar (bukan cuma area section, termasuk nutup taskbar Windows) → tekan Esc atau klik ikon lagi → balik normal.
- [ ] **PDF 33 halaman semua kebaca**: buka PDF banyak halaman → scroll dari halaman 1 sampai halaman TERAKHIR → semua halaman render (gak ada yang blank/berhenti di tengah).
- [ ] **PDF gak lag pas scroll cepat** (virtualisasi): scroll cepat naik-turun PDF panjang → gak nge-freeze/nge-lag parah (halaman yang jauh dari viewport gak dirender, cuma placeholder).
- [ ] **Pan PDF pakai Space+drag**: tahan tombol Space (kursor mouse di atas area PDF) → drag → PDF ikut geser (pan), bukan scroll biasa. Lepas Space → balik normal.
- [ ] **Zoom PDF ke arah kursor**: scroll+Ctrl (atau Cmd) di titik tertentu pada PDF → PDF zoom in/out MENGARAH ke titik kursor itu, bukan ke tengah halaman.
- [ ] **Capture PDF tetap jalan**: toggle ikon Capture di PDF → drag pilih area di 1 halaman → hasil crop resolusi tinggi masuk ke capture pool (regression check, fitur lama).

---

## 11. Diagnosa presisi dari pesan error (2026-09-16) ✅ PDF di-fix, video BUKAN bug kode

User kirim screenshot pesan error video ("Format/codec video ini tidak didukung...") + screenshot PDF yang logo/icon-nya kosong (background/teks/garis tetap muncul) — persis skenario yang dijelasin §10 buat diagnosa presisi.

**PDF — ketemu & di-fix**: pdf.js butuh 3 folder asset (`cmaps`, `standard_fonts`, `wasm` dari `node_modules/pdfjs-dist`) buat decode gambar JPX/JPEG2000 (format umum dari InDesign/Illustrator export — logo "BF44"/icon salib di screenshot kemungkinan besar JPX) dan font non-embedded. Kode kita SEBELUMNYA gak pernah kasih opsi ini ke `pdfjsLib.getDocument()` sama sekali — pdf.js diam-diam skip decode gambar itu, teks & vektor (yang gak butuh decoder itu) tetap render normal, PERSIS gejala di screenshot. **Fix**: 3 folder itu di-copy ke `src/public/pdfjs/` (Vite serve `public/` apa adanya, ~3.7MB), di-wire ke `getDocument({ cMapUrl, standardFontDataUrl, wasmUrl, cMapPacked: true })`.

**Video — DIAGNOSA PASTI, BUKAN bug kode**: saya cek langsung file asli-nya (`BF43_0030.mp4`, ada di `%APPDATA%/slack-intake-apps/attachments/...`) pakai `mp4box` (sudah kepakai buat auto-detect FPS) buat baca metadata track video-nya:

```
codec: "hev1.1.6.L90.90"   <- ini kode codec HEVC / H.265
```

**Videonya di-encode pakai HEVC (H.265), bukan H.264.** Chromium/Electron (termasuk versi resmi dari npm) **TIDAK support decode HEVC** secara default — beda dari H.264 yang didukung penuh. Ini BUKAN bug di kode app manapun (Command Builder, Hej Pro, atau app kita) — ini keterbatasan platform Chromium/Electron itu sendiri terhadap 1 codec spesifik. Gak ada perbaikan CSS/JS/IPC yang bisa "benerin" ini — file HEVC gak akan pernah bisa diputar `<video>` biasa di app berbasis Electron/Chromium, titik.

**Pesan error yang saya tambahin di §10 kepake persis buat nemuin ini** — sebelumnya gagal diam-diam (kotak hitam kosong), sekarang ada pesan jelas yang langsung nunjukin arah diagnosa. Kalau file video LAIN (bukan `BF43_0030.mp4`) juga gagal diputar, cek dulu apa pesan errornya SAMA ("codec tidak didukung") — kalau iya, kemungkinan besar semua file dari sumber/render pipeline yang sama pakai HEVC juga.

**3 opsi kalau video HEVC ini emang perlu bisa diputar di app** (bukan keputusan yang bisa saya ambil sendiri — masing-masing trade-off beda):
1. **Transcode ke H.264 di luar app** (paling simpel, paling cepat) — re-export/convert video dari source-nya (After Effects, Premiere, DaVinci, dll.) pakai H.264 bukan HEVC. Gak butuh perubahan kode app sama sekali.
2. **Auto-transcode pas file di-attach ke app** — app otomatis convert HEVC→H.264 pas user attach file (pakai `ffmpeg` yang di-bundle ke app, +/-70-100MB ukuran installer nambah). Paling nyaman buat user (gak perlu convert manual), tapi nambah dependency gede + waktu convert tiap attach.
3. **Terima keterbatasannya** — video HEVC ditandain gak bisa dipreview LANGSUNG di app (pesan error yang udah ada), user tetap bisa lihat videonya lewat aplikasi lain (Windows Media Player/VLC dukung HEVC, tinggal buka file-nya langsung dari File Explorer/attachments folder).

Checklist manual (buat konfirmasi diagnosa, bukan nyari bug baru):

- [ ] **PDF logo/icon sekarang muncul**: buka PDF yang tadinya logo/icon-nya kosong → sekarang tampil (BUKAN kosong lagi).
- [ ] **Video H.264 (bukan HEVC) bisa diputar normal**: coba attach/putar video yang KODENYA BUKAN HEVC (export ulang salah satu video pakai H.264, atau cari video lain yang emang H.264) → harus BISA diputar normal di app (buktiin video player-nya emang gak ada bug, cuma HEVC doang yang gak didukung).

---

## 12. Diagnosa Hej Pro (HEVC) + capture pool bisa di-preview (2026-09-16) ✅ (siap dites)

**HEVC — dicek kode Hej Pro `main.js`, gak ketemu mekanisme khusus** (gak ada flag Chromium, gak ada ffmpeg/codec library di-bundle, gak ada custom decode via MediaSource/WebCodecs — `<video src="file://...">` polos, sama persis kayak kita). Beda nyata cuma versi Electron (Hej Pro pakai `^32.0.0`, kita `^44.3.0`). **Ditambah eksperimen**: `app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport')` di `main.cjs` — nyuruh Chromium coba pakai decoder HEVC bawaan Windows (Media Foundation) KALAU Windows-nya punya "HEVC Video Extensions" ter-install. Gak ada downside kalau gak ngefek.

**Capture pool sekarang bisa di-preview** — poin laporan "attach file image bahkan hasil capture belum bisa dilihat": ternyata attached image SUDAH bisa dilihat (klik chip file di field → tampil di DisplayPane kiri), tapi **capture pool (hasil crop/frame yang belum di-attach) sebelumnya CUMA thumbnail 44×44 tanpa cara lihat ukuran penuh** — cuma bisa didrag atau dihapus. Sekalian dibereskan duplikasinya: `CapturePoolStrip` sebelumnya ada 2 salinan terpisah (satu di `Drawer.tsx` buat image/PDF, satu lagi inline di `VideoPlayer.tsx` buat video) — sekarang 1 komponen bersama (`src/screens/CapturePoolStrip.tsx`), dipakai di tiga-tiganya (image, PDF, video).

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih (bonus: lazy-loading `VideoPlayer`/`PdfViewer` — perubahan yang udah ada di disk sebelum turn ini — sekarang kelihatan hasilnya di build: 4 chunk terpisah, bukan 1 bundle 1.2MB lagi).

Checklist manual:

- [ ] **Flag HEVC (opsional, cuma kalau Windows-nya punya codec extension)**: coba lagi video HEVC yang tadinya gagal — MUNGKIN sekarang bisa (tergantung ada/tidaknya HEVC Video Extensions di Windows-nya).
- [ ] **Capture pool bisa di-klik buat lihat ukuran penuh**: capture gambar/video (drag pilih area) → thumbnail masuk capture pool strip → KLIK thumbnail itu (bukan drag) → modal preview kebuka nampilin gambarnya ukuran penuh, bukan cuma thumbnail kecil. Tombol X di pojok thumbnail tetap hapus dari pool (gak ikut kebuka modal).
- [ ] **Capture pool di video juga bisa di-preview** (regression check, sekarang pakai komponen sama): capture dari VIDEO (bukan gambar/PDF) → thumbnail-nya di bawah video player juga bisa diklik buat preview ukuran penuh.

---

## 13. Root cause ASLI "image gak tampil" ketemu — bug di `toFileUrl` (2026-09-16) ✅ (siap dites)

User kirim screenshot: chip "image (3).png" ke-pilih (border biru), tapi area preview cuma nampilin ikon broken-image kecil + nama file — bukan gambarnya. Dicek langsung: file-nya ADA di disk (`attachments\...\image (3).png`, 89KB, header PNG valid), DAN record di database (`reply_files.stored_path`) COCOK PERSIS sama path file aslinya. Jadi bukan file hilang/salah path — masalahnya di FRONTEND, cara app bikin `file://` URL dari path itu.

**Ketemu bug-nya** di `src/lib/fileUrl.ts` — `toFileUrl()` encode TIAP SEGMEN path pakai `encodeURIComponent`, yang JUGA nge-encode karakter `:` jadi `%3A`. Buat path Windows, drive letter "C:" ikut ke-encode jadi "C%3A" — hasil URL-nya `file://C%3A/Users/...` alih-alih `file:///C:/Users/...`. Chromium butuh titik dua drive letter itu APA ADANYA (gak di-encode) buat bisa resolve balik ke drive C: — begitu ke-encode, path-nya gagal di-resolve, `<img>`/`<video>` gagal muat KONTEN-nya DIAM-DIAM (gak ada pesan error network yang jelas buat `<img>`, cuma jadi ikon broken-image).

Ini kemungkinan besar JUGA akar dari keluhan LAMA "attached file icon masih mentah" (§8) — waktu itu saya kira cuma soal styling/polish, ditambah kotak ikon yang lebih rapi, padahal kemungkinan besar itu beneran ikon BROKEN IMAGE (gagal muat), bukan cuma kurang dipoles.

**Fix**: `toFileUrl` sekarang pakai `encodeURI()` di SELURUH string path sekaligus (bukan per-segmen) — persis pola yang dipakai Hej Pro Breakdown & Command Builder (`toFileUrl`/`richTextInlineToHtml_` versi mereka) — `encodeURI` SENGAJA gak nyentuh karakter `:` (ada di reserved-safe set bawaannya), tapi tetap escape spasi & karakter gak aman lainnya. Fungsi ini dipakai LUAS (semua `<img>` di FileChip/DisplayPane, `<video src>` di VideoPlayer.tsx) — 1 fix ini berpotensi benerin BANYAK tempat sekaligus, bukan cuma 1 file yang dilaporkan.

**Sudah diverifikasi**: standalone self-check Node (bukan cuma tsc/build) — path asli `image (3).png` dari kasus ini di-transform, hasilnya persis `file:///C:/Users/.../image%20(3).png` (titik dua utuh, spasi ke-escape `%20`, kurung `()` gak diapa-apain — valid). `tsc --noEmit` bersih, `npm run build:renderer` bersih.

Checklist manual — INI YANG PALING PENTING buat dites ulang:

- [ ] **"image (3).png" sekarang tampil**: buka lagi item yang sama (BF43_0010), klik chip "image (3).png" → gambarnya BENERAN muncul di panel kiri, bukan ikon broken-image lagi.
- [ ] **Semua thumbnail gambar lain juga cek ulang**: buka beberapa file gambar lain yang di-attach (termasuk "HEJ PRO.png" yang tadinya diragukan) → semua thumbnail (FileChip kecil di field kanan) DAN preview besar (DisplayPane kiri) nampilin gambar asli, bukan ikon generik/broken.
- [ ] **General Display image juga**: chip General Display yang gambar (ada ikon pin) → preview-nya juga nampilin gambar asli.
- [ ] **Video masih perlu dicek terpisah**: fix ini KEMUNGKINAN BESAR gak nutup kasus video HEVC (itu beda akar masalah, dikonfirmasi lewat pesan error "codec gak didukung" yang tetap muncul artinya file-nya KETEMU/KEBACA, cuma format-nya yang gak didukung) — tapi coba juga video H.264 kalau ada, buat mastiin video path loading-nya juga gak kena bug yang sama.

---

## 14. Audit total — root cause SEBENARNYA ketemu: origin mismatch mode dev (2026-09-16) ✅ (siap dites, PENTING)

User konfirmasi: udah restart bersih `npm run dev`, fix `toFileUrl` (§13) TETAP gak nutup masalahnya. Diminta audit total — section Display DAN seluruh project. Ketemu akar masalah yang JAUH lebih besar dari sekadar bug encoding.

**Root cause SEBENARNYA**: `npm run dev` muat renderer dari `http://localhost:5173` (`main.cjs`: `isDev ? win.loadURL("http://localhost:5173") : win.loadFile(dist/index.html)`) — origin HALAMANNYA sendiri jadi `http://localhost:5173`, BUKAN `file://`. `webSecurity` Electron (default `true`, gak di-override di `main.cjs`) **BLOKIR halaman ber-origin `http://` muat resource lewat skema `file://` langsung** (`<img src="file://...">`, `<video src="file://...">`) — ini restriksi level Chromium, DI LUAR jangkauan CSP (CSP kita udah izinin `file:` di `img-src`/`media-src`, tapi itu gak ngalahin blokir origin-mismatch level browser). Fix `toFileUrl` (§13) tetap valid/benar (URL-nya emang tadinya salah), tapi bukan itu yang bikin gambar gak muncul — origin-block ini yang BENERAN nutup semuanya, terlepas dari URL-nya benar apa nggak.

**Kenapa PDF udah kerja duluan**: PDF (§9/§11) udah dipindah baca byte lewat IPC `file:readBytes` (main process, `fs.readFileSync`) — SAMA SEKALI gak lewat `<img>`/`fetch()`/resource-loader browser, jadi otomatis kebal dari restriksi ini (kebetulan, bukan disengaja waktu itu — alasan awal pindah ke IPC itu soal CSP `connect-src`, ternyata SEKALIAN nutup masalah origin ini juga).

**Kenapa ini gak kejadian pas app di-package (bukan `npm run dev`)**: `win.loadFile(dist/index.html)` bikin origin halamannya JADI `file://` juga — file://-ke-file:// (skema sama) gak diblokir. Ini MURNI gotcha mode dev Electron+Vite, tapi karena testing selama ini lewat `npm run dev`, efeknya kerasa terus dari awal.

**Fix**: `<img>`/`<video>` sekarang SEMUA baca lewat pola yang sama kayak PDF — `window.api.file.readBytes()` (IPC ke main process) → `Blob` → `URL.createObjectURL()`. Blob: URL SELALU se-origin sama halaman yang bikinnya (baik `http://localhost:5173` pas dev, MAUPUN `file://` pas packaged) — kebal dari restriksi ini di DUA-DUANYA, bukan cuma di dev doang. Hook baru `useFileBlobUrl()` di `src/lib/fileUrl.ts`, dipakai di `FileChip`, `FilePreview` (gambar), dan `VideoPlayer.tsx`. `toFileUrl()` (fungsi lama) DIHAPUS total — gak dipakai lagi di mana pun (audit grep konfirmasi).

**Bug tambahan ke-fix sekalian**: 2 `useEffect` di `VideoPlayer.tsx` (frame-tracking `requestVideoFrameCallback`, dan loop-timeupdate) sebelumnya cuma punya dependency `[fps]`/`[loopEnabled, loopStart, loopEnd]` — TIDAK termasuk `url`. Karena `<video>` sekarang baru KE-MOUNT setelah blob: URL siap (async), `videoRef.current` masih `null` pas effect pertama kali jalan, dan gak akan PERNAH nyala lagi setelah video-nya beneran mount (effect gak dependency ke perubahan itu). Ketauan pas audit, di-fix SEBELUM sempat jadi bug baru (nambahin `url` ke dependency array keduanya).

**Audit tambahan** (poin "audit semua terkait project"):
- Grep SEMUA `<img>`/`<video>` di seluruh `src/` — cuma 3 tempat yang masih relevan (`FileChip`, `FilePreview` gambar, `VideoPlayer`), semuanya sekarang pakai `useFileBlobUrl`. Sisanya aman: capture-preview (`CapturePoolStrip`, `CapturePreviewModal` di 2 tempat) pakai base64 `data:` URL (gak pernah kena masalah ini), logo/asset UI (`Login.tsx`, `Chrome.tsx`) pakai Vite bundled-asset import (otomatis se-origin, gak pernah kena masalah ini juga).
- Grep SEMUA `fetch(` di `src/` — NIHIL, semua pembacaan file lokal sekarang lewat IPC (`file:readBytes`/`getPathForFile`), gak ada satu pun sisa `fetch()` ke path lokal.
- `node -c` semua `.cjs` di `electron/` — bersih semua.
- Cross-check channel IPC `main.cjs` ↔ `preload.cjs` — cocok 100%, gak ada channel nyangkut sebelah.
- `tsc --noEmit` + `npm run build:renderer` — bersih.

Checklist manual — INI HARUSNYA BENERAN NUTUP MASALAHNYA:

- [ ] **Restart PENUH `npm run dev`** (bukan cuma Ctrl+R di window app — matiin proses dev-nya, `npm run dev` ulang dari nol) — WAJIB, ini fix di banyak file sekaligus.
- [ ] **"image (3).png" beneran muncul**: sama kayak checklist §13, tapi sekarang harusnya BENERAN kepake.
- [ ] **Semua gambar attached/General Display muncul** (regression penuh, bukan cuma 1 file).
- [ ] **Video H.264 (bukan HEVC) sekarang muncul & bisa diputar**: kalau ada video non-HEVC → sekarang harusnya BENERAN jalan (sebelumnya kemungkinan besar KEDUA masalah numpuk: origin-block DULU baru ketauan HEVC-nya kalau origin-block-nya udah kebuka).
- [ ] **Video HEVC tetap gagal, TAPI dengan pesan error yang sama** ("format/codec gak didukung") — bukan pesan error baru/beda. Kalau pesan errornya BERUBEH jadi sesuatu yang lain, kasih tau — itu bukti origin-block KEMUNGKINAN yang selama ini nutupin diagnosa HEVC juga (video literally gak pernah nyampe tahap decode).
- [ ] **Video scrub/timecode readout jalan** (regression check buat fix dependency array `useEffect`): buka video → play → timecode/frame counter di transport bar BENERAN jalan real-time (bukan diem di 0 terus).

---

## 15. Auto-fit PDF + restrukturisasi chip Display (2026-09-16) ✅ (siap dites)

Bug §14 KONFIRMASI kepake — user lapor "sekarang bekerja". 2 hal baru diminta:

**1. Ruang kosong di section Display (PDF)** — `PdfViewer.tsx` masih punya `height: 420` FIXED dari desain lama, padahal section Display sekarang jauh lebih tinggi dari itu (sisa ruang kosong di bawah viewer, kelihatan di screenshot user). **Fix**: `height: 420` → `flex: 1, minHeight: 280` (pola sama kayak `VideoPlayer.tsx`), wrapper-nya di `Drawer.tsx` (`FilePreview` cabang pdf) ikut diubah jadi flex column biar tinggi flex:1 itu ada yang ngasih.

**2. Restrukturisasi chip Display** — sebelumnya SEMUA chip (General Display + tiap file reply) numpuk jadi 1 daftar rata kiri, dan 1 REPLY yang punya 2 file (mis. "Animatic" isi video+gambar) bikin **chip "Animatic" dobel** (1 chip per FILE, bukan per field) — itu yang bikin screenshot user nunjukin "Animatic Animatic", "General Note General Note". Diminta: General Display (statis, project-level) mulai dari KIRI, Field Display (dari reply/field) mulai dari KANAN, dan field yang punya >1 file TETAP 1 chip aja (gak dobel), viewer-nya dikasih pager ala PDF ("‹ 1/2 ›") buat pindah antar file DALAM field itu.

**Perubahan model data**: `selection` di `Drawer.tsx` sekarang discriminated union — `{kind:"general", fileId}` ATAU `{kind:"field", replyId, fileIndex}` (sebelumnya cuma 1 string `selectedFileId` id-file-datar). `DisplayPane` dipecah jadi 2 grup chip: `generalChips` (dari `projectFiles`, 1 chip/file, kiri) dan `fieldChips` (dari `item.replies` yang punya file, 1 chip/REPLY, kanan lewat `marginLeft:auto`). Field dengan >1 file dapet baris pager terpisah di bawah baris chip (cuma nongol kalau field aktif emang punya >1 file). Klik file spesifik di kartu field (FileChip) sekarang manggil `onSelectFile(replyId, fileId)` (bukan cuma `fileId`) — biar bisa langsung lompat ke HALAMAN yang benar di pager, bukan cuma pilih field-nya doang.

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih, `node -c` semua `.cjs`.

Checklist manual:

- [ ] **PDF ngisi penuh section Display**: buka PDF → viewer-nya ngisi SELURUH tinggi panel kiri, gak ada ruang kosong putih di bawahnya lagi.
- [ ] **Chip General Display di kiri, Field Display di kanan**: baris chip di atas panel Display → chip General (ada ikon pin, dari tombol "+") ada di sisi KIRI, chip Field (dari reply/field kanan) ada di sisi KANAN, ada jarak/gap di tengah kalau muat.
- [ ] **Field dengan banyak file CUMA 1 chip**: reply "Animatic" yang punya 2 file (video+gambar) → cuma ada SATU chip "Animatic" di baris Field Display (bukan dobel lagi).
- [ ] **Pager muncul buat field multi-file**: klik chip "Animatic" (yang punya 2 file) → di bawah baris chip muncul baris pager "‹ 1/2 — nama-file ›" → klik panah kanan → viewer ganti nampilin file KEDUA, panah kiri balik ke pertama. Field yang cuma punya 1 file (kayak "General Note" kalau cuma 1 file) TIDAK nampilin baris pager ini.
- [ ] **Klik file spesifik di kartu field langsung lompat ke halaman yang benar**: di kartu reply "Animatic", klik file KEDUA (misal gambar) di baris file compact-nya → panel Display langsung nampilin field "Animatic" DAN pager-nya langsung di posisi file ke-2 (bukan balik ke file pertama).
- [ ] **Badge jumlah file di chip**: chip Field yang punya >1 file nampilin badge kecil "(2)" di sebelah nama field-nya.

---

## 16. Thumbnail video, redesign attached-file strip, limit 5 file, Fit Lebar/Tinggi PDF (2026-09-16) ✅ (siap dites)

**Batas file per reply — dicek ke Slack dulu**: WebSearch ke dokumentasi Slack resmi — TIDAK ada angka publish eksplisit "maksimal berapa file per pesan" (cuma nemu batas per-FILE 1GB, rate-limit 1 pesan/detik/channel; angka "20" yang sempat muncul di 1 hasil pencarian ternyata soal *message attachments* legacy — field/color blocks, BUKAN file upload — beda konsep). Dicek balik ke bot referensi (Command Builder JavaScript.html): `MULTI_FILE_MAX_PER_REPLY = 5`, sudah lama dipakai produksi. **Diadopsi 5** — ditegakkan client-side di 4 jalur attach sekaligus (tombol paperclip toolbar, drag-drop native, drag capture-pool, paste clipboard), pesan jelas (`alert`) kalau kepotong/penuh, teksnya disamain persis kayak toast Command Builder.

**Thumbnail video** — video attached sekarang BENERAN nampilin thumbnail (frame di tengah durasi video), bukan cuma ikon generik `FileVideo` lagi. Komponen baru `VideoThumbnail`: `<video>` tersembunyi (gak nempel DOM kelihatan), seek ke tengah durasi, gambar frame ke `<canvas>`, hasilnya jadi `<img>`. Pakai `useFileBlobUrl` yang sama (§14) buat baca file-nya.

**Redesign strip attached file** — dari list VERTIKAL (ikon+nama+X per baris) jadi HORIZONTAL, thumbnail-only (nama file dihapus dari tampilan, masih ada di `title` tooltip pas hover). Tombol hapus jadi badge X kecil di pojok KANAN-ATAS tiap thumbnail (overlay, bukan lagi di ujung baris). Kalau file-nya kebanyakan buat muat horizontal (misal reply lama dari sebelum cap 5 masih bisa punya lebih), muncul panah overlay kiri/kanan (bukan cuma andelin scrollbar tipis yang kurang jelas) — komponen baru `AttachedFilesRow` (wrapper, ngatur panah+scroll) + `AttachedThumb` (1 thumbnail).

**PDF Fit Lebar vs Fit Tinggi** — tombol "Fit" lama (otomatis milih sumbu yang lebih kecil antara lebar/tinggi) kadang nyisain 1 sumbu KURANG dari viewport, jadi ujung halaman BERIKUTNYA nyembul dikit ("di antara 2 halaman"). Dipecah jadi 2 tombol eksplisit: **Fit Lebar** (halaman selebar viewer, mode baca, boleh scroll vertikal), **Fit Tinggi** (halaman SETINGGI viewer PERSIS — jamin 1 halaman utuh kelihatan, gak ada bocoran halaman lain). Double-click sekarang manggil Fit Tinggi (sebelumnya manggil fit-otomatis lama).

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih, `node -c` semua `.cjs` (gak ada perubahan backend ronde ini — limit file ditegakkan client-side aja, cukup karena app ini satu-satunya jalur masuk data, gak ada aktor luar yang bisa nge-bypass UI).

Checklist manual:

- [ ] **Video attached nampilin thumbnail beneran**: attach video ke field → thumbnail-nya nampilin FRAME video (bukan ikon kamera/video generik lagi).
- [ ] **Attached file horizontal, thumbnail doang**: field dengan beberapa file → baris file-nya SEJAJAR HORIZONTAL, cuma thumbnail (gak ada teks nama file kelihatan). Hover 1 thumbnail → tooltip nama file muncul.
- [ ] **X di pojok kanan-atas thumbnail**: tiap thumbnail ada badge X kecil nempel di sudut kanan-atas → klik → file itu kehapus dari field (bukan ikut buka preview di Display).
- [ ] **Panah scroll muncul kalau kepanjangan**: field dengan banyak file yang gak muat 1 baris → panah "‹"/"›" muncul overlay di kiri/kanan strip thumbnail → klik → scroll horizontal.
- [ ] **Limit 5 file per field**: coba attach 6+ file sekaligus (drag-drop atau lewat toolbar) ke 1 field kosong → cuma 5 pertama yang ke-attach, muncul pesan "Cuma 5 file yang ditambahkan (maksimal 5 file per field)". Field yang UDAH ada 5 file → coba tambah lagi → muncul "Field ini sudah penuh (maksimal 5 file)", gak ada yang nambah.
- [ ] **Fit Lebar vs Fit Tinggi PDF beda hasil**: buka PDF, resize/coba di halaman yang aspect ratio-nya beda jauh dari section Display → klik "Fit Lebar" → halaman selebar viewer (mungkin kepotong atas/bawah). Klik "Fit Tinggi" → halaman SETINGGI viewer, jelas kelihatan 1 halaman utuh, gak ada sisa halaman lain nyembul di bawah.
- [ ] **Double-click PDF = Fit Tinggi**: double-click di area PDF (bukan lagi select teks) → efeknya sama kayak klik tombol "Fit Tinggi".

## 17. Koreksi limit jadi 10, badge hapus lebih kontras, Loop/FPS/Speed icon-only (2026-09-16) ✅ (siap dites)

**Limit file dikoreksi 5 → 10** — §16 adopsi angka `5` dari bot referensi (Command Builder) karena Slack sendiri gak publish angka resmi. User tes LANGSUNG ke Slack beneran dan ketemu batas asli **10**. `MAX_FILES_PER_REPLY` di `Drawer.tsx` diubah ke `10`, komentar diupdate jelasin kedua sumber data (riset vs tes langsung), pesan `alert()` ikut ganti otomatis (pakai konstanta yang sama, gak ada angka ke-hardcode di 2 tempat).

**Badge hapus makin kontras** — badge X kecil di §16 masih tipis (border-outline) dan kurang keliatan di atas thumbnail terang. Diganti jadi lingkaran merah solid (`background: var(--danger)`, border putih tipis biar ada pemisah dari thumbnail, `X` icon putih tebal `strokeWidth={3}`) — diterapkan di 2 tempat yang render badge sama: `AttachedThumb` (Drawer.tsx, badge attached-file) dan `CapturePoolStrip.tsx` (badge capture-pool).

**Loop/FPS/Speed di VideoPlayer — selalu kelihatan, icon-only** — sebelumnya baris kontrol ini cuma muncul pas fullscreen (`{fullscreen && (...)}`), dan Loop pakai checkbox+teks "Loop". Sekarang: baris ini SELALU tampil (gate fullscreen dihapus); Loop jadi tombol toggle icon (`Repeat`, warna aktif pas nyala); tombol titik-awal/titik-akhir loop (`ArrowLeftToLine`/`ArrowRightToLine`) cuma muncul kalau Loop lagi aktif (`{loopEnabled && (...)}`) — sebelumnya selalu kelihatan walau Loop mati, bikin bingung; satuan titik awal/akhir diganti dari detik (`12.3`) ke **nomor frame** (`frameFromTime(t, fps)`, formula sama kayak Hej Pro) biar presisi buat kerja frame-by-frame; label teks "FPS" diganti icon `Film`, indikator "auto" teks diganti titik hijau kecil; label speed diganti icon `Gauge`. Caption nama file di ujung baris ini dihapus (nama file udah gak ditampilkan di attached-thumb pun, §16).

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih (chunk `VideoPlayer` 198.70 kB gzip 50.06 kB), `node -c` semua 7 file `.cjs` di `electron/` OK.

Checklist manual:

- [ ] **Limit 10, bukan 5**: attach 11+ file sekaligus ke 1 field kosong → cuma 10 pertama yang ke-attach, pesan "Cuma 10 file yang ditambahkan (maksimal 10 file per field)". Field yang udah 10 → tambah lagi → "Field ini sudah penuh (maksimal 10 file)".
- [ ] **Badge hapus jelas kelihatan**: lihat attached-file thumbnail DAN capture-pool thumbnail → badge X di pojok kanan-atas harus lingkaran merah solid, kontras jelas di atas thumbnail apapun (terang/gelap).
- [ ] **Loop/FPS/Speed selalu kelihatan**: buka video, JANGAN fullscreen → baris kontrol Loop/FPS/Speed tetap tampil di bawah player (sebelumnya cuma muncul pas fullscreen).
- [ ] **Awal/akhir loop cuma muncul kalau Loop aktif**: pastikan Loop mati → tombol titik-awal/titik-akhir TIDAK kelihatan. Klik toggle Loop (icon `Repeat`) → tombol awal/akhir muncul, angkanya nomor FRAME (bukan detik kayak "12.3").
- [ ] **Semua kontrol icon-only**: Loop, FPS, Speed gak ada teks label lagi — cuma icon (`Repeat`, `Film`, `Gauge`) + input/angka seperlunya. Hover masing-masing → tooltip jelasin fungsinya.

## 18. Statis display gak reload, header pil, badge kepotong, autoformat list, volume, dll (2026-09-16) ✅ (siap dites)

**General Display reload pas ganti item — root cause: `key={activeItem.id}` di `MainTable.tsx`** — `<Drawer>` di-`key`-in per item, jadi REACT REMOUNT TOTAL tiap ganti item (video/PDF/posisi scroll/zoom, bahkan chip yang lagi aktif, semua ke-reset), padahal General Display (projectFiles) itu level PROJECT, seharusnya statis. `key` dihapus. Konsekuensinya, state yang MEMANG harus reset per-item (seleksi reply buat dihapus, wizard template baru, capture pool ephemeral) yang sebelumnya "gratis" ke-reset lewat remount, sekarang di-reset manual lewat `useEffect(() => {...}, [item.id])` di `Drawer.tsx`. Field Display (per reply) tetap otomatis reset ke chip pertama pas ganti item — itu udah ditangani `DisplayPane`'s existing `stillValid` check (§15), gak perlu tambahan.

**Header item — bold+besar, pil, hilangkan "(1/20)"** — nama item sekarang `fontWeight:800, fontSize:18` (dari 600/default). Counter "(1/20)" (posisi item di project) dihapus — props `itemIndex`/`itemCount` jadi dead code, dihapus juga dari `Drawer`/`MainTable.tsx`. Ditambah **pil badge** di samping judul — interpretasi: satu-satunya data "status" yang ada di model (`item.source: "manual" | "folder-import"`) ditampilin sebagai pil rounded ("Manual"/"Folder Import"). ⚠️ Kalau maksudnya bukan ini, kasih tau maksud "Pil button"-nya apa.

**Badge X thumbnail kepotong — root cause: `overflow:hidden` di div YANG SAMA yang nampung badge** — `AttachedThumb` naro badge (`position:absolute, top:-5, right:-5`) sebagai child div yang juga punya `overflow:hidden` (buat bikin gambar rounded), jadi badge yang nongol di luar batas ikut ke-clip. Dipindah: `overflow:hidden` sekarang cuma di wrapper KONTEN (img/video/icon), badge jadi sibling di luar wrapper itu (gak lagi diclip). Ditambah `paddingTop:6` di scroll container (`AttachedFilesRow`) — perlu, soalnya `overflow-x:auto` bikin browser otomatis nge-treat `overflow-y` jadi `auto` juga (clip), padding ngasih ruang buat badge yang nongol -5px di atas thumbnail.

**Autoformat "- "→bullet dan "1. "→number DIMATIIN** — sebelumnya `MarkdownShortcutPlugin` dikasih `SLACK_TRANSFORMERS` penuh (termasuk `UNORDERED_LIST`/`ORDERED_LIST`), jadi ketik "- " atau "1. " di awal baris auto-jadi list — user gak mau behavior ini. Transformer baru `LIVE_TYPING_TRANSFORMERS` (di `slackMarkdown.ts`) = `SLACK_TRANSFORMERS` DIKURANGI 2 list transformer itu, dipakai KHUSUS buat `MarkdownShortcutPlugin` (live-typing). `SLACK_TRANSFORMERS` (lengkap, termasuk list) TETAP dipakai buat convert markdown load/save — list yang udah ada di data lama, atau dibikin manual lewat tombol toolbar List/ListOrdered, tetap kebaca/kesave normal. Bold (`*teks*`) dan italic (`_teks_`) live-shortcut TETAP jalan (gak diminta dihapus).

**Fullscreen window → Field input +15%** — Electron gak expose event "window maximized" ke renderer secara default, jadi dipakai heuristik: `window.outerWidth/Height` dibandingin `window.screen.availWidth/Height` (hook `useIsWindowMaximized`, listen `resize`). Kalau kepake penuh, `form-pane` lebar `420 * 1.15 = 483px` (dari `420px`). ⚠️ Heuristik screen-size, BUKAN true OS fullscreen (app ini belum punya fitur itu) — kalau meleset (misal user resize manual ke ukuran gede tapi bukan maximize), kasih tau, upgrade ke IPC `win.isMaximized()` beneran.

**mr-emoji — DICOBA, GAGAL, DIBATALKAN** — source yang diminta user (`github.com/Dipen-Dedania/mr-emoji`) di-`npm install`, tapi package-nya KE-PATAHIN di registry: `package.json` `main` nunjuk ke `dist/index.js` yang GAK ADA di tarball (cuma ada `dist-es`), dan `dist-es`-nya import `babel-runtime` & `prop-types` yang gak dideklarasiin sebagai dependency — Vite/Rollup gagal build ("failed to resolve import") 2x berturut-turut (coba tambal `babel-runtime` manual, masih gagal lagi di `prop-types`). Package unmaintained/rusak, BUKAN soal konfigurasi di app ini. Di-`npm uninstall`, dibalikin ke grid `COMMON_EMOJIS` manual (29 emoji) yang sudah ada. ⚠️ Perlu arahan lanjutan: pakai grid manual yang ada, atau coba library emoji picker lain yang masih aktif di-maintain (misal `emoji-picker-react`)?

**Volume slider di VideoPlayer** — slider `<input type="range">` (0–1, step 0.05) + tombol mute (`Volume2`/`VolumeX`) ditambah di baris kontrol utama, sebelah tombol Fullscreen. State `volume`/`muted` disinkronkan ke `videoRef.current.volume`/`.muted` lewat `useEffect` (dependency `url` — pola sama kayak effect lain, `<video>` baru ada pas blob: URL siap).

**Shortcut `C` buat capture DIHAPUS** — sebelumnya toggle capture mode (gambar di `Drawer.tsx` DAN video di `VideoPlayer.tsx`) bisa dipicu tombol keyboard `C`. Dihapus di 2 tempat (listener `keydown`-nya, plus teks "(C)"/"(C buat batal)" di tooltip/caption) — capture sekarang CUMA lewat klik tombol Crop manual.

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih, `node -c` semua 7 file `.cjs` OK. mr-emoji: dicoba lewat `npm install`/`npm run build:renderer` langsung (bukan cuma baca dokumentasi) — 2 percobaan gagal dengan bukti build-log yang jelas (module resolution error), baru diputuskan dibatalkan.

Checklist manual:

- [ ] **General Display statis pas ganti item**: buka video/PDF di General Display (chip kiri) → geser posisi/zoom/playback → pindah item (panah kiri/kanan) → posisi/zoom/playback TIDAK reset, chip yang aktif juga tetap.
- [ ] **Field Display TETAP reset per item**: pilih field chip (kanan) di item A → pindah ke item B → Display balik nunjukin General Display (atau field pertama item B), BUKAN nyangkut ke field item A yang udah gak ada.
- [ ] **Reply-selection/template-builder/capture-pool reset per item**: centang beberapa reply buat dihapus / buka wizard "Template Baru" / isi capture pool → pindah item → semua itu balik kosong/tertutup di item baru.
- [ ] **Header item**: nama item jelas lebih tebal & besar dari sebelumnya. "(1/20)" GAK ada lagi. Ada pil kecil "Manual"/"Folder Import" di sebelah nama.
- [ ] **Badge X thumbnail gak kepotong**: lihat attached-file thumbnail → badge X bulat merah full terlihat, NONGOL di atas tepi thumbnail (bukan keliatan cuma separuh/ke-crop di dalam kotak thumbnail).
- [ ] **Autoformat list mati, bold/italic tetap jalan**: di field reply, ketik `- ` di awal baris → TIDAK jadi bullet. Ketik `1. ` → TIDAK jadi angka. Tapi ketik `*tebal*` → tetap jadi bold live. List MASIH bisa dibikin lewat tombol toolbar (icon List/ListOrdered).
- [ ] **Field input lebih lebar pas maximize**: window di-restore (gak full) → catat lebar panel Field kanan. Maximize window (klik tombol maximize titlebar) → panel Field kanan keliatan lebih lebar.
- [ ] **Emoji picker masih grid manual**: klik icon Emoji di toolbar reply → masih muncul grid 29 emoji (bukan error/kosong) — konfirmasi rollback mr-emoji gak ninggalin apa pun yang rusak.
- [ ] **Volume slider video**: buka video → ada tombol speaker + slider di sebelah tombol Fullscreen → geser slider → volume video berubah. Klik tombol speaker → mute/unmute, icon berubah.
- [ ] **Shortcut C gak ngefek lagi**: buka gambar ATAU video di Display → tekan tombol `C` di keyboard → capture mode TIDAK aktif. Klik tombol Crop manual → capture mode aktif normal.

## 19. Instant Intake (overlay pesawat scoped, kirim langsung) + mr-emoji BENERAN jalan (2026-09-16) ✅ (siap dites)

**Overlay "Instant Intake" — redesign total** (koreksi dari §18): posisi pindah ke **kiri** cell (dari kanan), icon jadi `SendHorizontal` (panah horizontal, bukan `Send` diagonal) warna biru (`var(--accent)`), dibungkus lingkaran hitam `rgba(0,0,0,0.8)`. Visibility diganti dari `tr:hover` (nyalain SEMUA overlay 1 baris sekaligus) jadi `td:hover` (cuma cell yang lagi di-cursor), plus `transition-delay: 0.5s` CSS (nongol nunggu 0.5 detik biar gak "kedip" pas mouse numpang lewat, tapi ilang LANGSUNG pas mouse keluar). Komponen dipindah jadi shared `QuickSendButton.tsx` (2 variant: `overlay` buat Tab Table, `inline` buat Tab Reply).

**Instant Intake juga ada di Field (Tab Reply)** — tombol sama persis (icon, warna, lingkaran) ditaruh di `.reply-actions` tiap `ReplyRow`, **di sebelah kiri checkbox**. Reveal-nya ikut mekanisme hover `.reply-actions` yang udah ada (bukan delay 0.5s terpisah — biar konsisten sama ikon broadcast/trash di baris yang sama).

**Klik = kirim LANGSUNG, gak ada modal lagi** — percobaan §18 (reuse `SlackViewPreview`+`ChannelPicker`) DIBATALKAN, diganti IPC baru `send:quick` (main.cjs) yang langsung manggil `slack.sendItem` tanpa modal apa pun, pakai channel default project. Feedback loading/sukses/gagal sekarang ada DI TOMBOLNYA SENDIRI (`Loader2` muter → `Check` ijo sekejap → balik normal; `alert()` kalau gagal).

**Scoped per kolom/field (bukan full item lagi)** — `send:quick` terima `scope`: `"item"` (Tab Table, kolom Item — cuma mastiin/bikin thread `*itemName*`, TANPA mention artis/reply), `"artist"` (kolom Artis — cuma mention `<@artistId>`, error jelas kalau item belum ada artis ditugaskan), `"replies"` (kolom Reply — SEMUA reply/field item ini, tanpa mention artis), `"field"` (Tab Reply, per-ReplyRow — SATU reply/field doang, butuh `replyId`). Helper `replyToPost()` baru di `main.cjs` (dipakai bareng `send:start` DAN `send:quick`, DRY — sebelumnya logic mapping reply->post digandain).

**mr-emoji BENERAN JALAN** (bukan grid manual lagi) — user download source ASLI dari GitHub (bukan lewat `npm install`) ke `D:\...\Other\EMOJI mr Emoji\mr-emoji-master`. Diperiksa: source mentahnya (folder `src/`) TIDAK pernah import `babel-runtime` — itu cuma muncul di HASIL BUILD `dist-es` yang dipublish ke npm (dikompail pakai Babel 6 + `babel-plugin-transform-runtime`, itulah root cause asli §18). Source mentah pakai native ES class, aman buat toolchain modern (Vite/esbuild) tanpa transform apa pun. Satu file penting HILANG dari download (`src/data/data.js`, dataset emoji) — di-`.gitignore` upstream karena GENERATED (`scripts/build-data.js` + `emoji-datasource@4.0.2`+`emojilib`+`inflection`), jadi di-generate ULANG manual (isolated di folder download-nya sendiri, gak nyentuh project) lalu hasilnya di-copy.

Source di-vendor ke `src/vendor/mr-emoji/` (bukan `node_modules`, gak lewat npm) — file yang ngandung JSX di-rename `.js`→`.jsx` biar esbuild otomatis ngenalin (komponen: anchors/category/emoji/parser/picker/preview/search + svgs/index; `skins.js` di-skip, dead code — commented out di barrel export asli). Dependency asli SATU-SATUNYA yang genuinely dibutuhin: `prop-types` (npm install biasa, paket kecil resmi, aktif di-maintain — BEDA dari `babel-runtime` yang emang udah gak eksis di dependency graph source mentah). `Picker` dipanggil dengan prop `native` (render karakter unicode asli, BUKAN sprite-sheet gambar dari CDN `unpkg.com` — CSP app ini cuma izinin `img-src 'self' data: blob: file:`, sprite-sheet bakal gagal senyap kalau `native` gak dipasang). Grid manual `COMMON_EMOJIS` (fallback §16-18) dihapus, udah gak dipakai.

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` BENERAN bersih (chunk emoji baru `245.94 kB` + CSS `emoji-mart.css 4.70 kB` muncul di output build, konfirmasi ke-bundle valid — beda total sama 2 percobaan gagal §18 yang berhenti di "failed to resolve import"), `node -c` semua 7 `.cjs`, cross-check channel IPC `send:quick` preload<->main match. **BELUM**: smoke-test manual buka app beneran & klik Emoji picker-nya (build sukses = kode valid & ke-bundle, tapi belum ada verifikasi visual/runtime — perlu dicek manual).

Checklist manual:

- [ ] **Overlay posisi kiri, icon biru horizontal**: hover cell Item/Artis/Reply di Tab Table → overlay muncul di pojok KIRI (bukan kanan lagi), icon panah horizontal (bukan pesawat diagonal), warna biru, di dalam lingkaran hitam.
- [ ] **Cuma cell yang di-hover yang nongolin overlay**: hover salah satu cell (misal Item) di 1 row → overlay CUMA muncul di situ, TIDAK muncul bebarengan di cell Artis/Reply row yang sama.
- [ ] **Delay 0.5 detik**: hover cell → overlay BELUM muncul instant, tunggu ~0.5 detik baru muncul. Geser mouse keluar cell → overlay ilang LANGSUNG (gak ada delay pas ngilang).
- [ ] **Instant Intake di Field (Tab Reply)**: buka Tab Reply, hover salah satu field card → muncul tombol pesawat (sama gaya: biru, lingkaran hitam) di sebelah KIRI checkbox.
- [ ] **Klik = kirim langsung, gak ada modal**: klik overlay pesawat di kolom Item → TIDAK ada modal preview/channel-picker muncul. Icon berubah jadi spinner muter, lalu centang ijo sekejap, balik normal — cek Slack beneran, thread `*nama item*` kebentuk TANPA mention artis/reply.
- [ ] **Scope per kolom bener**: klik pesawat di kolom Artis → cek Slack, di thread item itu CUMA ada mention artis (gak ada post reply lain nambah). Klik pesawat di kolom Reply → cek Slack, SEMUA reply/field item itu kekirim (gak ada mention artis baru). Klik pesawat di 1 field spesifik (Tab Reply) → cek Slack, CUMA field itu doang yang kekirim.
- [ ] **Artis kosong = error jelas**: item yang belum ada artis-nya → klik pesawat di kolom Artis → `alert()` muncul bilang belum ada artis ditugaskan, gak ada apa pun kekirim ke Slack.
- [ ] **Emoji picker mr-emoji beneran muncul**: klik icon Emoji di toolbar field → popover emoji LENGKAP muncul (bukan grid 29 manual lagi) — ada search bar, kategori, banyak emoji. Klik salah satu emoji → ke-insert ke text field.

## 20. Bug Instant Intake: mention Artis gak kekirim + Field bikin thread duplikat (2026-09-17) ✅ (siap dites)

User tes langsung 3 scope Instant Intake berurutan di 1 item yang sama: Item (berhasil) → Artis (**gak ada apa pun masuk ke Slack**) → Field (**berhasil, tapi bikin pesan item BARU, bukan nyambung ke thread yang udah ada**). 2 bug root cause KETEMU, dua-duanya di `sendItem()` (`slack.cjs`) — bukan soal UI:

**Bug 1 — `artistSent` di-infer salah, bukan dibaca dari DB.** Kode lama: `let artistSent = resume ? resume.artist_sent : (existing ? 1 : 0);` — asumsi "kalau thread-nya UDAH ADA, pasti artis-nya udah pernah di-mention". Asumsi ini BENER di dunia lama (artis SELALU jadi langkah pertama tiap `sendItem()` dipanggil), tapi JEBOL sejak Instant Intake scope `"item"` bisa bikin thread TANPA mention artis sama sekali (persis skenario user: tes "Item" duluan). Efeknya: pas tes "Artis" berikutnya, `existing` (thread dari tes Item) ketemu → `artistSent` dianggap `1` (padahal FAKTANYA belum pernah kekirim) → blok `if (artistId && !artistSent)` di-skip → gak ada apa pun yang kepost ke Slack, TANPA error (makanya user gak lihat error apa pun, cuma "gak ada yang kekirim").

**Fix 1**: tambah kolom **durable** `threads.artist_sent` (migrasi `ALTER TABLE`, ada di `db.cjs`, 3 jalur migrasi dicoba manual: fresh install, DB existing yang udah punya composite key, DAN DB sangat lama dengan PK lama — 3-3-nya diverifikasi lewat skrip standalone pakai `node:sqlite` in-memory, bukan cuma baca kode). `artistSent` sekarang DIBACA dari kolom ini (`existing?.artist_sent`), bukan di-infer dari "thread ada apa nggak". Di-update ke `1` cuma pas mention BENERAN kepost (`setThreadArtistSent`).

**Bug 2 — Field Instant Intake bisa salah channel, jadi mikir thread belum ada.** `send:quick` sebelumnya default channel ke `project.channel_id` polos kalau caller gak kasih `channelId` eksplisit (dan panggilan dari Field/ReplyRow MEMANG sengaja gak ngasih channelId). Masalahnya: kalau kiriman ASLI item ini dulu (lewat tombol Kirim utama + Slack View Preview) dikirim ke channel LAIN (fitur "ganti channel cuma buat kiriman ini" — udah ada dari awal), `project.channel_id` (default project) BEDA sama channel tempat thread aslinya ada. `getThread.get(itemName, channelId_yang_salah)` gak ketemu apa-apa → `sendItem` mikir ini item BARU → bikin pesan `*itemName*` BARU di channel yang salah, reply-nya nempel di thread BARU itu, bukan di thread asli. Ini match PERSIS sama laporan user ("bukan buat Pesan item baru lalu kirim di dalamnya").

**Fix 2**: fungsi baru `slack.findThreadChannel(itemName)` — cek dulu channel MANA aja yang UDAH punya thread buat item ini (`SELECT channel_id FROM threads WHERE item_name = ? ORDER BY updated_at DESC LIMIT 1`), dipakai sebagai preferensi KEDUA (setelah channelId eksplisit, sebelum fallback ke `project.channel_id`) di `send:quick`. Efeknya: instant-send SEKARANG otomatis nemuin & nyambung ke thread yang bener, bahkan kalau channelId gak dikasih eksplisit dari frontend. Panggilan quicksend di `MainTable.tsx` (kolom Item/Artis/Reply) juga disederhanain — gak lagi maksa `channelId: project.channel_id`, dibiarin backend yang nentuin (konsisten sama Field yang dari awal emang gak ngasih channelId).

**Bonus — "simpan link pesan itemnya" (saran user)**: kolom `threads.permalink` ditambah juga (migrasi sama), di-isi tiap kali `sendItem()` berhasil dapet permalink dari Slack API. BELUM ada UI baru buat nampilin ini (belum diminta eksplisit) — tapi datanya sekarang TERSIMPAN PERMANEN per item+channel, siap dipakai kalau nanti mau ditambah tombol "buka di Slack" yang gak cuma hidup selama sesi kirim itu doang.

Juga dibenerin: baris `saveAttempt.run({..., artistSent: existing ? 1 : artistSent, ...})` (satu lagi tempat yang punya bug SAMA PERSIS kayak Bug 1, ke-skip kalau cuma benerin baris pertama doang) — disederhanain jadi langsung pakai `artistSent` (udah bener di titik itu).

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih, `node -c` semua 7 `.cjs`, cross-check IPC channel `send:quick` masih match. **3 jalur migrasi DB diuji manual** via skrip standalone `node:sqlite` in-memory (fresh/existing/legacy-PK — lihat detail di atas), bukan cuma dibaca. **BELUM**: smoke-test manual kirim beneran ke Slack (perlu app di-restart dulu biar `main.cjs`/`preload.cjs` yang baru kepakai — bukan hot-reload).

Checklist manual (ulang skenario user PERSIS):

- [ ] **Item → Artis → Field berurutan di 1 item BARU (belum pernah dikirim sama sekali)**: klik pesawat Item (bikin thread) → klik pesawat Artis → cek Slack, mention artis SEKARANG muncul di thread yang SAMA (bukan hilang lagi). Klik pesawat 1 Field → cek Slack, reply itu nempel DI THREAD YANG SAMA (bukan bikin pesan item baru lagi).
- [ ] **Item yang channel aslinya BEDA dari default project** (kalau ada test case gini — item yang dulu di-Kirim lewat tombol utama dengan ganti channel di Slack View Preview): klik pesawat Field di item itu → cek Slack, reply-nya nempel di THREAD ASLI di channel yang BENER (bukan bikin thread baru di channel default project).
- [ ] **Restart app dulu** sebelum tes (perubahan `main.cjs`/`preload.cjs` gak hot-reload) — kalau masih ada `window.api.send.quick is not a function`, berarti belum bener-bener restart.

## 21. Koreksi pil judul item + Fitur Preset Emoji (2026-09-17) ✅ (siap dites)

**Koreksi pil**: poin revisi §18 salah paham — "tambahkan Pil button" ternyata maksudnya nama ITEM-nya sendiri yang dibungkus pil (bukan badge status Manual/Folder Import terpisah). Badge "Manual"/"Folder Import" dihapus total, nama item sekarang yang punya `borderRadius:999, border, background` (pil).

**Fitur baru: Preset Emoji** — dikonfirmasi dulu ke user sebelum dibangun (3 keputusan desain: custom emoji insert teks shortcode `:nama:` bukan gambar; preset GLOBAL satu buat semua project, bukan per-project; entry point "Kelola preset..." di popover berupa baris teks). Perubahan:

- **Picker toolbar field SEKARANG cuma nampilin preset** (bukan semua ~1800 emoji unicode lagi) — kalau preset kosong, ada pesan "Belum ada preset emoji." Baris "Kelola preset..." di bawah popover buka modal manajemen.
- **Modal "Preset Emoji"** (`EmojiPresetModal.tsx`) — 3 bagian: (1) daftar preset saat ini + tombol hapus per-item (badge X pola sama kayak delete-badge lain di app), (2) form tambah custom emoji (pilih PNG lokal + nama, validasi nama di backend: huruf kecil/angka/`_`/`-`/`+` doang, dedupe), (3) picker mr-emoji LENGKAP (lazy) buat milih dari semua emoji unicode masuk preset.
- **Custom emoji = teks shortcode, BUKAN gambar** — pas dipilih dari picker, yang ke-insert ke field cuma teks `:nama_emoji:` (persis syntax custom emoji Slack). PNG yang di-upload cuma buat preview di picker KITA sendiri, GAK PERNAH di-upload/divalidasi ke Slack — kalau workspace tujuan gak punya custom emoji nama sama, ya tampil apa adanya sebagai teks, SENGAJA gak ditolak/error (sesuai request user).
- **Emoji picker juga ada di modal Generate Item**, di sebelah field Prefix — insert nempel di ujung teks (input polos, bukan rich editor, gak ada tracking posisi kursor).
- **2 entry point ke modal preset**: menu bar Edit → "Preset Emoji...", ATAU baris "Kelola preset..." di popover emoji manapun (toolbar field, Prefix Generate Item — sama-sama pakai komponen `EmojiPicker.tsx` yang sama).
- Backend baru: tabel `emoji_presets` (`type: 'unicode'|'custom'`, `value`, `image_path`, `sort_order`) — GLOBAL, gak ada kolom owner (pola sama kayak `hyperlink_presets` yang udah ada). 4 IPC baru: `emojiPreset:list/addUnicode/addCustom/remove`, + `emojiPreset:pickImage` (dialog pilih PNG lokal). PNG custom di-copy ke folder attachment terkelola app (`stageFile`, sama pola kayak semua attachment lain) — dihapus otomatis pas presetnya dihapus.
- Refactor pendukung: lazy-loader `MrEmojiPicker` (full picker mr-emoji) dipindah dari `Drawer.tsx` ke `src/lib/mrEmoji.ts` (shared) — dipakai `EmojiPresetModal.tsx` doang sekarang (toolbar field gak lagi nampilin picker lengkap langsung). `EmojiPicker` (komponen tombol+popover) diekstrak dari `Drawer.tsx` jadi `EmojiPicker.tsx` mandiri, dipakai di 2 tempat (Drawer.tsx field toolbar + MainTable.tsx Generate Item Prefix).

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih, `node -c` semua 7 `.cjs`, cross-check IPC channel (`emojiPreset:*` match preload<->main). **BELUM**: smoke-test manual (restart app dulu, ini nambah IPC channel baru — `main.cjs`/`preload.cjs` gak hot-reload).

Checklist manual:

- [ ] **Judul item jadi pil**: buka Tab Reply, lihat header — nama item (bukan badge terpisah) yang sekarang dibungkus pil bulat.
- [ ] **Picker toolbar cuma nampilin preset**: klik icon Emoji di field mana pun → kalau belum pernah nambah preset, muncul pesan "Belum ada preset emoji." (bukan grid semua emoji lagi).
- [ ] **Tambah preset dari daftar lengkap**: klik "Kelola preset..." → modal kebuka → scroll ke bagian bawah (picker lengkap) → klik satu emoji → cek bagian "Preset saat ini" di atas, emoji itu langsung muncul di situ.
- [ ] **Tambah custom emoji**: di modal yang sama, klik "Pilih PNG" → pilih file .png lokal → isi nama (misal `logo_herald`) → klik "Tambah" → muncul di "Preset saat ini" sebagai thumbnail PNG kecil.
- [ ] **Custom emoji insert teks, bukan gambar**: tutup modal, buka picker toolbar lagi → klik emoji custom yang baru ditambah → cek text field, yang muncul teks `:logo_herald:` (bukan gambar nempel).
- [ ] **Hapus preset**: di modal, hover salah satu chip preset → klik badge X merah → chip-nya hilang dari daftar.
- [ ] **Akses dari menu Edit**: klik menu "Edit" di menu bar atas → ada item "Preset Emoji..." → klik → modal yang sama kebuka.
- [ ] **Emoji di Generate Item**: klik "Generate Item" (sidebar) → di field Prefix ada icon Emoji di sebelah kanan input → klik, pilih emoji → nempel di ujung teks Prefix.

**Bug susulan ketemu dari log terminal user** (`Error occurred in handler for 'file:readBytes': Error: File tidak terdaftar di project.`, berulang) — root cause: `file:readBytes` (main.cjs) selalu validasi lewat `projects.isManagedFile(filePath)` sebelum ngasih baca file APA PUN (proteksi sengaja, cegah baca file sembarangan di luar project) — tapi fungsi itu cuma cek 3 tabel (`project_files`/`item_files`/`reply_files`), belum tau soal `emoji_presets` yang baru ditambah. Efeknya: thumbnail PNG custom emoji GAGAL TERUS kebaca (`useFileBlobUrl` manggil `file:readBytes`, ditolak). **Errornya sendiri BUKAN indikasi bahaya** — proteksinya justru kerja SEHARUSNYA (nolak file yang gak dikenal), cuma lupa didaftarin buat tabel baru. Fix: `isManagedFile` ditambah 1 cek lagi (`SELECT 1 FROM emoji_presets WHERE image_path = ?`, tanpa join owner — emoji_presets global). Diverifikasi: `tsc --noEmit`, `npm run build:renderer`, `node -c` semua `.cjs`, semua bersih.
- [ ] **Thumbnail custom emoji kebaca**: setelah restart app, tambah custom emoji (PNG) → thumbnail-nya HARUS keliatan (gambar asli, bukan icon placeholder `FileText`) di "Preset saat ini" DAN di grid picker toolbar. Cek terminal `npm run dev` — gak ada lagi error "File tidak terdaftar di project" berulang.

## 22. Custom emoji tampil PNG di editor kita, tapi kirim tetap teks ":nama:" (2026-09-17) ✅ (siap dites)

Koreksi poin revisi §21: user klarifikasi upload PNG BUKAN buat beneran jadi emoji Slack (dicek ke dokumentasi Slack resmi — itu emang gak bisa, `admin.emoji.add` cuma buat Enterprise Grid org-level, bukan workspace biasa) — maksudnya PNG-nya tampil visual DI DALAM APP KITA SENDIRI (field reply pas ngetik/lihat), sementara yang TERSIMPAN dan TERKIRIM ke Slack tetap teks polos `:nama:` persis kayak sebelumnya.

**Implementasi — custom Lexical node, bukan sekadar tampilan:**
- `src/lib/EmojiImageNode.tsx` — node Lexical baru (`DecoratorNode`, inline) yang render `<img>` PNG di editor, tapi `exportJSON`/export-markdown-nya balik jadi teks `:nama:` polos. Path gambar-nya SENGAJA gak disimpan DI NODE (cuma nama) — di-lookup LIVE dari cache pas render, jadi kalau preset-nya diedit/dihapus pas field lagi kebuka, tampilannya ikut update otomatis (`subscribeEmojiPresets`).
- `src/lib/emojiPresetStore.ts` — cache in-memory (nama -> path PNG) buat custom emoji, dibutuhin SYNCHRONOUS sama transformer Lexical padahal presetnya sendiri di-fetch ASYNC dari DB. Di-refresh pas `MainTable` mount DAN tiap `EmojiPresetModal` nambah/hapus emoji.
- `slackMarkdown.ts` — transformer baru `EMOJI_IMAGE` (text-match, trigger `:`) masuk ke `SLACK_TRANSFORMERS` — ":nama:" ke-convert jadi `EmojiImageNode` pas LOAD isi tersimpan ATAU pas user NGETIK manual char-per-char (persis kayak custom emoji Slack asli). Kalau "nama"-nya BUKAN preset custom kita (atau cache belum kemuat), dibiarin jadi teks polos — gak dipaksa/error.
- **Kenapa perlu jalur insert TERPISAH buat picker** (`insertEmojiImage` di `RichTextEditorHandle`, bukan cuma `insertText(':nama:')`): dicek langsung ke source `@lexical/markdown` — Lexical SENGAJA gak nge-trigger auto-transform buat insert BORONGAN multi-karakter sekaligus (programmatic `insertText(":nama:")`), cuma buat ketikan asli 1 karakter per event. Klik picker manual bikin node gambar-nya LANGSUNG (`selection.insertNodes([$createEmojiImageNode(name)])`), gak lewat jalur text-match sama sekali.
- Emoji UNICODE tetap teks biasa seperti sebelumnya (karakternya sendiri udah tampil sebagai emoji secara native, gak butuh node khusus).

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih, `node -c` semua 7 `.cjs`, cross-check IPC. Perilaku Lexical (auto-transform gak jalan buat bulk insert) diverifikasi BACA LANGSUNG source `node_modules/@lexical/markdown/dist/LexicalMarkdown.dev.js`, bukan asumsi. **BELUM**: smoke-test manual (fitur ini murni frontend, gak nambah IPC baru — HARUSNYA cukup hot-reload biasa, gak perlu restart app).

Checklist manual:

- [ ] **Custom emoji tampil GAMBAR di editor**: tambah custom emoji lewat modal Preset → klik dari picker toolbar → di TEXT FIELD (bukan cuma di picker) yang muncul HARUS gambar PNG kecil inline, BUKAN teks ":nama:" literal.
- [ ] **Isi tersimpan tetap teks**: setelah nambah gambar emoji ke field, klik di luar (blur) → buka lagi field itu → gambar tetap muncul (bukti round-trip load/save benar, bukan cuma tampilan sesaat).
- [ ] **Kirim ke Slack = teks polos**: kirim item yang field-nya ada custom emoji → cek pesan yang beneran nyampe di Slack → yang muncul teks `:nama_emoji:` (BUKAN gambar/broken image/data URL apa pun).
- [ ] **Ngetik manual char-per-char**: di field kosong, ketik manual `:nama_emoji:` (nama yang UDAH ada di preset) huruf-per-huruf → begitu titik dua penutup diketik, otomatis berubah jadi gambar (persis kayak custom emoji Slack asli).
- [ ] **Nama yang BUKAN preset gak dipaksa**: ketik `:random_bukan_preset:` → TETAP jadi teks polos, gak error/gak crash.
- [ ] **Preset dihapus, node yang lagi kelihatan update**: buka field yang ada custom emoji-nya → di tab/window lain buka modal Preset, hapus emoji itu → balik ke field tadi (masih kebuka) → gambar berubah jadi fallback teks `:nama:` (bukan gambar rusak/blank).

## 23. Fitur Reaction pada Item (2026-09-17) ✅ (siap dites)

Dikonfirmasi dulu ke user sebelum dibangun (reaction dipakai koor di lapangan sebagai status/assignment). Klarifikasi penting di tengah diskusi: ternyata dibutuhin **2 jalur reaction terpisah**, bukan cuma 1:

1. **Icon di Pil Item (`ItemReactionBar`, SELALU kelihatan)** — nambah ke antrean **PENDING** (tabel baru `item_reactions`), BELUM kekirim ke Slack. Ditampilin sebagai chip kecil (`:nama:` atau karakter emoji) di sebelah pil, bisa dibatalkan (hapus dari antrean) sebelum beneran kekirim.
2. **Overlay pas hover Pil Item (`InstantReactionOverlay`)** — pola SAMA PERSIS kayak Instant Intake (delay 0.5s, `.row-quicksend`, hover-zone baru `.pill-hover-zone` karena pil bukan `<td>`) — klik = LANGSUNG `reactions.add` ke Slack, gak pernah nyentuh tabel `item_reactions`.

**Kapan reaction pending beneran kekirim**: nempel di alur "Kirim ke Slack" yang UDAH ADA (`send:start`) — urutan per item: pesan utama → semua reply → (BARU) semua reaction pending. Reaction yang GAGAL (custom emoji belum ada di Slack workspace tujuan, dll) **gak nggagalin seluruh item** — pesan/reply-nya udah kekirim duluan, reaction itu doang yang dicatat ke log dan TETAP pending (bisa dicoba lagi di pengiriman berikutnya).

**Kenapa butuh Slack shortcode, bukan cuma emoji-nya** — `reactions.add` Slack API butuh parameter `name` (nama emoji TANPA titik dua, misal "grinning"), BUKAN karakter unicode atau gambar. Preset emoji unicode sekarang ikut nyimpen `slack_shortcode` (kolom baru di `emoji_presets`, diambil dari field `colons` yang udah dikasih picker mr-emoji pas milih — gak perlu bikin mapping manual). Custom emoji: shortcode-nya ya nama custom-nya sendiri. Picker reaction MEMFILTER preset yang gak punya shortcode (harusnya udah gak ada buat preset baru, jaga-jaga doang buat data lama).

**Backend baru**: tabel `item_reactions` (`emoji_type`, `emoji_value`, `slack_shortcode`, per-item, dedupe otomatis kalau shortcode sama diulang), fungsi `slack.addReaction()` (nge-wrap `reactions.add`, `already_reacted` dianggap SUKSES bukan error — idempoten), `slack.findThreadInfo(itemName)` (cari channel+thread_ts item ini kalau udah pernah dikirim, dipakai jalur instan). 5 IPC baru: `itemReaction:list/add/remove`, `reaction:sendInstant`. Access-control: `ownsItem`/`ownsItemReaction` ditambah ke `validateAccess`.

**Sudah diverifikasi otomatis**: `tsc --noEmit` bersih, `npm run build:renderer` bersih, `node -c` semua 7 `.cjs`, cross-check IPC channel, migrasi DB (`emoji_presets.slack_shortcode` ALTER + `item_reactions` CREATE) diuji standalone lewat `node:sqlite` in-memory (data lama survive, kolom baru nullable). **BELUM**: smoke-test manual (restart app dulu — ada IPC channel baru, gak hot-reload).

Checklist manual:

- [ ] **Restart app dulu** (IPC baru, `main.cjs`/`preload.cjs` gak hot-reload).
- [ ] **Icon reaction selalu kelihatan di pil**: buka Tab Reply → icon `SmilePlus` ada di sebelah pil Item, TANPA perlu hover (beda dari overlay instan).
- [ ] **Tambah reaction pending**: klik icon itu → pilih emoji dari preset → chip kecil `:nama:`/emoji muncul di sebelah pil. Cek Slack — REACTION BELUM MUNCUL di sana (masih pending doang).
- [ ] **Kirim bareng**: klik "Kirim ke Slack" buat item itu (tombol utama ATAU pesawat Instant Intake kolom Item/Reply) → cek Slack, pesan/reply terkirim SEPERTI BIASA, DAN reaction-nya SEKARANG muncul di pesan utamanya. Balik ke app, chip pending-nya HILANG (udah kekirim, dihapus dari antrean).
- [ ] **Overlay instan berbeda dari icon pending**: hover pil Item (jangan klik icon SmilePlus yang selalu kelihatan) → overlay TERPISAH muncul di pojok pil (delay 0.5s) → klik, pilih emoji → LANGSUNG cek Slack, reaction muncul SEKETIKA (gak nunggu "Kirim ke Slack").
- [ ] **Overlay instan di item yang belum pernah dikirim**: pilih item yang beneran belum pernah ada pesan di Slack sama sekali → hover pil-nya, klik overlay instan, pilih emoji → muncul error jelas ("belum pernah dikirim..."), BUKAN bikin pesan baru dadakan.
- [ ] **Icon pending TETAP bisa dipakai di item yang belum pernah dikirim**: item yang sama di atas → klik icon SmilePlus yang selalu kelihatan (bukan overlay) → tetap bisa nambah ke antrean pending, gak ada error (nunggu dikirim bareng nanti).
- [ ] **Reaction custom emoji yang gagal gak nggagalin item**: antre-in reaction custom emoji yang BELUM ada di Slack workspace tujuan → kirim item itu → pesan & reply tetap SUKSES terkirim, reaction-nya doang yang tetap "pending" (cek Message Log ada catatan gagalnya).
