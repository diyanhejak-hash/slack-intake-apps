const fs = require("node:fs");
const path = require("node:path");
const { createFile, MP4BoxBuffer } = require("mp4box");

async function readVideoMetadata(filePath) {
  if (!/\.(mp4|mov|m4v)$/i.test(filePath)) return null;
  const file = await fs.promises.open(filePath, "r");
  try {
    const size = (await file.stat()).size;
    const mp4 = createFile();
    let metadata = null;
    mp4.onReady = (info) => {
      const track = info.videoTracks[0];
      if (track && track.timescale > 0 && track.duration > 0) {
        metadata = { frame: track.nb_samples, duration: track.duration / track.timescale };
      }
    };
    mp4.onError = () => {};
    let offset = 0;
    let scanned = 0;
    // ponytail: batasi pembacaan metadata 64 MB per file; jika moov lebih besar, CSV tetap dibuat dengan kolom kosong.
    while (offset < size && !metadata && scanned < 64 * 1024 * 1024) {
      const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, size - offset));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, offset);
      if (!bytesRead) break;
      const data = chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + bytesRead);
      const next = mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(data, offset));
      scanned += bytesRead;
      offset = Math.max(offset + bytesRead, Number.isFinite(next) ? next : 0);
    }
    if (!metadata) mp4.flush();
    return metadata;
  } catch {
    return null;
  } finally {
    await file.close();
  }
}

function csvCell(value) {
  const text = String(value);
  const safe = /^[\s]*[=+@\-\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

async function createMetadataCsv(files, readMetadata = readVideoMetadata) {
  const rows = ["scene,frame,duration"];
  for (const file of files) {
    const metadata = await readMetadata(file.path);
    const scene = path.parse(file.filename).name;
    rows.push([csvCell(scene), metadata?.frame ?? "", metadata?.duration?.toFixed(3) ?? ""].join(","));
  }
  return `${rows.join("\r\n")}\r\n`;
}

module.exports = { readVideoMetadata, createMetadataCsv };
