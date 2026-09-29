const fs = require("node:fs");

const MAGIC = Buffer.from("HEJAKPK1");
const MAX_MANIFEST = 16 * 1024 * 1024;

function safeEntryName(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") ||
      value.split("/").some(part => !part || part === "." || part === ".." || part.includes(":"))) {
    throw new Error("Path dalam paket Hejak tidak aman.");
  }
  return value;
}

function readHandoffArchive(filePath) {
  const fd = fs.openSync(filePath, "r");
  try {
    const total = fs.fstatSync(fd).size;
    const header = Buffer.alloc(12);
    if (fs.readSync(fd, header, 0, 12, 0) !== 12 || !header.subarray(0, 8).equals(MAGIC)) {
      throw new Error("File ini bukan paket Hejak.");
    }
    const length = header.readUInt32BE(8);
    if (!length || length > MAX_MANIFEST || 12 + length > total) throw new Error("Manifest paket Hejak tidak valid.");
    const bytes = Buffer.alloc(length);
    if (fs.readSync(fd, bytes, 0, length, 12) !== length) throw new Error("Manifest paket Hejak terpotong.");
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (manifest.format !== "hejak-sia-handoff" || manifest.version !== 1 ||
        !manifest.project || typeof manifest.project.name !== "string" ||
        !Array.isArray(manifest.items) || !Array.isArray(manifest.projectFiles) ||
        !Array.isArray(manifest.entries) || manifest.items.length > 10000) {
      throw new Error("Struktur handoff Hejak tidak didukung.");
    }
    const locations = new Map();
    let offset = 12 + length;
    for (const entry of manifest.entries) {
      safeEntryName(entry.name);
      if (locations.has(entry.name) || !Number.isSafeInteger(entry.size) || entry.size < 0 || offset + entry.size > total) {
        throw new Error("Daftar attachment Hejak tidak valid.");
      }
      locations.set(entry.name, { offset, length: entry.size });
      offset += entry.size;
    }
    if (offset !== total) throw new Error("Ukuran paket Hejak tidak cocok.");
    const allFiles = [...manifest.projectFiles, ...manifest.items.flatMap(item => item.files || [])];
    for (const item of manifest.items) {
      if (!item || typeof item.sceneCode !== "string" || !item.sceneCode.trim() || !Array.isArray(item.files)) {
        throw new Error("Item dalam paket Hejak tidak valid.");
      }
    }
    for (const file of allFiles) {
      if (!file || typeof file.role !== "string" || !file.role.trim() ||
          typeof file.label !== "string" || !safeEntryName(file.path) || !locations.has(file.path)) {
        throw new Error("Referensi file Hejak tidak valid.");
      }
    }
    return { manifest, locations, filePath };
  } finally { fs.closeSync(fd); }
}

module.exports = { readHandoffArchive };
