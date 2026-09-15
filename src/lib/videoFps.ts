// Auto-detect FPS dari metadata file video (poin E1 rancangan) — baca box `moov`/`stts` via
// mp4box.js. Command Builder sendiri GAK BISA lakuin ini (HTMLVideoElement gak expose frame
// rate di browser), tapi kita di Electron bisa baca bytes file langsung.
// Cuma untuk MP4/MOV (format lain gak didukung mp4box) — pemanggil WAJIB sedia fallback input
// manual (default 24) kalau ini balikin null, bukan gantiin total.
import { createFile, MP4BoxBuffer } from "mp4box";

const MAX_BYTES_TO_READ = 500 * 1024 * 1024; // ponytail: skip file >500MB demi memori, jarang kejadian buat file review produksi

// Baca bytes lewat main process (IPC `file:readBytes`), BUKAN fetch(file://) di renderer —
// sama kayak fix di PdfViewer.tsx (port dari Hej Pro Breakdown): fetch/XHR ke skema file://
// gak konsisten di Electron dengan contextIsolation. detectVideoFps sebelumnya pakai fetch()
// dibungkus try/catch yang nelen error diam-diam — kalau fetch-nya gagal, FPS auto-detect
// SELALU jatuh ke fallback manual (24fps) tanpa ada yang sadar itu sebenarnya gagal.
export async function detectVideoFps(filePath: string): Promise<number | null> {
  try {
    const bytes = await window.api.file.readBytes(filePath);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES_TO_READ) return null;
    // mp4box butuh ArrayBuffer murni, bukan Uint8Array bagian dari buffer lain.
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    return await new Promise<number | null>((resolve) => {
      const finish = (fps: number | null) => { window.clearTimeout(timeout); resolve(fps); };
      const timeout = window.setTimeout(() => finish(null), 10000);
      const mp4boxFile = createFile();
      mp4boxFile.onReady = (info) => {
        const track = info.videoTracks[0];
        if (!track || !track.nb_samples || !track.timescale) {
          finish(null);
          return;
        }
        const durationSec = track.duration / track.timescale;
        finish(durationSec > 0 ? track.nb_samples / durationSec : null);
      };
      mp4boxFile.onError = () => finish(null);
      try {
        mp4boxFile.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buf, 0), true);
        mp4boxFile.flush();
      } catch {
        finish(null);
      }
    });
  } catch {
    return null;
  }
}
