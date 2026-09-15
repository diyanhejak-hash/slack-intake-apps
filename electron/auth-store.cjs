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

module.exports = { saveToken, loadToken, clearToken };
