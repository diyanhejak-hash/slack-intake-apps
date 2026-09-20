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
function formatJobStart({ totalJobs, estimateMinutes }) {
  return `:arrow_forward: Eksekusi ${totalJobs} job, estimasi ${estimateMinutes} menit`;
}

function formatJobHeader({ doneJobs, totalJobs, estimateMinutes }) {
  return `:arrow_forward: Eksekusi ${doneJobs}/${totalJobs} job, estimasi ${estimateMinutes} menit`;
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

function formatJobProgress({ doneJobs, totalJobs, percent, estimateMinutes }) {
  return `${formatJobHeader({ doneJobs, totalJobs, estimateMinutes })}\nProgress.. ${progressBar(percent)} ${percent}%`;
}

function formatJobDone({ totalJobs, okCount, failedNames = [] }) {
  const lines = [`:white_check_mark: Eksekusi Selesai, ${okCount} job Berhasil terkirim.`];
  if (failedNames.length) lines.push(`Gagal (${failedNames.length}): ${failedNames.join(", ")}`);
  return lines.join("\n");
}

// Ngedit pesan job cuma pas progress nyentuh threshold (poin revisi: "10%, lalu kelipatan 20,
// lalu 95%") -- BUKAN tiap step selesai, biar gak nge-flood chat.update (rate-limit channel
// status dipakai bareng SEMUA user app ini). `step()` dipanggil 1x tiap 1 slot kerja (item x fase)
// kelar, gak peduli sukses/gagal/dibatalkan -- totalSteps FIXED dari awal (targets.length x
// jumlah fase scope ini), jadi persentase SELALU nyampe 100% pas job kelar apa pun hasilnya.
const PROGRESS_THRESHOLDS = [10, 30, 50, 70, 90, 95];
function createProgressEditor({ slack, token, handle, totalJobs, totalSteps, estimateMinutes }) {
  let completedSteps = 0;
  let firedUpTo = 0;
  return async function step() {
    completedSteps++;
    if (!totalSteps) return;
    const percent = Math.min(100, Math.round((completedSteps / totalSteps) * 100));
    const next = PROGRESS_THRESHOLDS.find((t) => t > firedUpTo && percent >= t);
    if (!next) return;
    firedUpTo = next;
    const doneJobs = Math.min(totalJobs, Math.round((completedSteps / totalSteps) * totalJobs));
    await updateJobStatus(slack, token, handle, formatJobProgress({ doneJobs, totalJobs, percent, estimateMinutes }));
  };
}

// Estimasi waktu kirim (poin revisi) — REAL, bukan tebakan kasar, ngikutin persis pacing 4-fase
// (paceChannel 1.1s/panggilan, paceReactions 1.2s/panggilan) yang udah jalan di send:start.
// Dipanggil SEBELUM proses kirim mulai, jadi cuma butuh HITUNG berapa panggilan per fase bakal
// kejadian -- bukan simulasi penuh.
function estimateSendMinutes({ targets, scope, assignModes, presetByMember, projects }) {
  const MSG_SEC = 1.1;
  const REACT_SEC = 1.2;
  let seconds = targets.length * MSG_SEC; // fase 1: root, semua item

  for (const item of targets) {
    // Poin revisi: syncAssignMessage sekarang SELALU jalan tiap scope (item/replies TERMASUK,
    // gak di-skip lagi) DAN selalu post/update walau gak ada artis (placeholder) -- estimasi ini
    // ngikutin itu, gak nge-nolin/nge-syarat-kan artistIds lagi.
    // Mode mention (poin revisi multi-artist) — SATU pesan assignment per item (syncAssignMessage),
    // gak peduli berapa banyak artis-nya -- bukan 1 pesan PER artis lagi. Independen dari react
    // (poin revisi lanjutan: dua-duanya bisa aktif bareng).
    if (assignModes.mention) seconds += MSG_SEC;

    const codeNames = new Set((item.artists || []).map((a) => presetByMember.get(a.artist_id)?.code_name).filter(Boolean));
    const reactions = projects.listItemReactions(item.id);
    const artistReactionCount = reactions.filter((r) => codeNames.has(r.slack_shortcode)).length;
    seconds += artistReactionCount * REACT_SEC;
    const otherCount = reactions.length - artistReactionCount;
    seconds += otherCount * REACT_SEC;

    // Reply jadi post CUMA kalau title/text_value/files-nya gak kosong -- persis logika
    // composeReplyText+replyToPost (main.cjs), biar hitungannya akurat sama alur beneran.
    const nonEmptyReplyCount = item.replies.filter((r) => (r.title || "").trim() || (r.text_value || "").trim() || r.files.length).length;
    if (scope !== "item" && scope !== "artist") {
      const postCount = scope === "replies" ? nonEmptyReplyCount : (item.files.length ? 1 : 0) + nonEmptyReplyCount;
      seconds += postCount * MSG_SEC;
    }
  }
  return Math.max(1, Math.ceil(seconds / 60));
}

module.exports = {
  STATUS_CHANNEL_NAME, findStatusChannel, postStatus, estimateSendMinutes,
  postJobStatus, updateJobStatus, formatJobStart, formatJobHeader, formatJobProgress, formatJobDone, progressBar,
  createProgressEditor, PROGRESS_THRESHOLDS,
};
