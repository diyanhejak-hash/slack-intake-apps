// Papan status "HB Apps" (poin revisi, hasil diskusi rate-limit) — 1 channel Slack biasa jadi
// tempat semua user app ini broadcast Online/Offline/mulai-kirim/selesai-kirim. Tujuannya: user
// lain tau siapa lagi pakai app & kapan ada yang lagi nge-hantam rate-limit workspace bareng
// (reactions.add dkk berbagi 1 kuota per-workspace-per-app, lihat diskusi sebelumnya), biar bisa
// saling koordinasi manual (lewat DM Slack biasa) tanpa perlu server/infrastruktur baru.
//
// Channel di-TEMUKAN lewat NAMA (bukan ID hardcode — beda tiap workspace), di-cache in-memory
// SEKALI per proses app biar gak scan ulang (listChannels) tiap mau post. Semua fungsi di sini
// BEST-EFFORT — gagal post (channel gak ketemu, network error, dst) TIDAK BOLEH nge-block/
// nggagalin alur utama app (login, kirim ke Slack, atau nutup app).
//
// "HB-Apps" (poin revisi, nama yang diminta user) — Slack SELALU nyimpen nama channel huruf
// kecil semua (buat channel via UI/API otomatis di-lowercase, gak bisa mixed-case), jadi channel
// beneran di Slack namanya "hb-apps". Matching tetep case-insensitive buat jaga-jaga.
const fs = require("node:fs");
const STATUS_CHANNEL_NAME = "hb-apps";

let cachedChannelId = null;
let scanned = false;

async function findStatusChannel(slack, token) {
  if (cachedChannelId) return cachedChannelId;
  if (scanned) return null; // udah pernah discan & gak ketemu -- jangan scan ulang terus-terusan
  scanned = true;
  try {
    const channels = await slack.listChannels(token);
    const found = channels.find((c) => c.name.toLowerCase() === STATUS_CHANNEL_NAME);
    if (found) cachedChannelId = found.id;
  } catch { /* best-effort */ }
  return cachedChannelId;
}

async function postStatus(slack, token, text) {
  try {
    const channelId = await findStatusChannel(slack, token);
    if (!channelId || !token) return;
    await slack.postSimpleMessage({ token, channelId, text });
  } catch { /* best-effort -- gagal post status gak boleh nge-block alur utama */ }
}

// Poin revisi: "mulai -> progress -> selesai" SEKARANG 1 pesan aja yang di-EDIT berkala (dulu
// 2 pesan terpisah: "Eksekusi N job..." di awal, "Job selesai" di akhir, gak ada progress sama
// sekali di antaranya). postJobStatus post pesan pertamanya, balikin handle {channelId, ts} buat
// dipakai updateJobStatus ngedit pesan yang SAMA berkali-kali.
async function postJobStatus(slack, token, text) {
  try {
    const channelId = await findStatusChannel(slack, token);
    if (!channelId || !token) return null;
    const posted = await slack.postSimpleMessage({ token, channelId, text });
    return { channelId, ts: posted.ts };
  } catch { return null; } // best-effort -- kalau gagal post awal, progress selanjutnya di-skip diem-diem (handle null)
}

async function updateJobStatus(slack, token, handle, text) {
  if (!handle?.channelId || !handle?.ts || !token) return;
  try {
    await slack.updateSimpleMessage({ token, channelId: handle.channelId, ts: handle.ts, text });
  } catch { /* best-effort -- gagal edit status gak boleh nge-block kirim */ }
}

// Poin revisi (diminta user) — pesan PALING AWAL (sebelum progress apa pun) beda format dari
// pesan progress: cuma "Eksekusi N job..." (total doang, gak ada pecahan "0/N" yang keliatan
// aneh soalnya belum ada satu pun yang kelar).
function formatCounts(counts) {
  return [
    `Item: ${counts.items}`,
    `Assign: ${counts.assigns}`,
    `Reply: ${counts.replies}`,
    `File: ${counts.files}`,
  ].join(" | ");
}

