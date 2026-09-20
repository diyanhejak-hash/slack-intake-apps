import { useEffect, useState } from "react";

// BUG BESAR ketemu (2026-09-16) — akar masalah SEBENARNYA dari "gambar/video gak tampil di
// Display", BUKAN cuma soal encoding path (fix sebelumnya beneran benerin 1 bug nyata, tapi
// ternyata ada 1 lagi yang lebih besar di baliknya, masih nutupin hasilnya):
//
// `npm run dev` muat renderer dari http://localhost:5173 (lihat main.cjs: isDev ?
// win.loadURL("http://localhost:5173") : win.loadFile(dist/index.html)) — origin HALAMANNYA
// itu sendiri "http://localhost:5173", BUKAN "file://". webSecurity Electron (default TRUE,
// gak di-override di main.cjs) BLOKIR halaman ber-origin http:// muat resource lewat skema
// file:// langsung (<img src="file://...">, <video src="file://...">) — ini restriksi level
// Chromium, DI LUAR jangkauan CSP (CSP img-src/media-src kita udah izinin "file:", tapi itu
// gak ngalahin blokir origin-mismatch level browser ini). Makanya PDF (yang UDAH dipindah baca
// byte lewat IPC `file:readBytes`, bukan lewat <img>/fetch(file://) sama sekali) BISA muncul,
// sementara <img>/<video> yang masih pakai src="file://..." langsung TETAP gagal — bukan soal
// encoding lagi, soal origin dasarnya beda skema.
//
// Di app YANG SUDAH DI-PACKAGE (bukan dev), ini gak kejadian — window.loadFile(dist/index.html)
// bikin origin halamannya JADI "file://" juga, jadi file://-ke-file:// (skema sama) gak
// ke-blokir. Ini murni gotcha mode DEV Electron+Vite, tapi user testing lewat `npm run dev`,
// jadi harus di-benerin biar dev experience-nya juga jalan (gak nunggu sampe di-package baru
// ketauan beneran kerja apa nggak).
//
// Fix: sama kayak PDF — baca bytes lewat `window.api.file.readBytes` (main process, `fs`,
// SAMA SEKALI gak lewat resource-loader browser), bikin Blob, `URL.createObjectURL()` — blob:
// URL SELALU se-origin sama halaman yang bikinnya (baik http://localhost:5173 pas dev, MAUPUN
// file:// pas sudah di-package), jadi gak kena restriksi originmismatch file:// ini di DUA-DUANYA.
// Dipakai hook `useFileBlobUrl` di semua tempat yang sebelumnya pakai `toFileUrl` buat
// <img>/<video> src (FileChip, FilePreview gambar, VideoPlayer).
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
  avi: "video/x-msvideo",
};

function mimeTypeFor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

/** Baca file lewat main process + bikin object URL (blob:) — lihat catatan panjang di atas
 * kenapa ini WAJIB, bukan sekadar preferensi, buat <img>/<video> src. `null` selama masih
 * dimuat ATAU kalau storedPath kosong; revoke otomatis pas storedPath ganti/unmount. */
export function useFileBlobUrl(storedPath: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!storedPath) return;
    let cancelled = false;
    let created: string | null = null;
    window.api.file.readBytes(storedPath).then((bytes) => {
      if (cancelled) return;
      // `bytes` selalu Uint8Array asli dari IPC (bukan SharedArrayBuffer) — DOM lib TS strict
      // soal ArrayBufferView<ArrayBuffer> vs ArrayBufferLike, cast aman di sini.
      const blob = new Blob([bytes as BlobPart], { type: mimeTypeFor(storedPath) });
      created = URL.createObjectURL(blob);
      setUrl(created);
    }).catch((err) => {
      // Poin revisi (bug dilaporkan) — dulu gak ada .catch() di sini sama sekali: kalau
      // file:readBytes reject (mis. path belum/gak kebaca kayak isManagedFile ketinggalan
      // ngecek tabel baru), jadi UNHANDLED PROMISE REJECTION, munculnya sebagai dialog error
      // "Error invoking remote method..." yang bikin app kerasa nge-freeze (fokus input ke-ambil
      // dialog). Preview doang, jadi gagal = anggap "gak ada gambar" (null), gak usah crash.
      if (!cancelled) console.error("useFileBlobUrl gagal baca file:", storedPath, err);
    });
    return () => {
      cancelled = true;
      if (created) URL.revokeObjectURL(created);
    };
  }, [storedPath]);
  return url;
}

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);
const VIDEO_EXT = new Set(["mp4", "mov", "mkv", "webm", "avi"]);

export function fileKind(name: string): "image" | "video" | "pdf" | "other" {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  if (IMAGE_EXT.has(ext)) return "image";
  if (VIDEO_EXT.has(ext)) return "video";
  if (ext === "pdf") return "pdf";
  return "other";
}
