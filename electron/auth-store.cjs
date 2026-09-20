const { app, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const tokenFile = path.join(app.getPath("userData"), "token.enc");

function saveToken(info) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Penyimpanan kredensial terenkripsi tidak tersedia di perangkat ini.");
  const plain = Buffer.from(JSON.stringify(info), "utf8");
  const data = safeStorage.encryptString(plain.toString("utf8"));
  const temporary = tokenFile + ".tmp";
  fs.writeFileSync(temporary, data, { mode: 0o600 });
  fs.renameSync(temporary, tokenFile);
}

function loadToken() {
  if (!fs.existsSync(tokenFile)) return null;
  const data = fs.readFileSync(tokenFile);
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const json = safeStorage.decryptString(data);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function clearToken() {
  if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile);
}

// App-Level Token (xapp-...) buat Socket Mode (poin revisi, sync 2 arah reaction Slack->app) —
// SENGAJA disimpen LOKAL per-instalasi (pola sama persis kayak token.enc di atas), BUKAN lewat
// runtime-config.json/GitHub secret yang ikut ke installer. Beda dari access token OAuth biasa
// (per-user), App-Level Token itu rahasia level WORKSPACE APP — kalau dibundel ke installer,
// SETIAP orang yang punya installer-nya bisa ekstrak token itu dan buka koneksi Socket Mode
// sendiri ke Slack App-nya (persis masalah yang bikin SLACK_CLIENT_SECRET dihapus dari installer
// dulu, lihat build-config.cjs). User yang mau pakai fitur ini paste token-nya sendiri lewat UI
// Settings, disimpen terenkripsi di device itu doang.
const appTokenFile = path.join(app.getPath("userData"), "slack-app-token.enc");

function saveAppToken(token) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Penyimpanan kredensial terenkripsi tidak tersedia di perangkat ini.");
  const data = safeStorage.encryptString(token);
  const temporary = appTokenFile + ".tmp";
  fs.writeFileSync(temporary, data, { mode: 0o600 });
  fs.renameSync(temporary, appTokenFile);
}

function loadAppToken() {
  if (!fs.existsSync(appTokenFile)) return null;
  const data = fs.readFileSync(appTokenFile);
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(data);
  } catch {
    return null;
  }
}

function clearAppToken() {
  if (fs.existsSync(appTokenFile)) fs.unlinkSync(appTokenFile);
}

module.exports = { saveToken, loadToken, clearToken, saveAppToken, loadAppToken, clearAppToken };
