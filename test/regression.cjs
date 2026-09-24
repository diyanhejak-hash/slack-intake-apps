const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");

const appRoot = path.resolve(__dirname, "..");
const root = path.resolve(appRoot, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "slack-intake-test-"));
const appData = path.join(temp, "userdata");
const nativeRequire = createRequire(path.join(appRoot, "package.json"));
fs.mkdirSync(appData, { recursive: true });
const { DatabaseSync } = require("node:sqlite");
const legacyDb = new DatabaseSync(path.join(appData, "slack-intake-apps.db"));
legacyDb.exec(`CREATE TABLE threads(item_name TEXT PRIMARY KEY, channel_id TEXT NOT NULL, thread_ts TEXT NOT NULL, updated_at TEXT NOT NULL)`);
legacyDb.prepare(`INSERT INTO threads VALUES(?,?,?,?)`).run("legacy", "CA", "0.001", new Date().toISOString());
// Skema LAMA artist_assign_mode (poin revisi, bug dilaporkan: "table has no column named
// mention_enabled" pas buka app versi lama) -- cuma kolom id+mode, TANPA mention_enabled/
// react_enabled, persis kondisi DB nyata sebelum kolom itu ditambah. Reproduksi exact crash-nya:
// db.cjs harus bisa migrasi ini TANPA nge-crash.
legacyDb.exec(`CREATE TABLE artist_assign_mode(id INTEGER PRIMARY KEY CHECK (id=1), mode TEXT NOT NULL DEFAULT 'mention')`);
legacyDb.prepare(`INSERT INTO artist_assign_mode (id, mode) VALUES (1, 'react')`).run();
legacyDb.close();

function load(relativePath, mocks) {
  const filename = path.join(appRoot, relativePath);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
    require: (id) => Object.hasOwn(mocks, id) ? mocks[id] : nativeRequire(id),
    module, exports: module.exports, Buffer, console, URL, URLSearchParams, process, __dirname: path.dirname(filename), setTimeout, clearTimeout,
  }, { filename });
  return module.exports;
}

const dbModule = load("electron/db.cjs", { electron: { app: { getPath: () => appData } } });
const { db } = dbModule;
const projects = load("electron/projects.cjs", { "./db.cjs": dbModule });
projects.setScope("U-TEST", "T-TEST");

const calls = [];
const updateCalls = [];
const reactionCalls = [];
const reactionRemoveCalls = [];
const oauthAccessCalls = [];
let failUpload = false;
let confirmedUploadCount = null;
let hideCompletedUploadsFromThread = false;
let uploadedFileSerial = 0;
const visibleUploadedFileIds = new Set();
let failPermalink = false;
// Simulasi 429 SEKALI doang (poin revisi, test auto-retry) -- angka = retryAfter (detik) yang
// dikasih ke error, flag auto-reset ke false abis 1x throw (jadi panggilan berikutnya sukses,
// meniru "kena rate-limit sekali, retry otomatis berhasil").
let rateLimitReactionOnce = false;
// D17 (poin revisi, bug ditemukan lewat audit) — simulasi rate-limit SEKALI di TENGAH upload,
// SETELAH stream-nya abis dibaca (persis kondisi asli: SDK ngedrain stream buat kirim chunk,
// baru server balikin 429) -- uploadByteCounts nyatet berapa byte kebaca TIAP attempt, biar
// test bisa mastiin retry BENERAN baca ulang dari awal file (bukan stream basi = 0 byte).
let rateLimitUploadOnce = false;
const uploadByteCounts = [];
// D15 (poin revisi, bug ditemukan lewat audit) — simulasi Slack nolak SEKALI dengan bentuk error
// ASLI token_expired ({message, data:{ok:false,error:"token_expired"}}), biar test bisa mastiin
// .data-nya TETAP kebawa abis sendItem/ensureRoot/syncAssignMessage/sendReplies ngebungkus error
// itu jadi pesan yang lebih actionable (wrapSlackError) -- .data ilang = auto-refresh token di
// main.cjs gak akan pernah kepicu buat error yang lewat fungsi-fungsi itu.
let tokenExpiredOnce = false;
function throwIfTokenExpiredOnce() {
  if (!tokenExpiredOnce) return;
  tokenExpiredOnce = false;
  const err = new Error("An API error occurred: token_expired");
  err.data = { ok: false, error: "token_expired" };
  throw err;
}
let serial = 0;
class MockSlack {
  constructor() { this.userPage = 0; this.channelPage = 0; this.memberPage = 0; }
  chat = {
    postMessage: async (args) => { throwIfTokenExpiredOnce(); calls.push(args); return { ts: `${++serial}.000` }; },
    update: async (args) => { updateCalls.push(args); return { ts: args.ts }; },
    getPermalink: async () => { if (failPermalink) throw Error("mock permalink failure"); return { permalink: "https://example.invalid/thread" }; },
  };
  files = {
    uploadV2: async (args) => {
      let bytes = 0;
      for (const f of args.file_uploads || []) for await (const chunk of f.file) bytes += chunk.length;
      uploadByteCounts.push(bytes);
      if (rateLimitUploadOnce) {
        rateLimitUploadOnce = false;
        const err = new Error("mock rate limited upload");
        err.code = "slack_webapi_rate_limited_error";
        err.retryAfter = 0.05;
        throw err;
      }
      if (failUpload) throw Error("mock upload failure");
      const count = confirmedUploadCount ?? (args.file_uploads || []).length;
      confirmedUploadCount = null;
      const files = Array.from({ length: count }, () => ({ id: `F${++uploadedFileSerial}` }));
      if (!hideCompletedUploadsFromThread) for (const file of files) visibleUploadedFileIds.add(file.id);
      return { ok: true, files: [{ ok: true, files }] };
    },
  };
  reactions = {
    add: async (args) => {
      if (rateLimitReactionOnce) {
        rateLimitReactionOnce = false;
        const err = new Error("mock rate limited");
        err.code = "slack_webapi_rate_limited_error";
        err.retryAfter = 0.05;
        throw err;
      }
      reactionCalls.push(args);
    },
    remove: async (args) => { reactionRemoveCalls.push(args); },
  };
  emoji = {
    list: async () => ({
      emoji: {
        diyan: "https://emoji.slack-edge.com/T1/diyan/abc.png",
        adrian: "https://emoji.slack-edge.com/T1/adrian/def.png",
        "diyan-alias": "alias:diyan", // alias valid -- HARUS resolve ke URL diyan asli
        "broken-alias": "alias:gak-ada", // alias nunjuk ke nama yang gak ada -- HARUS di-skip
      },
    }),
  };
  oauth = {
    v2: {
      access: async (args) => {
        oauthAccessCalls.push(args);
        if (args.grant_type === "refresh_token") {
          // Poin revisi (bug real ditemukan user) — refresh grant BALIKIN token TOP-LEVEL, BUKAN
          // nested authed_user kayak initial exchange (beda dari yang dites di sini sebelumnya --
          // itu yang bikin bug "Gagal refresh token" gak ketauan lewat test, mock-nya sendiri
          // salah asumsi). Mock ini sekarang niru bentuk ASLI biar gak salah lagi.
          return { ok: true, access_token: `xoxp-refreshed-${args.refresh_token}`, refresh_token: "rt-new", expires_in: 43200 };
        }
        return { authed_user: { access_token: "xoxp-mock", id: "U-MOCK", refresh_token: "rt-initial", expires_in: 43200 }, team: { name: "Mock Team", id: "T-MOCK" } };
      },
    },
  };
  users = {
    list: async () => (++this.userPage === 1
      ? { members: [{ id: "U1", name: "First" }], response_metadata: { next_cursor: "next" } }
      : { members: [{ id: "U2", name: "Second" }], response_metadata: { next_cursor: "" } }),
    conversations: async () => (++this.channelPage === 1
      ? { channels: [{ id: "CA", name: "First" }], response_metadata: { next_cursor: "next" } }
      : { channels: [{ id: "CB", name: "Second" }], response_metadata: { next_cursor: "" } }),
  };
  conversations = {
    members: async () => (++this.memberPage === 1
      ? { members: ["U1"], response_metadata: { next_cursor: "next" } }
      : { members: ["U2"], response_metadata: { next_cursor: "" } }),
    replies: async () => ({
      messages: [{ files: [...visibleUploadedFileIds].map((id) => ({ id })) }],
      response_metadata: { next_cursor: "" },
    }),
  };
}
const slack = load("electron/slack.cjs", { "./db.cjs": dbModule, "@slack/web-api": { WebClient: MockSlack } });
const send = (itemName, channelId, posts = []) => slack.sendItem({ token: "MOCK", itemName, threadKey: itemName, channelId, posts });
// Pacing produksi (poin revisi, 1100ms message / 1200ms reaction) bakal bikin suite ini lambat
// banget (puluhan panggilan chat.postMessage/reactions.add di berbagai test) -- dimatiin di
// sini, diaktifkan lagi sesaat buat test pacing-nya sendiri di bawah.
slack.setMinPostIntervalForTests(0);
slack.setReactionIntervalForTests(0);
slack.setUploadVerificationDelaysForTests([0]);

async function test(name, fn) {
  await fn();
  console.log(`PASS: ${name}`);
}

