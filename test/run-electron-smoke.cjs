const { spawnSync } = require("node:child_process");
const path = require("node:path");
const electronPath = require("electron");

// Beberapa terminal/agent menetapkan ELECTRON_RUN_AS_NODE secara global. Jika diwariskan,
// binary Electron berubah menjadi Node biasa sehingga smoke test gagal sebelum `app` tersedia.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const result = spawnSync(electronPath, [path.join(__dirname, "electron-smoke.cjs")], {
  env,
  stdio: "inherit",
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
