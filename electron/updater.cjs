const { app } = require("electron");

// Cek versi doang, install tetap manual (poin 9 rancangan — app unsigned/gratis di Mac
// gak bisa pakai auto-update diam-diam ala Squirrel.Mac yang butuh signing).
//
// `token` (poin revisi: repo rilis privat) — fine-grained PAT read-only, scoped CUMA ke 1 repo
// ini ("Contents: Read-only"), dipakai buat baca /releases/latest yang gak kebaca publik kalau
// repo-nya privat. Beda risiko dari client_secret OAuth yang dihapus — token ini gak bisa dipakai
// buat apa pun selain baca metadata rilis repo ini, dan gampang dicabut/diganti dari GitHub
// Settings kapan pun kalau kecurigaan bocor.
async function checkForUpdate(repo, token) {
  if (!repo) return { available: false, reason: "GITHUB_REPO belum dikonfigurasi." };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: token ? { Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } : {},
    });
    if (!res.ok) return { available: false, reason: `GitHub API ${res.status}` };
    const data = await res.json();
    const latest = String(data.tag_name || "").replace(/^v/, "");
    const current = app.getVersion();
    const parts = (v) => String(v).split("-")[0].split(".").map((n) => Number(n) || 0);
    const [l, c] = [parts(latest), parts(current)];
    const available = l.some((n, i) => n !== (c[i] || 0) && l.slice(0, i).every((x, j) => x === (c[j] || 0)) && n > (c[i] || 0));
    return {
      available,
      latest,
      current,
      url: data.html_url,
    };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

module.exports = { checkForUpdate };
