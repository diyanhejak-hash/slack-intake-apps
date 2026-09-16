const fs = require("node:fs");
const crypto = require("node:crypto");
const { WebClient } = require("@slack/web-api");
const { db } = require("./db.cjs");

// channels:read + groups:read ditambah buat users.conversations (dropdown pilih channel di New Project) —
// beda dari Phase 0 yang gak punya fitur pilih-channel-dari-daftar.
const USER_SCOPES = "chat:write,files:write,users:read,groups:write,channels:read,groups:read,reactions:write";

// PKCE (poin revisi keamanan, general availability Maret 2026 — https://docs.slack.dev/changelog/2026/03/30/pkce/)
// — App "public client", gak lagi butuh client_secret disebar ke tiap instalasi. code_verifier
// dibikin BARU tiap login (random, gak disimpan di mana pun setelah proses ini kelar), code_challenge
// = SHA-256(code_verifier) di-encode base64url (RFC 4648 §5, TANPA padding — persis yang diminta
// dokumentasi Slack). PENTING: PKCE harus DIAKTIFKAN di Slack App dashboard-nya SEBELUM kode ini
// dipakai — kalau belum, App masih nganggep dirinya "confidential client" (masih minta client_secret),
// login bakal gagal.
function pkcePair() {
  const codeVerifier = crypto.randomBytes(32).toString("base64url"); // 43 char, sesuai RFC 7636
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

// Redirect via custom URI scheme (slackintakeapps://callback), BUKAN server HTTP lokal —
// syarat "Use HTTPS For Your Features" di Manage Distribution Slack nolak http://localhost
// (itu dianggap redirect buat development doang). Custom URI scheme "always treated as desktop
// redirect" dan didukung penuh sama PKCE (https://docs.slack.dev/authentication/using-pkce/),
// ini jalur resmi buat app desktop yang didistribusikan. OS yang antar `slackintakeapps://...`
// balik ke app ini (app.on("open-url") / "second-instance" di main.cjs), main.cjs manggil
// completeLoginFromUrl() di bawah begitu link itu nyampe.
let pendingLogin = null;

function loginWithBrowser({ clientId, redirectUri }, openUrl) {
  if (!clientId || !redirectUri) {
    throw new Error("Client ID dan Redirect URI wajib diisi (cek .env).");
  }
  if (pendingLogin) throw new Error("Login sedang berjalan.");

  const state = crypto.randomBytes(24).toString("base64url");
  const { codeVerifier, codeChallenge } = pkcePair();
  const authorizeUrl =
    `https://slack.com/oauth/v2/authorize?client_id=${clientId}` +
    `&user_scope=${USER_SCOPES}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&code_challenge=${codeChallenge}&code_challenge_method=S256` +
    `&state=${state}`;

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingLogin = null;
      reject(new Error("Login Slack kedaluwarsa. Coba login lagi."));
    }, 5 * 60 * 1000);
    pendingLogin = { clientId, redirectUri, state, codeVerifier, resolve, reject, timer };
    Promise.resolve().then(() => openUrl(authorizeUrl)).catch((error) => {
      clearTimeout(timer);
      pendingLogin = null;
      reject(error);
    });
  });
}

// Dipanggil dari main.cjs tiap OS ngirim balik URL slackintakeapps://... . Callback asing/salah
// state DIABAIKAN (return diam-diam) — gak boleh nge-cancel login yang lagi beneran berjalan.
async function completeLoginFromUrl(urlString) {
  if (!pendingLogin) return;
  let url;
  try { url = new URL(urlString); } catch { return; }
  if (url.searchParams.get("state") !== pendingLogin.state) return;

  const { clientId, redirectUri, codeVerifier, resolve, reject, timer } = pendingLogin;
  clearTimeout(timer);
  pendingLogin = null;

  const error = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  if (error) { reject(new Error(`Login dibatalkan/gagal: ${error}`)); return; }
  if (!code) { reject(new Error("Callback login tidak valid.")); return; }

  try {
    const client = new WebClient();
    const result = await client.oauth.v2.access({ client_id: clientId, code_verifier: codeVerifier, code, redirect_uri: redirectUri });
    const userToken = result.authed_user?.access_token;
    if (!userToken) throw new Error("Tidak ada authed_user.access_token — cek User Token Scopes di App.");
    console.log("[debug] oauth.v2.access result.team =", JSON.stringify(result.team));
    resolve({
      accessToken: userToken,
      userId: result.authed_user.id,
      team: result.team?.name,
      teamId: result.team?.id, // buat deep-link slack://channel?team=...&id=... pas kirim
      savedAt: new Date().toISOString(),
    });
  } catch (err) {
    reject(new Error(`${err.message} Gagal tukar code jadi token.`));
  }
}

