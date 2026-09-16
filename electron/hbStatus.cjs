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

// Estimasi waktu kirim (poin revisi) — REAL, bukan tebakan kasar, ngikutin persis pacing 4-fase
// (paceChannel 1.1s/panggilan, paceReactions 1.2s/panggilan) yang udah jalan di send:start.
// Dipanggil SEBELUM proses kirim mulai, jadi cuma butuh HITUNG berapa panggilan per fase bakal
// kejadian -- bukan simulasi penuh.
function estimateSendMinutes({ targets, scope, assignMode, presetByMember, projects }) {
  const MSG_SEC = 1.1;
  const REACT_SEC = 1.2;
  let seconds = targets.length * MSG_SEC; // fase 1: root, semua item

  for (const item of targets) {
    let artistId = item.artist_id;
    if (scope === "item" || scope === "replies") artistId = null;
    if (artistId && assignMode === "mention") seconds += MSG_SEC;

    const codeName = item.artist_id && presetByMember.get(item.artist_id)?.code_name;
    const reactions = projects.listItemReactions(item.id);
    const artistReaction = codeName && reactions.find((r) => r.slack_shortcode === codeName);
    if (artistReaction) seconds += REACT_SEC;
    const otherCount = reactions.length - (artistReaction ? 1 : 0);
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

module.exports = { STATUS_CHANNEL_NAME, findStatusChannel, postStatus, estimateSendMinutes };