function formatJobStart({ counts, estimateMinutes }) {
  return `:arrow_forward: Eksekusi ${counts.total} job, estimasi ${estimateMinutes} menit\n${formatCounts(counts)}`;
}

function formatJobHeader({ doneJobs, counts, estimateMinutes }) {
  return `:arrow_forward: Eksekusi ${doneJobs}/${counts.total} job, estimasi ${estimateMinutes} menit\n${formatCounts(counts)}`;
}

// Poin revisi (diminta user) — presisi setengah blok (▌) buat persentase yang gak abis dibagi 10
// (mis. 95%) -- sebelumnya dibulatin ke blok penuh terdekat, bikin 95% keliatan SAMA PERSIS kayak
// 100% (10 blok penuh, gak ada beda visual). Sekarang 95% = 9 blok penuh + 1 setengah blok.
function progressBar(percent) {
  const units = Math.max(0, Math.min(10, percent / 10));
  const full = Math.floor(units);
  const half = units - full >= 0.5 ? 1 : 0;
  const empty = 10 - full - half;
  return "█".repeat(full) + (half ? "▌" : "") + "░".repeat(Math.max(0, empty));
}

function formatJobProgress({ doneJobs, counts, percent, estimateMinutes }) {
  return `${formatJobHeader({ doneJobs, counts, estimateMinutes })}\nProgress.. ${progressBar(percent)} ${percent}%`;
}

function formatJobDone({ counts, okCount, failedNames = [] }) {
  const lines = [`:white_check_mark: Eksekusi Selesai, ${okCount}/${counts.items} item berhasil.`, formatCounts(counts)];
  if (failedNames.length) lines.push(`Gagal (${failedNames.length}): ${failedNames.join(", ")}`);
  return lines.join("\n");
}

// Ngedit pesan job cuma pas progress nyentuh threshold (poin revisi: "10%, lalu kelipatan 20,
// lalu 95%") -- BUKAN tiap step selesai, biar gak nge-flood chat.update (rate-limit channel
// status dipakai bareng SEMUA user app ini). `step(units)` menerima jumlah unit kerja yang
// selesai pada tiap fase. Totalnya dibekukan dari awal, jadi persentase tetap nyampe 100%
// ketika job selesai walau ada item yang gagal atau dibatalkan.
const PROGRESS_THRESHOLDS = [10, 30, 50, 70, 90, 95];
function createProgressEditor({ slack, token, handle, counts, estimateMinutes }) {
  let completedSteps = 0;
  let firedUpTo = 0;
  return async function step(units = 1) {
    completedSteps = Math.min(counts.total, completedSteps + Math.max(0, units));
    if (!counts.total || !units) return;
    const percent = Math.min(100, Math.round((completedSteps / counts.total) * 100));
    const crossed = PROGRESS_THRESHOLDS.filter((t) => t > firedUpTo && percent >= t);
    const next = crossed[crossed.length - 1];
    if (!next) return;
    firedUpTo = next;
    await updateJobStatus(slack, token, handle, formatJobProgress({ doneJobs: completedSteps, counts, percent, estimateMinutes }));
  };
}

function countItemWork(item, scope) {
  const includePosts = scope !== "item" && scope !== "artist";
  const replies = includePosts
    ? (item.replies || []).filter((reply) => !reply.sent && ((reply.title || "").trim() || (reply.text_value || "").trim() || (reply.files || []).length))
    : [];
  return {
    items: 1,
    assigns: (item.artists || []).length,
    replies: replies.length,
    files: includePosts
      ? replies.reduce((total, reply) => total + (reply.files || []).length, 0) + (scope === "replies" ? 0 : (item.files || []).length)
      : 0,
  };
}

function countSendWork({ targets, scope }) {
  const counts = { items: 0, assigns: 0, replies: 0, files: 0 };
  for (const item of targets) {
    const itemCounts = countItemWork(item, scope);
    for (const key of Object.keys(counts)) counts[key] += itemCounts[key];
  }
  return { ...counts, total: counts.items + counts.assigns + counts.replies + counts.files };
}

