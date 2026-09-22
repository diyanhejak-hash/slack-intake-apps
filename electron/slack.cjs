const fs = require("node:fs");
const crypto = require("node:crypto");
const { WebClient } = require("@slack/web-api");
const { db } = require("./db.cjs");

// channels:read + groups:read ditambah buat users.conversations (dropdown pilih channel di New Project) —
// beda dari Phase 0 yang gak punya fitur pilih-channel-dari-daftar. emoji:read (poin revisi) —
// ambil custom emoji ASLI workspace buat Preset Artis (emoji.list), gak perlu upload PNG manual
// + ngetik shortcode sendiri lagi. reactions:read (poin revisi, sync 2 arah) — dibutuhin buat
// Event Subscriptions "on behalf of users" nerima reaction_added/reaction_removed lewat Socket
// Mode. channels:history/groups:history (poin revisi, otomasi WIP) — dibutuhin buat nerima event
// pesan baru (message.channels/message.groups) lewat Socket Mode juga. users:read.email (poin
// revisi, sistem Admin/Member) — dibutuhin buat verifikasi "apakah akun Slack ini owner app"
// (dicocokin ke email hardcode di adminAccess.cjs), diambil sekali pas login lewat users.info.
// Scope BARU -- user existing wajib login ulang biar dapet ini.
const USER_SCOPES = "chat:write,files:write,users:read,users:read.email,groups:write,channels:read,groups:read,reactions:write,reactions:read,emoji:read,channels:history,groups:history";

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
    // Email (poin revisi, sistem Admin/Member) — dipakai verifikasi owner (adminAccess.cjs),
    // best-effort: gagal ambil (scope belum ke-approve dulu / network) TIDAK BOLEH nggagalin
    // login, cuma berarti isOwner ke-anggep false sampai user login ulang abis scope-nya fix.
    let email = null;
    try {
      const info = await client.users.info({ token: userToken, user: result.authed_user.id });
      email = info.user?.profile?.email || null;
    } catch { /* best-effort */ }
    resolve({
      accessToken: userToken,
      // refresh_token/expires_in (poin revisi, auto-refresh) — CUMA ada kalau App Slack-nya
      // punya "Token Rotation" aktif (kalau enggak, keduanya undefined/null, token gak pernah
      // expired — auto-refresh jadi no-op aman, gak nge-break App yang gak pakai rotation).
      refreshToken: result.authed_user.refresh_token || null,
      expiresAt: result.authed_user.expires_in ? Date.now() + result.authed_user.expires_in * 1000 : null,
      userId: result.authed_user.id,
      team: result.team?.name,
      teamId: result.team?.id, // buat deep-link slack://channel?team=...&id=... pas kirim
      email,
      savedAt: new Date().toISOString(),
    });
  } catch (err) {
    reject(new Error(`${err.message} Gagal tukar code jadi token.`));
  }
}