function client(token) {
  // timeout 60s (dulu) kepotong duluan buat upload file gede (files.uploadV2 SHARE client yang
  // sama kayak panggilan ringan macam users.conversations) — koneksi upload lambat + file
  // mendekati batas 100MB gampang lewat 60 detik, padahal uploadnya masih jalan normal, cuma
  // pelan. Poin revisi lanjutan: batas ukuran file sendiri udah dihapus total (ikut aturan
  // Slack), jadi file bisa jauh lebih besar dari 100MB — 30 menit dikasih biar upload gede punya
  // ruang beneran, panggilan ringan tetap balik cepat (ini cuma ceiling, bukan delay per-request).
  return new WebClient(token, { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 30 * 60 * 1000 });
}

// Throttle POSTING MESSAGE per channel (poin revisi, stress-test nemu "we are not displaying
// some messages sent by this application") — dokumentasi Slack: "apps may post no more than
// one message per second per channel... If you attempt bursts, there is no guarantee that
// messages will be stored or displayed to users." Ini BUKAN error 429 biasa (WebClient gak
// nge-throw, request-nya "sukses" dari sisi API), jadi gak ketangkep sama try/catch — pesannya
// diam-diam ilang dari sisi user walau app kita nganggep semua berhasil. Fix: paksa jarak
// MINIMAL antar panggilan chat.postMessage/files.uploadV2 ke channel yang SAMA (per-channel,
// bukan global — channel lain gak ke-throttle bareng). 1100ms (dikit di atas 1 detik resmi
// Slack) biar ada buffer, bukan pas-pasan di garis batas. Cuma buat "posting message"
// (postMessage/uploadV2) — reactions.add beda tier/limit, gak kena masalah yang sama.
const lastPostedAt = new Map();
let minPostIntervalMs = 1100;
// Cuma buat test regresi (poin revisi) — delay real 1.1 detik x puluhan panggilan di test bakal
// bikin suite lambat banget. Production TETAP 1100ms, test set ke 0/kecil lewat ini.
function setMinPostIntervalForTests(ms) { minPostIntervalMs = ms; }
async function paceChannel(channelId) {
  const last = lastPostedAt.get(channelId) || 0;
  const wait = last + minPostIntervalMs - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastPostedAt.set(channelId, Date.now());
}

// Throttle reactions.add (poin revisi lanjutan) — beda tier dari posting message (Tier 3,
// "50+ per minute", bukan 1/detik ketat + gak ada gejala "diam-diam ilang" yang didokumentasiin
// buat ini). Dipace GLOBAL (bukan per-channel) — limitnya per method/workspace, dan app ini cuma
// punya 1 token/workspace aktif per sesi, jadi 1 pacer bareng udah cukup akurat. ~1200ms (60000/50)
// biar aman di bawah 50/menit dengan buffer dikit.
let lastReactionAt = 0;
let minReactionIntervalMs = 1200;
function setReactionIntervalForTests(ms) { minReactionIntervalMs = ms; }
async function paceReactions() {
  const wait = lastReactionAt + minReactionIntervalMs - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastReactionAt = Date.now();
}

// Auto-retry pas kena rate-limit (poin revisi) — WebClient (rejectRateLimitedCalls:true,
// retryConfig:{retries:0}) sengaja MATIIN retry bawaan SDK (biar gak nunggu diam-diam gak jelas
// berapa lama di dalam 1 await) — begitu Slack balikin 429, error yang nyampe ke kita punya
// `.code === "slack_webapi_rate_limited_error"` DAN `.retryAfter` (detik, dari header resmi
// Retry-After Slack — dicek langsung dari source @slack/web-api, bukan tebakan). Sebelumnya:
// user langsung lihat error, harus retry manual. Sekarang: tunggu PERSIS sesuai retryAfter
// (+buffer dikit), coba lagi otomatis — maksimal beberapa kali, biar gak infinite loop kalau
// Slack-nya beneran bermasalah terus-terusan.
async function withRetry(fn, maxAttempts = 4) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error?.code !== "slack_webapi_rate_limited_error" || attempt >= maxAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, (error.retryAfter + 0.5) * 1000));
    }
  }
}

