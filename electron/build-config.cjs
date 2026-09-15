const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

// The desktop OAuth client is distributed to trusted local users. Package only its
// required configuration; never copy unrelated developer environment variables.
//
// PKCE (poin revisi keamanan) — App sekarang "public client", SLACK_CLIENT_SECRET SENGAJA GAK
// ADA lagi di daftar `keys` di bawah, biar walau ada sisa nilainya di .env developer, gak bakal
// ikut ke-copy ke runtime-config.json yang dipaket ke installer. Sebelumnya secret ini kebawa ke
// SETIAP instalasi tim — sekarang gak ada rahasia apa pun yang perlu didistribusikan.
module.exports = async function () {
  const root = path.resolve(__dirname, '..');
  const envPath = path.join(root, '.env');
  const env = { ...(fs.existsSync(envPath) ? dotenv.parse(fs.readFileSync(envPath)) : {}), ...process.env };
  const keys = ['SLACK_CLIENT_ID', 'SLACK_REDIRECT_URI', 'OAUTH_PORT', 'GITHUB_REPO'];
  const config = Object.fromEntries(keys.filter((key) => env[key]).map((key) => [key, env[key]]));
  for (const key of keys.slice(0, 2)) if (!config[key]) throw new Error(`Konfigurasi build belum lengkap: ${key}`);
  const destination = path.join(root, '.packaging');
  fs.mkdirSync(destination, { recursive: true });
  fs.writeFileSync(path.join(destination, 'runtime-config.json'), JSON.stringify(config), { mode: 0o600 });
};