// Auto-refresh (poin revisi) — token_expired (dilempar Slack begitu access_token abis masa
// berlaku, App dengan Token Rotation aktif) sebelumnya matiin total app (semua panggilan Slack
// gagal, satu-satunya jalan logout+login manual). oauth.v2.access endpoint yang SAMA dipakai
// buat tukar refresh_token -> access_token baru, `grant_type: "refresh_token"` — TANPA
// client_secret (PKCE public client, sama kayak login awal).
// Poin revisi (bug ditemukan user, real refresh call ke Slack): response INITIAL exchange
// (authorization_code) nyimpen token di authed_user.* (user_scope) — TAPI response REFRESH
// grant_type=refresh_token ternyata balikin token BARU di TOP-LEVEL (access_token/refresh_token/
// expires_in), BUKAN nested authed_user lagi. OauthV2AccessResponse.d.ts (@slack/web-api) emang
// punya DUA-duanya field optional buat 2 skenario ini — sebelumnya cuma dibaca dari authed_user,
// jadi refresh SELALU "gagal" (newToken undefined) walau API call-nya sendiri sukses (ok:true).
// Cek authed_user DULU (initial-exchange shape), fallback ke top-level (refresh-grant shape).
async function refreshAccessToken({ clientId, refreshToken }) {
  if (!clientId || !refreshToken) throw new Error("Refresh token tidak tersedia — login ulang diperlukan.");
  const client = new WebClient();
  const result = await client.oauth.v2.access({ client_id: clientId, grant_type: "refresh_token", refresh_token: refreshToken });
  const newToken = result.authed_user?.access_token || result.access_token;
  if (!newToken) throw new Error(`Gagal refresh token — login ulang diperlukan. (respons Slack: ${JSON.stringify(result)})`);
  return {
    accessToken: newToken,
    // Fallback ke refresh_token lama kalau Slack (jarang) gak ngasih yang baru di response ini.
    refreshToken: result.authed_user?.refresh_token || result.refresh_token || refreshToken,
    expiresAt: (result.authed_user?.expires_in || result.expires_in) ? Date.now() + (result.authed_user?.expires_in || result.expires_in) * 1000 : null,
  };
}