async function listChannels(token) {
  const c = client(token);
  const channels = [];
  let cursor;
  do {
    const res = await c.users.conversations({ types: "public_channel,private_channel", exclude_archived: true, limit: 200, cursor });
    channels.push(...(res.channels || []));
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return channels.map((ch) => ({
    id: ch.id,
    name: ch.name,
    isPrivate: !!ch.is_private,
  }));
}

async function listUsers(token) {
  const c = client(token);
  const members = [];
  let cursor;
  do {
    const res = await c.users.list({ limit: 200, cursor });
    members.push(...(res.members || []));
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return members
    .filter((m) => !m.is_bot && !m.deleted && m.id !== "USLACKBOT")
    .map((m) => ({
      id: m.id,
      name: m.profile?.real_name || m.name,
      avatar: m.profile?.image_48,
    }));
}

const getThread = db.prepare(`SELECT thread_ts, artist_sent, permalink FROM threads WHERE item_name = ? AND channel_id = ?`);
const upsertThread = db.prepare(
  `INSERT INTO threads (item_name, channel_id, thread_ts, updated_at) VALUES (@itemName, @channelId, @threadTs, @updatedAt)
   ON CONFLICT(item_name, channel_id) DO UPDATE SET thread_ts = excluded.thread_ts, updated_at = excluded.updated_at`
);
const setThreadArtistSent = db.prepare(`UPDATE threads SET artist_sent = 1, updated_at = ? WHERE item_name = ? AND channel_id = ?`);
const setThreadPermalink = db.prepare(`UPDATE threads SET permalink = ?, updated_at = ? WHERE item_name = ? AND channel_id = ?`);
const getThreadChannel = db.prepare(`SELECT channel_id FROM threads WHERE item_name = ? ORDER BY updated_at DESC LIMIT 1`);
// Instant Intake (poin revisi) gak selalu tau/kasih channelId eksplisit (field-level, khususnya)
// — daripada nebak project.channel_id doang (bisa keliru kalau kiriman ASLI dulu dikirim ke
// channel LAIN lewat override di Slack View Preview), cek dulu item ini pernah punya thread di
// channel mana. Null kalau item ini beneran belum pernah dikirim sama sekali.
function findThreadChannel(itemName) {
  return getThreadChannel.get(itemName)?.channel_id || null;
}

const getThreadAny = db.prepare(`SELECT channel_id, thread_ts FROM threads WHERE item_name = ? ORDER BY updated_at DESC LIMIT 1`);
// Reaction INSTAN (poin revisi) butuh channelId+thread_ts sekaligus buat reactions.add — null
// kalau item ini belum pernah punya thread sama sekali (belum pernah dikirim).
function findThreadInfo(itemName) {
  const row = getThreadAny.get(itemName);
  return row ? { channelId: row.channel_id, threadTs: row.thread_ts } : null;
}

const getAttempt = db.prepare(`SELECT * FROM send_attempts WHERE item_name = ? AND channel_id = ?`);
const saveAttempt = db.prepare(`
  INSERT INTO send_attempts (item_name, channel_id, fingerprint, thread_ts, artist_sent, next_post, updated_at)
  VALUES (@itemName, @channelId, @fingerprint, @threadTs, @artistSent, @nextPost, @updatedAt)
  ON CONFLICT(item_name, channel_id) DO UPDATE SET fingerprint=excluded.fingerprint, thread_ts=excluded.thread_ts,
    artist_sent=excluded.artist_sent, next_post=excluded.next_post, updated_at=excluded.updated_at
`);
const clearAttempt = db.prepare(`DELETE FROM send_attempts WHERE item_name = ? AND channel_id = ?`);
// Bikin baris send_attempts KOSONG kalau belum ada (poin revisi, dipakai ensureRoot/
// sendArtistMention) — cuma buat nyimpen pending_phase pas fase itu lagi jalan, gak nyentuh
// fingerprint/thread_ts/artist_sent/next_post punya baris yang mungkin udah ada (biar gak numpuk
// data punya fase "post", yang emang butuh fingerprint asli).
const ensureAttemptRow = db.prepare(`
  INSERT INTO send_attempts (item_name, channel_id, fingerprint, thread_ts, artist_sent, next_post, updated_at)
  VALUES (?, ?, '', '', 0, 0, ?)
  ON CONFLICT(item_name, channel_id) DO NOTHING
`);

// Reuse pola sendItem Phase 0 (lib/slack-send.js), diperluas: multi-file per reply ikut batas
// asli Slack (files.uploadV2 file_uploads array, bukan hardcode 5 seperti Command Builder/HB5),
// plus `posts` — daftar reply berurutan (attach langsung + tiap Reply dari Drawer/Template).
const sending = new Set();
const setPending = db.prepare('UPDATE send_attempts SET pending_phase=? WHERE item_name=? AND channel_id=?');
function pendingAttempt(key, channelId) { return getAttempt.get(key, channelId) || null; }

function legacyThread(itemName, channelId) { return getThread.get(itemName, channelId) || null; }
function bindLegacyThread(key, channelId, legacy) {
  upsertThread.run({ itemName: key, channelId, threadTs: legacy.thread_ts, updatedAt: new Date().toISOString() });
  if (legacy.artist_sent) setThreadArtistSent.run(new Date().toISOString(), key, channelId);
}

function resolveAttempt({ threadKey, channelId, action, threadTs }) {
  if (sending.has(threadKey)) throw new Error("Pengiriman masih berjalan.");
  const attempt = getAttempt.get(threadKey, channelId);
  if (!attempt) return;
  if (action === "restart") { clearAttempt.run(threadKey, channelId); return; }
  if (!["received", "retry"].includes(action)) throw new Error("Pilihan pemulihan tidak valid.");
  if (attempt.pending_phase === "root" && action === "received") {
    if (!/^\d+\.\d+$/.test(threadTs || "")) throw new Error("Timestamp thread Slack wajib diisi.");
    upsertThread.run({ itemName: threadKey, channelId, threadTs, updatedAt: new Date().toISOString() });
    db.prepare('UPDATE send_attempts SET thread_ts=? WHERE item_name=? AND channel_id=?').run(threadTs, threadKey, channelId);
  } else if (attempt.pending_phase === "artist" && action === "received") {
    setThreadArtistSent.run(new Date().toISOString(), threadKey, channelId);
    db.prepare('UPDATE send_attempts SET artist_sent=1 WHERE item_name=? AND channel_id=?').run(threadKey, channelId);
  } else if (attempt.pending_phase === "post" && action === "received") {
    db.prepare('UPDATE send_attempts SET next_post=next_post+1 WHERE item_name=? AND channel_id=?').run(threadKey, channelId);
  }
  setPending.run(null, threadKey, channelId);
}

async function sendItem({ token, channelId, itemName, threadKey, artistId, posts = [] }) {
  if (!token || !channelId || !itemName) throw new Error("Login, channel, dan nama item wajib diisi.");
  const key = threadKey || JSON.stringify([crypto.createHash("sha256").update(token).digest("hex"), itemName]);
  if (sending.has(key)) throw new Error("Item ini sedang dikirim.");
  sending.add(key);
  try {
    // Validate every file before any Slack side effect; uploads use streams. Gak ada batas
    // ukuran sendiri (poin revisi) — ikut aturan Slack aja, biar Slack yang nolak kalau memang
    // di luar batas mereka (jauh lebih besar dari batas lama 100MB yang kita set sendiri).
    const fileSignatures = [];
    for (const post of posts) for (const file of post.files || []) {
      const stat = fs.statSync(file.path);
      if (!stat.isFile()) throw new Error("Attachment bukan file.");
      const hash = crypto.createHash("sha256");
      for await (const chunk of fs.createReadStream(file.path)) hash.update(chunk);
      fileSignatures.push(hash.digest("hex"));
    }
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ artistId: artistId || null, posts, fileSignatures })).digest("hex");
    const previous = getAttempt.get(key, channelId);
    if (previous?.pending_phase) throw new Error("Hasil kirim sebelumnya belum pasti. Periksa Slack lalu gunakan Pulihkan kiriman.");
    if (previous && previous.fingerprint !== fingerprint) throw new Error("Isi berubah sejak kiriman parsial. Pulihkan kiriman sebelum mencoba lagi.");
    const existing = getThread.get(key, channelId);
    let threadTs = previous?.thread_ts || existing?.thread_ts || "";
    let artistSent = previous?.artist_sent || existing?.artist_sent || 0;
    let nextPost = previous?.next_post || 0;
    let isNew = false;
    const c = client(token);
    const save = () => saveAttempt.run({ itemName: key, channelId, fingerprint, threadTs, artistSent, nextPost, updatedAt: new Date().toISOString() });
    save();
    async function request(phase, fn) {
      setPending.run(phase, key, channelId);
      await paceChannel(channelId);
      try {
        const result = await withRetry(fn);
        return result;
      } catch (error) {
        // A platform rejection of a single chat call is definitive. UploadV2 is multi-step.
        if (phase !== "post" && error?.data?.ok === false) setPending.run(null, key, channelId);
        throw new Error(`${error.message} Hasil kirim perlu diperiksa di Slack sebelum retry.`);
      }
    }
    if (!threadTs) {
      const posted = await request("root", () => c.chat.postMessage({ channel: channelId, text: `*${itemName}*` }));
      threadTs = posted.ts;
      isNew = true;
      upsertThread.run({ itemName: key, channelId, threadTs, updatedAt: new Date().toISOString() });
      save(); setPending.run(null, key, channelId);
    }
    if (artistId && !artistSent) {
      await request("artist", () => c.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `<@${artistId}>` }));
      artistSent = 1;
      setThreadArtistSent.run(new Date().toISOString(), key, channelId);
      save(); setPending.run(null, key, channelId);
    }
    for (let index = nextPost; index < posts.length; index++) {
      const post = posts[index];
      if (post.files?.length) {
        const streams = post.files.map((f) => fs.createReadStream(f.path));
        try {
          await request("post", () => c.files.uploadV2({
            channel_id: channelId, thread_ts: threadTs, initial_comment: post.text || undefined,
            file_uploads: post.files.map((f, i) => ({ file: streams[i], filename: f.filename })),
          }));
        } finally { streams.forEach((stream) => stream.destroy()); }
      } else if (post.text) {
        await request("post", () => c.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: post.text }));
      }
      nextPost = index + 1; save(); setPending.run(null, key, channelId);
    }
    upsertThread.run({ itemName: key, channelId, threadTs, updatedAt: new Date().toISOString() });
    clearAttempt.run(key, channelId);
    let permalink = existing?.permalink || undefined;
    try {
      ({ permalink } = await c.chat.getPermalink({ channel: channelId, message_ts: threadTs }));
      if (permalink) setThreadPermalink.run(permalink, new Date().toISOString(), key, channelId);
    } catch { /* delivery succeeded; permalink is optional */ }
    return { threadTs, isNew, permalink, artistSent: !!artistSent };
  } finally { sending.delete(key); }
}