(async () => {
  try {
    await test("legacy thread schema migrates without losing mapping", () => {
      assert.equal(db.prepare("SELECT thread_ts FROM threads WHERE item_name=? AND channel_id=?").get("legacy", "CA").thread_ts, "0.001");
      assert.deepEqual(Array.from(db.prepare("PRAGMA table_info(threads)").all().filter((c) => c.pk).map((c) => c.name)), ["item_name", "channel_id"]);
    });
    await test("legacy artist_assign_mode (kolom mode doang, poin revisi bug: crash \"no column named mention_enabled\") migrasi ke 2 flag TANPA nge-crash + gak kehilangan preferensi lama", () => {
      // db.cjs udah ke-load duluan (dbModule di atas) -- kalau migrasinya salah urutan (INSERT
      // nyoba nulis ke kolom baru SEBELUM ALTER TABLE nambahin kolomnya), module ini bakal throw
      // pas di-require, dan seluruh test suite langsung berhenti total (persis crash yang
      // dilaporkan user pas buka app beneran). Sampai baris ini kejalanin = udah kebukti gak crash.
      const row = db.prepare(`SELECT mode, mention_enabled, react_enabled FROM artist_assign_mode WHERE id = 1`).get();
      // Preferensi lama ('react') HARUS ke-backfill akurat ke flag baru, bukan ke-reset ke default.
      assert.equal(row.mention_enabled, 0);
      assert.equal(row.react_enabled, 1);
    });
    await test("thread mappings remain independent per channel", async () => {
      const a = await send("same-name", "CA");
      const b = await send("same-name", "CB");
      assert.notEqual(a.threadTs, b.threadTs);
      assert.equal((await send("same-name", "CA")).threadTs, a.threadTs);
      assert.equal(db.prepare("SELECT count(*) AS n FROM threads WHERE item_name=?").get("same-name").n, 2);
    });
    await test("sendItem (poin revisi, diminta user) — item yang UDAH py thread & di-rename lokal: pesan root ikut ke-update (chat.update) pas Instant Intake dipanggil lagi, BUKAN post baru", async () => {
      const before = updateCalls.length;
      await send("rename-root-test", "CR"); // panggilan pertama: post root baru, belum ada thread
      assert.equal(updateCalls.length, before); // belum ada chat.update sama sekali
      const result = await slack.sendItem({ token: "MOCK", itemName: "rename-root-test EDITED", threadKey: "rename-root-test", channelId: "CR" });
      assert.equal(result.isNew, false); // thread lama dipakai lagi, BUKAN post root baru
      assert.equal(updateCalls.length, before + 1);
      assert.equal(updateCalls[updateCalls.length - 1].text, "*rename-root-test EDITED*");
    });
    await test("retry reuses root and resumes failed upload", async () => {
      const file = path.join(temp, "attachment.txt"); fs.writeFileSync(file, "test");
      const posts = [{ text: "done first" }, { files: [{ path: file, filename: "attachment.txt" }] }];
      failUpload = true; await assert.rejects(send("partial", "CA", posts));
      failUpload = false;
      await assert.rejects(send("partial", "CA", posts), /belum pasti/);
      slack.resolveAttempt({ threadKey: "partial", channelId: "CA", action: "retry" });
      await send("partial", "CA", posts);
      assert.equal(calls.filter((c) => c.text === "*partial*" && !c.thread_ts).length, 1);
      assert.equal(calls.filter((c) => c.text === "done first").length, 1);
    });
    await test("sendItem upload retry (poin revisi, bug ditemukan lewat audit D17) — rate-limit di TENGAH upload retry pakai stream FRESH (baca ulang dari awal file), bukan stream basi yang udah abis dibaca (0 byte)", async () => {
      const file = path.join(temp, "d17-upload.txt"); fs.writeFileSync(file, "sebelas byte"); // 12 char, cukup buat mastiin > 0
      const bytesBefore = uploadByteCounts.length;
      rateLimitUploadOnce = true;
      const result = await send("d17-retry", "CA", [{ files: [{ path: file, filename: "d17-upload.txt" }] }]);
      assert.equal(result.threadTs.length > 0, true); // sukses -- withRetry otomatis nyoba lagi abis kena rate-limit
      const attempts = uploadByteCounts.slice(bytesBefore);
      assert.equal(attempts.length, 2); // attempt 1 (kena rate-limit) + attempt 2 (retry, sukses)
      assert.equal(attempts[0], attempts[1]); // KEDUA attempt baca jumlah byte yang SAMA (stream fresh, bukan basi/0)
      assert.ok(attempts[1] > 0); // bukan 0 byte -- itu gejala bug lama (stream udah abis kebaca attempt pertama)
    });
    await test("upload file hanya dianggap sukses kalau jumlah file yang dikonfirmasi Slack sesuai", async () => {
      const file = path.join(temp, "upload-count.txt"); fs.writeFileSync(file, "x");
      confirmedUploadCount = 0;
      await assert.rejects(
        send("upload-count", "CA", [{ files: [{ path: file, filename: "upload-count.txt" }] }]),
        /Slack mengonfirmasi 0 dari 1 file/
      );
    });
    await test("upload tidak ditandai sukses kalau Slack memberi file ID tetapi file-share tidak muncul di thread", async () => {
      const file = path.join(temp, "upload-hidden.txt"); fs.writeFileSync(file, "x");
      hideCompletedUploadsFromThread = true;
      try {
        await assert.rejects(
          send("upload-hidden", "CA", [{ files: [{ path: file, filename: "upload-hidden.txt" }] }]),
          /belum menampilkan 1 file di thread/
        );
      } finally {
        hideCompletedUploadsFromThread = false;
      }
    });
    await test("sendItem/ensureRoot/syncAssignMessage/sendReplies (poin revisi, bug ditemukan lewat audit D15) — error token_expired TETAP bawa .data abis dibungkus jadi pesan actionable, biar auto-refresh token di main.cjs bisa ke-deteksi", async () => {
      // sendItem
      tokenExpiredOnce = true;
      await assert.rejects(send("d15-senditem", "CA"), (err) => err.data?.error === "token_expired");

      // ensureRoot
      tokenExpiredOnce = true;
      await assert.rejects(slack.ensureRoot({ token: "MOCK", channelId: "CA", itemName: "d15-ensureroot", threadKey: "d15-ensureroot" }), (err) => err.data?.error === "token_expired");

      // syncAssignMessage -- butuh thread valid dulu (post placeholder BELUM ada baris item_assign_messages).
      const rp = projects.createProject({ name: "d15-project", channelId: "CA", channelName: "test" });
      const itemId = projects.addItem(rp.id, { name: "d15-item" });
      const { threadTs } = await send("d15-syncassign", "CA");
      tokenExpiredOnce = true;
      await assert.rejects(
        slack.syncAssignMessage({ token: "MOCK", channelId: "CA", itemId, threadTs, artistIds: [] }),
        (err) => err.data?.error === "token_expired"
      );

      // sendReplies -- butuh thread valid juga.
      tokenExpiredOnce = true;
      await assert.rejects(
        slack.sendReplies({ token: "MOCK", channelId: "CA", threadKey: "d15-syncassign", threadTs, posts: [{ text: "d15 reply" }] }),
        (err) => err.data?.error === "token_expired"
      );
    });
    await test("send:start (poin revisi, bug ditemukan lewat audit D15) — token_expired di TENGAH batch auto-refresh SEKALI & retry item yang gagal; kalau refresh gagal, batch dihentikan (item sisanya di-skip, bukan digagalkan satu-satu percuma)", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/handle\("send:start",[\s\S]*?\n\}\);/)[0];
      function makeContext(refreshSucceeds) {
        let tokenValue = "OLD-TOKEN";
        const ensureRootCalls = [];
        const refreshCalls = [];
        let handler;
        const context = {
          activeSend: null, cancelRequested: false,
          require: nativeRequire, handle: (_name, fn) => { handler = fn; },
          Notification: { isSupported: () => false },
          projects: {
            getProject: () => ({
              name: "proj", channel_id: "CA",
              items: [
                { id: "A", name: "Item A", artists: [], files: [], replies: [] },
                { id: "B", name: "Item B", artists: [], files: [], replies: [] },
                { id: "C", name: "Item C", artists: [], files: [], replies: [] },
              ],
            }),
            addLog: () => {},
            isManagedFile: () => true,
            listArtistPresets: () => [],
            listItemReactions: () => [],
            getArtistAssignModes: () => ({ mention: false, react: false }),
          },
          currentToken: () => tokenValue,
          threadKey: (_p, id) => id, confirmLegacyThread: async () => {}, openSlack: () => {}, autoOpenSlack: () => {}, replyToPost: () => null,
          reconcileItemStatusState: async () => {},
          tryRefreshToken: async () => {
            refreshCalls.push(1);
            if (refreshSucceeds) { tokenValue = "NEW-TOKEN"; return true; }
            return false;
          },
          slack: {
            ensureRoot: async ({ token, threadKey: key }) => {
              ensureRootCalls.push({ itemId: key, token });
              // Item B gagal SEKALI dengan token LAMA (simulasi token_expired) -- token BARU lolos.
              if (key === "B" && token === "OLD-TOKEN") {
                const err = new Error("token_expired");
                err.data = { ok: false, error: "token_expired" };
                throw err;
              }
              return { threadTs: `${key}.ts`, isNew: true };
            },
            syncAssignMessage: async () => {},
            addReaction: async () => {},
          },
          hbStatus: {
            estimateSendMinutes: () => 1, postStatus: async () => {},
            countSendWork: ({ targets }) => ({ items: targets.length, assigns: 0, replies: 0, files: 0, total: targets.length }),
            countItemWork: () => ({ items: 1, assigns: 0, replies: 0, files: 0 }),
            postJobStatus: async () => ({ channelId: "C", ts: "1" }), updateJobStatus: async () => {},
            formatJobStart: () => "start", formatJobHeader: () => "header", formatJobDone: () => "done", createProgressEditor: () => async () => {},
          },
        };
        vm.runInNewContext(block, context);
        return { invoke: () => handler({ sender: { isDestroyed: () => false, send: () => {} } }, { projectId: "P", itemIds: ["A", "B", "C"], scope: "item" }), ensureRootCalls, refreshCalls };
      }

      // Refresh SUKSES -- item B ke-retry pakai token baru, C TETAP lanjut normal.
      {
        const { invoke, ensureRootCalls, refreshCalls } = makeContext(true);
        const { results } = await invoke();
        assert.equal(refreshCalls.length, 1); // auto-refresh SEKALI doang
        assert.equal(results.find((r) => r.itemId === "A").status, "berhasil");
        assert.equal(results.find((r) => r.itemId === "B").status, "berhasil"); // retry sukses abis refresh
        assert.equal(results.find((r) => r.itemId === "C").status, "berhasil");
        // B kepanggil 2x (gagal token lama, sukses token baru), C cuma sekali pakai token baru.
        assert.equal(ensureRootCalls.filter((c) => c.itemId === "B").length, 2);
        assert.equal(ensureRootCalls.find((c) => c.itemId === "C").token, "NEW-TOKEN");
      }
      // Refresh GAGAL -- B gagal, batch DIHENTIKAN total (reuse cancelRequested, sama semangatnya
      // kayak user pencet Cancel manual di tengah batch -- item lain yang belum kelar SEMUA fase
      // ikut kebawa "dibatalkan", bukan cuma B doang, konsisten sama perilaku Cancel yang udah
      // ada). C gak pernah DICOBA sama sekali (gak ada gunanya nembak token yang pasti masih mati).
      {
        const { invoke, ensureRootCalls, refreshCalls } = makeContext(false);
        const { results } = await invoke();
        assert.equal(refreshCalls.length, 1);
        assert.notEqual(results.find((r) => r.itemId === "B").status, "berhasil"); // gagal (token_expired, refresh gagal)
        // A UDAH sukses fase root duluan, tapi fase berikutnya (artist/react) tetap kebawa
        // "dibatalkan" begitu batch dihentikan -- sama persis semangatnya kayak user pencet
        // Cancel manual di tengah batch (batch itu satu kesatuan 4-fase, bukan per-fase berdiri
        // sendiri), bukan bug baru yang saya introduce.
        assert.equal(results.find((r) => r.itemId === "A").status, "dibatalkan");
        assert.equal(results.find((r) => r.itemId === "C").status, "dibatalkan"); // ikut kebawa batal, BUKAN dicoba ulang percuma
        assert.equal(ensureRootCalls.some((c) => c.itemId === "C"), false); // C gak pernah dicoba sama sekali
      }
    });
    await test("permalink metadata failure does not fail delivery", async () => {
      failPermalink = true;
      const result = await send("permalink", "CA", [{ text: "sent" }]);
      failPermalink = false;
      assert.equal(result.permalink, undefined);
    });
    await test("import rejects path traversal without modifying files", () => {
      const sentinel = path.join(appData, "sentinel.txt"); fs.writeFileSync(sentinel, "original");
      assert.throws(() => projects.importProject({ formatVersion: 1, project: { name: "x", channel_id: "CA", channel_name: "a", items: [], files: [{ original_name: "../../../sentinel.txt", dataBase64: "eA==" }] } }));
      assert.equal(fs.readFileSync(sentinel, "utf8"), "original");
    });
    const project = projects.createProject({ name: "test", channelId: "CA", channelName: "audit" });
    const sourceItem = projects.addItem(project.id, { name: "source" });
    const targetItem = projects.addItem(project.id, { name: "target" });
    await test("renamed reply broadcasts by visible category", () => {
      const source = projects.addReplyWithFiles(sourceItem, { title: "BG", textValue: "source" });
      const oldTarget = projects.addReplyWithFiles(targetItem, { title: "BG", textValue: "keep" });
      projects.updateReply(source, { title: "Char" });
      projects.broadcastReply(source, project.id);
      assert.equal(db.prepare("SELECT text_value FROM replies WHERE id=?").get(oldTarget).text_value, "keep");
      assert.equal(db.prepare("SELECT count(*) AS n FROM replies WHERE item_id=? AND category='Char'").get(targetItem).n, 1);
    });
    await test("invalid batch update rolls back", () => {
      projects.saveBatchSections(project.id, [{ id: "old", name: "old", files: [] }]);
      assert.throws(() => projects.saveBatchSections(project.id, [{ id: "new", name: null, files: [] }]));
      assert.equal(projects.listBatchSections(project.id)[0].id, "old");
    });
    await test("batch apply is idempotent", () => {
      const file = path.join(temp, "batch.txt"); fs.writeFileSync(file, "batch");
      projects.saveBatchSections(project.id, [{ id: "section", name: "Assets", files: [{ id: "batch-file", path: file, filename: "batch.txt", connectedItemIds: [sourceItem] }] }]);
      assert.equal(projects.applyBatchSections(project.id).added, 1);
      assert.equal(projects.applyBatchSections(project.id).added, 0);
    });
    await test("failed broadcast preserves destination attachment", () => {
      const file = path.join(temp, "broadcast.txt"); fs.writeFileSync(file, "test");
      const source = projects.addReplyWithFiles(sourceItem, { title: "broadcast", filePaths: [file] });
      const target = projects.addReplyWithFiles(targetItem, { title: "broadcast", filePaths: [file] });
      fs.unlinkSync(db.prepare("SELECT stored_path FROM reply_files WHERE reply_id=?").get(source).stored_path);
      assert.throws(() => projects.broadcastReply(source, project.id));
      assert.equal(db.prepare("SELECT count(*) AS n FROM reply_files WHERE reply_id=?").get(target).n, 1);
    });
    await test("broadcastReply (poin revisi, bug ditemukan lewat audit D02) — target yang UDAH sent (dikunci) TIDAK ketiban-timpa, isinya tetap sama & sent_at tetap ada; broadcast bikin reply BARU di kategori sama biar isinya tetap nyampe", () => {
      const bp = projects.createProject({ name: "broadcast-lock", channelId: "CA", channelName: "test" });
      const srcItem = projects.addItem(bp.id, { name: "src" });
      const dstItem = projects.addItem(bp.id, { name: "dst" });
      const source = projects.addReplyWithFiles(srcItem, { title: "Ref", textValue: "NEW" });
      const dstReply = projects.addReplyWithFiles(dstItem, { title: "Ref", textValue: "ALREADY SENT" });
      projects.markReplySent(dstReply);

      projects.broadcastReply(source, bp.id);

      const dstAfter = db.prepare(`SELECT text_value, sent_at FROM replies WHERE id=?`).get(dstReply);
      assert.equal(dstAfter.text_value, "ALREADY SENT"); // TIDAK ketiban-timpa
      assert.ok(dstAfter.sent_at); // masih locked, konsisten sama isinya yang gak berubah

      const dstReplies = projects.getProject(bp.id).items.find((i) => i.id === dstItem).replies;
      assert.equal(dstReplies.length, 2); // reply lama (locked) + reply BARU (isi broadcast)
      const newReply = dstReplies.find((r) => r.id !== dstReply);
      assert.equal(newReply.text_value, "NEW");
      assert.equal(newReply.sent, false);
    });
    await test("exportProject/importProject/duplicateProject (poin revisi, bug ditemukan lewat audit D04) — status_id/status_sent_shortcode item TETAP kebawa, gak diam-diam kebuang", () => {
      const preset = projects.saveStatusPreset({ name: "Done-D04", codeName: "done-d04" });
      const ep = projects.createProject({ name: "export-status", channelId: "CA", channelName: "test" });
      const itemId = projects.addItem(ep.id, { name: "item-status-export" });
      projects.setItemStatus(itemId, preset);
      projects.setItemStatusSentShortcode(itemId, "done-d04");

      const payload = projects.exportProject(ep.id);
      const importedId = projects.importProject(payload);
      const importedItem = projects.getProject(importedId).items[0];
      assert.equal(importedItem.status_id, preset);
      assert.equal(importedItem.status_sent_shortcode, "done-d04");

      const duplicateId = projects.duplicateProject(ep.id, "export-status-copy");
      const duplicateItem = projects.getProject(duplicateId).items[0];
      assert.equal(duplicateItem.status_id, preset); // Save As/duplicate numpang export+import yang sama
      assert.equal(duplicateItem.status_sent_shortcode, "done-d04");

      projects.removeStatusPreset(preset); // status_presets GLOBAL -- jangan nyisa buat test lain
    });
    await test("export file v2 menyimpan attachment sebagai biner dan import tetap utuh", () => {
      const source = path.join(temp, "archive-v2.bin");
      const bytes = Buffer.alloc(2 * 1024 * 1024 + 17, 0x5a);
      fs.writeFileSync(source, bytes);
      const project = projects.createProject({ name: "archive-v2", channelId: "CA", channelName: "test" });
      const itemId = projects.addItem(project.id, { name: "archive-item" });
      projects.addItemFiles(itemId, [source]);

      const archive = path.join(temp, "archive-v2.slackintake");
      projects.exportProjectToFile(project.id, archive);
      assert.equal(fs.readFileSync(archive).subarray(0, 13).toString("ascii"), "SLACKINTAKE2\n");
      assert.ok(fs.statSync(archive).size < bytes.length + 100_000, "attachment tidak boleh membengkak 33% seperti Base64");

      const importedId = projects.importProjectFile(archive);
      const importedFile = projects.getProject(importedId).items[0].files[0];
      assert.deepEqual(fs.readFileSync(importedFile.stored_path), bytes);
    });
    await test("malformed import leaves no partial project", () => {
      const before = projects.listProjects().length;
      assert.throws(() => projects.importProject({ formatVersion: 1, project: { name: "broken", channel_id: "CA", channel_name: "a", items: null } }));
      assert.equal(projects.listProjects().length, before);
    });
    await test("Slack lists consume every cursor page", async () => {
      assert.equal((await slack.listUsers("MOCK")).length, 2);
      assert.equal((await slack.listChannels("MOCK")).length, 2);
      assert.equal((await slack.getChannelMembers({ token: "MOCK", channelId: "CA" })).join(","), "U1,U2");
    });
    await test("cache member lokal ditimpa per workspace tanpa mengubah info atau assignment artis", () => {
      const cacheProject = projects.createProject({ name: "member-cache", channelId: "C-CACHE", channelName: "cache" });
      const itemId = projects.addItem(cacheProject.id, { name: "CACHE_001", source: "manual" });
      projects.addItemArtist(itemId, "U-CACHE", "Nama Assignment");
      const presetId = projects.saveArtistPreset({ memberId: "U-CACHE", nickname: "Nama Preset", codeName: "cache" });

      projects.replaceCachedSlackUsers([{ id: "U-CACHE", name: "Nama Lama", avatar: "old.png" }]);
      projects.replaceCachedChannelMemberIds("C-CACHE", ["U-CACHE"]);
      assert.equal(projects.listCachedSlackUsers()[0].name, "Nama Lama");
      assert.equal(projects.listCachedChannelMemberIds("C-CACHE").join(","), "U-CACHE");

      projects.replaceCachedSlackUsers([{ id: "U-NEW", name: "Nama Baru" }]);
      projects.replaceCachedChannelMemberIds("C-CACHE", ["U-NEW"]);
      assert.equal(projects.listCachedSlackUsers().map((u) => u.id).join(","), "U-NEW");
      assert.equal(projects.listCachedChannelMemberIds("C-CACHE").join(","), "U-NEW");
      assert.equal(projects.getProject(cacheProject.id).items[0].artists[0].artist_id, "U-CACHE");
      assert.equal(projects.listArtistPresets().find((p) => p.id === presetId).nickname, "Nama Preset");

      projects.setScope("U-OTHER", "T-OTHER");
      assert.equal(projects.listCachedSlackUsers().length, 0);
      assert.equal(projects.listCachedChannelMemberIds("C-CACHE").length, 0);
      projects.setScope("U-TEST", "T-TEST");
      projects.removeArtistPreset(presetId);
    });
    await test("listCustomEmojis (poin revisi, Preset Artis \"ambil dari Slack\") — resolve alias 1 level, skip alias yang nunjuk ke nama gak ada, urut alfabetis", async () => {
      const result = await slack.listCustomEmojis("MOCK");
      const byName = new Map(result.map((e) => [e.name, e.url]));
      assert.equal(byName.get("diyan"), "https://emoji.slack-edge.com/T1/diyan/abc.png");
      assert.equal(byName.get("adrian"), "https://emoji.slack-edge.com/T1/adrian/def.png");
      // Alias valid -- URL-nya HARUS sama persis kayak emoji asli yang dituju (diyan).
      assert.equal(byName.get("diyan-alias"), "https://emoji.slack-edge.com/T1/diyan/abc.png");
      // Alias nunjuk ke nama yang gak ada di daftar -- di-skip, BUKAN nyangkut jadi "alias:gak-ada".
      assert.equal(byName.has("broken-alias"), false);
      assert.equal(result.length, 3);
      const names = result.map((e) => e.name);
      assert.equal(names.join(","), [...names].sort().join(",")); // urut alfabetis (join, bukan
      // deepEqual -- array dibikin di dalam vm.runInNewContext, realm beda bikin deepEqual error
      // "not reference-equal" walau isinya sama persis).
    });
    await test("deleting project removes managed attachment", () => {
      const disposable = projects.createProject({ name: "delete", channelId: "CA", channelName: "audit" });
      const file = path.join(temp, "delete.txt"); fs.writeFileSync(file, "test");
      projects.addProjectFiles(disposable.id, [file]);
      const stored = projects.getProject(disposable.id).files[0].stored_path;
      projects.deleteProject(disposable.id);
      assert.equal(fs.existsSync(stored), false);
    });

    await test("legacy attachment deletion preserves sibling bytes", () => {
      const legacy = path.join(appData, "attachments", "legacy-owner");
      fs.mkdirSync(legacy, { recursive: true });
      for (const id of ["legacy-one", "legacy-two"]) {
        const file = path.join(legacy, id + ".txt"); fs.writeFileSync(file, id);
        db.prepare('INSERT INTO project_files(id,project_id,stored_path,original_name,sort_order) VALUES(?,?,?,?,0)').run(id, project.id, file, id + ".txt");
      }
      projects.removeProjectFile("legacy-one");
      assert.equal(fs.readFileSync(path.join(legacy, "legacy-two.txt"), "utf8"), "legacy-two");
    });
    await test("failed multi-file addition rolls back reply and attachment rows", () => {
      const file = path.join(temp, "valid.txt"); fs.writeFileSync(file, "valid");
      const before = db.prepare('SELECT count(*) AS n FROM replies').get().n;
      assert.throws(() => projects.addReplyWithFiles(sourceItem, { title: "partial", filePaths: [file, path.join(temp, "missing-file")] }));
      assert.equal(db.prepare('SELECT count(*) AS n FROM replies').get().n, before);
    });
    await test("addItem (poin revisi, bug ditemukan lewat audit D12) — artistId parameter (mis. lewat item:addManual) ngisi item_artists juga, bukan cuma kolom legacy items.artist_id yang gak kebaca render/kirim", () => {
      const ap = projects.createProject({ name: "additem-artist", channelId: "CA", channelName: "test" });
      const itemId = projects.addItem(ap.id, { name: "item-with-artist", artistId: "U-D12", artistName: "D12 Artist" });
      const loaded = projects.getProject(ap.id).items.find((i) => i.id === itemId);
      assert.deepEqual(loaded.artists.map((a) => a.artist_id), ["U-D12"]); // BUG LAMA: artists jadi [] kosong
    });
    await test("restore uses main-owned snapshot and keeps the same identity through redo", () => {
      const id = projects.addItem(project.id, { name: "" });
      projects.updateItem(id, { name: "Named" }); projects.updateItem(id, { name: "" });
      projects.removeItem(id);
      projects.restoreItem({ id, project_id: project.id, files: [{ stored_path: path.join(temp, "secret") }] });
      projects.updateItem(id, { name: "Named" });
      const restored = projects.getProject(project.id).items.find(i => i.id === id);
      assert.equal(restored.name, "Named"); assert.equal(restored.files.length, 0);
      assert.throws(() => projects.restoreItem({ id: "fabricated", project_id: project.id, files: [] }));
    });
    await test("removeItem/restoreItem (poin revisi, bug ditemukan lewat audit D03) — Undo hapus item TETAP bawa status, reply.sent_at, dan reaction.sent — gak hilang/ke-reset abis restore", () => {
      const preset = projects.saveStatusPreset({ name: "Done-D03", codeName: "done-d03" });
      const dp = projects.createProject({ name: "undo-d03", channelId: "CA", channelName: "test" });
      const itemId = projects.addItem(dp.id, { name: "item-d03" });
      projects.setItemStatus(itemId, preset);
      projects.setItemStatusSentShortcode(itemId, "done-d03");
      const replyId = projects.addReplyWithFiles(itemId, { title: "Ref-D03", textValue: "isi terkirim" });
      projects.markReplySent(replyId);
      const reactionId = projects.addItemReaction(itemId, { emojiType: "custom", emojiValue: "diyan", slackShortcode: "diyan" });
      projects.markItemReactionSent(reactionId);

      projects.removeItem(itemId);
      projects.restoreItem({ id: itemId, project_id: dp.id, files: [] });

      const restored = projects.getProject(dp.id).items.find((i) => i.id === itemId);
      assert.equal(restored.status_id, preset); // status TIDAK hilang
      assert.equal(restored.status_sent_shortcode, "done-d03");
      assert.equal(restored.replies[0].sent, true); // reply TETAP kekunci (bukan kebuka lagi buat edit)
      assert.equal(restored.replies[0].sent_by_user_id, "U-TEST");
      assert.equal(restored.reactions[0].sent, 1); // reaction TETAP dianggap udah terkirim

      projects.removeStatusPreset(preset); // status_presets GLOBAL -- jangan nyisa, tes lain hitung jumlah persis
    });
    await test("staged attachment paths are already canonical (cross-platform symlink safety)", () => {
      // Bug ketemu di CI macOS (bukan Windows): stageFile/stageWrite dulu nyimpen stored_path
      // MENTAH (path.join biasa), sementara isManagedFile/storagePath SELALU fs.realpathSync
      // path yang mau dicek sebelum query DB. Di Windows dua-duanya sama (jarang ada symlink di
      // path lokal), tapi macOS `/var` -> `/private/var` (tempat os.tmpdir() sering berada) bikin
      // 2 STRING BEDA buat file yang SAMA PERSIS, lookup DB gagal. Assert ini gak nunggu symlink
      // beneran ada — cukup buktiin stored_path yang di-generate SEKARANG udah bentuk final
      // (realpath == dirinya sendiri), invariant yang bikin lookup nanti konsisten di platform APA
      // PUN.
      const src = path.join(temp, "canonical-check.txt");
      fs.writeFileSync(src, "x");
      const { storedPath } = projects.stageFile(project.id, src);
      assert.equal(storedPath, fs.realpathSync(storedPath));
    });
    await test("artist preset CRUD: save inserts, save updates, remove cleans up PNG", () => {
      const src = path.join(temp, "artist-avatar.png");
      fs.writeFileSync(src, "fake-png-bytes");
      const id = projects.saveArtistPreset({ memberId: "U-ARTIST-1", nickname: "Budi", codeName: "artis-budi", sourcePath: src });
      let row = projects.listArtistPresets().find((p) => p.id === id);
      assert.equal(row.member_id, "U-ARTIST-1");
      assert.equal(row.nickname, "Budi");
      assert.equal(row.code_name, "artis-budi");
      assert.ok(row.image_path && fs.existsSync(row.image_path));
      const storedImagePath = row.image_path;

      // Update (id dikasih): ganti nickname, gak upload ulang PNG -> image_path lama dipertahankan,
      // code_name juga gak disentuh -> tetap kayak semula (bukan ke-null-in).
      const updatedId = projects.saveArtistPreset({ id, memberId: "U-ARTIST-1", nickname: "Budi Santoso", codeName: "artis-budi" });
      assert.equal(updatedId, id);
      row = projects.listArtistPresets().find((p) => p.id === id);
      assert.equal(row.nickname, "Budi Santoso");
      assert.equal(row.image_path, storedImagePath);

      // Satu preset per member_id -- insert baru (gak dikasih id) buat member yang UDAH punya ditolak.
      assert.throws(() => projects.saveArtistPreset({ memberId: "U-ARTIST-1", nickname: "Dobel" }), /udah punya preset/);

      projects.removeArtistPreset(id);
      assert.equal(projects.listArtistPresets().find((p) => p.id === id), undefined);
      assert.equal(fs.existsSync(storedImagePath), false);
    });
    await test("status preset CRUD (poin revisi, fitur Status) — save inserts/updates, remove cleans up PNG, gak ada batasan 1-per-member kayak artis", () => {
      const src = path.join(temp, "status-icon.png");
      fs.writeFileSync(src, "fake-png-bytes");
      const id = projects.saveStatusPreset({ name: "Revisi", codeName: "status-revisi", sourcePath: src });
      let row = projects.listStatusPresets().find((p) => p.id === id);
      assert.equal(row.name, "Revisi");
      assert.equal(row.code_name, "status-revisi");
      assert.ok(row.image_path && fs.existsSync(row.image_path));
      const storedImagePath = row.image_path;
      // Bug dilaporkan: isManagedFile() ketinggalan ngecek tabel status_presets (persis pola bug
      // lama yang pernah kejadian buat artist_presets) -- file:readBytes nolak preview PNG status
      // yang UDAH tersimpan sah, muncul error "File tidak terdaftar di project" abis Simpan.
      assert.equal(projects.isManagedFile(storedImagePath), true);

      const updatedId = projects.saveStatusPreset({ id, name: "Revisi Kecil", codeName: "status-revisi" });
      assert.equal(updatedId, id);
      row = projects.listStatusPresets().find((p) => p.id === id);
      assert.equal(row.name, "Revisi Kecil");
      assert.equal(row.image_path, storedImagePath); // PNG lama dipertahankan, gak diupload ulang

      // Beda dari artist preset -- bebas nambah status lain kapan aja, gak ada batasan "1 per apa".
      const id2 = projects.saveStatusPreset({ name: "Approved", codeName: "status-approved" });
      assert.equal(projects.listStatusPresets().length, 2);

      assert.throws(() => projects.saveStatusPreset({ name: "", codeName: "x" }), /Nama status wajib/);
      assert.throws(() => projects.saveStatusPreset({ name: "Tanpa emoji" }), /Emoji status wajib/);

      projects.removeStatusPreset(id);
      assert.equal(projects.listStatusPresets().find((p) => p.id === id), undefined);
      assert.equal(fs.existsSync(storedImagePath), false);
      projects.removeStatusPreset(id2);
    });
    await test("reorderStatusPresets (poin revisi, drag-reorder Kelola Status) — urutan baru kepakai listStatusPresets (dropdown Status)", () => {
      const idA = projects.saveStatusPreset({ name: "A", codeName: "status-order-a" });
      const idB = projects.saveStatusPreset({ name: "B", codeName: "status-order-b" });
      const idC = projects.saveStatusPreset({ name: "C", codeName: "status-order-c" });
      const inScope = () => projects.listStatusPresets().filter((p) => [idA, idB, idC].includes(p.id)).map((p) => p.id);
      assert.deepEqual(inScope(), [idA, idB, idC]); // urutan insert default

      // Drag "C" ke posisi paling depan.
      projects.reorderStatusPresets([idC, idA, idB]);
      assert.deepEqual(inScope(), [idC, idA, idB]);

      projects.removeStatusPreset(idA);
      projects.removeStatusPreset(idB);
      projects.removeStatusPreset(idC);
    });
    await test("keyword automation CRUD (poin revisi, Otomasi Kata Kunci) — save inserts/updates, remove, keyword SAMA boleh dobel baris (target beda), validasi field wajib", () => {
      const statusId = projects.saveStatusPreset({ name: "Automation Test Status", codeName: "auto-status" });

      const id = projects.saveKeywordAutomation({ keyword: "@WIP", targetType: "status", targetId: statusId });
      let row = projects.listKeywordAutomations().find((a) => a.id === id);
      assert.equal(row.keyword, "@WIP");
      assert.equal(row.target_type, "status");
      assert.equal(row.target_id, statusId);

      const updatedId = projects.saveKeywordAutomation({ id, keyword: "@WIP2", targetType: "status", targetId: statusId });
      assert.equal(updatedId, id);
      row = projects.listKeywordAutomations().find((a) => a.id === id);
      assert.equal(row.keyword, "@WIP2");

      // Keyword SAMA boleh dipakai lebih dari 1 baris (target beda, mis. "@DONE" trigger status
      // DAN artis sekaligus) -- gak ada constraint UNIQUE.
      const id2 = projects.saveKeywordAutomation({ keyword: "@DONE", targetType: "artist", targetId: "U-SOMEONE" });
      const id3 = projects.saveKeywordAutomation({ keyword: "@DONE", targetType: "status", targetId: statusId });
      assert.equal(projects.listKeywordAutomations().filter((a) => a.keyword === "@DONE").length, 2);

      assert.throws(() => projects.saveKeywordAutomation({ keyword: "", targetType: "status", targetId: statusId }), /Kata kunci wajib/);
      assert.throws(() => projects.saveKeywordAutomation({ keyword: "@X", targetType: "bukan-valid", targetId: statusId }), /Tipe target/);
      assert.throws(() => projects.saveKeywordAutomation({ keyword: "@X", targetType: "artist", targetId: "" }), /Target .* wajib dipilih/);

      projects.removeKeywordAutomation(id);
      projects.removeKeywordAutomation(id2);
      projects.removeKeywordAutomation(id3);
      assert.equal(projects.listKeywordAutomations().find((a) => a.id === id), undefined);
      projects.removeStatusPreset(statusId);
    });
    await test("status/artist preset unicode_value (poin revisi, bug dilaporkan: \"abis Simpan, emoji standar balik jadi kode nama lagi\") — persist karakter emoji, mutually exclusive sama PNG, gak ke-nimpa kalau edit gak nyentuh emoji", () => {
      // Pilih emoji standar (unicodeValue) -- code_name TETAP diminta (buat reactions.add),
      // TAPI karakter aslinya juga ikut kesimpen biar kepreview lagi abis reload.
      const id = projects.saveStatusPreset({ name: "Ide", codeName: "bulb", unicodeValue: "💡" });
      let row = projects.listStatusPresets().find((p) => p.id === id);
      assert.equal(row.unicode_value, "💡");
      assert.equal(row.image_path, null);

      // Edit TANPA nyentuh emoji sama sekali (cuma ganti nama) -- unicode_value HARUS tetap ada,
      // bukan ke-null-in gara-gara gak dikirim ulang.
      projects.saveStatusPreset({ id, name: "Ide Baru", codeName: "bulb" });
      row = projects.listStatusPresets().find((p) => p.id === id);
      assert.equal(row.name, "Ide Baru");
      assert.equal(row.unicode_value, "💡");

      // Ganti ke gambar custom -- unicode_value HARUS kekosongin (mutually exclusive).
      const src = path.join(temp, "status-unicode-to-image.png");
      fs.writeFileSync(src, "fake-png-bytes");
      projects.saveStatusPreset({ id, name: "Ide Baru", codeName: "bulb-custom", sourcePath: src });
      row = projects.listStatusPresets().find((p) => p.id === id);
      assert.equal(row.unicode_value, null);
      assert.ok(row.image_path);
      const storedImagePath = row.image_path;

      // Balik lagi ke unicode -- image_path lama HARUS kehapus dari disk + kekosongin.
      projects.saveStatusPreset({ id, name: "Ide Baru", codeName: "bulb", unicodeValue: "💡" });
      row = projects.listStatusPresets().find((p) => p.id === id);
      assert.equal(row.image_path, null);
      assert.equal(row.unicode_value, "💡");
      assert.equal(fs.existsSync(storedImagePath), false);

      projects.removeStatusPreset(id);

      // Sama persis buat artist preset (kode sama, disalin buat 2 tabel).
      const artistId = projects.saveArtistPreset({ memberId: "U-UNICODE-TEST", nickname: "Uni", codeName: "bulb", unicodeValue: "💡" });
      let artistRow = projects.listArtistPresets().find((p) => p.id === artistId);
      assert.equal(artistRow.unicode_value, "💡");
      projects.saveArtistPreset({ id: artistId, memberId: "U-UNICODE-TEST", nickname: "Uni Ganti Nama", codeName: "bulb" });
      artistRow = projects.listArtistPresets().find((p) => p.id === artistId);
      assert.equal(artistRow.unicode_value, "💡"); // gak ke-nimpa null gara-gara edit nickname doang
      projects.removeArtistPreset(artistId);
    });
    await test("item status (poin revisi, fitur Status) — getItemStatus/setItemStatus single-value, upsert gak nimpa sent_shortcode yang lagi disimpen reconcile", () => {
      const statusA = projects.saveStatusPreset({ name: "Status A", codeName: "status-a" });
      const statusB = projects.saveStatusPreset({ name: "Status B", codeName: "status-b" });
      const p = projects.createProject({ name: "status-item-test", channelId: "CA", channelName: "test" });
      const itemId = projects.addItem(p.id, { name: "item-status" });
      assert.equal(projects.getItemStatus(itemId), null);

      projects.setItemStatus(itemId, statusA);
      assert.equal(projects.getItemStatus(itemId).status_id, statusA);
      assert.equal(projects.getItemStatus(itemId).sent_shortcode, null);

      // Reconcile "beneran kirim ke Slack" -- catet shortcode yang lagi live.
      projects.setItemStatusSentShortcode(itemId, "status-a");
      assert.equal(projects.getItemStatus(itemId).sent_shortcode, "status-a");
      assert.equal(projects.getItemStatus(itemId).status_id, statusA); // gak ke-nimpa null

      // Ganti status -- status_id berubah, sent_shortcode LAMA dipertahankan sampai reconcile
      // beneran jalan (biar reconcile tau apa yang perlu dihapus).
      projects.setItemStatus(itemId, statusB);
      assert.equal(projects.getItemStatus(itemId).status_id, statusB);
      assert.equal(projects.getItemStatus(itemId).sent_shortcode, "status-a");

      // Lepas status (null).
      projects.setItemStatus(itemId, null);
      assert.equal(projects.getItemStatus(itemId).status_id, null);
    });
    await test("getProject item.has_thread (poin revisi, overlay Instant Intake vs Push) — false sebelum ada baris threads, true sesudahnya, key SAMA persis pola threadKey() main.cjs", () => {
      const hp = projects.createProject({ name: "has-thread-test", channelId: "CA", channelName: "test" });
      const itemId = projects.addItem(hp.id, { name: "item-belum-kirim" });

      let loaded = projects.getProject(hp.id);
      let item = loaded.items.find((i) => i.id === itemId);
      assert.equal(item.has_thread, false);

      // Key threads.item_name HARUS persis JSON.stringify([teamId, userId, projectId, itemId])
      // (threadKey(), main.cjs) -- scope test ini "U-TEST"/"T-TEST" (lihat projects.setScope di
      // atas file), urutan array [teamId, userId, ...] BUKAN [userId, teamId, ...].
      const key = JSON.stringify(["T-TEST", "U-TEST", hp.id, itemId]);
      db.prepare(`INSERT INTO threads (item_name, channel_id, thread_ts, updated_at) VALUES (?, ?, ?, ?)`).run(key, "CA", "1.000", new Date().toISOString());

      loaded = projects.getProject(hp.id);
      item = loaded.items.find((i) => i.id === itemId);
      assert.equal(item.has_thread, true);
    });
    await test("project.phase (poin revisi, tahap alur kerja Setup/Input, nama lama \"Assign\") — project BARU default 'setup', Setup->Input digate (SEMUA item harus has_thread), Input->Setup diblok TOTAL (one-way door), project LAMA (kolom belum ada) tetap 'input' lewat migrasi", () => {
      const pp = projects.createProject({ name: "phase-test", channelId: "CA", channelName: "test" });
      assert.equal(pp.phase, "setup");
      assert.equal(projects.getProject(pp.id).phase, "setup");

      // Tahapan gak boleh dilewatin -- project KOSONG (belum ada item) gak boleh masuk Input.
      assert.throws(() => projects.setProjectPhase(pp.id, "input"), /harus udah terkirim/);

      const itemId = projects.addItem(pp.id, { name: "phase-item" });
      // Ada item, tapi BELUM punya thread -- masih ditolak.
      assert.throws(() => projects.setProjectPhase(pp.id, "input"), /harus udah terkirim/);
      assert.equal(projects.getProject(pp.id).phase, "setup"); // gagal validasi -- gak kesimpen sebagian

      // Item ini punya thread sekarang -- boleh lanjut ke Input.
      const key = JSON.stringify(["T-TEST", "U-TEST", pp.id, itemId]);
      db.prepare(`INSERT INTO threads (item_name, channel_id, thread_ts, updated_at) VALUES (?, ?, ?, ?)`).run(key, "CA", "1.000", new Date().toISOString());
      projects.setProjectPhase(pp.id, "input");
      assert.equal(projects.getProject(pp.id).phase, "input");

      // Poin revisi lanjutan (diminta user) -- Input->Setup SEKARANG diblok TOTAL (one-way door),
      // beda dari keputusan awal yang masih ngebolehin mundur bebas.
      assert.throws(() => projects.setProjectPhase(pp.id, "setup"), /gak bisa dibalikin lagi/);
      assert.equal(projects.getProject(pp.id).phase, "input"); // tetap di Input, gak kesimpen

      assert.throws(() => projects.setProjectPhase(pp.id, "bukan-tahap-valid"), /Tahap tidak valid/);
      assert.equal(projects.getProject(pp.id).phase, "input"); // gagal validasi -- gak kesimpen sebagian

      // Migrasi kolom BARU (db.cjs ALTER TABLE ... DEFAULT 'input') -- baris yang udah ada
      // SEBELUM kolom phase ditambah harus tetap 'input' (bukan 'setup'), biar project lama gak
      // tiba-tiba kehilangan kolom Artis/Status/Pull/Push yang udah dipakai.
      db.prepare(`INSERT INTO projects (id, owner_user_id, owner_team_id, name, channel_id, channel_name, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run("legacy-phase-project", "U-TEST", "T-TEST", "legacy", "CA", "test", new Date().toISOString(), new Date().toISOString());
      assert.equal(projects.getProject("legacy-phase-project").phase, "input");
    });
    await test("reply sent-lock (poin revisi, diminta user) — field yang UDAH kekirim (markReplySent) gak bisa diedit/ditambah/dihapus file lagi lewat updateReply/addFilesToReply/removeReplyFile/addCapturedFileToReply, getProject expose reply.sent", () => {
      const rp = projects.createProject({ name: "reply-lock-test", channelId: "CA", channelName: "test" });
      const itemId = projects.addItem(rp.id, { name: "item-reply-lock" });
      const replyId = projects.addReplyWithFiles(itemId, { title: "Judul", textValue: "isi awal" });

      let loaded = projects.getProject(rp.id).items.find((i) => i.id === itemId);
      assert.equal(loaded.replies.find((r) => r.id === replyId).sent, false);

      // Belum sent -- edit BOLEH.
      projects.updateReply(replyId, { textValue: "isi diedit" });
      assert.equal(projects.getProject(rp.id).items.find((i) => i.id === itemId).replies[0].text_value, "isi diedit");

      projects.markReplySent(replyId);
      loaded = projects.getProject(rp.id).items.find((i) => i.id === itemId);
      assert.equal(loaded.replies.find((r) => r.id === replyId).sent, true);
      assert.equal(loaded.replies.find((r) => r.id === replyId).sent_by_user_id, "U-TEST");

      assert.throws(() => projects.updateReply(replyId, { textValue: "coba edit lagi" }), /udah kekirim/);
      assert.throws(() => projects.addFilesToReply(replyId, itemId, []), /udah kekirim/);
      assert.throws(() => projects.addCapturedFileToReply(replyId, itemId, "data:text/plain;base64,eA==", "x.txt"), /udah kekirim/);
      // Isi TETAP kayak sebelum di-lock (gak ke-ubah sama sekali sama percobaan edit di atas).
      assert.equal(projects.getProject(rp.id).items.find((i) => i.id === itemId).replies[0].text_value, "isi diedit");

      // "Buka gembok" (poin revisi, diminta user) -- override manual field yang kelanjur ke-lock
      // padahal SEBENARNYA gagal terkirim, biar bisa dikirim ulang lewat Instant Intake per-field.
      projects.unlockReply(replyId);
      loaded = projects.getProject(rp.id).items.find((i) => i.id === itemId);
      assert.equal(loaded.replies.find((r) => r.id === replyId).sent, false);
      assert.equal(loaded.replies.find((r) => r.id === replyId).sent_by_user_id, null);
      // Field kebuka lagi -- edit BOLEH lagi (bukan cuma UI, backend-nya beneran gak ke-lock lagi).
      projects.updateReply(replyId, { textValue: "isi abis buka gembok" });
      assert.equal(projects.getProject(rp.id).items.find((i) => i.id === itemId).replies[0].text_value, "isi abis buka gembok");
      projects.lockReply(replyId);
      loaded = projects.getProject(rp.id).items.find((i) => i.id === itemId);
      assert.equal(loaded.replies.find((r) => r.id === replyId).sent, true);
      assert.throws(() => projects.updateReply(replyId, { textValue: "tetap terkunci" }), /udah kekirim/);
    });
    await test("multi-artist (poin revisi): banyak artis per item, bidirectional chip artis<->reaction, union pas merge + restore pas unmerge", () => {
      const src = path.join(temp, "multi-artist.png");
      fs.writeFileSync(src, "fake-png-bytes");
      const presetId = projects.saveArtistPreset({ memberId: "U-MULTI-1", nickname: "Diyan", codeName: "diyan", sourcePath: src });

      const mp = projects.createProject({ name: "multi-artist", channelId: "CA", channelName: "test" });
      const itemId = projects.addItem(mp.id, { name: "item-multi" });
      projects.addItemArtist(itemId, "U-MULTI-1", "Diyan");
      projects.addItemArtist(itemId, "U-MULTI-2", "Budi");
      projects.addItemArtist(itemId, "U-MULTI-1", "Diyan"); // dobel -- UNIQUE(item_id,artist_id) bikin ini no-op
      assert.deepEqual(projects.listItemArtists(itemId).map((a) => a.artist_id).sort(), ["U-MULTI-1", "U-MULTI-2"]);

      // Bidirectional: chip react "milik" artis (custom, shortcode = code_name-nya) ikut kehapus
      // pas artis-nya di-unassign -- SEBALIKNYA juga (hapus reaction-nya duluan = artis ikut lepas).
      const reactionId = projects.addItemReaction(itemId, { emojiType: "custom", emojiValue: "diyan", slackShortcode: "diyan" });
      projects.removeItemReaction(reactionId);
      assert.equal(projects.listItemReactions(itemId).length, 0); // reaction ke-hapus barusan
      // U-MULTI-1 (Diyan) ikut lepas gara-gara reaction-nya dihapus.
      assert.deepEqual(projects.listItemArtists(itemId).map((a) => a.artist_id), ["U-MULTI-2"]);

      // Flush "sistem" (unassignArtist:false, dipakai send:start/send:quick abis reaction SUKSES
      // kekirim) TIDAK boleh ikut lepas artis-nya -- itu bukan user batal assign.
      projects.addItemArtist(itemId, "U-MULTI-1", "Diyan");
      const flushId = projects.addItemReaction(itemId, { emojiType: "custom", emojiValue: "diyan", slackShortcode: "diyan" });
      projects.removeItemReaction(flushId, { unassignArtist: false });
      assert.deepEqual(projects.listItemArtists(itemId).map((a) => a.artist_id).sort(), ["U-MULTI-1", "U-MULTI-2"]);

      // Merge: artis dari item yang "hilang" (digabung ke item lain) ikut di-UNION, bukan dibuang.
      const other = projects.addItem(mp.id, { name: "item-other" });
      projects.addItemArtist(other, "U-MULTI-3", "Citra");
      const merged = projects.mergeItems([itemId, other]);
      const afterMerge = projects.getProject(mp.id).items.find((i) => i.id === merged.keepId);
      assert.deepEqual(afterMerge.artists.map((a) => a.artist_id).sort(), ["U-MULTI-1", "U-MULTI-2", "U-MULTI-3"]);

      // Unmerge: balik ke daftar artis ASLI masing-masing item (bukan nyisain hasil union di keep).
      projects.unmergeItems(merged.snapshot);
      const restored = projects.getProject(mp.id);
      assert.deepEqual(restored.items.find((i) => i.id === itemId).artists.map((a) => a.artist_id).sort(), ["U-MULTI-1", "U-MULTI-2"]);
      assert.deepEqual(restored.items.find((i) => i.id === other).artists.map((a) => a.artist_id), ["U-MULTI-3"]);

      projects.removeArtistPreset(presetId);
    });
    await test("artist assign mode: 2 flag independen GLOBAL (poin revisi — balik bisa dua-duanya aktif bareng, koreksi dari mutually-exclusive sebelumnya)", () => {
      // assert.equal per-field (bukan deepEqual) -- projects.cjs jalan di vm.runInNewContext
      // sendiri (realm beda), object literal yang dibalikin bikin deepEqual error "not
      // reference-equal" walau isinya sama persis.
      function assertModes(mention, react) {
        const modes = projects.getArtistAssignModes();
        assert.equal(modes.mention, mention);
        assert.equal(modes.react, react);
      }
      assert.equal(projects.getArtistAssignModes().multi, true);
      assert.equal(projects.setMultiAssignEnabled(false), false);
      assert.equal(projects.getArtistAssignModes().multi, false);
      assert.equal(projects.setMultiAssignEnabled(true), true);
      // Set eksplisit ke titik awal yang diketahui (BUKAN andelin default fresh-DB — tabel ini
      // udah di-seed skema LEGACY di atas file, lihat test migrasi artist_assign_mode, jadi
      // starting value-nya udah beda dari default 'mention' murni).
      projects.setMentionEnabled(true);
      projects.setReactEnabled(false);
      assertModes(true, false);
      assert.equal(projects.setReactEnabled(true), true);
      // Dua-duanya AKTIF BARENG sekarang valid (poin revisi) -- BUKAN mutually-exclusive lagi.
      assertModes(true, true);
      assert.equal(projects.setMentionEnabled(false), false);
      assertModes(false, true);
      // Berlaku global -- gak ada konsep "per artis" lagi, cek 2 preset beda tetap baca nilai SAMA.
      const idA = projects.saveArtistPreset({ memberId: "U-GLOBAL-A", nickname: "A" });
      const idB = projects.saveArtistPreset({ memberId: "U-GLOBAL-B", nickname: "B" });
      assertModes(false, true);
      projects.removeArtistPreset(idA);
      projects.removeArtistPreset(idB);
      // Reset biar gak nyampur ke test lain.
      projects.setMentionEnabled(true);
      projects.setReactEnabled(false);
    });
    await test("instant intake toggle is a single global switch, gak sentuh reaction pending", () => {
      // Default OFF (poin revisi, diminta user — di-seed pas migrasi db.cjs).
      assert.equal(projects.getInstantIntakeEnabled(), false);
      assert.equal(projects.setInstantIntakeEnabled(true), true);
      assert.equal(projects.getInstantIntakeEnabled(), true);
      projects.setInstantIntakeEnabled(false); // reset biar gak nyampur ke test lain.
      assert.equal(projects.getInstantIntakeEnabled(), false);
    });
    await test("channel pilihan terakhir tersimpan per project tanpa mengubah project lain", () => {
      const first = projects.createProject({ name: "channel-a", channelId: "CA", channelName: "awal-a" });
      const second = projects.createProject({ name: "channel-b", channelId: "CB", channelName: "awal-b" });
      const updated = projects.setProjectChannel(first.id, "CC", "tujuan-baru");
      assert.equal(updated.channel_id, "CC");
      assert.equal(updated.channel_name, "tujuan-baru");
      assert.equal(projects.getProject(second.id).channel_id, "CB");
      assert.throws(() => projects.setProjectChannel(first.id, "", "invalid"), /tidak valid/);
    });
    await test("Auto Pop-up Slack default aktif dan preferensinya tersimpan", () => {
      assert.equal(projects.getAutoOpenSlackEnabled(), true);
      assert.equal(projects.setAutoOpenSlackEnabled(false), false);
      assert.equal(projects.getAutoOpenSlackEnabled(), false);
      assert.equal(projects.setAutoOpenSlackEnabled(true), true);
    });
    await test("Batch File Generate Item membuat nama unik, menghubungkan file, dan hanya berjalan saat Setup", () => {
      const bp = projects.createProject({ name: "batch-generate", channelId: "CA", channelName: "test" });
      const existingId = projects.addItem(bp.id, { name: "BF44_001" });
      projects.addItem(bp.id, { name: "BF44_010-020" });
      projects.addItem(bp.id, { name: "BF44_030, BF44_040" });
      const make = (name) => { const p = path.join(temp, name); fs.writeFileSync(p, name); return p; };
      const paths = {
        existing: make("BF44_001.mp4"), range: make("BF44_015.mp4"), comma: make("BF44_040.mp4"),
        newMp4: make("BF44_050.mp4"), newMov: make("BF44_050.mov"), another: make("BF44_060.png"), manual: make("custom-name.txt"),
      };
      projects.saveBatchSections(bp.id, [
        { id: "generate-a", name: "Animatic", files: [
          { id: "generate-existing", path: paths.existing, filename: "BF44_001.mp4", connectedItemIds: [] },
          { id: "generate-range", path: paths.range, filename: "BF44_015.mp4", connectedItemIds: [] },
          { id: "generate-comma", path: paths.comma, filename: "BF44_040.mp4", connectedItemIds: [] },
          { id: "generate-new-mp4", path: paths.newMp4, filename: "BF44_050.mp4", connectedItemIds: [] },
          { id: "generate-manual", path: paths.manual, filename: "custom-name.txt", connectedItemIds: [existingId] },
        ] },
        { id: "generate-b", name: "Preview", files: [
          { id: "generate-new-mov", path: paths.newMov, filename: "BF44_050.mov", connectedItemIds: [] },
          { id: "generate-another", path: paths.another, filename: "BF44_060.png", connectedItemIds: [] },
        ] },
      ]);

      const result = projects.generateBatchItems(bp.id);
      assert.equal(result.created, 2); // BF44_050 dobel lintas kategori tetap satu item + BF44_060
      const generated = projects.getProject(bp.id).items.filter((item) => ["BF44_050", "BF44_060"].includes(item.name));
      assert.deepEqual(generated.map((item) => item.name).sort(), ["BF44_050", "BF44_060"]);
      const generatedByName = new Map(generated.map((item) => [item.name, item.id]));
      const savedFiles = projects.listBatchSections(bp.id).flatMap((section) => section.files);
      assert.equal(savedFiles.find((file) => file.id === "generate-new-mp4").connectedItemIds[0], generatedByName.get("BF44_050"));
      assert.equal(savedFiles.find((file) => file.id === "generate-new-mov").connectedItemIds[0], generatedByName.get("BF44_050"));
      assert.equal(savedFiles.find((file) => file.id === "generate-another").connectedItemIds[0], generatedByName.get("BF44_060"));
      assert.equal(savedFiles.find((file) => file.id === "generate-existing").connectedItemIds.length, 0); // item sudah ada: jangan buat duplikat
      assert.equal(projects.generateBatchItems(bp.id).created, 0); // aman dipanggil ulang
      db.prepare('UPDATE projects SET phase=? WHERE id=?').run("input", bp.id);
      assert.throws(() => projects.generateBatchItems(bp.id), /hanya tersedia pada tahap Setup/);
    });
    await test("batch survives source removal, import, duplicate, deletion and resync", () => {
      const bp = projects.createProject({ name: "roundtrip", channelId: "CA", channelName: "audit" });
      const bi = projects.addItem(bp.id, { name: "batch" });
      const file = path.join(temp, "roundtrip.txt"); fs.writeFileSync(file, "bytes");
      projects.saveBatchSections(bp.id, [{ id: "roundtrip-section", name: "Assets", files: [{ id: "roundtrip-file", path: file, filename: "roundtrip.txt", connectedItemIds: [bi] }] }]);
      projects.applyBatchSections(bp.id); fs.unlinkSync(file);
      const payload = projects.exportProject(bp.id);
      const imported = projects.importProject(payload);
      assert.equal(projects.applyBatchSections(imported).added, 0);
      const duplicate = projects.duplicateProject(bp.id, "copy");
      assert.equal(projects.applyBatchSections(duplicate).added, 0);
      const reply = projects.getProject(bp.id).items[0].replies[0];
      projects.removeReply(reply.id);
      assert.equal(projects.applyBatchSections(bp.id).added, 1);
      const newReply = projects.getProject(bp.id).items[0].replies[0];
      projects.removeReplyFile(newReply.files[0].id);
      assert.equal(projects.applyBatchSections(bp.id).added, 1);
    });
    await test("applyBatchSections (poin revisi, diminta user) — >10 file konek ke 1 item dipecah jadi field baru per 10, field yang UDAH sent dikunci jadi field baru juga walau belum penuh", () => {
      const bp = projects.createProject({ name: "batch-cap", channelId: "CA", channelName: "test" });
      const itemId = projects.addItem(bp.id, { name: "batch-cap-item" });
      const makeFiles = (n, prefix) => Array.from({ length: n }, (_, i) => {
        const p = path.join(temp, `${prefix}-${i}.txt`); fs.writeFileSync(p, "x"); return p;
      });
      const paths15 = makeFiles(15, "cap");
      projects.saveBatchSections(bp.id, [{
        id: "cap-section", name: "Assets",
        files: paths15.map((p, i) => ({ id: `cap-file-${i}`, path: p, filename: `cap-${i}.txt`, connectedItemIds: [itemId] })),
      }]);
      const result = projects.applyBatchSections(bp.id);
      assert.equal(result.added, 15);
      const replies = projects.getProject(bp.id).items.find((i) => i.id === itemId).replies;
      assert.equal(replies.length, 2); // 15 file -> 10 + 5, dipecah jadi 2 field
      assert.ok(replies.every((r) => r.files.length <= 10));
      assert.deepEqual(replies.map((r) => r.files.length).sort((a, b) => b - a), [10, 5]);
      assert.equal(replies.reduce((n, r) => n + r.files.length, 0), 15); // gak ada file ilang
      assert.deepEqual(replies.map((r) => r.title), ["Assets 1", "Assets 2"]);

      // Field ke-2 (5 file, belum penuh) ditandain SENT -- batch APPLY BARU berikutnya harus
      // bikin field ke-3, BUKAN numpuk ke field ke-2 yang udah dikunci walau masih ada sisa slot.
      const lockedReplyId = replies.find((r) => r.files.length === 5).id;
      projects.markReplySent(lockedReplyId);
      const morePaths = makeFiles(2, "cap-more");
      projects.saveBatchSections(bp.id, [{
        id: "cap-section", name: "Assets",
        files: [
          ...paths15.map((p, i) => ({ id: `cap-file-${i}`, path: p, filename: `cap-${i}.txt`, connectedItemIds: [itemId] })),
          ...morePaths.map((p, i) => ({ id: `cap-file-more-${i}`, path: p, filename: `cap-more-${i}.txt`, connectedItemIds: [itemId] })),
        ],
      }]);
      const result2 = projects.applyBatchSections(bp.id);
      assert.equal(result2.added, 2); // 15 lama di-skip (udah applied), cuma 2 file baru
      const replies2 = projects.getProject(bp.id).items.find((i) => i.id === itemId).replies;
      assert.equal(replies2.length, 3); // field baru ke-3, bukan numpuk ke field ke-2 yang sent
      assert.equal(replies2.find((r) => r.id === lockedReplyId).files.length, 5); // field terkunci gak berubah
      assert.deepEqual(replies2.map((r) => r.title), ["Assets 1", "Assets 2", "Assets 3"]);
    });
    await test("cross-account broadcast, batch IDs and silent legacy adoption are rejected", () => {
      projects.setScope("OTHER", "OTHERTEAM");
      const foreign = projects.createProject({ name: "foreign", channelId: "CB", channelName: "foreign" });
      const fi = projects.addItem(foreign.id, { name: "foreign" });
      const fr = projects.addReplyWithFiles(fi, { title: "Shared", textValue: "unchanged" });
      projects.saveBatchSections(foreign.id, [{ id: "foreign-section", name: "foreign", files: [] }]);
      projects.setScope("U-TEST", "T-TEST");
      const own = projects.addReplyWithFiles(sourceItem, { title: "Shared", textValue: "bad" });
      assert.throws(() => projects.broadcastReply(own, foreign.id));
      assert.throws(() => projects.saveBatchSections(project.id, [{ id: "foreign-section", name: "bad", files: [] }]));
      assert.equal(db.prepare('SELECT text_value FROM replies WHERE id=?').get(fr).text_value, "unchanged");
      db.prepare('UPDATE projects SET owner_user_id=NULL, owner_team_id=NULL WHERE id=?').run(foreign.id);
      projects.setScope("U-TEST", "T-TEST", true);
      assert.equal(projects.ownsProject(foreign.id), false);
      assert.throws(() => projects.mergeItems([sourceItem, fi]));
    });
    await test("token fallback and explicit item identities isolate same-name threads", async () => {
      const args = { itemName: "collision", channelId: "CA" };
      const a = await slack.sendItem({ ...args, token: "A" });
      const b = await slack.sendItem({ ...args, token: "B" });
      assert.notEqual(a.threadTs, b.threadTs);
      const c = await slack.sendItem({ ...args, token: "A", threadKey: "project-A/item" });
      const d = await slack.sendItem({ ...args, token: "A", threadKey: "project-B/item" });
      assert.notEqual(c.threadTs, d.threadTs);
      assert.equal(slack.findThreadChannel("project-A/item"), "CA");
      await slack.sendItem({ token: "A", itemName: "collision", channelId: "CB", threadKey: "project-A/item" });
      db.prepare(`UPDATE threads SET updated_at=? WHERE item_name=? AND channel_id=?`).run("2099-01-01T00:00:00.000Z", "project-A/item", "CB");
      assert.equal(slack.findThreadChannel("project-A/item"), "CB");
      assert.equal(slack.findThreadChannel("project-A/item", "CA"), "CA");
    });
    await test("uncertain root is not posted twice and can be reconciled", async () => {
      const original = MockSlack.prototype.constructor;
      const pendingKey = "uncertain-root";
      db.prepare('INSERT INTO send_attempts(item_name,channel_id,fingerprint,thread_ts,artist_sent,next_post,updated_at,pending_phase) VALUES(?,?,?,?,0,0,?,?)').run(pendingKey, "CA", "pending", "", new Date().toISOString(), "root");
      const before = calls.length;
      await assert.rejects(slack.sendItem({ token: "MOCK", itemName: "uncertain", threadKey: pendingKey, channelId: "CA" }), /belum pasti/);
      assert.equal(calls.length, before);
      slack.resolveAttempt({ threadKey: pendingKey, channelId: "CA", action: "received", threadTs: "1234567890.000001" });
      assert.equal(slack.findThreadInfo(pendingKey).threadTs, "1234567890.000001");
    });
    await test("resolveAttempt action \"restart\" (poin revisi, bug ditemukan lewat audit D11) — pending_phase \"root\" DITOLAK (ambigu, bisa Slack UDAH nerima), \"artist\"/\"post\" TETAP boleh di-restart (trade-off Instant Intake yang udah disetujui)", async () => {
      const rootKey = "d11-root-pending";
      db.prepare('INSERT INTO send_attempts(item_name,channel_id,fingerprint,thread_ts,artist_sent,next_post,updated_at,pending_phase) VALUES(?,?,?,?,0,0,?,?)').run(rootKey, "CA", "fp", "", new Date().toISOString(), "root");
      // Restart BUTA dulu bakal bikin sendItem nembak root KEDUA (Slack mungkin udah nerima yang
      // pertama) -- sekarang ditolak, arahin ke Pulihkan Kiriman.
      assert.throws(() => slack.resolveAttempt({ threadKey: rootKey, channelId: "CA", action: "restart" }), /ROOT sebelumnya belum pasti/);
      // Attempt-nya TETAP nyangkut (belum ke-clear) -- sendItem masih nolak kirim langsung.
      await assert.rejects(slack.sendItem({ token: "MOCK", itemName: "d11-root", threadKey: rootKey, channelId: "CA" }), /belum pasti/);
      // Baru beneran ke-resolve lewat "received" (pola recovery yang sudah ada).
      slack.resolveAttempt({ threadKey: rootKey, channelId: "CA", action: "received", threadTs: "1111111111.000001" });

      // pending_phase "artist"/"post" (fase upload, BUKAN root) -- restart TETAP boleh (ini
      // trade-off yang udah disetujui user buat Instant Intake, cuma root yang digate).
      for (const phase of ["artist", "post"]) {
        const key = `d11-${phase}-pending`;
        db.prepare('INSERT INTO send_attempts(item_name,channel_id,fingerprint,thread_ts,artist_sent,next_post,updated_at,pending_phase) VALUES(?,?,?,?,0,0,?,?)').run(key, "CA", "fp", "9.000", new Date().toISOString(), phase);
        slack.resolveAttempt({ threadKey: key, channelId: "CA", action: "restart" }); // gak throw
        await slack.sendItem({ token: "MOCK", itemName: `d11-${phase}`, threadKey: key, channelId: "CA" }); // gak ketolak lagi
      }
    });
    await test("ensureRoot idempoten, gak posting ulang", async () => {
      const before = calls.length;
      const r1 = await slack.ensureRoot({ token: "MOCK", channelId: "CA", itemName: "phase-item", threadKey: "phase-item" });
      assert.equal(r1.isNew, true);
      const r2 = await slack.ensureRoot({ token: "MOCK", channelId: "CA", itemName: "phase-item", threadKey: "phase-item" });
      assert.equal(r2.threadTs, r1.threadTs);
      assert.equal(r2.isNew, false);
      assert.equal(calls.filter((c) => c.text === "*phase-item*" && !c.thread_ts).length, 1);
      assert.equal(calls.length - before, 1); // panggilan ke-2 no-op
    });
    await test("findItemByThread (poin revisi, sync 2 arah reaction Slack->App) — reverse lookup channel+ts -> projectId/itemId, abaikan baris legacy yang gak parse jadi array", async () => {
      // threadKey() (main.cjs) nyimpen JSON.stringify([teamId, userId, projectId, itemId]) sebagai
      // item_name -- findItemByThread harus bisa parse balik dari channel+ts doang.
      const key = JSON.stringify(["T1", "U1", "P-REV", "I-REV"]);
      const r = await slack.ensureRoot({ token: "MOCK", channelId: "CA", itemName: "reverse-lookup-item", threadKey: key });
      // Field-by-field (bukan deepEqual) -- objek balikan dari load()/vm.runInNewContext beda
      // realm, assert.deepEqual bisa error "not reference-equal" walau isinya sama persis.
      const found = slack.findItemByThread("CA", r.threadTs);
      assert.equal(found.teamId, "T1");
      assert.equal(found.userId, "U1");
      assert.equal(found.projectId, "P-REV");
      assert.equal(found.itemId, "I-REV");

      // Channel/ts yang gak match apa pun -- null, gak throw.
      assert.equal(slack.findItemByThread("CA", "9999.9999"), null);

      // Baris "legacy" (item_name mentah, dari sebelum skema multi-key ada) -- gak crash, null.
      await slack.ensureRoot({ token: "MOCK", channelId: "CA", itemName: "nama-item-mentah-legacy", threadKey: "nama-item-mentah-legacy" });
      const legacyRow = db.prepare(`SELECT thread_ts FROM threads WHERE item_name = ?`).get("nama-item-mentah-legacy");
      assert.equal(slack.findItemByThread("CA", legacyRow.thread_ts), null);
    });
    await test("syncAssignMessage (poin revisi multi-artist) post pertama kali, chat.update abis itu — gak numpuk pesan baru", async () => {
      const sp = projects.createProject({ name: "sync-assign", channelId: "CA", channelName: "test" });
      const itemId = projects.addItem(sp.id, { name: "item-a" });
      const before = { post: calls.length, update: updateCalls.length };
      const rootTs = "9999999999.000001";
      await slack.syncAssignMessage({ token: "MOCK", channelId: "CA", itemId, threadTs: rootTs, artistIds: ["U1", "U2"] });
      assert.equal(calls.length - before.post, 1); // pesan assignment BARU (belum pernah ada)
      assert.equal(calls[calls.length - 1].text, "<@U1> <@U2>");
      assert.equal(calls[calls.length - 1].thread_ts, rootTs);
      await slack.syncAssignMessage({ token: "MOCK", channelId: "CA", itemId, threadTs: rootTs, artistIds: ["U1"] }); // U2 dihapus
      assert.equal(calls.length - before.post, 1); // TETAP 1 post — perubahan berikutnya lewat chat.update, bukan post baru
      assert.equal(updateCalls.length - before.update, 1);
      assert.equal(updateCalls[updateCalls.length - 1].text, "<@U1>");
      await slack.syncAssignMessage({ token: "MOCK", channelId: "CA", itemId, threadTs: rootTs, artistIds: [] }); // semua dihapus
      // BUKAN dihapus/delete, diedit jadi mention ke ID PALSU (poin revisi eksplisit) — bukan
      // teks polos "Belum di tugaskan" lagi, biar pesan assignment TETAP ada buat di-edit nanti.
      assert.equal(updateCalls[updateCalls.length - 1].text, "<@U8BNTTT88VA>");
    });
    await test("syncAssignMessage: belum pernah assign & langsung kosong -> TETAP post placeholder (poin revisi, bukan skip lagi)", async () => {
      const sp = projects.createProject({ name: "sync-assign-empty", channelId: "CA", channelName: "test" });
      const itemId = projects.addItem(sp.id, { name: "item-b" });
      const before = calls.length;
      await slack.syncAssignMessage({ token: "MOCK", channelId: "CA", itemId, threadTs: "1.000", artistIds: [] });
      // Poin revisi: SEKARANG tetap post (placeholder mention), biar re-assign nanti ada pesan
      // yang udah ada buat di-chat.update — beda dari perilaku lama yang skip total.
      assert.equal(calls.length, before + 1);
      assert.equal(calls[calls.length - 1].text, "<@U8BNTTT88VA>");
    });
    await test("syncAssignMessage: belum ada thread & mau assign pertama kali -> error jelas (bukan crash)", async () => {
      const sp = projects.createProject({ name: "sync-assign-nothread", channelId: "CA", channelName: "test" });
      const itemId = projects.addItem(sp.id, { name: "item-c" });
      await assert.rejects(
        slack.syncAssignMessage({ token: "MOCK", channelId: "CA", itemId, threadTs: undefined, artistIds: ["U1"] }),
        /belum pernah dikirim/
      );
    });
    await test("syncAssignMessage (poin revisi, bug ditemukan lewat audit D01) — item pindah channel tujuan (CA->CB) bikin pesan assign BARU di CB, BUKAN chat.update ke pesan lama di CA", async () => {
      const sp = projects.createProject({ name: "sync-assign-channel-move", channelId: "CA", channelName: "test" });
      const itemId = projects.addItem(sp.id, { name: "item-move" });
      const beforePost = calls.length, beforeUpdate = updateCalls.length;
      await slack.syncAssignMessage({ token: "MOCK", channelId: "CA", itemId, threadTs: "1.000", artistIds: ["U1"] });
      assert.equal(calls.length - beforePost, 1); // post pertama di CA
      assert.equal(calls[calls.length - 1].channel, "CA");

      // Root/reply-nya sekarang dikirim ke CB (mis. override channel di Slack View Preview) --
      // syncAssignMessage dipanggil lagi dengan channelId BARU.
      await slack.syncAssignMessage({ token: "MOCK", channelId: "CB", itemId, threadTs: "2.000", artistIds: ["U1"] });
      // HARUS post BARU di CB (bukan chat.update ke pesan lama yang masih di CA).
      assert.equal(calls.length - beforePost, 2);
      assert.equal(calls[calls.length - 1].channel, "CB");
      assert.equal(updateCalls.length - beforeUpdate, 0); // gak ada chat.update SAMA SEKALI ke CA

      // Panggil lagi ke CB dengan daftar artis beda -- SEKARANG baru chat.update (pesan CB udah ada).
      await slack.syncAssignMessage({ token: "MOCK", channelId: "CB", itemId, threadTs: "2.000", artistIds: ["U1", "U2"] });
      assert.equal(calls.length - beforePost, 2); // gak nambah post baru
      assert.equal(updateCalls.length - beforeUpdate, 1);
      assert.equal(updateCalls[updateCalls.length - 1].channel, "CB");

      // Balik ke CA -- pesan LAMA di CA (masih ada di baris item_assign_messages, key beda) yang
      // di-update, bukan bikin post baru lagi (idempoten per-channel, sama kayak threads).
      await slack.syncAssignMessage({ token: "MOCK", channelId: "CA", itemId, threadTs: "1.000", artistIds: ["U1", "U3"] });
      assert.equal(calls.length - beforePost, 2); // gak ada post baru
      assert.equal(updateCalls.length - beforeUpdate, 2);
      assert.equal(updateCalls[updateCalls.length - 1].channel, "CA");
    });
    await test("removeReaction (poin revisi, realtime unassign artis mode react) manggil reactions.remove, \"no_reaction\" dianggap sukses", async () => {
      const before = reactionRemoveCalls.length;
      await slack.removeReaction({ token: "MOCK", channelId: "CA", timestamp: "1.000", name: "diyan" });
      assert.equal(reactionRemoveCalls.length - before, 1);
    });
    await test("paceChannel (poin revisi, stress-test nemu \"pesan gak ditampilkan\") jaga jarak antar post ke channel sama", async () => {
      // Dokumentasi Slack: max ~1 pesan/detik/channel, lewat itu pesan bisa DIAM-DIAM gak
      // ditampilkan (bukan error 429 yang ketangkep try/catch). paceChannel maksa jarak minimal
      // antar chat.postMessage/files.uploadV2 ke channel yang SAMA. Interval di-set kecil (400ms,
      // bukan production 1100ms/dimatiin-0 kayak test lain) biar gak bikin suite lambat, TAPI
      // cukup lebar (poin revisi, bug ditemukan lewat CI: flaky di runner mac/linux GitHub
      // Actions yang lebih lambat/rame -- ada overhead gak keitung ("pace-a" sendiri masih ngerjain
      // sisa kerjaannya SETELAH lastPostedAt keisi, SEBELUM `start` di bawah kepasang) yang bikin
      // buffer 150ms/130ms kadang kemakan, elapsed keukur kurang dari threshold walau pacing-nya
      // sendiri BENER) buat nampung overhead itu tanpa keliatan flaky lagi.
      slack.setMinPostIntervalForTests(400);
      try {
        await slack.ensureRoot({ token: "MOCK", channelId: "CA", itemName: "pace-a", threadKey: "pace-a" });
        const start = Date.now();
        await slack.ensureRoot({ token: "MOCK", channelId: "CA", itemName: "pace-b", threadKey: "pace-b" });
        assert.ok(Date.now() - start >= 300, "panggilan ke-2 ke channel sama harusnya nunggu ~400ms");
        // Channel BEDA gak ikut ke-throttle bareng -- harusnya balik cepat, gak nunggu.
        const start2 = Date.now();
        await slack.ensureRoot({ token: "MOCK", channelId: "CB", itemName: "pace-c", threadKey: "pace-c" });
        assert.ok(Date.now() - start2 < 100, "channel beda gak boleh ikut ke-throttle");
      } finally {
        slack.setMinPostIntervalForTests(0);
      }
    });
    await test("paceChannel (poin revisi, bug ditemukan lewat audit D16) — panggilan PARALEL (bukan diawait satu-satu) ke channel SAMA tetap ngantre bergiliran, gak lolos nyaris bersamaan", async () => {
      // Beda dari test di atas (sequential await) -- di sini SEMUA panggilan ditembak BARENG
      // (gak diawait dulu satu-satu) buat niru kondisi ASLI D16 (mis. Push massal paralel ke
      // banyak item, channel tujuan sama). Bug lama: 3 panggilan hampir bareng bisa baca
      // timestamp basi yang sama, lolos nyaris bersamaan (gap ~0ms buat panggilan ke-2/ke-3).
      slack.setMinPostIntervalForTests(80);
      try {
        const gaps = [];
        let lastFinish = null;
        const tasks = [1, 2, 3].map((i) => slack.ensureRoot({ token: "MOCK", channelId: "CA-PARALLEL", itemName: `pace-parallel-${i}`, threadKey: `pace-parallel-${i}` }).then(() => {
          const now = Date.now();
          gaps.push(lastFinish === null ? null : now - lastFinish);
          lastFinish = now;
        }));
        await Promise.all(tasks);
        // Panggilan ke-2 & ke-3 (gaps[1], gaps[2]) HARUS masing-masing berjarak ~80ms dari yang
        // sebelumnya (ngantre bergiliran), BUKAN ~0ms (lolos bareng, gejala race lama).
        assert.ok(gaps[1] >= 60, `panggilan ke-2 harusnya ngantre ~80ms, cuma ${gaps[1]}ms`);
        assert.ok(gaps[2] >= 60, `panggilan ke-3 harusnya ngantre ~80ms lagi dari ke-2, cuma ${gaps[2]}ms`);
      } finally {
        slack.setMinPostIntervalForTests(0);
      }
    });
    await test("paceReactions (poin revisi lanjutan) jaga jarak antar reactions.add", async () => {
      const root = await slack.ensureRoot({ token: "MOCK", channelId: "CD", itemName: "pace-react", threadKey: "pace-react" });
      slack.setReactionIntervalForTests(150);
      try {
        await slack.addReaction({ token: "MOCK", channelId: "CD", timestamp: root.threadTs, name: "tada" });
        const start = Date.now();
        await slack.addReaction({ token: "MOCK", channelId: "CD", timestamp: root.threadTs, name: "fire" });
        assert.ok(Date.now() - start >= 130, "reaction ke-2 harusnya nunggu ~150ms");
      } finally {
        slack.setReactionIntervalForTests(0);
      }
    });
    await test("withRetry (poin revisi lanjutan) otomatis coba lagi abis kena rate-limit, respect retryAfter", async () => {
      const root = await slack.ensureRoot({ token: "MOCK", channelId: "CE", itemName: "retry-react", threadKey: "retry-react" });
      rateLimitReactionOnce = true;
      const before = reactionCalls.length;
      const start = Date.now();
      await slack.addReaction({ token: "MOCK", channelId: "CE", timestamp: root.threadTs, name: "tada" });
      const elapsed = Date.now() - start;
      // withRetry nunggu (retryAfter + 0.5) detik -- mock retryAfter=0.05s, jadi ~550ms.
      assert.ok(elapsed >= 500, `harusnya nunggu ~550ms (retryAfter mock 0.05s + buffer 0.5s), cuma ${elapsed}ms`);
      assert.equal(reactionCalls.length, before + 1); // panggilan pertama gagal (gak tercatat), retry ke-2 sukses
      assert.equal(rateLimitReactionOnce, false); // flag mock udah kepake/reset
    });
    await test("sendReplies (poin revisi 4-fase) resume abis upload gagal, sama kayak sendItem", async () => {
      const file = path.join(temp, "phase-attach.txt"); fs.writeFileSync(file, "x");
      const root = await slack.ensureRoot({ token: "MOCK", channelId: "CA", itemName: "phase-post", threadKey: "phase-post" });
      const posts = [{ text: "phase first" }, { files: [{ path: file, filename: "phase-attach.txt" }] }];
      failUpload = true;
      await assert.rejects(slack.sendReplies({ token: "MOCK", channelId: "CA", threadKey: "phase-post", threadTs: root.threadTs, posts }));
      failUpload = false;
      await assert.rejects(slack.sendReplies({ token: "MOCK", channelId: "CA", threadKey: "phase-post", threadTs: root.threadTs, posts }), /belum pasti/);
      slack.resolveAttempt({ threadKey: "phase-post", channelId: "CA", action: "retry" });
      await slack.sendReplies({ token: "MOCK", channelId: "CA", threadKey: "phase-post", threadTs: root.threadTs, posts });
      assert.equal(calls.filter((c) => c.text === "phase first" && c.thread_ts === root.threadTs).length, 1);
    });
    await test("sendReplies tidak menganggap field sukses saat Slack mengonfirmasi file lebih sedikit", async () => {
      const file = path.join(temp, "reply-upload-count.txt"); fs.writeFileSync(file, "x");
      const root = await slack.ensureRoot({ token: "MOCK", channelId: "CA", itemName: "reply-upload-count", threadKey: "reply-upload-count-root" });
      confirmedUploadCount = 0;
      await assert.rejects(
        slack.sendReplies({
          token: "MOCK", channelId: "CA", threadKey: "reply-upload-count", threadTs: root.threadTs,
          posts: [{ files: [{ path: file, filename: "reply-upload-count.txt" }] }],
        }),
        /Slack mengonfirmasi 0 dari 1 file/
      );
    });
    await test("handle() auto-refresh token_expired sekali lalu retry, gagal kalau refresh gagal (poin revisi)", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/function handle\(channel, fn\) \{[\s\S]*?\n\}\n/)[0];
      function makeContext(tryRefreshToken, lastRefreshFailureReason) {
        const webContents = {};
        webContents.mainFrame = {};
        let registered;
        const context = {
          ipcMain: { handle: (_channel, cb) => { registered = cb; } },
          trustedURL: () => true,
          win: { webContents },
          validateAccess: () => {},
          allowFiles: () => {},
          tryRefreshToken,
          // Poin revisi (diagnosa token_expired) — handle() sekarang baca variabel module-level
          // ini buat nyusun pesan error yang beda-beda; di sini disuntik manual lewat context
          // vm (tryRefreshToken asli yang nyetel-nya, di-mock-in di test ini).
          lastRefreshFailureReason,
          projects: { addLog: () => {} },
        };
        vm.runInNewContext(block, context);
        const fakeEvent = { sender: webContents, senderFrame: webContents.mainFrame };
        return { handle: context.handle, invoke: () => registered(fakeEvent) };
      }
      const tokenExpiredError = () => { const err = new Error("An API error occurred: token_expired"); err.data = { error: "token_expired" }; return err; };

      // Skenario 1: token_expired sekali -> refresh sukses -> retry sukses.
      {
        let calls = 0, refreshCalls = 0;
        const { handle: h, invoke } = makeContext(async () => { refreshCalls++; return true; });
        h("test:ok", async () => { calls++; if (calls === 1) throw tokenExpiredError(); return "hasil-sukses"; });
        assert.equal(await invoke(), "hasil-sukses");
        assert.equal(calls, 2); // gagal 1x (token_expired), retry 1x abis refresh sukses
        assert.equal(refreshCalls, 1);
      }
      // Skenario 2: token_expired, tapi refresh GAGAL karena gak ada refresh_token tersimpan ->
      // pesan yang beda (poin revisi, diagnosa) ngasih tau EKSPLISIT itu penyebabnya, fn cuma
      // dipanggil sekali (gak ada retry percuma).
      {
        let calls = 0;
        const { handle: h, invoke } = makeContext(async () => false, "no_refresh_token");
        h("test:no-refresh", async () => { calls++; throw tokenExpiredError(); });
        await assert.rejects(invoke(), /gak punya refresh token tersimpan/);
        assert.equal(calls, 1);
      }
      // Skenario 2b: token_expired, refresh-nya SENDIRI yang gagal (bukan soal gak ada refresh
      // token) -> pesan beda lagi, arahin cek Log Aktivitas.
      {
        let calls = 0;
        const { handle: h, invoke } = makeContext(async () => false, "refresh_call_failed");
        h("test:refresh-failed", async () => { calls++; throw tokenExpiredError(); });
        await assert.rejects(invoke(), /Log Aktivitas/);
        assert.equal(calls, 1);
      }
      // Skenario 3: error LAIN (bukan token_expired) -> gak coba refresh sama sekali.
      {
        let calls = 0, refreshCalls = 0;
        const { handle: h, invoke } = makeContext(async () => { refreshCalls++; return true; });
        h("test:other-error", async () => { calls++; throw new Error("network down"); });
        await assert.rejects(invoke(), /network down/);
        assert.equal(calls, 1);
        assert.equal(refreshCalls, 0);
      }
    });
    await test("tryRefreshToken (poin revisi, diagnostik \"auth:testRefresh\") — bedain 3 skenario: gak ada refresh_token, sukses, gagal — dipakai user buat ngetes tanpa nunggu ~12 jam", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/let refreshPromise = null;[\s\S]*?\n\}\n/)[0];
      function makeContext({ storedInfo, refreshImpl }) {
        const savedTokens = [];
        const logs = [];
        const context = {
          authStore: { loadToken: () => storedInfo, saveToken: (info) => savedTokens.push(info) },
          slack: { refreshAccessToken: refreshImpl },
          projects: { addLog: (level, msg) => logs.push(msg) },
          process: { env: { SLACK_CLIENT_ID: "CID" } },
        };
        vm.runInNewContext(block, context);
        return { tryRefreshToken: context.tryRefreshToken, logs, savedTokens, get reason() { return context.lastRefreshFailureReason; } };
      }
      // 1. Gak ada refresh_token tersimpan -- return false, reason "no_refresh_token", ke-log.
      {
        const ctx = makeContext({ storedInfo: { accessToken: "old" }, refreshImpl: async () => { throw new Error("harusnya gak sampai sini"); } });
        assert.equal(await ctx.tryRefreshToken(), false);
        assert.equal(ctx.reason, "no_refresh_token");
        assert.ok(ctx.logs.some((m) => m.includes("dilewati")));
      }
      // 2. Ada refresh_token, refreshAccessToken sukses -- return true, reason null.
      {
        const ctx = makeContext({
          storedInfo: { accessToken: "old", refreshToken: "rt-1" },
          refreshImpl: async (args) => { assert.equal(args.refreshToken, "rt-1"); return { accessToken: "new", refreshToken: "rt-2" }; },
        });
        assert.equal(await ctx.tryRefreshToken(), true);
        assert.equal(ctx.reason, null);
        assert.equal(ctx.savedTokens.length, 1);
        assert.equal(ctx.savedTokens[0].accessToken, "new"); // token baru ke-simpen, nge-merge sama info lama
        assert.equal(ctx.savedTokens[0].refreshToken, "rt-2");
      }
      // 3. Ada refresh_token, tapi refreshAccessToken-nya SENDIRI gagal (mis. Token Rotation
      // belum di-opt-in) -- return false, reason "refresh_call_failed", ke-log pesan error asli.
      {
        const ctx = makeContext({
          storedInfo: { accessToken: "old", refreshToken: "rt-1" },
          refreshImpl: async () => { throw new Error("invalid_grant dari Slack"); },
        });
        assert.equal(await ctx.tryRefreshToken(), false);
        assert.equal(ctx.reason, "refresh_call_failed");
        assert.ok(ctx.logs.some((m) => m.includes("invalid_grant dari Slack")));
      }
    });
    await test("withItemArtistLock (poin revisi, multi-artist realtime) serialize per item, item BEDA jalan bebas", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/const itemArtistQueues = new Map\(\);\nfunction withItemArtistLock[\s\S]*?\n}\n/)[0];
      const context = {};
      vm.runInNewContext(block, context);
      const { withItemArtistLock } = context;

      // 2 panggilan buat item YANG SAMA -- ke-2 harus NUNGGU ke-1 kelar (order-nya kejaga),
      // biar syncAssignMessage gak race (dua-duanya baca "belum ada pesan" bareng -> post dobel).
      const order = [];
      let releaseFirst;
      const first = withItemArtistLock("item-1", () => new Promise((resolve) => {
        order.push("start-1");
        releaseFirst = () => { order.push("end-1"); resolve(); };
      }));
      const second = withItemArtistLock("item-1", async () => { order.push("start-2"); });
      await new Promise((r) => setTimeout(r, 10)); // beri waktu microtask "second" buat KEBURU jalan kalau gak di-lock
      assert.deepEqual(order, ["start-1"]); // "second" HARUS belum mulai selama "first" masih pending
      releaseFirst();
      await Promise.all([first, second]);
      assert.deepEqual(order, ["start-1", "end-1", "start-2"]);

      // Item BEDA gak ikut ke-block sama sekali (gak ada alasan buat nunggu, item lain gak
      // pernah nyentuh assign-message/reaction item ini).
      let calls2 = 0;
      await withItemArtistLock("item-2", async () => { calls2++; });
      assert.equal(calls2, 1);

      // Reject di panggilan pertama TETAP ngelepas lock-nya (queue gak nyangkut permanen).
      await assert.rejects(withItemArtistLock("item-3", async () => { throw new Error("gagal"); }));
      let ranAfterReject = false;
      await withItemArtistLock("item-3", async () => { ranAfterReject = true; });
      assert.equal(ranAfterReject, true);
    });
    await test("file:readBytes (bug dilaporkan: \"File tidak terdaftar di project\" pas preview emoji Slack yang BARU di-download) — pakai gerbang isFileAccessible YANG SAMA kayak validateFile, bukan isManagedFile doang", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const gateBlock = source.match(/const fileGrants = new Set\(\);[\s\S]*?\nfunction validateFile[\s\S]*?\n\}\n/)[0];
      const readBytesSrc = source.match(/handle\("file:readBytes", (async \(_e, filePath\) => \{[\s\S]*?\n\})\);/)[1];
      const managed = new Set();
      const context = {
        fs: {
          realpathSync: (p) => p,
          statSync: () => ({ isFile: () => true, size: 10 }),
          promises: { readFile: async (p) => Buffer.from(`bytes:${p}`) },
        },
        projects: { isManagedFile: (p) => managed.has(p) },
      };
      vm.runInNewContext(gateBlock, context);
      vm.runInNewContext(`var __readBytes = ${readBytesSrc};`, context);
      const readBytes = (p) => context.__readBytes({}, p);

      // File gak pernah di-allowFiles ATAU jadi managed file -- ditolak.
      await assert.rejects(readBytes("/tmp/unknown.png"), /tidak terdaftar/);

      // Bug asli: file HASIL slack:downloadEmojiImage cuma di-allowFiles (belum jadi managed
      // file, soalnya preset-nya belum disimpan) -- dulu file:readBytes cuma cek isManagedFile
      // doang jadi ditolak, padahal udah "diizinkan" lewat allowFiles. Sekarang harus LANGSUNG
      // kebaca tanpa perlu disimpan dulu.
      context.allowFiles(["/tmp/fresh-emoji.png"]);
      const bytes = await readBytes("/tmp/fresh-emoji.png");
      assert.ok(bytes.toString().includes("fresh-emoji.png"));

      // Preset lama yang UDAH jadi managed file (gak pernah lewat allowFiles sama sekali) --
      // jalur normal, tetap kebaca.
      managed.add("/tmp/already-managed.png");
      const bytes2 = await readBytes("/tmp/already-managed.png");
      assert.ok(bytes2.toString().includes("already-managed.png"));
    });
    await test("itemReaction:remove (poin revisi, chip react persisten) — pending cuma batal antre lokal, sent manggil reactions.remove, gagal Slack = baris lokal TETAP (gak kepisah sinkron)", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/handle\("itemReaction:remove",[\s\S]*?\n\}\);/)[0];
      function makeContext({ reaction, removeReactionImpl }) {
        const removedLocalIds = [];
        let handler;
        const context = {
          require: nativeRequire, handle: (_name, fn) => { handler = fn; },
          projects: {
            getItemReaction: () => reaction,
            projectIdForItem: () => "P",
            removeItemReaction: (id) => removedLocalIds.push(id),
          },
          currentToken: () => "MOCK",
          threadKey: (projectId, itemId) => `${projectId}/${itemId}`,
          slack: {
            findThreadInfo: () => ({ channelId: "CA", threadTs: "1.000" }),
            removeReaction: removeReactionImpl,
          },
        };
        vm.runInNewContext(block, context);
        return { invoke: (id) => handler({}, id), removedLocalIds };
      }

      // Pending (belum sent) -- cuma batal antre lokal, GAK manggil Slack sama sekali.
      {
        let slackCalled = false;
        const { invoke, removedLocalIds } = makeContext({
          reaction: { id: "R1", item_id: "I1", sent: 0, slack_shortcode: "tada" },
          removeReactionImpl: async () => { slackCalled = true; },
        });
        await invoke("R1");
        assert.equal(slackCalled, false);
        assert.deepEqual(removedLocalIds, ["R1"]);
      }
      // Sent -- manggil reactions.remove ke Slack DULU, baris lokal ikut kehapus abis itu sukses.
      {
        let slackArgs;
        const { invoke, removedLocalIds } = makeContext({
          reaction: { id: "R2", item_id: "I2", sent: 1, slack_shortcode: "diyan" },
          removeReactionImpl: async (args) => { slackArgs = args; },
        });
        await invoke("R2");
        assert.equal(slackArgs.channelId, "CA");
        assert.equal(slackArgs.timestamp, "1.000");
        assert.equal(slackArgs.name, "diyan");
        assert.deepEqual(removedLocalIds, ["R2"]);
      }
      // Sent tapi Slack GAGAL -- baris lokal TETAP ADA (gak boleh kepisah dari state Slack).
      {
        const { invoke, removedLocalIds } = makeContext({
          reaction: { id: "R3", item_id: "I3", sent: 1, slack_shortcode: "diyan" },
          removeReactionImpl: async () => { throw new Error("mock slack error"); },
        });
        await assert.rejects(invoke("R3"), /mock slack error/);
        assert.deepEqual(removedLocalIds, []);
      }
    });
    await test("quick-send holds its lock during await and releases it on rejection", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const quick = source.match(/handle\("send:quick",[\s\S]*?\n\}\);/)[0];
      let handler, finish;
      const context = { activeSend: null, require: nativeRequire, handle: (_name, fn) => { handler = fn; },
        projects: { getProject: () => ({ channel_id: "CA", items: [{ id: "I", name: "item", replies: [] }] }), addLog: () => {} },
        currentToken: () => "MOCK", threadKey: () => "key", confirmLegacyThread: async () => {}, openSlack: () => {}, autoOpenSlack: () => {}, replyToPost: () => null,
        slack: { findThreadChannel: () => null, resolveAttempt: () => {}, sendItem: () => new Promise((_resolve, reject) => { finish = reject; }) } };
      vm.runInNewContext(quick, context);
      const first = handler({}, { projectId: "P", itemId: "I", scope: "item" });
      assert.ok(context.activeSend);
      await assert.rejects(handler({}, { projectId: "P", itemId: "I", scope: "item" }), /berjalan/);
      finish(Error("network")); await assert.rejects(first, /network/);
      assert.equal(context.activeSend, null);
    });
    await test("quick-send also flushes pending reactions after sendItem succeeds", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const quick = source.match(/handle\("send:quick",[\s\S]*?\n\}\);/)[0];
      const addedReactions = [];
      const sentIds = [];
      let handler;
      const context = {
        activeSend: null, require: nativeRequire, handle: (_name, fn) => { handler = fn; },
        projects: {
          getProject: () => ({ channel_id: "CA", items: [{ id: "I", name: "item", replies: [], artists: [] }] }),
          addLog: () => {},
          listItemReactions: () => [{ id: "R1", slack_shortcode: "tada", sent: 0 }, { id: "R2", slack_shortcode: "fire", sent: 0 }],
          markItemReactionSent: (id) => sentIds.push(id),
          // react ON, mention OFF -- syncAssignMessage TIDAK boleh kepanggil, gak relevan
          // buat test ini (fokusnya reaction flush doang).
          getArtistAssignModes: () => ({ mention: false, react: true }),
        },
        currentToken: () => "MOCK", threadKey: () => "key", confirmLegacyThread: async () => {}, openSlack: () => {}, autoOpenSlack: () => {}, replyToPost: () => null,
        reconcileItemStatusState: async () => {},
        slack: {
          findThreadChannel: () => null,
          resolveAttempt: () => {},
          // sendItem IDEMPOTEN (thread lama dipakai ulang kalau ada) -- test ini gak bedain
          // "pesan belum ada" vs "pesan udah ada", dua-duanya lewat sendItem yang sama; yang
          // dites di sini murni "reaction pending ikut ke-flush abis sendItem sukses".
          sendItem: async () => ({ threadTs: "1234.0001", isNew: true, permalink: undefined }),
          syncAssignMessage: async () => {},
          addReaction: async (args) => { addedReactions.push(args); },
        },
      };
      vm.runInNewContext(quick, context);
      await handler({}, { projectId: "P", itemId: "I", scope: "item" });
      assert.deepEqual(addedReactions.map((a) => a.name), ["tada", "fire"]);
      assert.ok(addedReactions.every((a) => a.channelId === "CA" && a.timestamp === "1234.0001"));
      assert.deepEqual(sentIds, ["R1", "R2"]);
    });
    await test("quick-send selalu menempatkan assignment/placeholder sebelum field untuk semua scope", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const quick = source.match(/handle\("send:quick",[\s\S]*?\n\}\);/)[0];
      function makeContext(mode) {
        let sentArtistIds = "unset";
        let syncCalls = 0, syncArgs;
        let handler;
        const context = {
          activeSend: null, require: nativeRequire, handle: (_name, fn) => { handler = fn; },
          projects: {
            getProject: () => ({ channel_id: "CA", items: [{ id: "I", name: "item", replies: [], artists: [{ artist_id: "U1" }] }] }),
            addLog: () => {},
            listItemReactions: () => [],
            getArtistAssignModes: () => ({ mention: mode === "mention", react: mode === "react" }),
          },
          currentToken: () => "MOCK", threadKey: () => "key", confirmLegacyThread: async () => {}, openSlack: () => {}, autoOpenSlack: () => {}, replyToPost: () => null,
          reconcileItemStatusState: async () => {},
          slack: {
            findThreadChannel: () => null,
            resolveAttempt: () => {},
            sendItem: async (args) => { sentArtistIds = args.artistIds; return { threadTs: "1.000", isNew: true }; },
            addReaction: async () => {},
            syncAssignMessage: async (args) => { syncCalls++; syncArgs = args; },
          },
        };
        vm.runInNewContext(quick, context);
        return { invoke: (payload) => handler({}, payload), get syncCalls() { return syncCalls; }, get syncArgs() { return syncArgs; }, get sentArtistIds() { return sentArtistIds; } };
      }

      // Mode react: assignment placeholder tetap menjadi reply pertama walau Mention OFF.
      {
        const ctx = makeContext("react");
        await ctx.invoke({ projectId: "P", itemId: "I", scope: "artist" });
        assert.equal(ctx.syncCalls, 1);
        assert.equal(ctx.syncArgs.artistIds.length, 0);
        assert.equal(ctx.sentArtistIds.length, 0); // sendItem juga gak pernah dikasih artistIds lagi (poin revisi)
      }
      // Mode mention, scope APAPUN (termasuk "item"/"replies" — poin revisi terbaru: Instant
      // Intake per-kolom/reply-aja juga ikut sinkron, gak di-skip lagi) -- syncAssignMessage
      // kepanggil dengan daftar artis TERKINI item (U1), threadTs dari sendItem.
      for (const scope of ["item", "artist", "replies"]) {
        const ctx = makeContext("mention");
        await ctx.invoke({ projectId: "P", itemId: "I", scope });
        assert.equal(ctx.syncCalls, 1, `scope ${scope} harusnya tetap sync assign message`);
        assert.deepEqual(ctx.syncArgs.artistIds, ["U1"]);
        assert.equal(ctx.syncArgs.threadTs, "1.000");
      }
    });
    await test("send:quick scope \"replies\"/\"field\" (poin revisi, bug ditemukan lewat audit D10) — reply.sent DI-SKIP dari payload, Instant Intake gak ngirim ulang field yang udah terkirim", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const quick = source.match(/handle\("send:quick",[\s\S]*?\n\}\);/)[0];
      function makeContext() {
        const sendItemCalls = [];
        const sendRepliesCalls = [];
        let handler;
        const context = {
          activeSend: null, require: nativeRequire, handle: (_name, fn) => { handler = fn; },
          projects: {
            getProject: () => ({
              channel_id: "CA",
              items: [{
                id: "I", name: "item", artists: [],
                replies: [
                  { id: "R-OLD", title: "Old", text_value: "sudah terkirim", sent: true },
                  { id: "R-NEW", title: "New", text_value: "field baru", sent: false },
                ],
              }],
            }),
            addLog: () => {},
            listItemReactions: () => [],
            getArtistAssignModes: () => ({ mention: false, react: false }),
            markReplySent: () => {},
          },
          currentToken: () => "MOCK", threadKey: () => "key", confirmLegacyThread: async () => {}, openSlack: () => {}, autoOpenSlack: () => {},
          replyToPost: (reply) => (reply.text_value ? { text: reply.text_value } : null),
          reconcileItemStatusState: async () => {},
          slack: {
            findThreadChannel: () => null,
            resolveAttempt: () => {},
            sendItem: async (args) => { sendItemCalls.push(args); return { threadTs: "1.000", isNew: true }; },
            sendReplies: async (args) => { sendRepliesCalls.push(args); return {}; },
            addReaction: async () => {},
            syncAssignMessage: async () => {},
          },
        };
        vm.runInNewContext(quick, context);
        return { invoke: (payload) => handler({}, payload), sendItemCalls, sendRepliesCalls };
      }

      // scope "replies" -- R-OLD (sent) di-skip, R-NEW doang yang masuk payload. Poin revisi
      // (bug dilaporkan: field hasil pecahan Merge gak kekirim/gak ke-lock kalau field LAIN di
      // item yang sama gagal) -- sendItem sekarang dipanggil TERPISAH per field (bukan 1 array
      // gabungan): panggilan pertama pastiin root (posts kosong), panggilan berikutnya SATU per
      // reply yang belum sent.
      {
        const ctx = makeContext();
        await ctx.invoke({ projectId: "P", itemId: "I", scope: "replies" });
        assert.equal(ctx.sendItemCalls.length, 1);
        assert.equal(ctx.sendItemCalls[0].posts.length, 0);
        assert.equal(ctx.sendRepliesCalls.length, 1);
        assert.equal(ctx.sendRepliesCalls[0].posts[0].text, "field baru");
      }
      // scope "field" langsung ke R-OLD -- no-op (posts kosong), gak resend field yang udah sent.
      {
        const ctx = makeContext();
        await ctx.invoke({ projectId: "P", itemId: "I", scope: "field", replyId: "R-OLD" });
        assert.equal(ctx.sendItemCalls.length, 1);
        assert.equal(ctx.sendItemCalls[0].posts.length, 0);
        assert.equal(ctx.sendRepliesCalls.length, 0);
      }
    });
    await test("send:quick mengirim field berurutan dan berhenti sebelum field berikutnya saat satu field gagal", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const quick = source.match(/handle\("send:quick",[\s\S]*?\n\}\);/)[0];
      const sendItemCalls = [];
      const sendRepliesCalls = [];
      const markedSent = [];
      let handler;
      const context = {
        activeSend: null, require: nativeRequire, handle: (_name, fn) => { handler = fn; },
        projects: {
          getProject: () => ({
            channel_id: "CA",
            items: [{
              id: "I", name: "item", artists: [],
              // Simulasi merge >10 file: 2 reply kategori/judul SAMA ("Animatic"), field-1
              // (11-20.mp4) sukses, field-2 (21-30.mp4) gagal upload.
              replies: [
                { id: "R-1", title: "Animatic", text_value: null, sent: false },
                { id: "R-2", title: "Animatic", text_value: null, sent: false },
                { id: "R-3", title: "Animatic", text_value: null, sent: false },
              ],
            }],
          }),
          addLog: () => {},
          listItemReactions: () => [],
          getArtistAssignModes: () => ({ mention: false, react: false }),
          markReplySent: (id) => markedSent.push(id),
        },
        currentToken: () => "MOCK", threadKey: () => "key", confirmLegacyThread: async () => {}, openSlack: () => {}, autoOpenSlack: () => {},
        replyToPost: (reply) => ({ text: reply.title, files: [{ path: "/x", filename: `${reply.id}.mp4` }] }),
        reconcileItemStatusState: async () => {},
        slack: {
          findThreadChannel: () => null,
          resolveAttempt: () => {},
          sendItem: async (args) => {
            sendItemCalls.push(args);
            return { threadTs: "1.000", isNew: true };
          },
          sendReplies: async (args) => {
            sendRepliesCalls.push(args);
            const fileId = args.posts[0]?.files?.[0]?.filename;
            if (fileId === "R-2.mp4") throw new Error("upload gagal (simulasi network)");
            return {};
          },
          addReaction: async () => {},
          syncAssignMessage: async () => {},
        },
      };
      vm.runInNewContext(quick, context);
      await assert.rejects(handler({}, { projectId: "P", itemId: "I", scope: "replies" }), /upload gagal/);

      // Root-ensure (posts kosong) + R-1 (sukses) + R-2 (gagal) — TIGA panggilan, R-2 TETAP
      // dicoba walau urutannya SETELAH field yang independen (bukan ke-skip diam-diam).
      assert.equal(sendItemCalls.length, 1);
      assert.equal(sendRepliesCalls.length, 2);
      assert.equal(sendRepliesCalls[0].posts[0].files[0].filename, "R-1.mp4");
      assert.equal(sendRepliesCalls[1].posts[0].files[0].filename, "R-2.mp4");
      assert.ok(!sendRepliesCalls.some((call) => call.posts[0].files[0].filename === "R-3.mp4"));
      // Cuma field yang BENERAN sukses (R-1) yang di-lock -- R-2 TETAP kebuka, bisa dicoba lagi
      // lewat Instant Intake tanpa perlu "buka gembok" dulu.
      assert.deepEqual(markedSent, ["R-1"]);
    });
    await test("quick-send scope \"artist\" pada item tanpa artis tetap mem-post placeholder pada semua mode", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const quick = source.match(/handle\("send:quick",[\s\S]*?\n\}\);/)[0];
      function makeContext(mode) {
        let syncCalls = 0, syncArgs;
        let handler;
        const context = {
          activeSend: null, require: nativeRequire, handle: (_name, fn) => { handler = fn; },
          projects: {
            // artists: [] -- item BELUM ada artis di-assign sama sekali, sama kasus dilaporkan.
            getProject: () => ({ channel_id: "CA", items: [{ id: "I", name: "item 003", replies: [], artists: [] }] }),
            addLog: () => {},
            listItemReactions: () => [],
            getArtistAssignModes: () => ({ mention: mode === "mention", react: mode === "react" }),
          },
          currentToken: () => "MOCK", threadKey: () => "key", confirmLegacyThread: async () => {}, openSlack: () => {}, autoOpenSlack: () => {}, replyToPost: () => null,
          reconcileItemStatusState: async () => {},
          slack: {
            findThreadChannel: () => null,
            resolveAttempt: () => {},
            sendItem: async () => ({ threadTs: "1.000", isNew: true }),
            addReaction: async () => {},
            syncAssignMessage: async (args) => { syncCalls++; syncArgs = args; },
          },
        };
        vm.runInNewContext(quick, context);
        return { invoke: () => handler({}, { projectId: "P", itemId: "I", scope: "artist" }), get syncCalls() { return syncCalls; }, get syncArgs() { return syncArgs; } };
      }
      // Mode mention: dulu throw "Item ini belum ada artis yang ditugaskan" -- SEKARANG jalan
      // terus, placeholder ke-post (syncAssignMessage dengan artistIds kosong).
      {
        const ctx = makeContext("mention");
        await ctx.invoke(); // gak boleh reject
        assert.equal(ctx.syncCalls, 1);
        assert.equal(ctx.syncArgs.artistIds.length, 0);
      }
      // Mode react: juga gak boleh throw -- no-op aman (gak ada apa pun buat di-react).
      {
        const ctx = makeContext("react");
        await ctx.invoke(); // gak boleh reject
        assert.equal(ctx.syncCalls, 1);
        assert.equal(ctx.syncArgs.artistIds.length, 0);
      }
    });
    await test("quick-send (poin revisi, \"Instant Intake jadi sumber kebenaran\") — resolveAttempt(\"restart\") dipanggil SEBELUM sendItem, bersihin bookkeeping percobaan lama biar gak keblokir \"Isi berubah sejak kiriman parsial\"", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const quick = source.match(/handle\("send:quick",[\s\S]*?\n\}\);/)[0];
      const callOrder = [];
      let handler;
      const context = {
        activeSend: null, require: nativeRequire, handle: (_name, fn) => { handler = fn; },
        projects: { getProject: () => ({ channel_id: "CA", items: [{ id: "I", name: "item", replies: [], artists: [] }] }), addLog: () => {}, listItemReactions: () => [], getArtistAssignModes: () => ({ mention: false, react: false }) },
        currentToken: () => "MOCK", threadKey: (_p, id) => id, confirmLegacyThread: async () => {}, openSlack: () => {}, autoOpenSlack: () => {}, replyToPost: () => null,
        reconcileItemStatusState: async () => {},
        slack: {
          findThreadChannel: () => null,
          resolveAttempt: (args) => { callOrder.push(["resolveAttempt", args]); },
          sendItem: async () => { callOrder.push(["sendItem"]); return { threadTs: "1.000", isNew: true }; },
          syncAssignMessage: async () => {},
          addReaction: async () => {},
        },
      };
      vm.runInNewContext(quick, context);
      await handler({}, { projectId: "P", itemId: "I", scope: "item", channelId: "CA" });
      assert.equal(callOrder[0][0], "resolveAttempt");
      assert.equal(callOrder[0][1].action, "restart");
      assert.equal(callOrder[0][1].channelId, "CA");
      assert.equal(callOrder[0][1].threadKey, "I"); // threadKey(_p,id)=>id mock, "I" = itemId
      assert.equal(callOrder[1][0], "sendItem"); // urutannya WAJIB resolveAttempt DULU, baru sendItem
    });
    await test("artistAssign:syncProject (poin revisi, tombol manual \"Update\"; bug ditemukan lewat audit D13) — target SEMUA item yang PUNYA thread (bukan cuma yang punya artis/status SAAT INI, biar item yang BARU dilepas artis terakhirnya & item rename-only ikut kesinkron), item TANPA thread di-skip, gagal 1 item gak nge-abort yang lain", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/const itemArtistQueues = new Map\(\);[\s\S]*?handle\("artistAssign:syncProject",[\s\S]*?\n\}\);/)[0];
      const reconciledItemIds = [];
      const logs = [];
      const handlers = {};
      const context = {
        require: nativeRequire,
        handle: (name, fn) => { handlers[name] = fn; },
        projects: {
          getProject: () => ({
            items: [
              { id: "A", name: "Item A", artists: [{ artist_id: "U1" }], has_thread: true },
              // Poin revisi (audit D13) — B PUNYA thread tapi artis TERAKHIRNYA baru aja dilepas
              // (mis. realtime lagi OFF pas dilepas) -- HARUS TETAP jadi target, biar mention/
              // reaction lama yang masih live di Slack ikut dibersihin, bukan di-skip lagi.
              { id: "B", name: "Item B", artists: [], has_thread: true },
              { id: "C", name: "Item C", artists: [{ artist_id: "U2" }], has_thread: true },
              // D PUNYA GAK PERNAH kekirim (gak ada thread) -- HARUS tetap di-skip, gak ada
              // apa pun buat disinkron ke Slack.
              { id: "D", name: "Item D", artists: [], has_thread: false },
            ],
          }),
          getRealtimeAssignEnabled: () => false, // OFF -- tombol manual harus TETAP jalan (force)
          getArtistAssignModes: () => ({ mention: true, react: false }),
          listArtistPresets: () => [],
          listItemArtists: (itemId) => (itemId === "A" ? [{ artist_id: "U1" }] : itemId === "C" ? [{ artist_id: "U2" }] : []),
          listItemReactions: () => [],
          addLog: (level, msg) => logs.push(msg),
        },
        currentToken: () => "MOCK",
        threadKey: (_p, id) => id,
        slack: {
          findThreadInfo: (key) => {
            reconciledItemIds.push(key);
            if (key === "C") throw new Error("mock findThreadInfo failure buat item C");
            return { channelId: "CA", threadTs: "1.000" };
          },
          syncAssignMessage: async () => {},
          syncRootMessageName: async () => {},
        },
      };
      vm.runInNewContext(block, context);
      const result = await handlers["artistAssign:syncProject"]({}, "P");
      assert.equal(result.total, 3); // D (gak ada thread) di-skip, A/B/C jadi target
      // Distinct item yang disentuh (bukan hitungan mentah findThreadInfo -- pushItemToSlack
      // poin revisi (rename ikut update) manggil findThreadInfo sendiri DULUAN sebelum reconcile,
      // jadi "A" bisa kepanggil >1x, yang penting A/B/C ke-touch, D enggak).
      assert.deepEqual([...new Set(reconciledItemIds)].sort(), ["A", "B", "C"]);
      assert.equal(result.synced, 2); // A & B sukses, C gagal
      assert.equal(result.errors.length, 1);
      assert.ok(result.errors[0].includes("Item C"));
      assert.ok(logs.some((m) => m.includes("Item C"))); // gagal tetap ke-log, gak diem-diem ilang
    });
    await test("artistAssign:syncProject (poin revisi lanjutan, fitur Status) — item TANPA artis tapi PUNYA status (atau nyisa sent_shortcode) ikut disinkron, bukan cuma yang punya artis", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/const itemArtistQueues = new Map\(\);[\s\S]*?handle\("artistAssign:syncProject",[\s\S]*?\n\}\);/)[0];
      const statusAddCalls = [];
      const statusRemoveCalls = [];
      const handlers = {};
      const context = {
        require: nativeRequire,
        handle: (name, fn) => { handlers[name] = fn; },
        openSlack: () => {}, autoOpenSlack: () => {},
        projects: {
          getProject: () => ({
            items: [
              { id: "A", name: "Item A", artists: [], status_id: "S-A", status_sent_shortcode: null, has_thread: true }, // status baru, belum pernah sync
              { id: "B", name: "Item B", artists: [], status_id: null, status_sent_shortcode: "status-old", has_thread: true }, // preset-nya udah dihapus, nyisa reaction
              // C beneran kosong (gak ada artis/status) TAPI tetap py thread (poin revisi audit
              // D13, target sekarang has_thread) -- reconcile jalan, no-op aman (gak ada add/remove
              // status yang ke-trigger), gak nge-skip item rename-only kayak filter lama.
              { id: "C", name: "Item C", artists: [], status_id: null, status_sent_shortcode: null, has_thread: true },
            ],
          }),
          getRealtimeAssignEnabled: () => false,
          getItemStatus: (itemId) => {
            const item = { A: { status_id: "S-A", sent_shortcode: null }, B: { status_id: null, sent_shortcode: "status-old" } }[itemId];
            return item || null;
          },
          setItemStatusSentShortcode: () => {},
          listStatusPresets: () => [{ id: "S-A", code_name: "status-a" }],
          // Poin revisi (audit D13) — pushItemToSlack SEKARANG SELALU manggil
          // reconcileItemAssignState (gak lagi digate item.artists.length>0), jadi dependensinya
          // butuh dimock juga di sini walau test ini fokus ke sisi Status doang.
          getArtistAssignModes: () => ({ mention: false, react: false }),
          listItemArtists: () => [],
          listArtistPresets: () => [],
          listItemReactions: () => [],
          addLog: () => {},
        },
        currentToken: () => "MOCK",
        threadKey: (_p, id) => id,
        slack: {
          findThreadInfo: () => ({ channelId: "CA", threadTs: "1.000" }),
          addReaction: async (args) => { statusAddCalls.push(args.name); },
          removeReaction: async (args) => { statusRemoveCalls.push(args.name); },
          syncAssignMessage: async () => {},
        },
      };
      vm.runInNewContext(block, context);
      const result = await handlers["artistAssign:syncProject"]({}, "P");
      assert.equal(result.total, 3); // A/B/C semua py thread (poin revisi D13, target has_thread)
      assert.deepEqual(statusAddCalls, ["status-a"]); // A: status baru dipasang
      assert.deepEqual(statusRemoveCalls, ["status-old"]); // B: reaction lama (preset udah dihapus) dibersihin
      // C beneran kosong -- reconcile tetep jalan (no-op aman), gak ada add/remove status yang
      // ke-trigger buat dia (assertion di atas udah nyakup ini implisit -- cuma "status-a"/
      // "status-old" doang yang masuk daftar, gak ada entry ketiga dari C).
    });
    await test("slackPull:syncProject (poin revisi, tombol Pull manual) — react state-diff (assign/lepas artis ngikutin react TERKINI di Slack) + replay kata kunci di reply thread, 1 item gagal fetch gak nge-abort item lain", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/const itemArtistQueues = new Map\(\);[\s\S]*?handle\("slackSocket:clearToken",[\s\S]*?\n\}\);/)[0];

      let i1Artists = [{ artist_id: "U-IKSAN", artist_name: "Iksan" }];
      let i2Status = null;
      let i1Reactions = [{ id: "R-SEED-IKSAN", slack_shortcode: "iksan", sent: 1 }]; // id BEDA dari generator R${++ridSeq} di bawah, cegah tabrakan id
      let ridSeq = 0;
      const notifyPushes = [];
      const logs = [];
      const handlers = {};
      const context = {
        require: nativeRequire,
        handle: (name, fn) => { handlers[name] = fn; },
        openSlack: () => {}, autoOpenSlack: () => {},
        currentToken: () => "MOCK",
        threadKey: (_p, id) => id,
        // notifyItemChanged ASLI ikut ke-extract di block ini (posisinya di antara
        // itemArtistQueues dan slackSocket:clearToken) -- gak bisa di-mock langsung (function
        // declaration di dalam block nimpa context.notifyItemChanged), jadi mock `win`-nya aja
        // (dependency notifyItemChanged yang SEBENARNYA), sama pola kayak test handleIncomingReaction.
        win: { isDestroyed: () => false, webContents: { send: (_channel, data) => notifyPushes.push(data) } },
        projects: {
          getProject: (pid) => (pid === "P" ? {
            items: [
              { id: "I1", name: "Item 1", artists: i1Artists.slice() },
              { id: "I2", name: "Item 2", artists: [] },
              { id: "I3", name: "Item 3 (thread gagal diambil)", artists: [] },
            ],
          } : null),
          listArtistPresets: () => [
            { member_id: "U-DIYAN", code_name: "diyan", nickname: "Diyan" }, // BELUM assigned lokal, TAPI live di Slack -- harus ke-assign
            { member_id: "U-IKSAN", code_name: "iksan", nickname: "Iksan" }, // UDAH assigned+sent lokal, TAPI react-nya UDAH GAK ADA di Slack -- harus ke-lepas
          ],
          listStatusPresets: () => [{ id: "S-A", name: "Status A", code_name: "clock" }],
          listItemArtists: (itemId) => (itemId === "I1" ? i1Artists.slice() : []),
          addItemArtist: (itemId, artistId, artistName) => { if (itemId === "I1" && !i1Artists.find((a) => a.artist_id === artistId)) i1Artists.push({ artist_id: artistId, artist_name: artistName }); },
          removeItemArtist: (itemId, artistId) => { if (itemId === "I1") i1Artists = i1Artists.filter((a) => a.artist_id !== artistId); },
          listItemReactions: (itemId) => (itemId === "I1" ? i1Reactions.slice() : []),
          addItemReaction: (_itemId, { slackShortcode }) => { const id = `R${++ridSeq}`; i1Reactions.push({ id, slack_shortcode: slackShortcode, sent: 0 }); return id; },
          markItemReactionSent: (id) => { const r = i1Reactions.find((r) => r.id === id); if (r) r.sent = 1; },
          removeItemReaction: (id) => { i1Reactions = i1Reactions.filter((r) => r.id !== id); },
          getArtistAssignModes: () => ({ mention: false, react: true }),
          getItemStatus: (itemId) => (itemId === "I2" ? i2Status : null),
          setItemStatus: (itemId, statusId) => { if (itemId === "I2") i2Status = { status_id: statusId, sent_shortcode: i2Status?.sent_shortcode || null }; },
          setItemStatusSentShortcode: (itemId, shortcode) => { if (itemId === "I2") i2Status = { status_id: i2Status?.status_id || null, sent_shortcode: shortcode }; },
          getRealtimeAssignEnabled: () => false,
          getKeywordAutomationEnabled: () => true,
          listKeywordAutomations: () => [{ id: "A1", keyword: "@WIP", target_type: "status", target_id: "S-A" }],
          addLog: (level, msg) => logs.push([level, msg]),
        },
        slack: {
          findThreadInfo: (key) => (key === "I3" ? { channelId: "CA", threadTs: "I3.ts" } : { channelId: "CA", threadTs: `${key}.ts` }),
          fetchThreadReplies: async ({ threadTs }) => {
            if (threadTs === "I1.ts") return [{ ts: "I1.ts", reactions: [{ name: "diyan" }] }]; // "iksan" UDAH GAK live
            if (threadTs === "I2.ts") return [{ ts: "I2.ts" }, { ts: "I2.reply1", text: "@WIP mulai dikerjain dong" }];
            if (threadTs === "I3.ts") throw new Error("network drop pas ambil thread");
            return [];
          },
          addReaction: async () => {},
          removeReaction: async () => {},
          syncAssignMessage: async () => {},
        },
      };
      vm.runInNewContext(block, context);

      const result = await handlers["slackPull:syncProject"]({}, "P");

      // React state-diff: diyan ke-assign (live di Slack, belum lokal), iksan ke-lepas (lokal
      // masih assigned+sent, TAPI react-nya udah gak ada di Slack) -- 2 perubahan react.
      assert.equal(result.reactionChanges, 2);
      assert.equal(i1Artists.length, 1);
      assert.equal(i1Artists[0].artist_id, "U-DIYAN");
      assert.ok(i1Reactions.some((r) => r.slack_shortcode === "diyan" && r.sent));
      assert.ok(!i1Reactions.some((r) => r.slack_shortcode === "iksan"));

      // Kata kunci "@WIP" di reply thread I2 -- status ke-set via reconcileItemStatusState ASLI
      // (force:true), reaction "clock" ke-pasang beneran ke Slack.
      assert.equal(result.keywordChanges, 1);
      assert.equal(i2Status.status_id, "S-A");
      assert.equal(i2Status.sent_shortcode, "clock");

      // I3 gagal fetch thread -- ke-log sebagai error, TAPI I1/I2 tetap keproses normal (di atas).
      assert.equal(result.errors.length, 1);
      assert.ok(result.errors[0].includes("Item 3"));
      assert.ok(logs.some(([level, msg]) => level === "error" && msg.includes("Item 3")));

      // item:changed didorong buat I1 & I2 (yang beneran berubah), TIDAK buat I3 (gagal/di-skip).
      assert.deepEqual(notifyPushes.map((p) => p.itemId).sort(), ["I1", "I2"]);
    });
    await test("item:pushRootName, artistAssign:syncItem & slackPull:syncItem — Push Item cuma rename root; Push penuh/Pull tetap scope satu item", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/const itemArtistQueues = new Map\(\);[\s\S]*?handle\("slackSocket:clearToken",[\s\S]*?\n\}\);/)[0];

      let i1Artists = [{ artist_id: "U-DIYAN", artist_name: "Diyan" }];
      let i2Artists = []; // I2 SENGAJA gak boleh kesentuh sama sekali oleh syncItem(I1)
      let i1Reactions = [];
      const syncAssignCalls = [];
      const addReactionCalls = [];
      const rootSyncCalls = [];
      const notifyPushes = [];
      const openSlackCalls = [];
      const handlers = {};
      const context = {
        require: nativeRequire,
        handle: (name, fn) => { handlers[name] = fn; },
        openSlack: (args) => openSlackCalls.push(args), autoOpenSlack: (args) => openSlackCalls.push(args),
        currentToken: () => "MOCK",
        threadKey: (_p, id) => id,
        win: { isDestroyed: () => false, webContents: { send: (_c, data) => notifyPushes.push(data) } },
        projects: {
          getProject: (pid) => (pid === "P" ? {
            items: [
              { id: "I1", name: "Item 1", artists: i1Artists.slice(), status_id: null, status_sent_shortcode: null },
              { id: "I2", name: "Item 2", artists: i2Artists.slice(), status_id: null, status_sent_shortcode: null },
            ],
          } : null),
          listArtistPresets: () => [{ member_id: "U-DIYAN", code_name: "diyan", nickname: "Diyan" }],
          listStatusPresets: () => [],
          listItemArtists: (itemId) => (itemId === "I1" ? i1Artists.slice() : i2Artists.slice()),
          addItemArtist: () => {}, removeItemArtist: () => {},
          listItemReactions: (itemId) => (itemId === "I1" ? i1Reactions.slice() : []),
          addItemReaction: (_itemId, { slackShortcode }) => { const id = `R${i1Reactions.length + 1}`; i1Reactions.push({ id, slack_shortcode: slackShortcode, sent: 0 }); return id; },
          markItemReactionSent: (id) => { const r = i1Reactions.find((r) => r.id === id); if (r) r.sent = 1; },
          removeItemReaction: () => {},
          getArtistAssignModes: () => ({ mention: false, react: true }),
          getItemStatus: () => null,
          setItemStatus: () => {}, setItemStatusSentShortcode: () => {},
          getKeywordAutomationEnabled: () => false,
          listKeywordAutomations: () => [],
          addLog: () => {},
        },
        slack: {
          findThreadInfo: (key) => ({ channelId: "CA", threadTs: `${key}.ts` }),
          fetchThreadReplies: async ({ threadTs }) => (threadTs === "I1.ts" ? [{ ts: "I1.ts", reactions: [{ name: "diyan" }] }] : []),
          addReaction: async (args) => { addReactionCalls.push(args); },
          removeReaction: async () => {},
          syncAssignMessage: async (args) => { syncAssignCalls.push(args); },
          syncRootMessageName: async (args) => { rootSyncCalls.push(args); },
        },
      };
      vm.runInNewContext(block, context);

      // Push scope item (I1 punya artis assigned -- reconcileItemAssignState beneran jalan,
      // mode react -- pasang reaction "diyan"). I2 TIDAK ikut kesentuh (gak ada assertion soal
      // I2 -- kalau syncItem salah scope, i2Artists/mock-nya tetep kosong, gak ada cara ke-detect
      // dari sini kecuali lewat absennya panggilan buat I2 sama sekali di atas -- desain testnya
      // sendiri MEMANG cuma nyediain mock buat I1, kalau kode salah sentuh I2 bakal throw duluan).
      const pushResult = await handlers["artistAssign:syncItem"]({}, { projectId: "P", itemId: "I1" });
      assert.equal(pushResult.itemName, "Item 1");
      assert.ok(addReactionCalls.some((c) => c.name === "diyan"));
      // Poin revisi (diminta user) — Push HARUS ikut nyoba update nama pesan root, bukan cuma
      // reconcile artis/status, biar rename lokal ikut ke-refleksiin ke Slack.
      assert.equal(rootSyncCalls.length, 1);
      assert.equal(rootSyncCalls[0].itemName, "Item 1");
      assert.equal(rootSyncCalls[0].channelId, "CA");
      // Poin revisi (diminta user, "auto open link pesan saat instan intake") — Push per-item
      // SELALU buka link abis kelar (openAfter default true, samain UX kayak send:quick).
      assert.equal(openSlackCalls.length, 1);
      assert.equal(openSlackCalls[0].channelId, "CA");
      assert.equal(openSlackCalls[0].ts, "I1.ts");

      // openAfter=false (dipakai overlay KOLOM, bisa Push banyak item sekaligus) -- HARUS gak
      // buka tab tambahan.
      await handlers["artistAssign:syncItem"]({}, { projectId: "P", itemId: "I1", openAfter: false });
      assert.equal(openSlackCalls.length, 1); // tetap 1, gak nambah

      // Overlay Push pada kolom Item adalah jalur khusus: nama root saja. Tidak boleh ikut
      // reconcile artis/status/reaction seperti Push utama/kolom Artis/Status.
      const beforeRootOnly = {
        roots: rootSyncCalls.length,
        reactions: addReactionCalls.length,
        assignments: syncAssignCalls.length,
        opened: openSlackCalls.length,
      };
      const rootOnlyResult = await handlers["item:pushRootName"]({}, { projectId: "P", itemId: "I1", openAfter: false });
      assert.equal(rootOnlyResult.itemName, "Item 1");
      assert.equal(rootSyncCalls.length, beforeRootOnly.roots + 1);
      assert.equal(addReactionCalls.length, beforeRootOnly.reactions);
      assert.equal(syncAssignCalls.length, beforeRootOnly.assignments);
      assert.equal(openSlackCalls.length, beforeRootOnly.opened);

      await assert.rejects(handlers["artistAssign:syncItem"]({}, { projectId: "P", itemId: "I-GAK-ADA" }), /Item tidak ditemukan/);
      await assert.rejects(handlers["item:pushRootName"]({}, { projectId: "P", itemId: "I-GAK-ADA" }), /Item tidak ditemukan/);

      // Pull scope item.
      const pullResult = await handlers["slackPull:syncItem"]({}, { projectId: "P", itemId: "I1" });
      assert.equal(pullResult.itemName, "Item 1");
      assert.equal(pullResult.reactionChanges, 0); // diyan UDAH live+sent dari Push di atas, gak ada perubahan baru
      assert.equal(pullResult.keywordChanges, 0);

      await assert.rejects(handlers["slackPull:syncItem"]({}, { projectId: "P", itemId: "I-GAK-ADA" }), /Item tidak ditemukan/);
    });
    await test("pullItemFromSlack (poin revisi, diminta user \"pull dan push bisa ubah nama item\") — nama item ikut Pull kalau beda dari pesan root Slack, lucutin tanda bintang pembungkus, no-op kalau udah sama", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/const itemArtistQueues = new Map\(\);[\s\S]*?handle\("slackSocket:clearToken",[\s\S]*?\n\}\);/)[0];
      const updateItemCalls = [];
      const notifyPushes = [];
      const handlers = {};
      let itemName = "Nama Lama";
      const context = {
        require: nativeRequire,
        handle: (name, fn) => { handlers[name] = fn; },
        openSlack: () => {}, autoOpenSlack: () => {},
        currentToken: () => "MOCK",
        threadKey: (_p, id) => id,
        win: { isDestroyed: () => false, webContents: { send: (_c, data) => notifyPushes.push(data) } },
        projects: {
          getProject: (pid) => (pid === "P" ? { items: [{ id: "I1", name: itemName, artists: [], status_id: null, status_sent_shortcode: null }] } : null),
          listArtistPresets: () => [],
          listStatusPresets: () => [],
          listItemArtists: () => [],
          listItemReactions: () => [],
          getArtistAssignModes: () => ({ mention: false, react: false }),
          getItemStatus: () => null,
          getKeywordAutomationEnabled: () => false,
          listKeywordAutomations: () => [],
          updateItem: (id, patch) => { updateItemCalls.push({ id, patch }); if (patch.name !== undefined) itemName = patch.name; },
          addLog: () => {},
        },
        slack: {
          findThreadInfo: () => ({ channelId: "CA", threadTs: "I1.ts" }),
          fetchThreadReplies: async () => [{ ts: "I1.ts", text: "*Nama Baru Dari Slack*", reactions: [] }],
        },
      };
      vm.runInNewContext(block, context);

      const result = await handlers["slackPull:syncItem"]({}, { projectId: "P", itemId: "I1" });
      assert.equal(result.nameChanged, true);
      assert.equal(result.itemName, "Nama Baru Dari Slack"); // tanda bintang pembungkus kelucutin
      assert.equal(updateItemCalls.length, 1);
      assert.equal(updateItemCalls[0].id, "I1");
      assert.equal(updateItemCalls[0].patch.name, "Nama Baru Dari Slack");
      assert.equal(notifyPushes.length, 1); // nameChanged doang TETEP notify item:changed

      // Panggil lagi -- pesan root SEKARANG sama kayak nama lokal (udah ke-update di atas),
      // no-op, gak manggil updateItem lagi.
      const result2 = await handlers["slackPull:syncItem"]({}, { projectId: "P", itemId: "I1" });
      assert.equal(result2.nameChanged, false);
      assert.equal(updateItemCalls.length, 1); // tetap 1, gak nambah
    });
    await test("reconcileItemAssignState (poin revisi, bug dilaporkan: \"ganti mode, react lama masih tertinggal\") — bersihin reaction stale + sinkron mention sesuai mode SAAT INI, siapa pun triggernya", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/const itemArtistQueues = new Map\(\);[\s\S]*?handle\("item:removeArtist",[\s\S]*?\n\}\)\);/)[0];

      let mode = "react";
      const realtime = true;
      const itemArtists = [];
      const reactions = [];
      let ridSeq = 0;
      const reactionAddCalls = [];
      const reactionRemoveCalls = [];
      const syncCalls = [];
      const openSlackCalls = [];
      const handlers = {};

      const context = {
        require: nativeRequire,
        handle: (name, fn) => { handlers[name] = fn; },
        openSlack: (args) => { openSlackCalls.push(args); }, autoOpenSlack: (args) => { openSlackCalls.push(args); },
        projects: {
          getProject: () => ({ items: [{ id: "I", name: "item-003" }] }),
          addItemArtist: (_itemId, artistId, artistName) => { if (!itemArtists.find((a) => a.artist_id === artistId)) itemArtists.push({ artist_id: artistId, artist_name: artistName }); },
          removeItemArtist: (_itemId, artistId) => { const i = itemArtists.findIndex((a) => a.artist_id === artistId); if (i >= 0) itemArtists.splice(i, 1); },
          listItemArtists: () => itemArtists.slice(),
          getArtistAssignModes: () => ({ mention: mode === "mention", react: mode === "react" }),
          getRealtimeAssignEnabled: () => realtime,
          listArtistPresets: () => [{ member_id: "U-DIYAN", code_name: "diyan" }, { member_id: "U-ADRIAN", code_name: "adrian" }],
          listItemReactions: () => reactions.slice(),
          addItemReaction: (_itemId, { slackShortcode }) => { const id = `R${++ridSeq}`; reactions.push({ id, slack_shortcode: slackShortcode, sent: 0 }); return id; },
          markItemReactionSent: (id) => { const r = reactions.find((r) => r.id === id); if (r) r.sent = 1; },
          removeItemReaction: (id) => { const i = reactions.findIndex((r) => r.id === id); if (i >= 0) reactions.splice(i, 1); },
          // Poin revisi (urutan react artis vs status) -- item ini gak punya status di test-nya,
          // getItemStatus tetap harus ada (dipanggil reconcileItemAssignState buat cek bump urutan).
          getItemStatus: () => null,
          addLog: () => {},
        },
        currentToken: () => "MOCK",
        threadKey: (_p, id) => id,
        slack: {
          findThreadInfo: () => ({ channelId: "CA", threadTs: "1.000" }),
          addReaction: async (args) => { reactionAddCalls.push(args.name); },
          removeReaction: async (args) => { reactionRemoveCalls.push(args.name); },
          syncAssignMessage: async (args) => { syncCalls.push(args.artistIds.slice()); },
        },
      };
      vm.runInNewContext(block, context);

      // 1. Mode react: assign diyan -> reaction diyan langsung live, mention TETAP placeholder
      // (array kosong) walau UDAH ada yang assigned -- sesuai aturan "mode react, placeholder
      // selalu kosong".
      await handlers["item:addArtist"]({}, { projectId: "P", itemId: "I", artistId: "U-DIYAN", artistName: "Diyan" });
      assert.deepEqual(reactionAddCalls, ["diyan"]);
      // .length (bukan deepEqual) -- array dibikin di dalam vm.runInNewContext, realm beda bikin
      // assert.deepEqual array kosong lintas-realm error "not reference-equal".
      assert.equal(syncCalls[syncCalls.length - 1].length, 0);
      // Poin revisi: realtime assign per-item LANGSUNG buka Slack ke thread item ini.
      assert.equal(openSlackCalls.length, 1);
      assert.equal(openSlackCalls[0].channelId, "CA");
      assert.equal(openSlackCalls[0].ts, "1.000");

      // 2. Ganti mode ke mention (diyan TETAP assigned di item_artists, gak pernah eksplisit
      // dilepas), assign adrian juga. Bug lama: reaction diyan NYANGKUT (gak pernah dicek ulang).
      // Fix: reconcile baca ULANG mode SAAT INI -> diyan gak seharusnya live lagi -> dibersihin.
      mode = "mention";
      await handlers["item:addArtist"]({}, { projectId: "P", itemId: "I", artistId: "U-ADRIAN", artistName: "Adrian" });
      assert.deepEqual(reactionRemoveCalls, ["diyan"]);
      assert.deepEqual(syncCalls[syncCalls.length - 1].sort(), ["U-ADRIAN", "U-DIYAN"]); // dua-duanya assigned, mode mention -> mention beneran nampilin dua-duanya

      // 3. Lepas diyan (chip artis ATAU chip react, efeknya sama — reconcile yang nanganin) ->
      // mention ke-update lagi cuma nyisa adrian, perubahan "aktif di 2 sisi".
      await handlers["item:removeArtist"]({}, { projectId: "P", itemId: "I", artistId: "U-DIYAN" });
      assert.deepEqual(syncCalls[syncCalls.length - 1], ["U-ADRIAN"]);
    });
    await test("item:setArtists mengganti assignment secara atomik dan membersihkan reaction pending lama", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/const itemArtistQueues = new Map\(\);[\s\S]*?handle\("item:setArtists",[\s\S]*?\n\}\)\);/)[0];
      const itemArtists = [
        { artist_id: "U-A", artist_name: "A" },
        { artist_id: "U-B", artist_name: "B" },
      ];
      const reactions = [
        { id: "R-A", slack_shortcode: "a", sent: 0 },
        { id: "R-B", slack_shortcode: "b", sent: 0 },
      ];
      const handlers = {};
      const context = {
        require: nativeRequire,
        handle: (name, fn) => { handlers[name] = fn; },
        projects: {
          getProject: () => ({ items: [{ id: "I", name: "Item" }] }),
          listItemArtists: () => itemArtists.slice(),
          addItemArtist: (_itemId, artistId, artistName) => itemArtists.push({ artist_id: artistId, artist_name: artistName }),
          removeItemArtist: (_itemId, artistId) => { const i = itemArtists.findIndex((a) => a.artist_id === artistId); if (i >= 0) itemArtists.splice(i, 1); },
          listArtistPresets: () => [
            { member_id: "U-A", code_name: "a" },
            { member_id: "U-B", code_name: "b" },
            { member_id: "U-C", code_name: "c" },
          ],
          listItemReactions: () => reactions.slice(),
          removeItemReaction: (id) => { const i = reactions.findIndex((r) => r.id === id); if (i >= 0) reactions.splice(i, 1); },
          addItemReaction: (_itemId, { slackShortcode }) => { reactions.push({ id: `R-${slackShortcode}`, slack_shortcode: slackShortcode, sent: 0 }); },
          getArtistAssignModes: () => ({ mention: false, react: true, multi: false }),
          getRealtimeAssignEnabled: () => false,
        },
        slack: {},
      };
      vm.runInNewContext(block, context);
      await handlers["item:setArtists"]({}, { projectId: "P", itemId: "I", artists: [{ artistId: "U-C", artistName: "C" }] });
      assert.deepEqual(itemArtists.map((a) => a.artist_id), ["U-C"]);
      assert.deepEqual(reactions.map((r) => r.slack_shortcode), ["c"]);
    });
    await test("reconcileItemAssignState: mention DAN react bisa aktif BARENG (poin revisi terbaru, bukan mutually-exclusive lagi)", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/const itemArtistQueues = new Map\(\);[\s\S]*?handle\("item:removeArtist",[\s\S]*?\n\}\)\);/)[0];

      const mentionOn = true, reactOn = true; // DUA-duanya ON bareng
      const realtime = true;
      const itemArtists = [];
      const reactions = [];
      let ridSeq = 0;
      const reactionAddCalls = [];
      const reactionRemoveCalls = [];
      const syncCalls = [];
      const handlers = {};

      const context = {
        require: nativeRequire,
        handle: (name, fn) => { handlers[name] = fn; },
        openSlack: () => {}, autoOpenSlack: () => {},
        projects: {
          getProject: () => ({ items: [{ id: "I", name: "item-both" }] }),
          addItemArtist: (_itemId, artistId, artistName) => { if (!itemArtists.find((a) => a.artist_id === artistId)) itemArtists.push({ artist_id: artistId, artist_name: artistName }); },
          removeItemArtist: (_itemId, artistId) => { const i = itemArtists.findIndex((a) => a.artist_id === artistId); if (i >= 0) itemArtists.splice(i, 1); },
          listItemArtists: () => itemArtists.slice(),
          getArtistAssignModes: () => ({ mention: mentionOn, react: reactOn }),
          getRealtimeAssignEnabled: () => realtime,
          listArtistPresets: () => [{ member_id: "U-DIYAN", code_name: "diyan" }],
          listItemReactions: () => reactions.slice(),
          addItemReaction: (_itemId, { slackShortcode }) => { const id = `R${++ridSeq}`; reactions.push({ id, slack_shortcode: slackShortcode, sent: 0 }); return id; },
          markItemReactionSent: (id) => { const r = reactions.find((r) => r.id === id); if (r) r.sent = 1; },
          removeItemReaction: (id) => { const i = reactions.findIndex((r) => r.id === id); if (i >= 0) reactions.splice(i, 1); },
          getItemStatus: () => null,
          addLog: () => {},
        },
        currentToken: () => "MOCK",
        threadKey: (_p, id) => id,
        slack: {
          findThreadInfo: () => ({ channelId: "CA", threadTs: "1.000" }),
          addReaction: async (args) => { reactionAddCalls.push(args.name); },
          removeReaction: async (args) => { reactionRemoveCalls.push(args.name); },
          syncAssignMessage: async (args) => { syncCalls.push(args.artistIds.slice()); },
        },
      };
      vm.runInNewContext(block, context);

      // Assign diyan -- HARUS kejadian DUA-duanya: reaction diyan live DAN mention beneran
      // nampilin @diyan (bukan placeholder), soalnya mention & react sekarang independen.
      await handlers["item:addArtist"]({}, { projectId: "P", itemId: "I", artistId: "U-DIYAN", artistName: "Diyan" });
      assert.deepEqual(reactionAddCalls, ["diyan"]);
      assert.deepEqual(syncCalls[syncCalls.length - 1], ["U-DIYAN"]);

      // Lepas diyan -- reaction-nya ikut kehapus DAN mention balik ke placeholder (array kosong),
      // dua-duanya sisi ke-update bareng.
      await handlers["item:removeArtist"]({}, { projectId: "P", itemId: "I", artistId: "U-DIYAN" });
      assert.deepEqual(reactionRemoveCalls, ["diyan"]);
      assert.equal(syncCalls[syncCalls.length - 1].length, 0);
    });
    await test("reconcileItemAssignState (poin revisi, urutan reaction) — react status yang UDAH nempel duluan di-bump ke belakang tiap ada react artis BARU, biar artis SELALU tampil duluan", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/const itemArtistQueues = new Map\(\);[\s\S]*?handle\("item:removeArtist",[\s\S]*?\n\}\)\);/)[0];

      const itemArtists = [];
      const reactions = [];
      let ridSeq = 0;
      const reactionOps = []; // urutan panggilan Slack asli (add/remove) -- ini yang mastiin posisi tampil
      const handlers = {};

      const context = {
        require: nativeRequire,
        handle: (name, fn) => { handlers[name] = fn; },
        openSlack: () => {}, autoOpenSlack: () => {},
        projects: {
          getProject: () => ({ items: [{ id: "I", name: "item-order" }] }),
          addItemArtist: (_itemId, artistId, artistName) => { if (!itemArtists.find((a) => a.artist_id === artistId)) itemArtists.push({ artist_id: artistId, artist_name: artistName }); },
          removeItemArtist: () => {},
          listItemArtists: () => itemArtists.slice(),
          getArtistAssignModes: () => ({ mention: false, react: true }),
          getRealtimeAssignEnabled: () => true,
          listArtistPresets: () => [{ member_id: "U-DIYAN", code_name: "diyan" }],
          listItemReactions: () => reactions.slice(),
          addItemReaction: (_itemId, { slackShortcode }) => { const id = `R${++ridSeq}`; reactions.push({ id, slack_shortcode: slackShortcode, sent: 0 }); return id; },
          markItemReactionSent: (id) => { const r = reactions.find((r) => r.id === id); if (r) r.sent = 1; },
          removeItemReaction: () => {},
          // Poin revisi -- status "ngerja" UDAH nempel duluan di Slack SEBELUM artis di-assign
          // (skenario yang dilaporkan bikin urutan kebalik: status keliatan lebih duluan dari artis).
          getItemStatus: () => ({ status_id: "S-A", sent_shortcode: "ngerja" }),
          addLog: () => {},
        },
        currentToken: () => "MOCK",
        threadKey: (_p, id) => id,
        slack: {
          findThreadInfo: () => ({ channelId: "CA", threadTs: "1.000" }),
          addReaction: async (args) => { reactionOps.push(["add", args.name]); },
          removeReaction: async (args) => { reactionOps.push(["remove", args.name]); },
          syncAssignMessage: async () => {},
        },
      };
      vm.runInNewContext(block, context);

      await handlers["item:addArtist"]({}, { projectId: "P", itemId: "I", artistId: "U-DIYAN", artistName: "Diyan" });
      // Urutan panggilan Slack: react artis "diyan" ditambah DULU, baru status "ngerja" di-lepas +
      // dipasang ulang (pindah ke ujung belakang) -- hasilnya di Slack, chip artis tampil duluan.
      assert.deepEqual(reactionOps, [["add", "diyan"], ["remove", "ngerja"], ["add", "ngerja"]]);
    });
    await test("item:setStatus / reconcileItemStatusState (poin revisi, fitur Status) — ganti status lepas reaction lama pasang yang baru, force=true gak buka Slack, no-op kalau udah sinkron", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/const itemArtistQueues = new Map\(\);[\s\S]*?handle\("item:setStatus",[\s\S]*?\n\}\)\);/)[0];

      const realtime = true;
      let itemStatus = null; // { status_id, sent_shortcode }
      const addCalls = [];
      const removeCalls = [];
      const openSlackCalls = [];
      const handlers = {};
      const context = {
        require: nativeRequire,
        handle: (name, fn) => { handlers[name] = fn; },
        openSlack: (args) => { openSlackCalls.push(args); }, autoOpenSlack: (args) => { openSlackCalls.push(args); },
        projects: {
          getProject: () => ({ items: [{ id: "I", name: "item-status" }] }),
          getRealtimeAssignEnabled: () => realtime,
          getItemStatus: () => itemStatus,
          setItemStatus: (_itemId, statusId) => { itemStatus = { status_id: statusId, sent_shortcode: itemStatus?.sent_shortcode || null }; },
          setItemStatusSentShortcode: (_itemId, shortcode) => { itemStatus = { status_id: itemStatus?.status_id || null, sent_shortcode: shortcode }; },
          listStatusPresets: () => [{ id: "S-A", code_name: "status-a" }, { id: "S-B", code_name: "status-b" }],
          addLog: () => {},
        },
        currentToken: () => "MOCK",
        threadKey: (_p, id) => id,
        slack: {
          findThreadInfo: () => ({ channelId: "CA", threadTs: "1.000" }),
          addReaction: async (args) => { addCalls.push(args.name); },
          removeReaction: async (args) => { removeCalls.push(args.name); },
        },
      };
      vm.runInNewContext(block, context);

      // 1. Pilih status A -- reaction status-a live, Slack ke-buka (realtime per-item).
      await handlers["item:setStatus"]({}, { projectId: "P", itemId: "I", statusId: "S-A" });
      assert.deepEqual(addCalls, ["status-a"]);
      assert.deepEqual(removeCalls, []);
      assert.equal(openSlackCalls.length, 1);

      // 2. Ganti ke status B -- status-a HARUS dilepas dulu, status-b baru dipasang (cuma 1 aktif).
      await handlers["item:setStatus"]({}, { projectId: "P", itemId: "I", statusId: "S-B" });
      assert.deepEqual(removeCalls, ["status-a"]);
      assert.deepEqual(addCalls, ["status-a", "status-b"]);

      // 3. Lepas status (null) -- status-b ikut dilepas, gak ada yang dipasang lagi.
      await handlers["item:setStatus"]({}, { projectId: "P", itemId: "I", statusId: null });
      assert.deepEqual(removeCalls, ["status-a", "status-b"]);

      // 4. Panggil ulang tanpa perubahan apa pun -- no-op, gak ada panggilan Slack tambahan.
      await handlers["item:setStatus"]({}, { projectId: "P", itemId: "I", statusId: null });
      assert.equal(addCalls.length, 2);
      assert.equal(removeCalls.length, 2);
    });
    await test("reconcileItemStatusState (poin revisi, bug ditemukan lewat audit D14) — removeReaction GAGAL -> sent_shortcode TETAP nyimpen shortcode LAMA (bukan di-null-in buta), reconcile berikutnya masih nyoba lepas lagi", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/const itemArtistQueues = new Map\(\);[\s\S]*?handle\("item:setStatus",[\s\S]*?\n\}\)\);/)[0];

      let itemStatus = { status_id: null, sent_shortcode: "old-status" }; // reaction lama UDAH live di Slack
      let removeShouldFail = true;
      const removeCalls = [];
      const addCalls = [];
      const context = {
        require: nativeRequire,
        handle: () => {},
        openSlack: () => {}, autoOpenSlack: () => {},
        projects: {
          getItemStatus: () => itemStatus,
          setItemStatusSentShortcode: (_itemId, shortcode) => { itemStatus = { ...itemStatus, sent_shortcode: shortcode }; },
          addLog: () => {},
        },
        currentToken: () => "MOCK",
        threadKey: (_p, id) => id,
        slack: {
          findThreadInfo: () => ({ channelId: "CA", threadTs: "1.000" }),
          removeReaction: async (args) => {
            removeCalls.push(args.name);
            if (removeShouldFail) throw new Error("mock network gagal");
          },
          addReaction: async (args) => { addCalls.push(args.name); },
        },
      };
      vm.runInNewContext(block, context);

      // Status baru di-set ke null (mau lepas "old-status") -- removeReaction GAGAL.
      await context.reconcileItemStatusState({ projectId: "P", itemId: "I", force: true });
      assert.equal(removeCalls.length, 1);
      // BUG LAMA: sent_shortcode ke-null-in walau gagal -- reconcile berikutnya nganggep "udah
      // sinkron" (liveShortcode null === desiredShortcode null), gak akan nyoba lepas lagi
      // SELAMANYA walau reaction lama itu MASIH nempel di Slack. Sekarang HARUS tetap "old-status".
      assert.equal(itemStatus.sent_shortcode, "old-status");

      // Panggil lagi, kali ini removeReaction SUKSES -- reconcile masih nyoba (soalnya
      // sent_shortcode belum ke-null-in tadi), BUKAN dianggap udah sinkron dari awal.
      removeShouldFail = false;
      await context.reconcileItemStatusState({ projectId: "P", itemId: "I", force: true });
      assert.equal(removeCalls.length, 2);
      assert.equal(itemStatus.sent_shortcode, null); // sekarang beneran bersih
    });
    await test("handleIncomingReaction (poin revisi, sync 2 arah reaction Slack->App) — cocok artis/status auto-assign/lepas TANPA nembak reactions.add/remove lagi (udah ada di Slack), abaikan thread/reaction yang gak dikenal", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/async function onIncomingArtistReaction[\s\S]*?handle\("slackSocket:clearToken",[\s\S]*?\n\}\);/)[0];

      let itemArtists = [];
      let itemReactions = [];
      let ridSeq = 0;
      let itemStatus = null;
      const syncCalls = [];
      const slackReactionCalls = []; // kalau ada isi-nya, berarti nembak Slack lagi -- SALAH
      const logs = [];
      const itemChangedPushes = [];
      const context = {
        require: nativeRequire,
        handle: () => {},
        withItemArtistLock: (_id, fn) => fn(),
        // Poin revisi (bug dilaporkan: klik chip react abis sync 2 arah ngubah data, UI stale) --
        // handleIncomingReaction harus dorong "item:changed" ke renderer TIAP kali beneran
        // ngubah sesuatu, biar UI auto-refresh gak nyangkut stale.
        win: { isDestroyed: () => false, webContents: { send: (channel, data) => itemChangedPushes.push([channel, data]) } },
        currentToken: () => "MOCK",
        threadKey: (_p, id) => id,
        projects: {
          getProject: (pid) => (pid === "P" ? { items: [{ id: "I", name: "item", artists: itemArtists.slice() }] } : null),
          ownsProject: (id) => id === "P",
          ownsItem: (id) => id === "I",
          addItemArtist: (_itemId, artistId, artistName) => { if (!itemArtists.find((a) => a.artist_id === artistId)) itemArtists.push({ artist_id: artistId, artist_name: artistName }); },
          removeItemArtist: (_itemId, artistId) => { itemArtists = itemArtists.filter((a) => a.artist_id !== artistId); },
          listItemArtists: () => itemArtists.slice(),
          listItemReactions: () => itemReactions.slice(),
          addItemReaction: (_itemId, { slackShortcode }) => { const id = `R${++ridSeq}`; itemReactions.push({ id, slack_shortcode: slackShortcode, sent: 0 }); return id; },
          markItemReactionSent: (id) => { const r = itemReactions.find((r) => r.id === id); if (r) r.sent = 1; },
          removeItemReaction: (id) => { itemReactions = itemReactions.filter((r) => r.id !== id); },
          getArtistAssignModes: () => ({ mention: true, react: false }),
          // Poin revisi (Level 1, toggle Realtime Sync sekarang gate arah Slack->App juga) --
          // test ini nguji jalur SUKSES (realtime dianggap ON), skenario toggle OFF ada di test
          // terpisah di bawah.
          getRealtimeAssignEnabled: () => true,
          listArtistPresets: () => [{ member_id: "U-DIYAN", code_name: "diyan", nickname: "Diyan" }],
          listStatusPresets: () => [{ id: "S-A", code_name: "status-a" }],
          getItemStatus: () => itemStatus,
          setItemStatus: (_itemId, statusId) => { itemStatus = { status_id: statusId, sent_shortcode: itemStatus?.sent_shortcode || null }; },
          setItemStatusSentShortcode: (_itemId, shortcode) => { itemStatus = { status_id: itemStatus?.status_id || null, sent_shortcode: shortcode }; },
          addLog: (level, msg) => logs.push(msg),
        },
        slack: {
          findItemByThread: (channel, ts) => (channel === "CA" && ts === "1.000" ? { projectId: "P", itemId: "I" } : null),
          findThreadInfo: () => ({ channelId: "CA", threadTs: "1.000" }),
          syncAssignMessage: async (args) => { syncCalls.push(args); },
          addReaction: async (args) => { slackReactionCalls.push(["add", args]); },
          removeReaction: async (args) => { slackReactionCalls.push(["remove", args]); },
        },
      };
      vm.runInNewContext(block, context);

      const artistEvent = { reaction: "diyan", item: { type: "message", channel: "CA", ts: "1.000" } };

      // 1. reaction_added cocok code_name artis -- auto-assign, reaction LANGSUNG ditandain sent
      // (BUKAN lewat slack.addReaction -- reaction-nya UDAH ada, itu kenapa event ini nyampe).
      await context.handleIncomingReaction("reaction_added", artistEvent);
      assert.deepEqual(itemArtists.map((a) => a.artist_id), ["U-DIYAN"]);
      assert.equal(itemArtists[0].artist_name, "Diyan"); // nickname preset dipakai, gak perlu listUsers lagi
      assert.deepEqual(itemReactions.map((r) => [r.slack_shortcode, r.sent]), [["diyan", 1]]);
      assert.equal(syncCalls.length, 1); // mode mention ON -- pesan assignment ke-update
      assert.deepEqual(syncCalls[0].artistIds, ["U-DIYAN"]);
      assert.equal(slackReactionCalls.length, 0); // TIDAK nembak reactions.add lagi

      // 2. Event yang SAMA nyampe lagi (retry/echo) -- idempoten, gak dobel-assign. Pesan
      // assignment ikut ke-sync ULANG (chat.update ke konten SAMA, harmless) -- Socket Mode
      // emang bisa redeliver event yang sama (field retry_num), gak masalah selama idempoten.
      await context.handleIncomingReaction("reaction_added", artistEvent);
      assert.equal(itemArtists.length, 1);
      assert.equal(itemReactions.length, 1);
      assert.equal(syncCalls.length, 2);

      // 3. reaction_removed cocok artis yang lagi assigned -- lepas, TANPA nembak reactions.remove.
      await context.handleIncomingReaction("reaction_removed", artistEvent);
      assert.equal(itemArtists.length, 0);
      assert.equal(itemReactions.length, 0);
      assert.equal(syncCalls.length, 3); // pesan assignment ke-update lagi (balik placeholder)
      assert.equal(slackReactionCalls.length, 0);

      // 4. reaction_added cocok code_name STATUS -- auto-set status, sent_shortcode langsung
      // ditandain (bukan reconcile penuh, biar gak ke-cleanup gara-gara mode react OFF).
      const statusEvent = { reaction: "status-a", item: { type: "message", channel: "CA", ts: "1.000" } };
      await context.handleIncomingReaction("reaction_added", statusEvent);
      assert.deepEqual(itemStatus, { status_id: "S-A", sent_shortcode: "status-a" });
      assert.equal(slackReactionCalls.length, 0);

      await context.handleIncomingReaction("reaction_removed", statusEvent);
      assert.deepEqual(itemStatus, { status_id: null, sent_shortcode: null });

      // 5. Reaction yang gak cocok preset artis/status manapun -- diabaikan diem-diem.
      await context.handleIncomingReaction("reaction_added", { reaction: "random-emoji", item: { type: "message", channel: "CA", ts: "1.000" } });
      assert.equal(itemArtists.length, 0);
      assert.equal(itemStatus.status_id, null);

      // 6. Thread yang gak dikenal (findItemByThread null) -- diabaikan, gak throw.
      await context.handleIncomingReaction("reaction_added", { reaction: "diyan", item: { type: "message", channel: "C-ASING", ts: "9.999" } });
      assert.equal(itemArtists.length, 0);

      // 7. Event ganjil (bukan reaction di message, atau gak ada field reaction) -- diabaikan aman.
      await context.handleIncomingReaction("reaction_added", { reaction: "diyan", item: { type: "file", channel: "CA", ts: "1.000" } });
      await context.handleIncomingReaction("reaction_added", { item: { type: "message", channel: "CA", ts: "1.000" } });
      assert.equal(itemArtists.length, 0);

      // 8. Push "item:changed" ke renderer (poin revisi, bug dilaporkan: UI stale abis sync) --
      // TIAP kali beneran ngubah sesuatu (langkah 1-4), BUKAN buat yang diabaikan (langkah 5-7).
      assert.equal(itemChangedPushes.length, 5);
      assert.ok(itemChangedPushes.every(([channel, data]) => channel === "item:changed" && data.projectId === "P" && data.itemId === "I"));
      assert.equal(logs.length, 0); // gak ada satu pun yang nyampe nge-log error
    });
    await test("handleIncomingReaction (poin revisi, toggle Realtime Sync sekarang gate arah Slack->App juga) — toggle OFF = react dari Slack di-skip total, gak nyentuh state lokal sama sekali", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/async function onIncomingArtistReaction[\s\S]*?handle\("slackSocket:clearToken",[\s\S]*?\n\}\);/)[0];
      let itemArtists = [];
      const context = {
        require: nativeRequire,
        handle: () => {},
        withItemArtistLock: (_id, fn) => fn(),
        win: { isDestroyed: () => false, webContents: { send: () => {} } },
        currentToken: () => "MOCK",
        threadKey: (_p, id) => id,
        projects: {
          getProject: (pid) => (pid === "P" ? { items: [{ id: "I", name: "item", artists: itemArtists.slice() }] } : null),
          ownsProject: (id) => id === "P",
          ownsItem: (id) => id === "I",
          addItemArtist: (_itemId, artistId, artistName) => { itemArtists.push({ artist_id: artistId, artist_name: artistName }); },
          getRealtimeAssignEnabled: () => false, // TOGGLE OFF -- inti test ini
          listArtistPresets: () => [{ member_id: "U-DIYAN", code_name: "diyan", nickname: "Diyan" }],
          addLog: () => {},
        },
        slack: {
          findItemByThread: (channel, ts) => (channel === "CA" && ts === "1.000" ? { projectId: "P", itemId: "I" } : null),
          findThreadInfo: () => ({ channelId: "CA", threadTs: "1.000" }),
        },
      };
      vm.runInNewContext(block, context);
      await context.handleIncomingReaction("reaction_added", { reaction: "diyan", item: { type: "message", channel: "CA", ts: "1.000" } });
      assert.equal(itemArtists.length, 0); // toggle OFF -- event diterima TAPI di-skip, gak assign apa pun
    });
    await test("slackSocket.cjs (poin revisi, bug ditemukan lewat audit D09) — start() GAGAL TIDAK bikin isRunning() ngaku jalan, reconnect berikutnya beneran nyoba start ulang (bukan di-skip karena isRunning() salah true)", async () => {
      let shouldFail = true;
      let startCalls = 0;
      class FakeSocketModeClient {
        on() {}
        removeAllListeners() {}
        async start() {
          startCalls++;
          if (shouldFail) throw new Error("mock start gagal (token salah/network mati)");
        }
        async disconnect() {}
      }
      const socket = load("electron/slackSocket.cjs", { "@slack/socket-mode": { SocketModeClient: FakeSocketModeClient } });
      assert.equal(socket.isRunning(), false);

      await assert.rejects(socket.start("xapp-fake", {}));
      // BUG LAMA: client diisi SEBELUM await c.start(), gak dikosongkan lagi kalau gagal --
      // isRunning() bakal balikin true di sini walau start()-nya beneran gagal.
      assert.equal(socket.isRunning(), false);
      assert.equal(startCalls, 1);

      shouldFail = false;
      await socket.start("xapp-fake", {}); // reconnect beneran NYOBA lagi, bukan di-skip
      assert.equal(socket.isRunning(), true);
      assert.equal(startCalls, 2);
    });
    await test("updateSocketModeConnectionState (poin revisi, Level 2) — connect kalau salah satu toggle ON & belum jalan, disconnect kalau dua-duanya OFF & lagi jalan, token TETAP TERSIMPAN (gak clearAppToken)", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/const itemArtistQueues = new Map\(\);[\s\S]*?handle\("slackSocket:clearToken",[\s\S]*?\n\}\);/)[0];
      let realtimeOn = false, keywordOn = false, running = false;
      const startCalls = [], stopCalls = [], logs = [];
      const context = {
        require: nativeRequire,
        handle: () => {},
        win: { isDestroyed: () => false, webContents: { send: () => {} } },
        authStore: { loadAppToken: () => "xapp-mock-token" },
        projects: {
          getRealtimeAssignEnabled: () => realtimeOn,
          getKeywordAutomationEnabled: () => keywordOn,
          addLog: (level, msg) => logs.push([level, msg]),
        },
        slackSocket: {
          isRunning: () => running,
          start: async () => { startCalls.push(1); running = true; },
          stop: async () => { stopCalls.push(1); running = false; },
        },
      };
      vm.runInNewContext(block, context);

      // Dua-duanya OFF, belum jalan -- no-op (gak ada yang perlu di-connect).
      await context.updateSocketModeConnectionState();
      assert.equal(startCalls.length, 0);
      assert.equal(stopCalls.length, 0);

      // Realtime Sync ON -- connect.
      realtimeOn = true;
      await context.updateSocketModeConnectionState();
      assert.equal(startCalls.length, 1);
      assert.equal(running, true);

      // Masih ON & UDAH jalan -- gak connect ulang (no-op, hindari start() dobel).
      await context.updateSocketModeConnectionState();
      assert.equal(startCalls.length, 1);

      // Realtime OFF lagi, TAPI Otomasi Kata Kunci ON -- TETAP jalan (salah satu cukup).
      realtimeOn = false; keywordOn = true;
      await context.updateSocketModeConnectionState();
      assert.equal(stopCalls.length, 0);
      assert.equal(running, true);

      // Dua-duanya OFF -- disconnect beneran.
      keywordOn = false;
      await context.updateSocketModeConnectionState();
      assert.equal(stopCalls.length, 1);
      assert.equal(running, false);
      assert.ok(logs.some(([level, msg]) => level === "info" && msg.includes("Socket Mode diputus")));
    });
    await test("keywordAutomationRegex (poin revisi, bug ditemukan lewat audit D07) — cek batas KEDUA sisi (bukan cuma belakang), keyword simbol-di-awal/akhir (\"@WIP\"/\"DONE!\") tetap cocok", () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/function keywordAutomationRegex[\s\S]*?\n\}/)[0];
      const context = {};
      vm.runInNewContext(block, context);
      const { keywordAutomationRegex } = context;

      // Bug lama: "WIP" ikut cocok DI DALAM "NEWIP" (cuma \b belakang, gak ada cek depan).
      assert.equal(keywordAutomationRegex("WIP").test("liat punya NEWIP dong"), false);
      assert.equal(keywordAutomationRegex("WIP").test("status masih WIP ya"), true);
      // Bug lama: keyword "@WIP" (diawali simbol) tetap harus cocok walau didahului spasi.
      assert.equal(keywordAutomationRegex("@WIP").test("hei @WIP tolong dicek"), true);
      assert.equal(keywordAutomationRegex("@WIP").test("hei @WIPER tolong dicek"), false);
      // Bug lama: keyword "DONE!" (diakhiri simbol) GAK PERNAH cocok sama sekali sebelumnya --
      // "!" itu non-word, \b gak bisa nempel abis "!" di akhir kalimat/pesan.
      assert.equal(keywordAutomationRegex("DONE!").test("field ini DONE!"), true);
      assert.equal(keywordAutomationRegex("DONE!").test("field ini DONE! banget"), true);
      assert.equal(keywordAutomationRegex("DONE!").test("field ini UNDONE!"), false);
    });
    await test("handleIncomingMessage (poin revisi, Otomasi Kata Kunci — digeneralisasi dari \"Otomasi WIP\") — kata kunci BEBAS di reply thread item -- trigger set status ATAU assign artis sesuai mapping user, OFF by default, abaikan subtype/di-luar-thread/kata mirip/target kehapus", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/function keywordAutomationRegex[\s\S]*?handle\("keywordAutomation:remove",[\s\S]*?\n\}\);/)[0];

      let enabled = true;
      let automations = [
        { id: "A1", keyword: "@WIP", target_type: "status", target_id: "S-WIP" },
        { id: "A2", keyword: "@DONE", target_type: "artist", target_id: "U-DIYAN" },
      ];
      let statusPresets = [{ id: "S-WIP", name: "Working on it", code_name: "clock" }];
      let artistPresets = [{ member_id: "U-DIYAN", nickname: "Diyan" }];
      let itemArtists = [];
      const setItemStatusCalls = [];
      const addItemArtistCalls = [];
      const reconcileStatusCalls = [];
      const reconcileAssignCalls = [];
      const itemChangedPushes = [];
      const logs = [];
      const context = {
        require: nativeRequire,
        handle: () => {},
        currentToken: () => "MOCK",
        withItemArtistLock: (_id, fn) => fn(),
        reconcileItemStatusState: async ({ projectId, itemId }) => { reconcileStatusCalls.push({ projectId, itemId }); },
        reconcileItemAssignState: async ({ projectId, itemId }) => { reconcileAssignCalls.push({ projectId, itemId }); },
        // notifyItemChanged didefinisikan SEBELUM keywordAutomationRegex di main.cjs (di luar
        // range regex extraction test ini) -- mock langsung di sini, sama alasan
        // withItemArtistLock/reconcileItem*State juga di-mock (definisi aslinya di luar range juga).
        notifyItemChanged: (projectId, itemId) => itemChangedPushes.push(["item:changed", { projectId, itemId }]),
        projects: {
          getKeywordAutomationEnabled: () => enabled,
          listKeywordAutomations: () => automations,
          ownsProject: (id) => id === "P",
          ownsItem: (id) => id === "I",
          getProject: (pid) => (pid === "P" ? { items: [{ id: "I", name: "item", artists: itemArtists }] } : null),
          listStatusPresets: () => statusPresets,
          listArtistPresets: () => artistPresets,
          setItemStatus: (itemId, statusId) => setItemStatusCalls.push({ itemId, statusId }),
          addItemArtist: (itemId, artistId, artistName) => { addItemArtistCalls.push({ itemId, artistId, artistName }); itemArtists.push({ artist_id: artistId }); },
          addLog: (level, msg) => logs.push([level, msg]),
        },
        slack: {
          findItemByThread: (channel, ts) => (channel === "CA" && ts === "ROOT.TS" ? { projectId: "P", itemId: "I" } : null),
        },
      };
      vm.runInNewContext(block, context);

      const baseEvent = { channel: "CA", thread_ts: "ROOT.TS", ts: "REPLY.TS", text: "@WIP <@U-DIYAN> <@U-IKSAN>" };

      // 1. Kata kunci "@WIP" (mapping ke target_type "status") -- status item ke-set,
      // reconcileItemStatusState yang beneran nembak Slack (force:true), push item:changed biar
      // UI auto-refresh, DAN ke-log sukses. TIDAK nyentuh assign artis sama sekali (cuma mapping
      // "@DONE" doang yang ke artis, gak match di pesan ini).
      await context.handleIncomingMessage(baseEvent);
      assert.equal(setItemStatusCalls.length, 1);
      assert.equal(setItemStatusCalls[0].itemId, "I");
      assert.equal(setItemStatusCalls[0].statusId, "S-WIP");
      assert.equal(reconcileStatusCalls.length, 1);
      assert.equal(addItemArtistCalls.length, 0);
      assert.deepEqual(itemChangedPushes[0], ["item:changed", { projectId: "P", itemId: "I" }]);
      assert.deepEqual(logs[logs.length - 1], ["info", 'Otomasi kata kunci "@WIP": status "Working on it" di-set otomatis (item I)']);

      // 2. Kata kunci "@DONE" (mapping ke target_type "artist") -- artis di-assign (pakai nickname
      // preset-nya buat artist_name, gak perlu listUsers), reconcileItemAssignState yang beneran
      // nembak Slack (BUKAN jalur khusus "udah ada di Slack" kayak reaction-sync -- ini genuinely
      // baru, jadi addReaction/syncAssignMessage HARUS beneran kejadian).
      await context.handleIncomingMessage({ ...baseEvent, text: "@DONE selesai dikerjain" });
      assert.equal(addItemArtistCalls.length, 1);
      assert.equal(addItemArtistCalls[0].artistId, "U-DIYAN");
      assert.equal(addItemArtistCalls[0].artistName, "Diyan");
      assert.equal(reconcileAssignCalls.length, 1);

      // 2b. Artis yang UDAH assigned -- gak di-addItemArtist ulang (idempoten), reconcile TETAP
      // dipanggil (biar mention/react ke-sync kalau emang ada yang berubah).
      await context.handleIncomingMessage({ ...baseEvent, text: "@DONE selesai lagi" });
      assert.equal(addItemArtistCalls.length, 1);
      assert.equal(reconcileAssignCalls.length, 2);

      // 3. Kata MIRIP tapi bukan "@WIP" utuh (nempel huruf lain) -- gak cocok, gak diproses.
      await context.handleIncomingMessage({ ...baseEvent, text: "@WIPER kotor jangan dipake" });
      assert.equal(setItemStatusCalls.length, 1);

      // 3b. "WIP" TANPA "@" di depan -- gak cocok (kata kunci-nya "@WIP", bukan "WIP" doang).
      await context.handleIncomingMessage({ ...baseEvent, text: "WIP nih tanpa tanda @" });
      assert.equal(setItemStatusCalls.length, 1);

      // 4. Toggle OFF -- gak diproses sama sekali.
      enabled = false;
      await context.handleIncomingMessage(baseEvent);
      assert.equal(setItemStatusCalls.length, 1);
      enabled = true;

      // 5. subtype ada (edit/delete/bot_message dst) -- diabaikan, bukan pesan baru "polos".
      await context.handleIncomingMessage({ ...baseEvent, subtype: "message_changed" });
      assert.equal(setItemStatusCalls.length, 1);

      // 6. Bukan reply di thread (gak ada thread_ts) -- diabaikan, TAPI ke-log.
      await context.handleIncomingMessage({ ...baseEvent, thread_ts: undefined });
      assert.equal(setItemStatusCalls.length, 1);
      assert.equal(logs[logs.length - 1][0], "info");
      assert.ok(logs[logs.length - 1][1].includes("BUKAN reply di dalam thread"));

      // 7. Ini PESAN ROOT-nya sendiri (thread_ts === ts) -- diabaikan, ke-log sama kayak kasus 6.
      await context.handleIncomingMessage({ ...baseEvent, thread_ts: "SAME.TS", ts: "SAME.TS" });
      assert.equal(setItemStatusCalls.length, 1);
      assert.ok(logs[logs.length - 1][1].includes("BUKAN reply di dalam thread"));

      // 8. Thread yang gak dikenal (findItemByThread null) -- diabaikan, gak throw, TAPI ke-log.
      await context.handleIncomingMessage({ ...baseEvent, channel: "C-ASING" });
      assert.equal(setItemStatusCalls.length, 1);
      assert.equal(logs[logs.length - 1][0], "info");
      assert.ok(logs[logs.length - 1][1].includes("thread ini bukan thread item manapun"));

      // 9. Target Status-nya UDAH KEHAPUS (poin revisi, mirip bug asli dilaporkan: dulu hardcode
      // nama preset yang belum tentu ada) -- diabaikan, TAPI ke-log ERROR yang jelas (bukan "info"
      // biasa, ini beneran butuh aksi user: cek lagi mapping-nya).
      statusPresets = [];
      await context.handleIncomingMessage(baseEvent);
      assert.equal(setItemStatusCalls.length, 1);
      assert.equal(logs[logs.length - 1][0], "error");
      assert.ok(logs[logs.length - 1][1].includes('preset Status target-nya udah gak ada'));
    });
    await test("send:start: root gagal memblokir item, tetapi assign gagal tidak boleh membuang Reply", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/handle\("send:start",[\s\S]*?\n\}\);/)[0];
      const callLog = [];
      const reactionCalls = [];
      const sentReactionIds = [];
      const sentReplyIds = [];
      const reactionsByItem = { A: [{ id: "RA", slack_shortcode: "artis-a", sent: 0 }, { id: "RX", slack_shortcode: "manual", sent: 0 }], B: [] };
      let handler;
      const context = {
        activeSend: null, cancelRequested: false, require: nativeRequire, handle: (_name, fn) => { handler = fn; },
        Notification: { isSupported: () => false },
        projects: {
          getProject: () => ({
            name: "proj", channel_id: "CA",
            items: [
              { id: "A", name: "Item A", artists: [{ artist_id: "U1" }], files: [], replies: [] },
              { id: "B", name: "Item B", artists: [], files: [], replies: [] },
              { id: "C", name: "Item C", artists: [], files: [], replies: [{ id: "RC", sent: false, files: [] }] },
            ],
          }),
          addLog: () => {},
          isManagedFile: () => true,
          listArtistPresets: () => [{ member_id: "U1", code_name: "artis-a" }],
          listItemReactions: (itemId) => reactionsByItem[itemId] || [],
          markItemReactionSent: (id) => {
            sentReactionIds.push(id);
            for (const key of Object.keys(reactionsByItem)) {
              const r = reactionsByItem[key].find((r) => r.id === id);
              if (r) r.sent = 1;
            }
          },
          markReplySent: (id) => sentReplyIds.push(id),
          getArtistAssignModes: () => ({ mention: true, react: false }),
        },
        currentToken: () => "MOCK", threadKey: (_p, id) => id, confirmLegacyThread: async () => {}, openSlack: () => {}, autoOpenSlack: () => {}, replyToPost: (reply) => reply ? { text: "field" } : null,
        reconcileItemStatusState: async () => {},
        slack: {
          ensureRoot: async ({ threadKey: key }) => {
            callLog.push(`root:${key}`);
            if (key === "B") throw new Error("root gagal buat B");
            return { threadTs: `${key}.ts`, isNew: true };
          },
          syncAssignMessage: async ({ itemId }) => {
            callLog.push(`artist:${itemId}`);
            if (itemId === "C") throw new Error("assign gagal buat C");
          },
          addReaction: async ({ name }) => { reactionCalls.push(name); },
          sendReplies: async ({ threadKey: key }) => { callLog.push(`post:${key}`); return { permalink: undefined }; },
        },
        // Papan status HB Apps (poin revisi) -- best-effort, gak diuji detailnya di sini (ada
        // test terpisah buat estimateSendMinutes/progress message), cukup no-op biar send:start jalan.
        hbStatus: {
          estimateSendMinutes: () => 1, postStatus: async () => {},
          countSendWork: ({ targets }) => ({ items: targets.length, assigns: 0, replies: 0, files: 0, total: targets.length }),
          countItemWork: () => ({ items: 1, assigns: 0, replies: 0, files: 0 }),
          postJobStatus: async () => ({ channelId: "C", ts: "1" }), updateJobStatus: async () => {},
          formatJobStart: () => "start", formatJobHeader: () => "header", formatJobDone: () => "done", createProgressEditor: () => async () => {},
        },
      };
      vm.runInNewContext(block, context);
      const { results } = await handler({ sender: { isDestroyed: () => false, send: () => {} } }, { projectId: "P", itemIds: ["A", "B", "C"], scope: undefined });

      // Item B gagal di fase root -> di-skip TOTAL di fase artist/react/post, item A tetap lanjut.
      assert.deepEqual(callLog.filter((c) => c.endsWith(":B")), ["root:B"]);
      assert.deepEqual(callLog.filter((c) => c.endsWith(":A")), ["root:A", "artist:A", "post:A"]);
      // Item C gagal assign, tetapi Reply independennya tetap dicoba dan ditandai terkirim.
      assert.deepEqual(callLog.filter((c) => c.includes(":C")), ["root:C", "artist:C", "post:C#reply:RC"]);
      assert.deepEqual(sentReplyIds, ["RC"]);
      // Urutan GLOBAL per-fase (bukan per-item lagi): semua root dulu, baru artist.
      assert.deepEqual(callLog.filter((c) => c.startsWith("root:") || c.startsWith("artist:")), ["root:A", "root:B", "root:C", "artist:A", "artist:C"]);
      // Reaction artis (artis-a) ke-flush pas fase artist, reaction manual (manual) di fase react
      // terpisah -- dua-duanya ke-flush, gak dobel-proses.
      assert.deepEqual(reactionCalls.sort(), ["artis-a", "manual"]);
      // Poin revisi (chip react persisten) — sukses kekirim = ditandain "sent", BUKAN dihapus
      // lagi. Fase react (3) gak boleh flush ulang yang udah sent di fase artist (2).
      assert.deepEqual(sentReactionIds.sort(), ["RA", "RX"]);
      assert.equal(results.find((r) => r.itemId === "A").status, "berhasil");
      assert.equal(results.find((r) => r.itemId === "B").status, "gagal");
      assert.equal(results.find((r) => r.itemId === "C").status, "gagal");
    });
    await test("send:start scope \"item\"/\"replies\" (poin revisi, Instant Intake per-kolom) TETAP sinkron assign message, gak di-skip lagi", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/handle\("send:start",[\s\S]*?\n\}\);/)[0];
      function makeContext(scope) {
        const syncCalls = [];
        let handler;
        const context = {
          activeSend: null, cancelRequested: false, require: nativeRequire, handle: (_name, fn) => { handler = fn; },
          Notification: { isSupported: () => false },
          projects: {
            getProject: () => ({
              name: "proj", channel_id: "CA",
              items: [{ id: "A", name: "Item A", artists: [{ artist_id: "U1" }], files: [], replies: [] }],
            }),
            addLog: () => {},
            isManagedFile: () => true,
            listArtistPresets: () => [],
            listItemReactions: () => [],
            getArtistAssignModes: () => ({ mention: true, react: false }),
          },
          currentToken: () => "MOCK", threadKey: (_p, id) => id, confirmLegacyThread: async () => {}, openSlack: () => {}, autoOpenSlack: () => {}, replyToPost: () => null,
          reconcileItemStatusState: async () => {},
          slack: {
            ensureRoot: async ({ threadKey: key }) => ({ threadTs: `${key}.ts`, isNew: true }),
            syncAssignMessage: async (args) => syncCalls.push(args),
            addReaction: async () => {},
            sendReplies: async () => ({ permalink: undefined }),
          },
          hbStatus: {
            estimateSendMinutes: () => 1, postStatus: async () => {},
            countSendWork: ({ targets }) => ({ items: targets.length, assigns: 0, replies: 0, files: 0, total: targets.length }),
            countItemWork: () => ({ items: 1, assigns: 0, replies: 0, files: 0 }),
            postJobStatus: async () => ({ channelId: "C", ts: "1" }), updateJobStatus: async () => {},
            formatJobStart: () => "start", formatJobHeader: () => "header", formatJobDone: () => "done", createProgressEditor: () => async () => {},
          },
        };
        vm.runInNewContext(block, context);
        return { invoke: () => handler({ sender: { isDestroyed: () => false, send: () => {} } }, { projectId: "P", itemIds: ["A"], scope }), syncCalls };
      }
      for (const scope of ["item", "replies"]) {
        const { invoke, syncCalls } = makeContext(scope);
        await invoke();
        assert.equal(syncCalls.length, 1, `scope ${scope} harusnya tetap manggil syncAssignMessage`);
        assert.deepEqual(syncCalls[0].artistIds, ["U1"]); // daftar artis TERKINI, bukan dikosongin paksa lagi
      }
    });

    await test("send:start fase post (poin revisi, bug ditemukan lewat audit D10) — reply.sent DI-SKIP dari payload, batch berikutnya TIDAK ngirim ulang field yang udah terkirim", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/handle\("send:start",[\s\S]*?\n\}\);/)[0];
      const sendRepliesCalls = [];
      let handler;
      const context = {
        activeSend: null, cancelRequested: false, require: nativeRequire, handle: (_name, fn) => { handler = fn; },
        Notification: { isSupported: () => false },
        projects: {
          getProject: () => ({
            name: "proj", channel_id: "CA",
            items: [{
              id: "A", name: "Item A", artists: [], files: [],
              replies: [
                { id: "R-OLD", title: "Old", text_value: "sudah terkirim", sort_order: 0, files: [], sent: true },
                { id: "R-NEW", title: "New", text_value: "field baru", sort_order: 1, files: [], sent: false },
              ],
            }],
          }),
          addLog: () => {},
          isManagedFile: () => true,
          listArtistPresets: () => [],
          listItemReactions: () => [],
          getArtistAssignModes: () => ({ mention: false, react: false }),
          markReplySent: () => {},
        },
        currentToken: () => "MOCK", threadKey: (_p, id) => id, confirmLegacyThread: async () => {}, openSlack: () => {}, autoOpenSlack: () => {},
        reconcileItemStatusState: async () => {},
        replyToPost: (reply) => (reply.text_value ? { text: reply.text_value } : null),
        slack: {
          ensureRoot: async ({ threadKey: key }) => ({ threadTs: `${key}.ts`, isNew: true }),
          syncAssignMessage: async () => {},
          addReaction: async () => {},
          sendReplies: async (args) => { sendRepliesCalls.push(args); return { permalink: undefined }; },
        },
        hbStatus: {
          estimateSendMinutes: () => 1, postStatus: async () => {},
          countSendWork: ({ targets }) => ({ items: targets.length, assigns: 0, replies: 0, files: 0, total: targets.length }),
          countItemWork: () => ({ items: 1, assigns: 0, replies: 0, files: 0 }),
          postJobStatus: async () => ({ channelId: "C", ts: "1" }), updateJobStatus: async () => {},
          formatJobStart: () => "start", formatJobHeader: () => "header", formatJobDone: () => "done", createProgressEditor: () => async () => {},
        },
      };
      vm.runInNewContext(block, context);
      await handler({ sender: { isDestroyed: () => false, send: () => {} } }, { projectId: "P", itemIds: ["A"], scope: "replies" });
      assert.equal(sendRepliesCalls.length, 1);
      // Cuma R-NEW yang keikut, R-OLD (sudah sent) di-skip -- payload asli sebelum fix ini nyertain
      // DUA-duanya, "sudah terkirim" bakal ke-post DOBEL tiap batch berikutnya.
      assert.equal(sendRepliesCalls[0].posts.length, 1);
      assert.equal(sendRepliesCalls[0].posts[0].text, "field baru");
    });
    await test("send:start fase post mempertahankan urutan dan tidak mengirim field setelah field yang gagal", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/handle\("send:start",[\s\S]*?\n\}\);/)[0];
      const sendRepliesCalls = [];
      const markedSent = [];
      let handler;
      const context = {
        activeSend: null, cancelRequested: false, require: nativeRequire, handle: (_name, fn) => { handler = fn; },
        Notification: { isSupported: () => false },
        projects: {
          getProject: () => ({
            name: "proj", channel_id: "CA",
            items: [{
              id: "A", name: "Item A", artists: [], files: [],
              // Simulasi hasil mergeItems >10 file: 2 reply kategori sama, field-1 (primary) 10
              // file, field-2 (overflow hasil pecahan) 10 file lain.
              replies: [
                { id: "R-1", title: "Referensi", text_value: null, sort_order: 0, files: [], sent: false },
                { id: "R-2", title: "Referensi", text_value: null, sort_order: 1, files: [], sent: false },
                { id: "R-3", title: "Referensi", text_value: null, sort_order: 2, files: [], sent: false },
              ],
            }],
          }),
          addLog: () => {},
          isManagedFile: () => true,
          listArtistPresets: () => [],
          listItemReactions: () => [],
          getArtistAssignModes: () => ({ mention: false, react: false }),
          markReplySent: (id) => markedSent.push(id),
        },
        currentToken: () => "MOCK", threadKey: (_p, id) => id, confirmLegacyThread: async () => {}, openSlack: () => {}, autoOpenSlack: () => {},
        reconcileItemStatusState: async () => {},
        replyToPost: (reply) => ({ text: reply.title }),
        slack: {
          ensureRoot: async ({ threadKey: key }) => ({ threadTs: `${key}.ts`, isNew: true }),
          syncAssignMessage: async () => {},
          addReaction: async () => {},
          // Field-2 (overflow) GAGAL (mis. upload file gede kena error transient) -- field-1
          // (primary) SUKSES. Versi lama: 1 panggilan sendReplies isi 2 post, gagal di post ke-2
          // = seluruh panggilan throw SEBELUM markReplySent kepanggil sama sekali (field-1 yang
          // SEBENARNYA sukses pun gak ke-lock, attempt row nyangkut ngeblok RETRY field-2 lewat
          // Instant Intake juga -- gak ada bedanya field mana yang "digembok").
          sendReplies: async (args) => {
            sendRepliesCalls.push(args);
            if (args.threadKey.includes("R-2")) throw new Error("upload gagal (simulasi network)");
            return { permalink: undefined };
          },
        },
        hbStatus: {
          estimateSendMinutes: () => 1, postStatus: async () => {},
          countSendWork: ({ targets }) => ({ items: targets.length, assigns: 0, replies: 0, files: 0, total: targets.length }),
          countItemWork: () => ({ items: 1, assigns: 0, replies: 0, files: 0 }),
          postJobStatus: async () => ({ channelId: "C", ts: "1" }), updateJobStatus: async () => {},
          formatJobStart: () => "start", formatJobHeader: () => "header", formatJobDone: () => "done", createProgressEditor: () => async () => {},
        },
      };
      vm.runInNewContext(block, context);
      const { results } = await handler({ sender: { isDestroyed: () => false, send: () => {} } }, { projectId: "P", itemIds: ["A"], scope: "replies" });

      // Field-1 (independen dari field-2) TETAP dicoba dan SUKSES -- panggilan sendReplies buat
      // dua-duanya kejadian (bukan berhenti begitu field-2 doang yang mock-nya gagal, order
      // gak masalah karena tiap field independen -- gak ada yang ke-skip diam-diam).
      assert.equal(sendRepliesCalls.length, 2);
      // `threadKey` di-namespace per-field (bukan 1 key polos punya item) -- attempt/resume
      // state-nya kepisah, field-2 yang gagal gak nyangkut ngeblok field-1 ATAU field lain.
      assert.ok(sendRepliesCalls.some((c) => c.threadKey === "A#reply:R-1"));
      assert.ok(sendRepliesCalls.some((c) => c.threadKey === "A#reply:R-2"));
      assert.ok(!sendRepliesCalls.some((c) => c.threadKey === "A#reply:R-3"));
      // Cuma field yang BENERAN sukses (R-1) yang di-lock -- field yang gagal (R-2) TETAP
      // kebuka, bisa dicoba lagi lewat Instant Intake tanpa perlu "buka gembok" dulu (belum
      // pernah ke-gembok dari awal, konsisten sama "field yang digembok = benar-benar terkirim").
      assert.deepEqual(markedSent, ["R-1"]);
      // Item tetap ditandai gagal di ringkasan (field-2 emang beneran gagal), tapi field-1 udah
      // aman ke-lock -- gak ke-anggap "gagal semua" padahal sebagian sukses.
      assert.equal(results.find((r) => r.itemId === "A").status, "gagal");
    });
    await test("adminAccess.isOwner (poin revisi, sistem Admin/Member) — cocokin email case-insensitive, null/undefined aman (false, gak throw)", () => {
      const admin = load("electron/adminAccess.cjs", {});
      assert.equal(admin.isOwner("diyanhejak@gmail.com"), true);
      assert.equal(admin.isOwner("DiyanHejak@Gmail.com"), true); // case-insensitive
      assert.equal(admin.isOwner("orang-lain@gmail.com"), false);
      assert.equal(admin.isOwner(null), false);
      assert.equal(admin.isOwner(undefined), false);
      assert.equal(admin.isOwner(""), false);
    });
    await test("adminAccess.findAdminChannel/isAdminMember (poin revisi) — ketemu di listChannels() SENDIRI = member (channel privat cuma nongol ke member, Slack yang jamin), cache SEKALI per proses sampai invalidateCache", async () => {
      const admin = load("electron/adminAccess.cjs", {});
      let listCalls = 0;
      const memberSlack = { listChannels: async () => { listCalls++; return [{ id: "C-ADM", name: admin.ADMIN_CHANNEL_NAME, isPrivate: true }]; } };
      assert.equal(await admin.isAdminMember(memberSlack, "TOKEN"), true);
      assert.equal(await admin.isAdminMember(memberSlack, "TOKEN"), true);
      assert.equal(listCalls, 1); // cache -- gak scan ulang tiap panggilan

      admin.invalidateCache();
      const nonMemberSlack = { listChannels: async () => { listCalls++; return [{ id: "C-OTHER", name: "bukan-admin", isPrivate: true }]; } };
      assert.equal(await admin.isAdminMember(nonMemberSlack, "TOKEN"), false);
      assert.equal(await admin.isAdminMember(nonMemberSlack, "TOKEN"), false);
      assert.equal(listCalls, 2); // +1 doang abis invalidate -- panggilan ke-2 kena negative-cache (scanned=true), gak scan ulang
    });
    await test("adminAccess.findAdminChannel (poin revisi, bug ditemukan lewat audit D05/D06) — channel PUBLIK bernama sama TETAP ditolak (harus isPrivate), kegagalan network TIDAK di-cache (dicoba lagi panggilan berikutnya)", async () => {
      const admin = load("electron/adminAccess.cjs", {});
      // D05 — publik dengan nama sama SENGAJA ditolak, walau namanya cocok persis.
      const publicSameName = { listChannels: async () => [{ id: "C-PUBLIC", name: admin.ADMIN_CHANNEL_NAME, isPrivate: false }] };
      assert.equal(await admin.isAdminMember(publicSameName, "TOKEN"), false);

      // D06 — gagal (network/API) BUKAN cache negatif permanen, beda dari "sukses tapi gak ketemu".
      admin.invalidateCache();
      let attempt = 0;
      const flaky = { listChannels: async () => { attempt++; if (attempt === 1) throw new Error("offline"); return [{ id: "C-ADM", name: admin.ADMIN_CHANNEL_NAME, isPrivate: true }]; } };
      assert.equal(await admin.isAdminMember(flaky, "TOKEN"), false); // percobaan 1 gagal -- gak ke-cache
      assert.equal(await admin.isAdminMember(flaky, "TOKEN"), true); // percobaan 2 (network pulih) -- BENERAN discan ulang, ketemu
      assert.equal(attempt, 2);
    });
    await test("requireAdminMember (poin revisi, bug ditemukan lewat audit D08) — dipanggil di AWAL slackSocket:setToken&clearToken/keywordAutomation:setEnabled&save&remove (verifikasi manual di source), TAPI TIDAK di artistRealtimeAssign:set (poin revisi lanjutan, diminta user — toggle Realtime Sync dibuka buat SEMUA user, bukan admin-member doang), fungsi guard-nya sendiri TOLAK non-admin-member, LOLOS admin-member", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/async function requireAdminMember\(\)[\s\S]*?\n\}/)[0];
      // Poin revisi (audit D08) — pastiin KELIMA handler yang seharusnya digate BENERAN manggil
      // requireAdminMember() di baris pertama badan fungsinya, bukan cuma fungsi guard-nya doang
      // yang bener tapi lupa dipasang di salah satu handler.
      for (const handlerName of ["slackSocket:setToken", "slackSocket:clearToken", "keywordAutomation:setEnabled", "keywordAutomation:save", "keywordAutomation:remove"]) {
        const handlerBlock = source.match(new RegExp(`handle\\("${handlerName.replace(":", "\\:")}",[\\s\\S]*?\\n\\}\\);`))[0];
        assert.ok(handlerBlock.includes("requireAdminMember()"), `${handlerName} harusnya manggil requireAdminMember()`);
      }
      // artistRealtimeAssign:set SENGAJA TIDAK digate -- pastiin gak ada yang nge-reintroduce guard
      // ini tanpa sadar (mis. copy-paste dari handler lain).
      const realtimeSetBlock = source.match(/handle\("artistRealtimeAssign:set",[\s\S]*?\n\}\);/)[0];
      assert.ok(!realtimeSetBlock.includes("requireAdminMember()"), "artistRealtimeAssign:set harusnya TIDAK digate admin lagi");

      let allowed = false;
      const context = {
        currentToken: () => "MOCK",
        adminAccess: { isAdminMember: async (_slack, token) => token === "MOCK" && allowed },
        slack: {},
      };
      vm.runInNewContext(block, context);
      await assert.rejects(context.requireAdminMember(), /cuma buat member channel admin/);
      allowed = true;
      await context.requireAdminMember(); // gak throw
    });
    await test("auth:login & auth:logout (poin revisi, bug ditemukan lewat audit D18) — keduanya manggil adminAccess.invalidateCache(), biar cache admin-member gak nempel ke akun BERIKUTNYA yang login di proses app yang sama", () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const loginBlock = source.match(/handle\("auth:login",[\s\S]*?\n\}\);/)[0];
      const logoutBlock = source.match(/handle\("auth:logout",[\s\S]*?\n\}\);/)[0];
      assert.ok(loginBlock.includes("adminAccess.invalidateCache()"), "auth:login harusnya manggil adminAccess.invalidateCache()");
      assert.ok(logoutBlock.includes("adminAccess.invalidateCache()"), "auth:logout harusnya manggil adminAccess.invalidateCache()");
    });
    await test("admin:getStatus & requireOwner (poin revisi, sistem Admin/Member) — isOwner murni lokal (cocokin email token tersimpan), admin:addMember/removeMember/listChannelMembers TOLAK non-owner walau dipanggil IPC langsung", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/handle\("admin:getStatus",[\s\S]*?handle\("admin:removeMember",[\s\S]*?\n\}\);/)[0];
      const handlers = {};
      let savedToken = { email: "diyanhejak@gmail.com" };
      const inviteCalls = [];
      const context = {
        require: nativeRequire,
        handle: (name, fn) => { handlers[name] = fn; },
        currentToken: () => "MOCK",
        authStore: { loadToken: () => savedToken },
        adminAccess: load("electron/adminAccess.cjs", {}),
        projects: { listCachedSlackUsers: () => [{ id: "U1", name: "Diyan" }] },
        slack: {
          listChannels: async () => [{ id: "C-ADM", name: "hb-adm", isPrivate: true }],
          createPrivateChannel: async () => { throw new Error("harusnya gak sampai bikin channel baru, udah ada"); },
          getChannelMembers: async () => ["U1"],
          listUsers: async () => [{ id: "U1", name: "Diyan" }],
          inviteToChannel: async (args) => inviteCalls.push(args),
          removeFromChannel: async (args) => inviteCalls.push(args),
        },
      };
      vm.runInNewContext(block, context);

      // Owner: semua lolos.
      const status = await handlers["admin:getStatus"]();
      assert.equal(status.isOwner, true);
      assert.equal(status.isAdminMember, true);
      const listed = await handlers["admin:listChannelMembers"]();
      assert.deepEqual(listed.members.map((m) => m.name), ["Diyan"]);
      await handlers["admin:addMember"]({}, "U2");
      assert.ok(inviteCalls.some((c) => c.userId === "U2"));
      await handlers["admin:removeMember"]({}, "U2");

      // Bukan owner: SEMUA admin:* selain getStatus HARUS ditolak, walau dipanggil langsung.
      savedToken = { email: "bukan-owner@gmail.com" };
      const status2 = await handlers["admin:getStatus"]();
      assert.equal(status2.isOwner, false);
      assert.equal(status2.isAdminMember, true); // isAdminMember gak peduli owner, cuma soal member channel
      await assert.rejects(handlers["admin:listChannelMembers"](), /Cuma owner/);
      await assert.rejects(handlers["admin:addMember"]({}, "U3"), /Cuma owner/);
      await assert.rejects(handlers["admin:removeMember"]({}, "U3"), /Cuma owner/);
    });
    await test("OAuth ignores wrong-state callbacks and finishes the legitimate callback", async () => {
      let authorizeUrl;
      const oauth = load("electron/slack.cjs", { "./db.cjs": dbModule, "@slack/web-api": { WebClient: MockSlack } });
      const promise = oauth.loginWithBrowser({ clientId: "fake", redirectUri: "slackintakeapps://callback" }, (url) => { authorizeUrl = url; });
      await Promise.resolve(); await Promise.resolve();
      // A callback with the wrong state (e.g. a stray/foreign deep-link) must be ignored, not
      // cancel the legitimate login still in flight.
      await oauth.completeLoginFromUrl("slackintakeapps://callback?state=wrong&error=denied");
      const state = new URL(authorizeUrl).searchParams.get("state");
      const rejected = assert.rejects(promise, /denied/);
      await oauth.completeLoginFromUrl("slackintakeapps://callback?state=" + state + "&error=denied");
      await rejected;
    });

    await test("login uses PKCE and never sends a client secret to Slack", async () => {
      const crypto = require("node:crypto");
      let authorizeUrl2;
      const oauth2 = load("electron/slack.cjs", { "./db.cjs": dbModule, "@slack/web-api": { WebClient: MockSlack } });
      // Passing clientSecret here (like a stale caller would) must be a no-op — the function
      // signature no longer reads it, and it must never reach Slack's token endpoint.
      const promise2 = oauth2.loginWithBrowser({ clientId: "fake", clientSecret: "should-be-ignored", redirectUri: "slackintakeapps://callback" }, (url) => { authorizeUrl2 = url; });
      await Promise.resolve(); await Promise.resolve();
      const url = new URL(authorizeUrl2);
      const challenge = url.searchParams.get("code_challenge");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.ok(challenge && challenge.length >= 43);
      assert.equal(authorizeUrl2.includes("client_secret"), false);
      const state2 = url.searchParams.get("state");
      const before = oauthAccessCalls.length;
      await oauth2.completeLoginFromUrl("slackintakeapps://callback?state=" + state2 + "&code=fake-code");
      await promise2;
      const sent = oauthAccessCalls[oauthAccessCalls.length - 1];
      assert.equal(oauthAccessCalls.length, before + 1);
      assert.equal("client_secret" in sent, false);
      assert.equal(typeof sent.code_verifier, "string");
      // The verifier Slack received must actually match the challenge published on the
      // authorize URL (S256), not just be present.
      assert.equal(crypto.createHash("sha256").update(sent.code_verifier).digest("base64url"), challenge);
    });
    await test("completeLoginFromUrl (poin revisi, auto-refresh) nangkep refresh_token & expires_in kalau ada", async () => {
      const oauth3 = load("electron/slack.cjs", { "./db.cjs": dbModule, "@slack/web-api": { WebClient: MockSlack } });
      let authorizeUrl3;
      const promise3 = oauth3.loginWithBrowser({ clientId: "fake", redirectUri: "slackintakeapps://callback" }, (url) => { authorizeUrl3 = url; });
      await Promise.resolve(); await Promise.resolve();
      const state3 = new URL(authorizeUrl3).searchParams.get("state");
      const before = Date.now();
      await oauth3.completeLoginFromUrl("slackintakeapps://callback?state=" + state3 + "&code=fake-code");
      const info = await promise3;
      assert.equal(info.refreshToken, "rt-initial");
      // expiresAt = Date.now() pas login + expires_in(43200s)*1000 -- rentang longgar biar gak flaky.
      assert.ok(info.expiresAt >= before + 43200 * 1000 && info.expiresAt <= Date.now() + 43200 * 1000 + 5000);
    });
    await test("slack.refreshAccessToken (poin revisi) tukar refresh_token jadi access_token baru, tanpa client_secret", async () => {
      const oauth4 = load("electron/slack.cjs", { "./db.cjs": dbModule, "@slack/web-api": { WebClient: MockSlack } });
      const before = oauthAccessCalls.length;
      const refreshed = await oauth4.refreshAccessToken({ clientId: "fake", refreshToken: "rt-old" });
      assert.equal(refreshed.accessToken, "xoxp-refreshed-rt-old");
      assert.equal(refreshed.refreshToken, "rt-new");
      assert.ok(refreshed.expiresAt > Date.now());
      const sent = oauthAccessCalls[oauthAccessCalls.length - 1];
      assert.equal(oauthAccessCalls.length, before + 1);
      assert.equal(sent.grant_type, "refresh_token");
      assert.equal(sent.refresh_token, "rt-old");
      assert.equal("client_secret" in sent, false); // PKCE public client -- gak pernah kirim secret
      // Gagal (gak ada refresh_token/clientId) -- lempar error yang jelas, bukan crash mentah.
      await assert.rejects(oauth4.refreshAccessToken({ clientId: "fake", refreshToken: "" }), /login ulang/);
    });

    await test("mergeItems (poin revisi, diminta user) — diblok total pas project.phase 'input' (item udah kekirim, resiko pesan Slack yatim), tetap boleh pas 'setup'", () => {
      const mp = projects.createProject({ name: "merge-phase-gate", channelId: "CA", channelName: "test" });
      const one = projects.addItem(mp.id, { name: "one" }), two = projects.addItem(mp.id, { name: "two" });
      // Kasih thread ke SEMUA item biar bisa masuk tahap Input (syarat setProjectPhase).
      for (const id of [one, two]) {
        const key = JSON.stringify(["T-TEST", "U-TEST", mp.id, id]);
        db.prepare(`INSERT INTO threads (item_name, channel_id, thread_ts, updated_at) VALUES (?, ?, ?, ?)`).run(key, "CA", `${id}.000`, new Date().toISOString());
      }
      projects.setProjectPhase(mp.id, "input");
      assert.throws(() => projects.mergeItems([one, two]), /Merge gak bisa dipakai lagi/);
      assert.equal(projects.getProject(mp.id).items.length, 2); // gagal -- gak ada yang kehapus
    });
    await test("merge koma: suffix angka diurutkan numerik dan prefix yang sama hanya ditulis sekali", () => {
      const mp = projects.createProject({ name: "merge-comma-name", channelId: "CA", channelName: "test" });
      const ids = ["BF44_010", "BF44_001", "BF44_005", "BF44_002"].map((name) => projects.addItem(mp.id, { name }));
      const merged = projects.mergeItems(ids, ", ");
      assert.equal(projects.getProject(mp.id).items.find((i) => i.id === merged.keepId).name, "BF44_001, 002, 005, 010");

      const mixed = projects.createProject({ name: "merge-comma-mixed", channelId: "CA", channelName: "test" });
      const mixedIds = ["BF44_010", "BG20_002"].map((name) => projects.addItem(mixed.id, { name }));
      const mixedMerged = projects.mergeItems(mixedIds, ", ");
      assert.equal(projects.getProject(mixed.id).items.find((i) => i.id === mixedMerged.keepId).name, "BF44_010, BG20_002");
    });
    await test("merge memecah reply gabungan yang lewat 10 file jadi reply baru (poin revisi)", () => {
      const mp = projects.createProject({ name: "merge-cap", channelId: "CA", channelName: "test" });
      const one = projects.addItem(mp.id, { name: "one" }), two = projects.addItem(mp.id, { name: "two" });
      const makeFiles = (n, prefix) => Array.from({ length: n }, (_, i) => {
        const p = path.join(temp, `${prefix}-${i}.txt`); fs.writeFileSync(p, "x"); return p;
      });
      // Judul SAMA -> category sama -> ke-konsolidasi jadi 1 reply pas merge (6 + 7 = 13 file).
      projects.addReplyWithFiles(one, { title: "Reference", filePaths: makeFiles(6, "one") });
      projects.addReplyWithFiles(two, { title: "Reference", filePaths: makeFiles(7, "two") });
      const merged = projects.mergeItems([one, two]);
      const item = projects.getProject(mp.id).items.find((i) => i.id === merged.keepId);
      const refReplies = item.replies.filter((r) => r.category === "Reference");
      assert.equal(refReplies.length, 2); // 13 file -> 10 + 3, dipecah jadi 2 reply
      assert.ok(refReplies.every((r) => r.files.length <= 10));
      assert.deepEqual(refReplies.map((r) => r.files.length).sort((a, b) => b - a), [10, 3]);
      assert.equal(refReplies.reduce((n, r) => n + r.files.length, 0), 13); // gak ada file ilang
      // Unmerge balikin ke state asli (2 reply terpisah, 6 & 7 file) -- reply hasil split
      // ke-cleanup total, bukan nyangkut.
      projects.unmergeItems(merged.snapshot);
      const restored = projects.getProject(mp.id);
      assert.equal(restored.items.find((i) => i.id === one).replies.find((r) => r.category === "Reference").files.length, 6);
      assert.equal(restored.items.find((i) => i.id === two).replies.find((r) => r.category === "Reference").files.length, 7);
    });
    await test("merge dedup file (nama sama) dan teks (100% identik) dalam 1 field, gak numpuk dobel (poin revisi)", () => {
      const mp = projects.createProject({ name: "merge-dedup", channelId: "CA", channelName: "test" });
      const one = projects.addItem(mp.id, { name: "one" }), two = projects.addItem(mp.id, { name: "two" });
      const shared = path.join(temp, "dedup-shared.txt"); fs.writeFileSync(shared, "x");
      const onlyOne = path.join(temp, "dedup-only-one.txt"); fs.writeFileSync(onlyOne, "x");
      // Judul sama -> 1 category -> konsolidasi. "shared.txt" muncul di DUA item (nama sama),
      // teks "Catatan sama" 100% identik di dua-duanya juga.
      projects.addReplyWithFiles(one, { title: "Ref", textValue: "Catatan sama", filePaths: [shared, onlyOne] });
      projects.addReplyWithFiles(two, { title: "Ref", textValue: "Catatan sama", filePaths: [shared] });
      const merged = projects.mergeItems([one, two]);
      const item = projects.getProject(mp.id).items.find((i) => i.id === merged.keepId);
      const refReplies = item.replies.filter((r) => r.category === "Ref");
      assert.equal(refReplies.length, 1);
      // 2 file unik (shared cuma sekali walau nunjuk di 2 item asal), bukan 3.
      assert.equal(refReplies[0].files.length, 2);
      assert.deepEqual(refReplies[0].files.map((f) => f.original_name).sort(), ["dedup-only-one.txt", "dedup-shared.txt"]);
      // Teks cuma sekali walau muncul di 2 reply sumber, bukan "Catatan sama\nCatatan sama".
      assert.equal(refReplies[0].text_value, "Catatan sama");
    });
    await test("merge: reply overflow (hasil split >10 file) nempel PERSIS di bawah primary-nya, bukan numpuk di ujung urutan (bug dilaporkan)", () => {
      const mp = projects.createProject({ name: "merge-order", channelId: "CA", channelName: "test" });
      const one = projects.addItem(mp.id, { name: "one" }), two = projects.addItem(mp.id, { name: "two" });
      const makeFiles = (n, prefix) => Array.from({ length: n }, (_, i) => {
        const p = path.join(temp, `${prefix}-${i}.txt`); fs.writeFileSync(p, "x"); return p;
      });
      // one: Animatic(sort0, 6 file) lalu General Note(sort1, teks) -- urutan ASLI item "keep".
      projects.addReplyWithFiles(one, { title: "Animatic", filePaths: makeFiles(6, "ord-one") });
      projects.addReplyWithFiles(one, { title: "General Note", textValue: "catatan umum" });
      // two: Animatic(7 file) -- gabung ke Animatic punya "one" (6+7=13 file, lewat batas 10,
      // ke-split jadi reply baru "Animatic" ke-2).
      projects.addReplyWithFiles(two, { title: "Animatic", filePaths: makeFiles(7, "ord-two") });
      const merged = projects.mergeItems([one, two]);
      const item = projects.getProject(mp.id).items.find((i) => i.id === merged.keepId);
      // Benar: Animatic, Animatic, General Note (2 Animatic NEMPEL, bukan kepisah sama General
      // Note di tengah — itu bug-nya: nextSortOrder lama numpuk overflow di ujung GLOBAL).
      assert.deepEqual(item.replies.map((r) => r.category), ["Animatic", "Animatic", "General Note"]);
      assert.deepEqual(item.replies.map((r) => r.sort_order), [0, 1, 2]);
      assert.equal(item.replies[2].text_value, "catatan umum");
    });
    await test("hbStatus.findStatusChannel cari channel by nama, cache hasil, gak scan ulang", async () => {
      const hb = load("electron/hbStatus.cjs", {});
      let listCalls = 0;
      const mockSlack = { listChannels: async () => { listCalls++; return [{ id: "C-OTHER", name: "random" }, { id: "C-STATUS", name: hb.STATUS_CHANNEL_NAME }]; } };
      assert.equal(await hb.findStatusChannel(mockSlack, "TOKEN"), "C-STATUS");
      assert.equal(await hb.findStatusChannel(mockSlack, "TOKEN"), "C-STATUS");
      assert.equal(listCalls, 1); // cache -- cuma scan sekali per proses
    });
    await test("hbStatus.findStatusChannel/postStatus best-effort kalau channel gak ketemu (gak throw)", async () => {
      const hb = load("electron/hbStatus.cjs", {});
      let listCalls = 0;
      const mockSlack = {
        listChannels: async () => { listCalls++; return [{ id: "C-OTHER", name: "bukan-status" }]; },
        postSimpleMessage: async () => { throw new Error("harusnya gak sampai sini, channel gak ketemu"); },
      };
      assert.equal(await hb.findStatusChannel(mockSlack, "TOKEN"), null);
      await hb.postStatus(mockSlack, "TOKEN", "test"); // gak boleh throw walau channel gak ketemu
      assert.equal(await hb.findStatusChannel(mockSlack, "TOKEN"), null);
      assert.equal(listCalls, 1); // gak scan ulang terus-terusan walau gagal ketemu
    });
    await test("hbStatus.postStatus best-effort kalau postSimpleMessage gagal (gak throw)", async () => {
      const hb = load("electron/hbStatus.cjs", {});
      const mockSlack = {
        listChannels: async () => [{ id: "C-STATUS", name: hb.STATUS_CHANNEL_NAME }],
        postSimpleMessage: async () => { throw new Error("network error"); },
      };
      await hb.postStatus(mockSlack, "TOKEN", "test"); // gak boleh throw -- status gak boleh nge-block alur utama
    });
    await test("hbStatus:goOnline (poin revisi, diminta user) — \"Mulai Sesi\" auto-buka Slack ke channel status hb-apps abis post Online", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8").replace(/\r\n/g, "\n");
      const block = source.match(/handle\("hbStatus:goOnline",[\s\S]*?\n\}\);/)[0];
      const postStatusCalls = [];
      const openSlackCalls = [];
      let handler;
      const context = {
        require: nativeRequire,
        handle: (_name, fn) => { handler = fn; },
        currentToken: () => "MOCK",
        openSlack: (args) => openSlackCalls.push(args), autoOpenSlack: (args) => openSlackCalls.push(args),
        hbStatus: {
          postStatus: async (_slack, token, text) => { postStatusCalls.push({ token, text }); },
          findStatusChannel: async () => "C-HBAPPS",
        },
        slack: {},
      };
      vm.runInNewContext(block, context);
      await handler();
      assert.equal(postStatusCalls.length, 1);
      assert.equal(openSlackCalls.length, 1);
      assert.equal(openSlackCalls[0].channelId, "C-HBAPPS");
    });
    await test("hbStatus.estimateSendMinutes ngitung sesuai pacing 4-fase (root+mention+react+post)", () => {
      const hb = load("electron/hbStatus.cjs", {});
      const mockProjects = { listItemReactions: (itemId) => (itemId === "A" ? [{ id: "R1", slack_shortcode: "artis-a" }] : []) };
      const presetByMember = new Map([["U1", { code_name: "artis-a" }]]);
      const targets = [
        { id: "A", artists: [{ artist_id: "U1" }], files: [{ id: "f1" }], replies: [{ title: "Ref", text_value: "x", files: [] }] },
        { id: "B", artists: [], files: [], replies: [] },
      ];
      // A: root 1.1 + mention 1.1 + react-artis 1.2 + post (file+reply = 2 panggilan) 2.2 = 5.6
      // B: root 1.1 + mention 1.1 (poin revisi: syncAssignMessage SELALU post/update walau gak
      // ada artis -- placeholder -- jadi biayanya tetap kehitung, bukan di-skip pas artists kosong)
      const expectedSeconds = 1.1 + 1.1 + 1.2 + 2.2 + 1.1 + 1.1;
      assert.equal(hb.estimateSendMinutes({ targets, scope: undefined, assignModes: { mention: true, react: false }, presetByMember, projects: mockProjects }), Math.max(1, Math.ceil(expectedSeconds / 60)));
    });
    await test("hbStatus.estimateSendMinutes skala bener buat banyak item (bukan cuma kebetulan floor 1 menit)", () => {
      const hb = load("electron/hbStatus.cjs", {});
      const mockProjects = { listItemReactions: () => [] };
      const presetByMember = new Map();
      // 60 item, masing-masing root(1.1)+assignment/placeholder(1.1), ditambah buffer 15%.
      const targets = Array.from({ length: 60 }, (_, i) => ({ id: `I${i}`, artists: [{ artist_id: "U1" }], files: [], replies: [] }));
      assert.equal(hb.estimateSendMinutes({ targets, scope: undefined, assignModes: { mention: true, react: false }, presetByMember, projects: mockProjects }), 3);
      assert.equal(hb.estimateSendMinutes({ targets, scope: undefined, assignModes: { mention: false, react: false }, presetByMember, projects: mockProjects }), 3); // placeholder tetap butuh 1 API call/item
    });
    await test("hbStatus.estimateSendMinutes menghitung ukuran file, overhead, buffer, dan hanya attachment pending dalam scope", () => {
      const MB = 1024 * 1024;
      const sizes = new Map([["A", 100 * MB], ["B", 100 * MB], ["C", 100 * MB], ["OLD", 1000 * MB], ["DIRECT", 1000 * MB]]);
      const hb = load("electron/hbStatus.cjs", { "node:fs": { statSync: (filePath) => ({ isFile: () => true, size: sizes.get(filePath) }) } });
      const projectsWithoutPendingReactions = { listItemReactions: () => [{ slack_shortcode: "done", sent: 1 }] };
      const target = {
        id: "WITH-FILES", artists: [], files: [{ stored_path: "DIRECT" }],
        replies: [
          { title: "Animatic", text_value: "", sent: false, files: [{ stored_path: "A" }, { stored_path: "B" }, { stored_path: "C" }] },
          { title: "Lama", text_value: "", sent: true, files: [{ stored_path: "OLD" }] },
        ],
      };
      // Scope replies: root 1.1 + placeholder 1.1 + field 1.1 + transfer 300/5=60
      // + overhead 3*0.4=1.2; subtotal 64.5 * buffer 1.15 = 74.175 detik => 2 menit.
      assert.equal(hb.estimateSendMinutes({ targets: [target], scope: "replies", assignModes: { mention: false }, presetByMember: new Map(), projects: projectsWithoutPendingReactions }), 2);
      // Scope item tidak membawa DIRECT/reply mana pun, jadi ukuran file tidak ikut dihitung.
      assert.equal(hb.estimateSendMinutes({ targets: [target], scope: "item", assignModes: { mention: false }, presetByMember: new Map(), projects: projectsWithoutPendingReactions }), 1);
    });
    await test("hbStatus.estimateSendMinutes memakai fallback 25 MB jika metadata file tidak terbaca", () => {
      const hb = load("electron/hbStatus.cjs", { "node:fs": { statSync: () => { throw new Error("missing"); } } });
      const files = Array.from({ length: 10 }, (_, i) => ({ stored_path: `MISSING-${i}` }));
      const target = { id: "MISSING", artists: [], files: [], replies: [{ title: "Files", text_value: "", sent: false, files }] };
      assert.equal(hb.estimateSendMinutes({ targets: [target], scope: "replies", assignModes: { mention: false }, presetByMember: new Map(), projects: { listItemReactions: () => [] } }), 2);
    });
    await test("hbStatus.countSendWork menghitung item, artis nyata, reply pending, dan setiap file fisik", () => {
      const hb = load("electron/hbStatus.cjs", {});
      const targets = [{
        id: "A",
        artists: [{ artist_id: "U1" }, { artist_id: "U2" }],
        files: [{ id: "direct" }],
        replies: [
          { title: "Animatic", text_value: "", sent: false, files: Array.from({ length: 10 }, (_, i) => ({ id: `F${i}` })) },
          { title: "Catatan", text_value: "Revisi", sent: false, files: [] },
          { title: "Sudah", text_value: "", sent: true, files: [{ id: "OLD" }] },
          { title: "", text_value: "", sent: false, files: [] },
        ],
      }];
      assert.equal(JSON.stringify(hb.countSendWork({ targets, scope: undefined })), JSON.stringify({ items: 1, assigns: 2, replies: 2, files: 11, total: 16 }));
      assert.equal(JSON.stringify(hb.countSendWork({ targets, scope: "replies" })), JSON.stringify({ items: 1, assigns: 2, replies: 2, files: 10, total: 15 }));
      assert.equal(JSON.stringify(hb.countSendWork({ targets, scope: "item" })), JSON.stringify({ items: 1, assigns: 2, replies: 0, files: 0, total: 3 }));
    });
    await test("hbStatus.createProgressEditor (poin revisi, 1 pesan diedit berkala) — cuma ngedit di threshold 10/30/50/70/90/95, bukan tiap step", async () => {
      const hb = load("electron/hbStatus.cjs", {});
      const updateCalls = [];
      const mockSlack = { updateSimpleMessage: async (args) => updateCalls.push(args) };
      const handle = { channelId: "C-STATUS", ts: "1.000" };
      // 20 step total -- threshold 10% = step 2, 30% = step 6, 50% = step 10, dst.
      const counts = { items: 5, assigns: 3, replies: 4, files: 8, total: 20 };
      const step = hb.createProgressEditor({ slack: mockSlack, token: "TOKEN", handle, counts, estimateMinutes: 4 });
      for (let i = 0; i < 20; i++) await step();
      // Threshold [10,30,50,70,90,95] -- 6 kali edit TOTAL walau step-nya 20 kali, bukan 20 kali.
      assert.equal(updateCalls.length, 6);
      assert.ok(updateCalls[0].text.includes("10%"));
      assert.ok(updateCalls[5].text.includes("95%"));
      assert.ok(updateCalls[0].text.includes("Eksekusi"));
      assert.equal(updateCalls[0].ts, "1.000");
    });
    await test("hbStatus.createProgressEditor best-effort kalau handle null (post awal gagal) — gak throw", async () => {
      const hb = load("electron/hbStatus.cjs", {});
      const step = hb.createProgressEditor({ slack: { updateSimpleMessage: async () => { throw new Error("harusnya gak sampai sini"); } }, token: "TOKEN", handle: null, counts: { items: 1, assigns: 0, replies: 0, files: 0, total: 1 }, estimateMinutes: 1 });
      await step(); // gak boleh throw walau handle null (channelId/ts kosong)
    });
    await test("hbStatus.formatJobDone (poin revisi) nampilin nama item gagal dalam rangkuman kalau ada", () => {
      const hb = load("electron/hbStatus.cjs", {});
      const counts = { items: 3, assigns: 2, replies: 4, files: 25, total: 34 };
      const clean = hb.formatJobDone({ counts, okCount: 3, failedNames: [] });
      assert.ok(clean.includes("3/3 item berhasil"));
      assert.ok(clean.includes("File: 25"));
      assert.ok(!clean.includes("Gagal"));
      const withErrors = hb.formatJobDone({ counts, okCount: 2, failedNames: ["Item C"] });
      assert.ok(withErrors.includes("Gagal (1): Item C"));
    });
    await test("hbStatus.formatJobStart (poin revisi) — pesan paling awal cuma total job, gak ada pecahan \"0/N\"", () => {
      const hb = load("electron/hbStatus.cjs", {});
      const start = hb.formatJobStart({ counts: { items: 35, assigns: 18, replies: 3, files: 25, total: 81 }, estimateMinutes: 4 });
      assert.equal(start, ":arrow_forward: Eksekusi 81 job, estimasi 4 menit\nItem: 35 | Assign: 18 | Reply: 3 | File: 25");
    });
    await test("hbStatus.progressBar (poin revisi, bug: 95% keliatan sama kayak 100%) — presisi setengah blok (▌) buat persen yang gak abis dibagi 10", () => {
      const hb = load("electron/hbStatus.cjs", {});
      assert.equal(hb.progressBar(10), "█░░░░░░░░░");
      assert.equal(hb.progressBar(20), "██░░░░░░░░");
      assert.equal(hb.progressBar(90), "█████████░");
      assert.equal(hb.progressBar(95), "█████████▌"); // 9 penuh + setengah, BEDA dari 90% dan 100%
      assert.equal(hb.progressBar(100), "██████████");
    });
    await test("template application is atomic and undo preserves attachment bytes", () => {
      const tp = projects.createProject({ name: "template", channelId: "CA", channelName: "test" });
      const one = projects.addItem(tp.id, { name: "one" }), two = projects.addItem(tp.id, { name: "two" });
      const template = projects.saveTemplate({ name: "bad", fields: [{ label: "ok" }, { label: {} }] });
      assert.throws(() => projects.applyTemplate(tp.id, template));
      assert.equal(projects.getProject(tp.id).items.flatMap(i => i.replies).length, 0);
      const file = path.join(temp, "undo.txt"); fs.writeFileSync(file, "undo");
      projects.addItemFiles(two, [file]);
      const merged = projects.mergeItems([one, two]);
      const stored = projects.getProject(tp.id).items[0].files[0];
      projects.removeItemFile(stored.id);
      assert.equal(fs.existsSync(stored.stored_path), true);
      projects.unmergeItems(merged.snapshot);
      assert.equal(projects.getProject(tp.id).items.find(i => i.id === two).files[0].id, stored.id);
      projects.removeItem(two);
      projects.releaseUndo(tp.id);
      assert.equal(fs.existsSync(stored.stored_path), false);
    });
  } finally {
    db.close();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith("slack-intake-test-"));
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