// Poin revisi (bug dilaporkan: listUsers nge-hang 30 MENIT PENUH baru muncul error pas koneksi
// lagi macet) — 30 menit tadinya dipakai RATA buat SEMUA panggilan (biar upload file gede gak
// keburu dianggap gagal), tapi efeknya panggilan RINGAN (listUsers/listChannels/addReaction/dst)
// yang harusnya balik dalam hitungan detik ikut nunggu sampai 30 menit kalau koneksinya nyangkut
// total (bukan lambat, tapi gak ada respons sama sekali) -- UX-nya jadi separah itu buat kasus
// yang harusnya cepet ketauan gagal. Sekarang timeout PER-PANGGILAN, bukan 1 angka rata: default
// 60 detik (cukup lebar buat panggilan API normal, tapi gak bikin user nunggu lama kalau koneksi
// beneran macet), upload file (files.uploadV2, sendItem/sendReplies) EKSPLISIT minta timeout
// panjang lewat parameter kedua.
const DEFAULT_TIMEOUT_MS = 60 * 1000;
const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
function client(token, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  return new WebClient(token, { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout });
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
// Poin revisi (bug ditemukan lewat audit, D16) — DULU baca lastPostedAt, tidur, BARU nulis
// timestamp baru SETELAH bangun. Dua panggilan paceChannel(channelId) yang jalan hampir
// bersamaan (mis. Push massal paralel ke item-item beda tapi channel SAMA) bisa DUA-duanya baca
// timestamp LAMA yang sama sebelum salah satu sempat nulis ulang, ngitung `wait` yang SAMA,
// tidur bareng, lepas request nyaris bersamaan -- pacing-nya jebol diam-diam. Sekarang slot
// waktu di-RESERVE (ditulis ke map) SEBELUM nunggu, bukan sesudah -- bagian sinkron sebelum
// `await` pertama di JS jalan atomik, jadi panggilan ke-2 yang mulai SESAAT setelah panggilan
// ke-1 bakal ngebaca slot yang UDAH ke-reserve itu, ngantre di belakangnya (giliran), bukan
// baca timestamp basi yang sama.
async function paceChannel(channelId) {
  const last = lastPostedAt.get(channelId) || 0;
  const scheduledAt = Math.max(last + minPostIntervalMs, Date.now());
  lastPostedAt.set(channelId, scheduledAt);
  const wait = scheduledAt - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

// Throttle reactions.add (poin revisi lanjutan) — beda tier dari posting message (Tier 3,
// "50+ per minute", bukan 1/detik ketat + gak ada gejala "diam-diam ilang" yang didokumentasiin
// buat ini). Dipace GLOBAL (bukan per-channel) — limitnya per method/workspace, dan app ini cuma
// punya 1 token/workspace aktif per sesi, jadi 1 pacer bareng udah cukup akurat. ~1200ms (60000/50)
// biar aman di bawah 50/menit dengan buffer dikit.
let lastReactionAt = 0;
let minReactionIntervalMs = 1200;
function setReactionIntervalForTests(ms) { minReactionIntervalMs = ms; }
// Sama fix-nya kayak paceChannel di atas (poin revisi, bug ditemukan lewat audit D16) — slot
// di-reserve SEBELUM nunggu, bukan sesudah, biar panggilan paralel beneran ngantre gantian.
async function paceReactions() {
  const scheduledAt = Math.max(lastReactionAt + minReactionIntervalMs, Date.now());
  lastReactionAt = scheduledAt;
  const wait = scheduledAt - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
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

function assertUploadedFileCount(result, expected) {
  const responses = Array.isArray(result?.files) ? result.files : [];
  const nested = responses.filter((entry) => Array.isArray(entry?.files));
  const confirmed = nested.length
    ? nested.reduce((total, entry) => total + entry.files.length, 0)
    : responses.filter((entry) => entry?.id).length;
  if (confirmed !== expected) throw new Error(`Slack mengonfirmasi ${confirmed} dari ${expected} file.`);
}

// wrapSlackError (poin revisi, bug ditemukan lewat audit D15) — sendItem/sendReplies/
// syncAssignMessage nge-bungkus error asli Slack SDK jadi `new Error(pesan-gabungan)` biar
// pesannya lebih actionable buat user ("Hasil kirim perlu diperiksa..."), TAPI itu ngebuang
// property `.data` bawaan error asli -- main.cjs punya auto-refresh token yang DETEKSI
// `err.data.error === "token_expired"` di lapisan IPC paling luar, jadi error yang lewat sini
// bikin auto-refresh gak pernah kepicu (nganggep BUKAN token expired, padahal aslinya iya).
// Helper ini mempertahankan `.data` di error yang dibungkus, biar deteksi itu tetap jalan.
function wrapSlackError(error, suffix) {
  const wrapped = new Error(`${error.message} ${suffix}`);
  wrapped.data = error.data;
  return wrapped;
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

// Custom emoji ASLI dari workspace (poin revisi, Preset Artis "ambil dari Slack") — emoji.list
// balikin { nama: url_gambar } ATAU { nama: "alias:nama_lain" } buat alias. Resolve alias SATU
// level ke URL emoji aslinya (ponytail: rantai alias-ke-alias jarang kejadian, di-skip aja kalau
// ada daripada resolve rekursif buat kasus langka) biar tetap muncul di daftar, bukan ilang.
async function listCustomEmojis(token) {
  const c = client(token);
  const res = await c.emoji.list();
  const emoji = res.emoji || {};
  const result = [];
  for (const [name, value] of Object.entries(emoji)) {
    const url = value.startsWith("alias:") ? emoji[value.slice(6)] : value;
    if (url && !url.startsWith("alias:")) result.push({ name, url });
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
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

// Reverse lookup (poin revisi, sync 2 arah reaction Slack->app) — kebalikan dari findThreadInfo:
// event reaction_added/removed dari Socket Mode cuma ngasih channelId+ts pesan yang di-react,
// butuh cari BALIK ini pesan root-nya item mana. `item_name` di tabel threads NYIMPEN "key" hasil
// threadKey() (main.cjs) = JSON.stringify([teamId, userId, projectId, itemId]) — bukan nama item
// mentah — jadi tinggal di-parse balik. Baris "legacy" (item_name mentah, dari sebelum skema
// multi-key ada, belum pernah kesentuh confirmLegacyThread) gak akan valid JSON array, di-skip
// diem-diem (return null) daripada crash.
const getThreadByChannelTs = db.prepare(`SELECT item_name FROM threads WHERE channel_id = ? AND thread_ts = ?`);
function findItemByThread(channelId, threadTs) {
  const row = getThreadByChannelTs.get(channelId, threadTs);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.item_name);
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [teamId, userId, projectId, itemId] = parsed;
    return { teamId, userId, projectId, itemId };
  } catch {
    return null;
  }
}

// "Pull" manual (poin revisi) — kebalikan arah dari "Sinkron ulang"/Push (App->Slack): ini
// Slack->App, dipicu TOMBOL (bukan otomatis/background), buat nutup celah "kata kunci/react
// kejadian pas semua instalasi offline, event Socket Mode-nya ilang gak ketangkep siapa pun".
// SATU panggilan conversations.replies ngasih DUA hal sekaligus: pesan root-nya sendiri (elemen
// pertama, buat baca reaction TERKINI yang nempel di situ) + semua reply-nya (buat scan kata
// kunci) — gak perlu panggilan/endpoint terpisah. Dipaginasi penuh (pola sama kayak listChannels),
// gak ada filter `oldest` (SENGAJA -- manual/jarang diklik, replay SEMUA pesan itu idempoten,
// hasil akhirnya sama kayak kalau event-nya kejadian live waktu itu, gak perlu checkpoint).
async function fetchThreadReplies({ token, channelId, threadTs }) {
  const c = client(token);
  const messages = [];
  let cursor;
  do {
    const res = await c.conversations.replies({ channel: channelId, ts: threadTs, limit: 200, cursor });
    messages.push(...(res.messages || []));
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return messages;
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
  if (action === "restart") {
    // Poin revisi (bug ditemukan lewat audit, D11) — pending_phase "root" itu AMBIGU: Slack
    // mungkin UDAH nerima chat.postMessage-nya, respons doang yang putus sebelum ts-nya
    // kesimpen ke tabel threads. "restart" yang nelen bookkeeping ini APA ADANYA (dulu) bisa
    // bikin app nembak POST ROOT KEDUA kalau Slack ternyata UDAH nerima yang pertama -- root
    // duplikat/thread kepecah, beda dari fase "artist"/"post" (upload) yang worst-case-nya
    // "cuma" DUPLIKAT ISI (nyebelin tapi gak numplekin identitas thread, itu trade-off yang
    // SUDAH disetujui user buat Instant Intake). Root WAJIB direkonsiliasi manual lewat
    // "Pulihkan Kiriman", gak boleh di-restart buta.
    if (attempt.pending_phase === "root") throw new Error("Hasil kirim ROOT sebelumnya belum pasti. Periksa Slack lalu gunakan Pulihkan kiriman.");
    clearAttempt.run(threadKey, channelId);
    return;
  }
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

async function sendItem({ token, channelId, itemName, threadKey, artistIds = [], posts = [] }) {
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
    const fingerprint = crypto.createHash("sha256").update(JSON.stringify({ artistIds, posts, fileSignatures })).digest("hex");
    const previous = getAttempt.get(key, channelId);
    if (previous?.pending_phase) throw new Error("Hasil kirim sebelumnya belum pasti. Periksa Slack lalu gunakan Pulihkan kiriman.");
    if (previous && previous.fingerprint !== fingerprint) throw new Error("Isi berubah sejak kiriman parsial. Pulihkan kiriman sebelum mencoba lagi.");
    const existing = getThread.get(key, channelId);
    let threadTs = previous?.thread_ts || existing?.thread_ts || "";
    let artistSent = previous?.artist_sent || existing?.artist_sent || 0;
    let nextPost = previous?.next_post || 0;
    let isNew = false;
    const c = client(token, { timeout: UPLOAD_TIMEOUT_MS }); // fase "post" bisa upload file gede, lihat catatan di client()
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
        throw wrapSlackError(error, "Hasil kirim perlu diperiksa di Slack sebelum retry.");
      }
    }
    if (!threadTs) {
      const posted = await request("root", () => c.chat.postMessage({ channel: channelId, text: `*${itemName}*` }));
      threadTs = posted.ts;
      isNew = true;
      upsertThread.run({ itemName: key, channelId, threadTs, updatedAt: new Date().toISOString() });
      save(); setPending.run(null, key, channelId);
    } else {
      // Poin revisi (diminta user) — item UDAH py thread & namanya berubah (rename lokal) di
      // Instant Intake: pesan root ikut ke-update. Best-effort (gak boleh gagalin
      // artist/upload gara-gara ini doang, bukan bagian dari fase resume/fingerprint).
      try {
        await syncRootMessageName({ token, channelId, threadTs, itemName });
      } catch {
        // biarin nama lama nempel, jangan lempar -- caller (send:quick) gak butuh tau soal ini
      }
    }
    if (artistIds.length && !artistSent) {
      const text = artistIds.map((id) => `<@${id}>`).join(" ");
      await request("artist", () => c.chat.postMessage({ channel: channelId, thread_ts: threadTs, text }));
      artistSent = 1;
      setThreadArtistSent.run(new Date().toISOString(), key, channelId);
      save(); setPending.run(null, key, channelId);
    }
    for (let index = nextPost; index < posts.length; index++) {
      const post = posts[index];
      if (post.files?.length) {
        // Poin revisi (bug ditemukan lewat audit, D17) — stream DULU dibikin di LUAR withRetry
        // (lewat request()), jadi kalau attempt pertama gagal SETELAH SDK udah mulai/abis
        // ngebaca stream-nya (mis. kena rate-limit di tengah multi-step upload), retry-nya
        // makan stream yang SAMA yang udah abis dibaca -- upload kedua kekirim 0 byte, bukan
        // gagal jelas. Stream sekarang dibikin FRESH di dalam closure yang di-retry, jadi tiap
        // attempt (termasuk retry) baca dari awal file lagi.
        await request("post", async () => {
          const streams = post.files.map((f) => fs.createReadStream(f.path));
          try {
            const result = await c.files.uploadV2({
              channel_id: channelId, thread_ts: threadTs, initial_comment: post.text || undefined,
              file_uploads: post.files.map((f, i) => ({ file: streams[i], filename: f.filename })),
            });
            assertUploadedFileCount(result, post.files.length);
            return result;
          } finally { streams.forEach((stream) => stream.destroy()); }
        });
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
      throw wrapSlackError(error, "Hasil kirim perlu diperiksa di Slack sebelum retry.");
    }
    upsertThread.run({ itemName: key, channelId, threadTs: posted.ts, updatedAt: new Date().toISOString() });
    setPending.run(null, key, channelId);
    return { threadTs: posted.ts, isNew: true };
  } finally { sending.delete(key); }
}

// Multi-artist (poin revisi) — GANTI sendArtistMention lama (1 artis, post SEKALI, idempoten
// pakai threads.artist_sent boolean). Sekarang: SATU pesan assignment per item (item_assign_
// messages, 1 baris per item_id), isinya daftar @mention TERKINI (atau "Belum di tugaskan" kalau
// kosong) -- post kalau belum ada baris, chat.update kalau udah ada. Idempoten by design (nge-
// panggil ulang dengan daftar sama = chat.update ke teks yang sama, gak masalah), jadi bisa
// dipanggil BEBAS baik dari fase "artist" batch (dgn daftar artis final) MAUPUN dari IPC realtime
// (tiap kali user tambah/hapus chip artis, lihat main.cjs).
// Keyed (item_id, channel_id) -- poin revisi (bug ditemukan lewat audit, D01). SEBELUMNYA
// item_id doang: item yang tujuan kirimnya diganti (mis. override channel di Slack View Preview)
// bikin pesan assign lama TERUS ke-chat.update di channel LAMA, channel BARU gak pernah dapet
// pesan assign-nya sendiri. Sekarang cari SPESIFIK buat channel tujuan SAAT INI -- beda channel
// = dianggap "belum ada", post baru (sama semangatnya kayak threads yang udah lama gini).
const getAssignMessage = db.prepare(`SELECT channel_id, message_ts FROM item_assign_messages WHERE item_id = ? AND channel_id = ?`);
const upsertAssignMessage = db.prepare(
  `INSERT INTO item_assign_messages (item_id, channel_id, message_ts, updated_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(item_id, channel_id) DO UPDATE SET message_ts = excluded.message_ts, updated_at = excluded.updated_at`
);
// Placeholder mention (poin revisi) — mention ke member id yang SENGAJA gak valid pas belum ada
// artis di-assign, GANTI teks polos "Belum di tugaskan". Tujuannya: pesan assignment SELALU
// ke-post dari awal (gak nunggu artis pertama di-assign dulu) -- assign PERTAMA/re-assign nanti
// tinggal chat.update pesan yang udah ADA ini, bukan post pesan baru. Slack gak validasi ID
// mention ke Web API (nerima teks apa aja), user ID ini emang gak akan pernah cocok member asli.
const UNASSIGNED_MENTION_ID = "U8BNTTT88VA";
async function syncAssignMessage({ token, channelId, itemId, threadTs, artistIds = [] }) {
  if (!token || !channelId || !itemId) throw new Error("Data assign artis tidak lengkap.");
  const text = artistIds.length ? artistIds.map((id) => `<@${id}>`).join(" ") : `<@${UNASSIGNED_MENTION_ID}>`;
  const existing = getAssignMessage.get(itemId, channelId);
  const c = client(token);
  await paceChannel(channelId);
  try {
    if (existing?.message_ts) {
      await withRetry(() => c.chat.update({ channel: channelId, ts: existing.message_ts, text }));
      upsertAssignMessage.run(itemId, channelId, existing.message_ts, new Date().toISOString());
    } else {
      // Poin revisi: SELALU post (bahkan placeholder-nya doang) — beda dari sebelumnya yang
      // skip post kalau belum ada artis, biar pesan-nya ADA dari awal buat di-edit nanti.
      if (!threadTs) throw new Error("Item ini belum pernah dikirim ke Slack (belum ada thread).");
      const posted = await withRetry(() => c.chat.postMessage({ channel: channelId, thread_ts: threadTs, text }));
      upsertAssignMessage.run(itemId, channelId, posted.ts, new Date().toISOString());
    }
  } catch (error) {
    throw wrapSlackError(error, "Gagal sinkron pesan assign artis ke Slack.");
  }
}

// syncRootMessageName (poin revisi, diminta user) — item yang UDAH py thread lalu di-rename di
// app: pesan root ("*nama item*") di Slack IKUT keupdate pas Instant Intake/Push berikutnya.
// chat.update ke teks yang sama = harmless (idempoten, sama pola kayak syncAssignMessage di
// atas), jadi dipanggil apa adanya tiap kali, gak perlu diffing "namanya beneran beda gak".
async function syncRootMessageName({ token, channelId, threadTs, itemName }) {
  const c = client(token);
  await paceChannel(channelId);
  await withRetry(() => c.chat.update({ channel: channelId, ts: threadTs, text: `*${itemName}*` }));
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
    const c = client(token, { timeout: UPLOAD_TIMEOUT_MS }); // reply bisa upload file gede, lihat catatan di client()
    const save = () => saveAttempt.run({ itemName: key, channelId, fingerprint, threadTs, artistSent: previous?.artist_sent || 0, nextPost, updatedAt: new Date().toISOString() });
    save();
    async function request(fn) {
      setPending.run("post", key, channelId);
      await paceChannel(channelId);
      try {
        return await withRetry(fn);
      } catch (error) {
        throw wrapSlackError(error, "Hasil kirim perlu diperiksa di Slack sebelum retry.");
      }
    }
    for (let index = nextPost; index < posts.length; index++) {
      const post = posts[index];
      if (post.files?.length) {
        // Poin revisi (bug ditemukan lewat audit, D17) — sama kayak fix di sendItem: stream
        // dibikin FRESH di dalam closure yang di-retry, biar retry gak makan stream yang udah
        // abis dibaca attempt sebelumnya (upload kirim 0 byte, bukan gagal jelas).
        await request(async () => {
          const streams = post.files.map((f) => fs.createReadStream(f.path));
          try {
            const result = await c.files.uploadV2({
              channel_id: channelId, thread_ts: threadTs, initial_comment: post.text || undefined,
              file_uploads: post.files.map((f, i) => ({ file: streams[i], filename: f.filename })),
            });
            assertUploadedFileCount(result, post.files.length);
            return result;
          } finally { streams.forEach((stream) => stream.destroy()); }
        });
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

// Kebalikan addReaction (poin revisi, realtime assign artis mode react) — hapus chip artis
// harus ikut hapus reaction-nya dari Slack kalau udah kekirim. "no_reaction" (belum/gak pernah
// ke-react) DIANGGAP SUKSES juga, sama filosofi kayak "already_reacted" di addReaction.
async function removeReaction({ token, channelId, timestamp, name }) {
  if (!token) throw new Error("Belum login ke Slack.");
  if (!channelId || !timestamp) return; // gak ada pesan buat di-unreact, gak ada yang perlu dihapus
  const c = client(token);
  await paceReactions();
  try {
    await withRetry(() => c.reactions.remove({ channel: channelId, timestamp, name }));
  } catch (err) {
    if (err?.data?.error === "no_reaction") return;
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

// Edit pesan status HB Apps yang UDAH ADA (poin revisi, progress bar berkala) — chat.update,
// dipasangkan sama postSimpleMessage di atas: 1 pesan diposting sekali, lalu di-edit berkala
// pakai fungsi ini (bukan post pesan baru tiap update progress).
async function updateSimpleMessage({ token, channelId, ts, text }) {
  if (!token || !channelId || !ts || !text) throw new Error("Token, channel, ts, dan teks wajib diisi.");
  const c = client(token);
  await paceChannel(channelId);
  return withRetry(() => c.chat.update({ channel: channelId, ts, text }));
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

// Sistem Admin/Member (poin revisi, diminta user) — invite/kick anggota channel admin ("hb-adm",
// lihat adminAccess.cjs), dipanggil dari modal "Manage Member Admin" (owner doang). groups:write
// (scope udah ada) cukup buat invite MAUPUN kick dari channel privat.
async function inviteToChannel({ token, channelId, userId }) {
  const c = client(token);
  await c.conversations.invite({ channel: channelId, users: userId });
}

async function removeFromChannel({ token, channelId, userId }) {
  const c = client(token);
  await c.conversations.kick({ channel: channelId, user: userId });
}

async function getChannelMembers({ token, channelId }) {
  const c = client(token);
  const members = [];
  let cursor;
  do {
    const res = await c.conversations.members({ channel: channelId, limit: 200, cursor });
    members.push(...(res.members || []));
    cursor = res.response_metadata?.next_cursor || undefined;
  } while (cursor);
  return members;
}

module.exports = { loginWithBrowser, completeLoginFromUrl, refreshAccessToken, client, listChannels, listUsers, listCustomEmojis, sendItem, ensureRoot, syncAssignMessage, syncRootMessageName, sendReplies, postSimpleMessage, updateSimpleMessage, createPrivateChannel, inviteToChannel, removeFromChannel, getChannelMembers, findThreadChannel, findThreadInfo, findItemByThread, addReaction, removeReaction, pendingAttempt, resolveAttempt, legacyThread, bindLegacyThread, setMinPostIntervalForTests, setReactionIntervalForTests, fetchThreadReplies };