// ---------- Kirim BATCH 4-fase (poin revisi) ----------
// send:start (main.cjs) sekarang kirim per-FASE lintas SEMUA item terpilih (semua item pesan
// utama dulu, baru semua item di-assign, dst) — BEDA dari sendItem() di atas (dipakai send:quick/
// Instant Intake, 1 item doang per panggilan, gak ada konsep "fase lintas item"). 3 fungsi di
// bawah ini SENGAJA dipisah dari sendItem, bukan hasil pecah ulang sendItem — sendItem TETAP
// dipakai apa adanya, zero perubahan, biar Instant Intake gak kesenggol sama sekali.
//
// Idempotensi root & assign PAKAI tabel `threads` (thread_ts/artist_sent) yang udah ada, BUKAN
// fingerprint kayak sendItem — soalnya isinya SELALU deterministik (nama item / artist_id),
// beda dari reply yang isinya bisa macam-macam & butuh deteksi "isi berubah pas retry".
// `pending_phase` (send_attempts) dipakai buat penanda "lagi di tengah panggilan API" —
// dialog Pulihkan Kiriman (send:recover, main.cjs) generik, baca field ini apa adanya, jadi
// TIDAK perlu diubah — string fase ("root"/"artist"/"post") sengaja sama persis kayak sendItem.

