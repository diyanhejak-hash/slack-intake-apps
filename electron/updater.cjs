const { app } = require("electron");

// Cek versi doang, install tetap manual (poin 9 rancangan — app unsigned/gratis di Mac
// gak bisa pakai auto-update diam-diam ala Squirrel.Mac yang butuh signing).
async function checkForUpdate(repo) {
  if (!repo) return { available: false, reason: "GITHUB_REPO belum dikonfigurasi." };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`);
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