// Estimasi waktu kirim (poin revisi) — REAL, bukan tebakan kasar, ngikutin persis pacing 4-fase
// (paceChannel 1.1s/panggilan, paceReactions 1.2s/panggilan) yang udah jalan di send:start.
// Ukuran file lokal ikut dihitung dengan asumsi 5 MB/detik, overhead 0,4 detik per file, lalu
// seluruh subtotal diberi buffer jaringan 15%. fs.stat cuma membaca metadata, bukan isi file.
function estimateSendMinutes({ targets, scope, assignModes: _assignModes, presetByMember, projects }) {
  const MSG_SEC = 1.1;
  const REACT_SEC = 1.2;
  const BYTES_PER_MB = 1024 * 1024;
  const UPLOAD_MB_PER_SEC = 5;
  const FILE_OVERHEAD_SEC = 0.4;
  const FALLBACK_FILE_BYTES = 25 * BYTES_PER_MB;
  const NETWORK_BUFFER = 1.15;
  let seconds = targets.length * MSG_SEC;
  let uploadBytes = 0;
  let uploadFileCount = 0;
  const sizeCache = new Map();

  function addFiles(files) {
    for (const file of files || []) {
      const filePath = file?.stored_path || file?.path;
      let bytes = sizeCache.get(filePath);
      if (bytes === undefined) {
        try {
          const stat = filePath && fs.statSync(filePath);
          bytes = stat?.isFile() && Number.isFinite(stat.size) && stat.size >= 0 ? stat.size : FALLBACK_FILE_BYTES;
        } catch {
          bytes = FALLBACK_FILE_BYTES;
        }
        if (filePath) sizeCache.set(filePath, bytes);
      }
      uploadBytes += bytes;
      uploadFileCount += 1;
    }
  }

  for (const item of targets) {
    // Assignment atau placeholder selalu dikirim satu kali per item, termasuk saat Mention OFF.
    seconds += MSG_SEC;

    const codeNames = new Set((item.artists || []).map((a) => presetByMember.get(a.artist_id)?.code_name).filter(Boolean));
    const reactions = projects.listItemReactions(item.id).filter((reaction) => !reaction.sent);
    const artistReactionCount = reactions.filter((r) => codeNames.has(r.slack_shortcode)).length;
    seconds += artistReactionCount * REACT_SEC;
    seconds += (reactions.length - artistReactionCount) * REACT_SEC;
    // Status/custom header direkonsiliasi berurutan. Nilai yang sudah live perlu remove+add
    // supaya urutannya tetap mengikuti Status lalu urutan custom header.
    if (item.status_id || item.status_sent_shortcode) seconds += (item.status_sent_shortcode ? 2 : 1) * REACT_SEC;
    for (const value of item.custom_values || []) {
      if (value.option_id || value.sent_shortcode) seconds += (value.sent_shortcode ? 2 : 1) * REACT_SEC;
    }

    const nonEmptyReplies = (item.replies || []).filter((reply) => !reply.sent && ((reply.title || "").trim() || (reply.text_value || "").trim() || (reply.files || []).length));
    if (scope !== "item" && scope !== "artist") {
      const includeItemFiles = scope !== "replies" && (item.files || []).length > 0;
      seconds += ((includeItemFiles ? 1 : 0) + nonEmptyReplies.length) * MSG_SEC;
      if (includeItemFiles) addFiles(item.files);
      for (const reply of nonEmptyReplies) addFiles(reply.files);
    }
  }

  seconds += (uploadBytes / BYTES_PER_MB / UPLOAD_MB_PER_SEC) + (uploadFileCount * FILE_OVERHEAD_SEC);
  return Math.max(1, Math.ceil((seconds * NETWORK_BUFFER) / 60));
}

module.exports = {
  STATUS_CHANNEL_NAME, findStatusChannel, postStatus, estimateSendMinutes,
  postJobStatus, updateJobStatus, formatCounts, formatJobStart, formatJobHeader, formatJobProgress, formatJobDone, progressBar,
  countItemWork, countSendWork,
  createProgressEditor, PROGRESS_THRESHOLDS,
};