async function ensureRoot({ token, channelId, itemName, threadKey }) {
  if (!token || !channelId || !itemName) throw new Error("Login, channel, dan nama item wajib diisi.");
  const key = threadKey || JSON.stringify([crypto.createHash("sha256").update(token).digest("hex"), itemName]);
  if (sending.has(key)) throw new Error("Item ini sedang dikirim.");
  sending.add(key);
  try {
    const existing = getThread.get(key, channelId);
    if (existing?.thread_ts) return { threadTs: existing.thread_ts, isNew: false };
    const attempt = getAttempt.get(key, channelId);
    if (attempt?.pending_phase === "root") throw new Error("Hasil kirim sebelumnya belum pasti. Periksa Slack lalu gunakan Pulihkan kiriman.");
    ensureAttemptRow.run(key, channelId, new Date().toISOString());
    setPending.run("root", key, channelId);
    const c = client(token);
    await paceChannel(channelId);
    let posted;
    try {
      posted = await withRetry(() => c.chat.postMessage({ channel: channelId, text: `*${itemName}*` }));
    } catch (error) {
      throw new Error(`${error.message} Hasil kirim perlu diperiksa di Slack sebelum retry.`);
    }
    upsertThread.run({ itemName: key, channelId, threadTs: posted.ts, updatedAt: new Date().toISOString() });
    setPending.run(null, key, channelId);
    return { threadTs: posted.ts, isNew: true };
  } finally { sending.delete(key); }
}

