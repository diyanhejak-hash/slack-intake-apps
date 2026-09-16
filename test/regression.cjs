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
const oauthAccessCalls = [];
let failUpload = false;
let failPermalink = false;
let serial = 0;
class MockSlack {
  constructor() { this.userPage = 0; this.channelPage = 0; }
  chat = {
    postMessage: async (args) => { calls.push(args); return { ts: `${++serial}.000` }; },
    getPermalink: async () => { if (failPermalink) throw Error("mock permalink failure"); return { permalink: "https://example.invalid/thread" }; },
  };
  files = { uploadV2: async (args) => { for (const f of args.file_uploads || []) for await (const _ of f.file) {} if (failUpload) throw Error("mock upload failure"); } };
  oauth = { v2: { access: async (args) => { oauthAccessCalls.push(args); return { authed_user: { access_token: "xoxp-mock", id: "U-MOCK" }, team: { name: "Mock Team", id: "T-MOCK" } }; } } };
  users = {
    list: async () => (++this.userPage === 1
      ? { members: [{ id: "U1", name: "First" }], response_metadata: { next_cursor: "next" } }
      : { members: [{ id: "U2", name: "Second" }], response_metadata: { next_cursor: "" } }),
    conversations: async () => (++this.channelPage === 1
      ? { channels: [{ id: "CA", name: "First" }], response_metadata: { next_cursor: "next" } }
      : { channels: [{ id: "CB", name: "Second" }], response_metadata: { next_cursor: "" } }),
  };
}
const slack = load("electron/slack.cjs", { "./db.cjs": dbModule, "@slack/web-api": { WebClient: MockSlack } });
const send = (itemName, channelId, posts = []) => slack.sendItem({ token: "MOCK", itemName, threadKey: itemName, channelId, posts });

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
    await test("thread mappings remain independent per channel", async () => {
      const a = await send("same-name", "CA");
      const b = await send("same-name", "CB");
      assert.notEqual(a.threadTs, b.threadTs);
      assert.equal((await send("same-name", "CA")).threadTs, a.threadTs);
      assert.equal(db.prepare("SELECT count(*) AS n FROM threads WHERE item_name=?").get("same-name").n, 2);
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
    await test("malformed import leaves no partial project", () => {
      const before = projects.listProjects().length;
      assert.throws(() => projects.importProject({ formatVersion: 1, project: { name: "broken", channel_id: "CA", channel_name: "a", items: null } }));
      assert.equal(projects.listProjects().length, before);
    });
    await test("Slack lists consume every cursor page", async () => {
      assert.equal((await slack.listUsers("MOCK")).length, 2);
      assert.equal((await slack.listChannels("MOCK")).length, 2);
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
    await test("artist assign mode is a single global switch (poin revisi, bukan per-artis)", () => {
      // Default 'mention' (di-seed pas migrasi db.cjs).
      assert.equal(projects.getArtistAssignMode(), "mention");
      assert.equal(projects.setArtistAssignMode("both"), "both");
      assert.equal(projects.getArtistAssignMode(), "both");
      // Berlaku global -- gak ada konsep "per artis" lagi, cek 2 preset beda tetap baca nilai SAMA.
      const idA = projects.saveArtistPreset({ memberId: "U-GLOBAL-A", nickname: "A" });
      const idB = projects.saveArtistPreset({ memberId: "U-GLOBAL-B", nickname: "B" });
      assert.equal(projects.getArtistAssignMode(), "both");
      projects.removeArtistPreset(idA);
      projects.removeArtistPreset(idB);
      assert.throws(() => projects.setArtistAssignMode("bukan-mode-valid"), /Mode assign/);
      projects.setArtistAssignMode("mention"); // reset biar gak nyampur ke test lain.
    });
    await test("instant intake toggle is a single global switch, gak sentuh reaction pending", () => {
      // Default enabled (di-seed pas migrasi db.cjs).
      assert.equal(projects.getInstantIntakeEnabled(), true);
      assert.equal(projects.setInstantIntakeEnabled(false), false);
      assert.equal(projects.getInstantIntakeEnabled(), false);
      projects.setInstantIntakeEnabled(true); // reset biar gak nyampur ke test lain.
      assert.equal(projects.getInstantIntakeEnabled(), true);
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
    await test("ensureRoot & sendArtistMention (poin revisi 4-fase) idempoten, gak posting ulang", async () => {
      const before = calls.length;
      const r1 = await slack.ensureRoot({ token: "MOCK", channelId: "CA", itemName: "phase-item", threadKey: "phase-item" });
      assert.equal(r1.isNew, true);
      const r2 = await slack.ensureRoot({ token: "MOCK", channelId: "CA", itemName: "phase-item", threadKey: "phase-item" });
      assert.equal(r2.threadTs, r1.threadTs);
      assert.equal(r2.isNew, false);
      assert.equal(calls.filter((c) => c.text === "*phase-item*" && !c.thread_ts).length, 1);

      await slack.sendArtistMention({ token: "MOCK", channelId: "CA", threadKey: "phase-item", threadTs: r1.threadTs, artistId: "U1" });
      await slack.sendArtistMention({ token: "MOCK", channelId: "CA", threadKey: "phase-item", threadTs: r1.threadTs, artistId: "U1" });
      assert.equal(calls.filter((c) => c.text === "<@U1>" && c.thread_ts === r1.threadTs).length, 1);
      assert.equal(calls.length - before, 2); // 1x root + 1x mention, panggilan ke-2 dua-duanya no-op
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
    await test("quick-send holds its lock during await and releases it on rejection", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8");
      const quick = source.match(/handle\("send:quick",[\s\S]*?\n\}\);/)[0];
      let handler, finish;
      const context = { activeSend: null, require: nativeRequire, handle: (_name, fn) => { handler = fn; },
        projects: { getProject: () => ({ channel_id: "CA", items: [{ id: "I", name: "item", replies: [] }] }), addLog: () => {} },
        currentToken: () => "MOCK", threadKey: () => "key", confirmLegacyThread: async () => {}, openSlack: () => {}, replyToPost: () => null,
        slack: { findThreadChannel: () => null, sendItem: () => new Promise((_resolve, reject) => { finish = reject; }) } };
      vm.runInNewContext(quick, context);
      const first = handler({}, { projectId: "P", itemId: "I", scope: "item" });
      assert.ok(context.activeSend);
      await assert.rejects(handler({}, { projectId: "P", itemId: "I", scope: "item" }), /berjalan/);
      finish(Error("network")); await assert.rejects(first, /network/);
      assert.equal(context.activeSend, null);
    });
    await test("quick-send also flushes pending reactions after sendItem succeeds", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8");
      const quick = source.match(/handle\("send:quick",[\s\S]*?\n\}\);/)[0];
      const addedReactions = [];
      const removedIds = [];
      let handler;
      const context = {
        activeSend: null, require: nativeRequire, handle: (_name, fn) => { handler = fn; },
        projects: {
          getProject: () => ({ channel_id: "CA", items: [{ id: "I", name: "item", replies: [] }] }),
          addLog: () => {},
          listItemReactions: () => [{ id: "R1", slack_shortcode: "tada" }, { id: "R2", slack_shortcode: "fire" }],
          removeItemReaction: (id) => removedIds.push(id),
        },
        currentToken: () => "MOCK", threadKey: () => "key", confirmLegacyThread: async () => {}, openSlack: () => {}, replyToPost: () => null,
        slack: {
          findThreadChannel: () => null,
          // sendItem IDEMPOTEN (thread lama dipakai ulang kalau ada) -- test ini gak bedain
          // "pesan belum ada" vs "pesan udah ada", dua-duanya lewat sendItem yang sama; yang
          // dites di sini murni "reaction pending ikut ke-flush abis sendItem sukses".
          sendItem: async () => ({ threadTs: "1234.0001", isNew: true, permalink: undefined }),
          addReaction: async (args) => { addedReactions.push(args); },
        },
      };
      vm.runInNewContext(quick, context);
      await handler({}, { projectId: "P", itemId: "I", scope: "item" });
      assert.deepEqual(addedReactions.map((a) => a.name), ["tada", "fire"]);
      assert.ok(addedReactions.every((a) => a.channelId === "CA" && a.timestamp === "1234.0001"));
      assert.deepEqual(removedIds, ["R1", "R2"]);
    });
    await test("quick-send suppresses @mention when global artist assign mode is react-only", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8");
      const quick = source.match(/handle\("send:quick",[\s\S]*?\n\}\);/)[0];
      let sentArtistId = "unset";
      let handler;
      const context = {
        activeSend: null, require: nativeRequire, handle: (_name, fn) => { handler = fn; },
        projects: {
          getProject: () => ({ channel_id: "CA", items: [{ id: "I", name: "item", replies: [], artist_id: "U1" }] }),
          addLog: () => {},
          listItemReactions: () => [],
          removeItemReaction: () => {},
          // Mode Mention/React GLOBAL (poin revisi) -- send:quick lookup lewat ini, bukan
          // per-artis/per-item lagi.
          getArtistAssignMode: () => "react",
        },
        currentToken: () => "MOCK", threadKey: () => "key", confirmLegacyThread: async () => {}, openSlack: () => {}, replyToPost: () => null,
        slack: {
          findThreadChannel: () => null,
          sendItem: async (args) => { sentArtistId = args.artistId; return { threadTs: "1.000", isNew: true }; },
          addReaction: async () => {},
        },
      };
      vm.runInNewContext(quick, context);
      await handler({}, { projectId: "P", itemId: "I", scope: "artist" });
      // mode global "react" -> item.artist_id tetap dipakai buat validasi "ada artis ditugaskan"
      // (gak nge-throw), tapi TIDAK diteruskan ke sendItem (gak ada @mention di-post) -- assign
      // "react" beneran diberitahu lewat reaction (test terpisah di atas), bukan mention.
      assert.equal(sentArtistId, null);
    });
    await test("send:start (poin revisi 4-fase) kirim per-fase lintas semua item, item gagal di-skip fase berikutnya", async () => {
      const source = fs.readFileSync(path.join(appRoot, "electron/main.cjs"), "utf8");
      const block = source.match(/handle\("send:start",[\s\S]*?\n\}\);/)[0];
      const callLog = [];
      const reactionCalls = [];
      const removedReactionIds = [];
      const reactionsByItem = { A: [{ id: "RA", slack_shortcode: "artis-a" }, { id: "RX", slack_shortcode: "manual" }], B: [] };
      let handler;
      const context = {
        activeSend: null, cancelRequested: false, require: nativeRequire, handle: (_name, fn) => { handler = fn; },
        Notification: { isSupported: () => false },
        projects: {
          getProject: () => ({
            name: "proj", channel_id: "CA",
            items: [
              { id: "A", name: "Item A", artist_id: "U1", files: [], replies: [] },
              { id: "B", name: "Item B", artist_id: null, files: [], replies: [] },
            ],
          }),
          addLog: () => {},
          isManagedFile: () => true,
          listArtistPresets: () => [{ member_id: "U1", code_name: "artis-a" }],
          listItemReactions: (itemId) => reactionsByItem[itemId] || [],
          removeItemReaction: (id) => {
            removedReactionIds.push(id);
            for (const key of Object.keys(reactionsByItem)) reactionsByItem[key] = reactionsByItem[key].filter((r) => r.id !== id);
          },
          getArtistAssignMode: () => "both",
        },
        currentToken: () => "MOCK", threadKey: (_p, id) => id, confirmLegacyThread: async () => {}, openSlack: () => {}, replyToPost: () => null,
        slack: {
          ensureRoot: async ({ threadKey: key }) => {
            callLog.push(`root:${key}`);
            if (key === "B") throw new Error("root gagal buat B");
            return { threadTs: `${key}.ts`, isNew: true };
          },
          sendArtistMention: async ({ threadKey: key }) => { callLog.push(`artist:${key}`); },
          addReaction: async ({ name }) => { reactionCalls.push(name); },
          sendReplies: async ({ threadKey: key }) => { callLog.push(`post:${key}`); return { permalink: undefined }; },
        },
      };
      vm.runInNewContext(block, context);
      const { results } = await handler({ sender: { isDestroyed: () => false, send: () => {} } }, { projectId: "P", itemIds: ["A", "B"], scope: undefined });

      // Item B gagal di fase root -> di-skip TOTAL di fase artist/react/post, item A tetap lanjut.
      assert.deepEqual(callLog.filter((c) => c.endsWith(":B")), ["root:B"]);
      assert.deepEqual(callLog.filter((c) => c.endsWith(":A")), ["root:A", "artist:A", "post:A"]);
      // Urutan GLOBAL per-fase (bukan per-item lagi): semua root dulu, baru artist.
      assert.deepEqual(callLog.filter((c) => c.startsWith("root:") || c.startsWith("artist:")), ["root:A", "root:B", "artist:A"]);
      // Reaction artis (artis-a) ke-flush pas fase artist, reaction manual (manual) di fase react
      // terpisah -- dua-duanya ke-flush, gak dobel-proses.
      assert.deepEqual(reactionCalls.sort(), ["artis-a", "manual"]);
      assert.deepEqual(removedReactionIds.sort(), ["RA", "RX"]);
      assert.equal(results.find((r) => r.itemId === "A").status, "berhasil");
      assert.equal(results.find((r) => r.itemId === "B").status, "gagal");
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
