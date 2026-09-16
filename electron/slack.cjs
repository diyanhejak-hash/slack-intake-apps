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
  return new WebClient(token, { retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 60000 });
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
    // Validate every file before any Slack side effect; uploads use streams.
    let total = 0;
    const fileSignatures = [];
    for (const post of posts) for (const file of post.files || []) {
      const stat = fs.statSync(file.path);
      if (!stat.isFile()) throw new Error("Attachment bukan file.");
      total += stat.size;
      if (total > 100 * 1024 * 1024) throw new Error("Total attachment per item maksimal 100 MB.");
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
      try {
        const result = await fn();
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

// Reaction (poin revisi) — dipakai 2 jalur: instan (overlay hover pil item, fire-and-forget) DAN
// batch (pending item_reactions, dikirim bareng lewat send:start). "already_reacted" DIANGGAP
// SUKSES (idempoten) — pesan yang udah di-react gak perlu di-react lagi, bukan error beneran.
async function addReaction({ token, channelId, timestamp, name }) {
  if (!token) throw new Error("Belum login ke Slack.");
  if (!channelId || !timestamp) throw new Error("Belum ada pesan buat di-react (item ini belum pernah dikirim).");
  const c = client(token);
  try {
    await c.reactions.add({ channel: channelId, timestamp, name });
  } catch (err) {
    if (err?.data?.error === "already_reacted") return;
    throw err;
  }
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

module.exports = { loginWithBrowser, completeLoginFromUrl, client, listChannels, listUsers, sendItem, createPrivateChannel, findThreadChannel, findThreadInfo, addReaction, pendingAttempt, resolveAttempt, legacyThread, bindLegacyThread };