async function sendArtistMention({ token, channelId, threadKey, threadTs, artistId }) {
  if (!token || !channelId || !threadTs || !artistId) throw new Error("Data assign artis tidak lengkap.");
  const key = threadKey;
  if (sending.has(key)) throw new Error("Item ini sedang dikirim.");
  sending.add(key);
  try {
    const existing = getThread.get(key, channelId);
    if (existing?.artist_sent) return { artistSent: true };
    const attempt = getAttempt.get(key, channelId);
    if (attempt?.pending_phase === "artist") throw new Error("Hasil kirim sebelumnya belum pasti. Periksa Slack lalu gunakan Pulihkan kiriman.");
    ensureAttemptRow.run(key, channelId, new Date().toISOString());
    setPending.run("artist", key, channelId);
    const c = client(token);
    await paceChannel(channelId);
    try {
      await withRetry(() => c.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: `<@${artistId}>` }));
    } catch (error) {
      throw new Error(`${error.message} Hasil kirim perlu diperiksa di Slack sebelum retry.`);
    }
    setThreadArtistSent.run(new Date().toISOString(), key, channelId);
    setPending.run(null, key, channelId);
    return { artistSent: true };
  } finally { sending.delete(key); }
}

async function sendReplies({ token, channelId, threadKey, threadTs, posts = [] }) {
  if (!token || !channelId || !threadTs) throw new Error("Login, channel, dan thread wajib diisi.");
  const key = threadKey;
  if (!posts.length) { clearAttempt.run(key, channelId); return { permalink: undefined }; }
  if (sending.has(key)) throw new Error("Item ini sedang dikirim.");
  sending.add(key);
  try {
    // Sama kayak sendItem: validasi semua file + hash dulu sebelum ada side-effect ke Slack.
    const fileSignatures = [];
    for (const post of posts) for (const file of post.files || []) {
      const stat = fs.statSync(file.path);
      if (!stat.isFile()) throw new Error("Attachment bukan file.");
      const hash = crypto.createHash("sha256");
      for await (const chunk of fs.createReadStream(file.path)) hash.update(chunk);
      fileSignatures.push(hash.digest("hex"));
    }
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ posts, fileSignatures })).digest("hex");
    const previous = getAttempt.get(key, channelId);
    if (previous?.pending_phase === "post") throw new Error("Hasil kirim sebelumnya belum pasti. Periksa Slack lalu gunakan Pulihkan kiriman.");
    // next_post > 0 (poin revisi) — baris ini mungkin cuma placeholder kosong dari
    // ensureRoot/sendArtistMention (fingerprint ''), BUKAN sisa attempt reply yang genuinely
    // parsial. Fingerprint mismatch cuma relevan kalau MEMANG udah ada reply yang kekirim.
    if (previous && previous.next_post > 0 && previous.fingerprint !== fingerprint) throw new Error("Isi berubah sejak kiriman parsial. Pulihkan kiriman sebelum mencoba lagi.");
    let nextPost = previous?.next_post || 0;
    const c = client(token);
    const save = () => saveAttempt.run({ itemName: key, channelId, fingerprint, threadTs, artistSent: previous?.artist_sent || 0, nextPost, updatedAt: new Date().toISOString() });
    save();
    async function request(fn) {
      setPending.run("post", key, channelId);
      await paceChannel(channelId);
      try {
        return await withRetry(fn);
      } catch (error) {
        throw new Error(`${error.message} Hasil kirim perlu diperiksa di Slack sebelum retry.`);
      }
    }
    for (let index = nextPost; index < posts.length; index++) {
      const post = posts[index];
      if (post.files?.length) {
        const streams = post.files.map((f) => fs.createReadStream(f.path));
        try {
          await request(() => c.files.uploadV2({
            channel_id: channelId, thread_ts: threadTs, initial_comment: post.text || undefined,
            file_uploads: post.files.map((f, i) => ({ file: streams[i], filename: f.filename })),
          }));
        } finally { streams.forEach((stream) => stream.destroy()); }
      } else if (post.text) {
        await request(() => c.chat.postMessage({ channel: channelId, thread_ts: threadTs, text: post.text }));
      }
      nextPost = index + 1; save(); setPending.run(null, key, channelId);
    }
    clearAttempt.run(key, channelId);
    let permalink;
    try {
      ({ permalink } = await c.chat.getPermalink({ channel: channelId, message_ts: threadTs }));
      if (permalink) setThreadPermalink.run(permalink, new Date().toISOString(), key, channelId);
    } catch { /* delivery succeeded; permalink is optional */ }
    return { permalink };
  } finally { sending.delete(key); }
}

