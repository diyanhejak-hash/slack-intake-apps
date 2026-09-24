# Catatan Auto Update

Status: ditunda untuk dipertimbangkan pada versi setelah `v0.3.11`.

Keputusan distribusi: auto-update akan memakai **repository GitHub public khusus installer**.
Repository source direncanakan tetap private.

## Perilaku Saat Ini

- Aplikasi memeriksa GitHub Release terbaru ketika Start Menu dibuka.
- Jika versi lebih baru tersedia, aplikasi menampilkan tombol **Update aplikasi tersedia**.
- Tombol membuka halaman GitHub Release. Download dan instalasi tetap dilakukan manual.
- Kegagalan pemeriksaan update tidak mengganggu fungsi utama aplikasi.

## Keputusan Arsitektur

- Windows dan macOS tetap memakai satu source project dan satu pipeline CI.
- Repository source menyimpan kode dan dapat dibuat private.
- Repository distribusi public hanya menyimpan GitHub Release, installer, dan metadata updater;
  repository ini tidak menyimpan source aplikasi.
- Pipeline menghasilkan artefak berbeda: installer Windows, macOS Intel, dan macOS Apple Silicon.
- File hasil Export/Import project tetap satu format lintas platform.
- Database `userData` mentah tidak dipindahkan manual antar-OS; perpindahan memakai Export/Import.

## Rekomendasi Implementasi Berikutnya

- Gunakan `electron-updater`.
- Saat tombol Update ditekan, download update di background dan tampilkan progres.
- Setelah download selesai, tampilkan **Restart & Install**. Jangan menutup aplikasi otomatis tanpa tindakan user.
- Blok instalasi selama proses kirim Slack masih berjalan atau ada pekerjaan yang belum aman ditutup.
- Pertahankan tombol menuju GitHub Release sebagai jalur cadangan jika updater gagal.
- Tambahkan logging untuk pemeriksaan, download, verifikasi, dan instalasi update.
- Uji migrasi database dan pelestarian attachment untuk setiap rilis.

## Kebutuhan GitHub Release

- Buat repository GitHub public terpisah khusus distribusi installer.
- Workflow dari repository source mengunggah artefak ke repository distribusi memakai credential
  CI yang disimpan sebagai GitHub Actions Secret. Credential tersebut tidak boleh dipaketkan ke aplikasi.
- Aplikasi membaca Release public tanpa `GITHUB_RELEASES_TOKEN`.
- Windows: unggah installer NSIS, `latest.yml`, dan `.blockmap`.
- macOS: build `dmg` dan `zip`, lalu unggah `latest-mac.yml` beserta artefak yang diperlukan updater.
- Rilis hanya diterbitkan setelah checks dan build semua platform berhasil.
- Halaman Release public tetap menjadi jalur download manual jika auto-update gagal.

## Code Signing

### Windows

- Pilihan publik: sertifikat code signing dari CA atau layanan Microsoft Artifact Signing.
- Pilihan internal: sertifikat organisasi/self-signed yang dipercaya secara manual pada seluruh komputer tim.
- Signing publik umumnya berbayar. Sertifikat internal dapat dibuat tanpa biaya sertifikat, tetapi distribusi trust harus dikelola sendiri.
- Ketersediaan Microsoft Artifact Signing Public Trust harus diperiksa kembali untuk negara tempat badan usaha terdaftar.

### macOS

- Auto-update memerlukan aplikasi yang ditandatangani.
- Dibutuhkan Apple Developer Program, sertifikat **Developer ID Application**, dan notarization.
- Biaya normal Apple Developer Program adalah USD 99 per tahun atau harga lokal yang berlaku.
- Credential signing dan notarization disimpan sebagai GitHub Actions Secrets, bukan di source code.

## Catatan Transisi

Versi pertama yang mengandung auto-updater masih harus dipasang manual oleh pengguna versi lama. Setelah versi tersebut terpasang, update berikutnya dapat dilakukan dari dalam aplikasi.