// Reaction (poin revisi) — dipakai 2 jalur: instan (overlay hover pil item, fire-and-forget) DAN
// batch (pending item_reactions, dikirim bareng lewat send:start). "already_reacted" DIANGGAP
// SUKSES (idempoten) — pesan yang udah di-react gak perlu di-react lagi, bukan error beneran.
async function addReaction({ token, channelId, timestamp, name }) {
  if (!token) throw new Error("Belum login ke Slack.");
  if (!channelId || !timestamp) throw new Error("Belum ada pesan buat di-react (item ini belum pernah dikirim).");
  const c = client(token);
  await paceReactions();
  try {
    await withRetry(() => c.reactions.add({ channel: channelId, timestamp, name }));
  } catch (err) {
    if (err?.data?.error === "already_reacted") return;
    throw err;
  }
}

// Post SEDERHANA ke channel (poin revisi, papan status "HB Apps online/kirim/selesai/offline")
// — BUKAN bagian dari alur kirim item (gak ada thread-tracking/idempotensi kayak ensureRoot dst,
// tiap panggilan SELALU pesan baru), tetap lewat paceChannel+withRetry yang SAMA biar konsisten
// sopan ke rate-limit channel itu.
async function postSimpleMessage({ token, channelId, text }) {
  if (!token || !channelId || !text) throw new Error("Token, channel, dan teks wajib diisi.");
  const c = client(token);
  await paceChannel(channelId);
  return withRetry(() => c.chat.postMessage({ channel: channelId, text }));
}

// Reuse persis Phase 0 lib/slack-channel.js — bikin channel privat lalu invite member,
// sebagai user yang login (jadi owner channel). Scope groups:write sudah cukup, sudah
// dibuktikan jalan di Phase 0, gak perlu scope baru.
async function createPrivateChannel({ token, name, memberIds = [] }) {
  if (!token) throw new Error("Belum login ke Slack.");
  if (!name) throw new Error("Nama channel belum diisi.");

  const safeName = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");

  const c = client(token);
  const created = await c.conversations.create({ name: safeName, is_private: true });
  const channelId = created.channel.id;

  if (memberIds.length) {
    await c.conversations.invite({ channel: channelId, users: memberIds.join(",") });
  }

  return { channelId, name: safeName };
}

module.exports = { loginWithBrowser, completeLoginFromUrl, client, listChannels, listUsers, sendItem, ensureRoot, sendArtistMention, sendReplies, postSimpleMessage, createPrivateChannel, findThreadChannel, findThreadInfo, addReaction, pendingAttempt, resolveAttempt, legacyThread, bindLegacyThread, setMinPostIntervalForTests, setReactionIntervalForTests };
