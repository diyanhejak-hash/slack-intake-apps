const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, dialog, shell, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
if (app.isPackaged) Object.assign(process.env, JSON.parse(fs.readFileSync(path.join(process.resourcesPath, "runtime-config.json"), "utf8")));
else require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

// Redirect login Slack (PKCE) lewat custom URI scheme slackintakeapps://callback, bukan server
// HTTP lokal — lihat catatan di electron/slack.cjs. OS ngirim balik URL ini ke app yang UDAH
// jalan lewat "open-url" (Mac) atau ngebuka instance BARU yang argv-nya berisi URL itu (Windows/
// Linux) — single-instance lock di bawah nangkep instance baru itu lewat "second-instance" terus
// nutup diri sendiri, biar gak muncul window kedua.
const PROTOCOL_SCHEME = "slackintakeapps";
if (!app.isPackaged && process.platform === "win32") {
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) app.quit();

const authStore = require("./auth-store.cjs");
const slack = require("./slack.cjs");
const projects = require("./projects.cjs");
const { checkForUpdate } = require("./updater.cjs");

const isDev = !!process.env.VITE_DEV;
const { pathToFileURL } = require("node:url");
const rendererURL = isDev ? "http://localhost:5173/" : pathToFileURL(path.join(__dirname, "../dist/index.html")).href;
const fileGrants = new Set();
function trustedURL(value) {
  try { const u = new URL(value); u.hash = ""; u.search = ""; return u.href === rendererURL; } catch { return false; }
}
function allowFiles(files) {
  for (const file of files) fileGrants.add(fs.realpathSync(file));
  return files;
}
function validateFile(file) {
  const real = fs.realpathSync(file);
  if (!fileGrants.has(real) && !projects.isManagedFile(real)) throw new Error("Pilih atau drop file terlebih dahulu.");
  if (!fs.statSync(real).isFile() || fs.statSync(real).size > 100 * 1024 * 1024) throw new Error("File maksimal 100 MB.");
}
function threadKey(projectId, itemId) {
  const info = authStore.loadToken();
  return JSON.stringify([info?.teamId, info?.userId, projectId, itemId]);
}
const iconPath = path.join(__dirname, "..", "Asset", "HB5_new.png");
// 1 nativeImage dimuat sekali, dipakai ulang di SEMUA tempat logo app harusnya muncul —
// window (title bar/taskbar), tray, notifikasi OS, dock (Mac) — biar konsisten logo HB,
// bukan default Electron di sebagian tempat doang. Sengaja BUKAN diisi di sini (module
// top-level jalan sebelum app.whenReady) — nativeImage yang dibuat sebelum app ready kadang
// gagal ke-convert jadi HICON Windows dengan benar (taskbar balik nunjukin icon Electron
// default). Diisi di app.whenReady() di bawah.
let appIcon = null;
let win = null;
let tray = null;
let cancelRequested = false;
let activeSend = null;
let authenticating = false;

// Windows grouping taskbar/notifikasi berdasarkan AppUserModelID, bukan cuma nama proses —
// tanpa ini, Windows kadang nge-grup sebagai "Electron" generik (shared sama app Electron lain
// yang pernah dijalankan dari electron.exe yang sama).
if (process.platform === "win32") {
  app.setAppUserModelId("com.heraldentertainment.slackintakeapps");
}

// Eksperimen — HEVC/H.265 (ffmpeg/mp4box konfirmasi banyak file animatic produksi di-encode
// pakai ini) gak didukung Chromium/Electron secara default (beda dari H.264, terverifikasi
// gagal via video.onerror: MEDIA_ERR_SRC_NOT_SUPPORTED). Flag ini nyuruh Chromium coba
// delegasikan decode HEVC ke Media Foundation Windows — CUMA kepake kalau Windows-nya punya
// "HEVC Video Extensions" ter-install (gratis dari sebagian OEM, atau berbayar dari Microsoft
// Store) DAN build Chromium versi ini masih ngedukung flag ini (gak dijamin di semua versi).
// Harus dipanggil SEBELUM app.whenReady(). Kalau ternyata gak ngefek di mesin ini, gak ada
// downside — video non-HEVC tetap jalan seperti biasa, flag ini cuma nambah 1 opsi decode.
if (process.platform === "win32") {
  app.commandLine.appendSwitch("enable-features", "PlatformHEVCDecoderSupport");
}

function currentToken() {
  const info = authStore.loadToken();
  return info?.accessToken || null;
}

// Buka Slack — SELALU coba slack:// langsung ke app desktop dulu (gak ada deteksi "app
// kepasang atau enggak" — itu kebukti gak reliable, shell.openExternal bisa "resolve" walau
// ujungnya cuma nampilin dialog error, bukan beneran buka app). teamId MURNI dari token login
// user yang sekarang (oauth.v2.access, lihat slack.cjs) — TIDAK di-hardcode, beda user/workspace
// dapet teamId beda juga. Kalau token lama belum punya teamId (login sebelum field ini ada),
// slack:// dilewati (butuh team buat tau workspace mana), langsung ke web tanpa nyoba deep-link
// yang pasti salah. `ts` opsional buat loncat ke pesan/thread spesifik.
function openSlack({ channelId, ts }) {
  const info = authStore.loadToken();
  console.log("[debug] openSlack: teamId tersimpan =", info?.teamId || "(KOSONG)", "| userId =", info?.userId, "| savedAt =", info?.savedAt);
  if (!info?.teamId) {
    shell.openExternal(`https://slack.com/app_redirect?channel=${channelId}`);
    return;
  }
  const webUrl = `https://slack.com/app_redirect?channel=${channelId}&team=${info.teamId}`;
  const params = new URLSearchParams({ team: info.teamId, id: channelId });
  if (ts) {
    params.set("message", ts);
    params.set("thread_ts", ts);
  }
  shell.openExternal(`slack://channel?${params.toString()}`).catch(() => shell.openExternal(webUrl));
}

// Wrapper terpusat ganti ipcMain.handle biasa: error apa pun dari handler manapun otomatis
// kecatet ke Message Log (poin baru), gak perlu try/catch manual di tiap handler satu-satu.
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      const senderUrl = event.senderFrame?.url || event.sender?.getURL?.() || "";
      const trusted = trustedURL(senderUrl);
      if (!trusted || !win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error("IPC ditolak dari halaman yang tidak dipercaya.");
      validateAccess(channel, args);
      const result = await fn(event, ...args);
      if (/:pickFiles$/.test(channel)) allowFiles(result || []);
      if (channel === "emojiPreset:pickImage" && result) allowFiles([result]);
      return result;
    } catch (err) {
      projects.addLog("error", `${channel}: ${err.message}`);
      throw err;
    }
  });
}

function validateAccess(channel, args) {
  if (!["auth:status", "auth:login", "update:check"].includes(channel) && !currentToken()) throw new Error("Login Slack terlebih dahulu.");
  if (activeSend && ["auth:login", "auth:logout"].includes(channel)) throw new Error("Tunggu pengiriman selesai sebelum berganti akun.");
  if (["project:attachFiles", "item:attachFiles"].includes(channel)) args[1].forEach(validateFile);
  if (channel === "reply:add") (args[0].filePaths || []).forEach(validateFile);
  if (channel === "reply:addFiles") args[2].forEach(validateFile);
  if (channel === "emojiPreset:addCustom") validateFile(args[0].filePath);
  if (channel === "batchFile:saveSections") {
    const previous = projects.listBatchSections(args[0]);
    for (const section of args[1]) for (const file of section.files) {
      const known = previous.flatMap((s) => s.files).find((f) => f.id === file.id);
      if (!known || (file.path !== known.path && file.path !== known.source_path)) validateFile(file.path);
    }
  }
  let valid = true;
  if (["project:load", "project:rename", "project:delete", "project:duplicate", "project:export", "project:attachFiles", "batchFile:listSections", "batchFile:saveSections", "batchFile:apply"].includes(channel)) valid = projects.ownsProject(args[0]);
  else if (channel === "item:addManual") valid = projects.ownsProject(args[0]?.projectId);
  else if (["item:update", "item:remove", "item:attachFiles"].includes(channel)) valid = projects.ownsItem(args[0]);
  else if (channel === "item:merge") valid = Array.isArray(args[0]) && args[0].every(projects.ownsItem);
  else if (["reply:update", "reply:remove", "reply:broadcast", "reply:addFiles", "reply:addCapturedToReply"].includes(channel)) valid = projects.ownsReply(args[0]);
  else if (channel === "reply:add") valid = projects.ownsItem(args[0]?.itemId);
  else if (channel === "reply:addCaptured") valid = projects.ownsItem(args[0]);
  else if (["item:removeFile", "project:removeFile", "reply:removeFile"].includes(channel)) valid = projects.ownsFile(args[0]);
  else if (channel === "reply:removeMany") valid = Array.isArray(args[0]) && args[0].every(projects.ownsReply);
  else if (channel === "reply:removeManyEverywhere" || channel === "reply:reorder") valid = projects.ownsProject(args[0]) || projects.ownsItem(args[0]);
  else if (channel === "send:start" || channel === "send:quick" || channel === "reaction:sendInstant") valid = projects.ownsProject(args[0]?.projectId);
  else if (["itemReaction:list", "itemReaction:add"].includes(channel)) valid = projects.ownsItem(args[0]);
  else if (channel === "itemReaction:addToProject") valid = projects.ownsProject(args[0]);
  else if (channel === "itemReaction:remove") valid = projects.ownsItemReaction(args[0]);
  else if (channel === "item:restore") valid = projects.ownsProject(args[0]?.project_id);
  else if (channel === "item:unmerge") valid = !args[0] || projects.ownsProject(args[0]?.items?.[0]?.project_id);
  if (channel === "send:recover") valid = projects.ownsProject(args[0]?.projectId);
  if (channel === "project:releaseUndo") valid = projects.ownsProject(args[0]);
  if (channel === "template:applyAll") valid = projects.ownsProject(args[0]);
  if (channel === "reply:broadcast") valid = valid && projects.ownsProject(args[1]);
  if (channel === "item:unmerge") valid = !!args[0]?.items?.length && args[0].items.every((i) => projects.ownsProject(i.project_id));
  if (!valid) throw new Error("Data tidak ditemukan untuk akun/workspace ini.");
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    icon: appIcon,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setIcon(appIcon); // redundan sama opsi `icon` di atas, tapi Windows kadang butuh set eksplisit ini abis window dibuat.
  win.setMenuBarVisibility(false);
  // Matikan zoom native Electron (poin F2 rancangan) — tanpa ini, Ctrl+scroll/Ctrl+Plus-Minus
  // bisa nge-zoom SELURUH window bentrok sama zoom custom di PdfViewer. Accelerator menu bawaan
  // (Ctrl+Plus/Minus/0) tetap aktif walau menu bar disembunyikan, makanya di-null-kan juga.
  win.webContents.setVisualZoomLevelLimits(1, 1);
  Menu.setApplicationMenu(null);

  if (isDev) {
    win.loadURL("http://localhost:5173");
  } else {
    win.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("slack://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (!trustedURL(url)) event.preventDefault();
  });

  // X = benar-benar tutup app. Minimize (-) = perilaku normal Windows (tetap di taskbar,
  // klik buat balikin) — BUKAN hide-to-tray. Tray icon tetap ada buat akses cepat/Keluar,
  // terpisah dari tombol minimize (poin 6, tapi gak nyulik tombol minimize bawaan OS).
}

function createTray() {
  tray = new Tray(appIcon.resize({ width: 32, height: 32 }));
  tray.setToolTip("Slack Intake Apps");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Buka", click: () => win?.show() },
      { type: "separator" },
      { label: "Keluar", click: () => app.quit() },
    ])
  );
  tray.on("click", () => win?.show());
}

function handleDeepLink(url) {
  if (!url || !url.startsWith(`${PROTOCOL_SCHEME}://`)) return;
  slack.completeLoginFromUrl(url);
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

// Windows/Linux: klik link slackintakeapps:// pas app UDAH jalan bukan buka window baru, OS
// buka INSTANCE BARU proses ini dengan URL di argv — single-instance lock di atas bikin instance
// baru itu langsung berhenti sendiri dan ngirim argv-nya ke instance pertama lewat event ini.
app.on("second-instance", (_event, argv) => {
  handleDeepLink(argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`)));
});
// macOS: link slackintakeapps:// nyampe langsung ke instance yang jalan lewat event ini.
app.on("open-url", (event, url) => {
  event.preventDefault();
  if (app.isReady()) handleDeepLink(url);
  else app.whenReady().then(() => handleDeepLink(url));
});

app.whenReady().then(() => {
  appIcon = nativeImage.createFromPath(iconPath);
  if (process.platform === "darwin") app.dock.setIcon(appIcon); // dock Mac = taskbar Windows, butuh di-set eksplisit juga
  createWindow();
  createTray();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (!win || win.isDestroyed()) createWindow();
  else win.show();
});

// ---------- Auth ----------
handle("auth:status", () => {
  const info = authStore.loadToken();
  if (info && !info.teamId) {
    authStore.clearToken();
    projects.setScope(null, null);
    return { loggedIn: false };
  }
  projects.setScope(info?.userId, info?.teamId);
  console.log("[debug] auth:status: teamId tersimpan =", info?.teamId || "(KOSONG)", "| savedAt =", info?.savedAt);
  return info ? { loggedIn: true, userId: info.userId, team: info.team } : { loggedIn: false };
});

handle("auth:login", async () => {
  if (authenticating) throw new Error("Login sedang berjalan.");
  authenticating = true;
  try {
  const info = await slack.loginWithBrowser(
    { clientId: process.env.SLACK_CLIENT_ID, redirectUri: process.env.SLACK_REDIRECT_URI },
    (url) => shell.openExternal(url)
  );
  authStore.saveToken(info);
  projects.setScope(info.userId, info.teamId);
  return { loggedIn: true, userId: info.userId, team: info.team };
  } finally { authenticating = false; }
});

handle("auth:logout", () => {
  if (authenticating) throw new Error("Tunggu login selesai.");
  fileGrants.clear();
  authStore.clearToken();
  projects.setScope(null, null);
  return { loggedIn: false };
});

// ---------- Slack data ----------
handle("slack:listChannels", () => slack.listChannels(currentToken()));
handle("slack:listUsers", () => slack.listUsers(currentToken()));
handle("slack:createChannel", (_e, { name, memberIds }) => slack.createPrivateChannel({ token: currentToken(), name, memberIds }));

// ---------- Projects ----------
handle("project:create", (_e, payload) => projects.createProject(payload));
handle("project:list", () => projects.listProjects());
handle("project:load", (_e, id) => projects.getProject(id));
handle("project:rename", (_e, id, name) => projects.renameProject(id, name));
handle("project:delete", (_e, id) => projects.deleteProject(id));
handle("project:duplicate", (_e, id, newName) => projects.duplicateProject(id, newName));
// General Display (Tab Reply, panel kiri) — level PROJECT (poin b1 revisi), sengaja beda dari
// item:attachFiles/item:removeFile (item_files per-item, dipakai buat lampiran Main Thread).
handle("project:attachFiles", (_e, projectId, filePaths) => projects.addProjectFiles(projectId, filePaths));
handle("project:removeFile", (_e, fileId) => projects.removeProjectFile(fileId));

handle("project:export", async (_e, id) => {
  const data = projects.exportProject(id);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Export Project",
    defaultPath: `${data.project.name}.slackintake.json`,
    filters: [{ name: "Slack Intake Project", extensions: ["json"] }],
  });
  if (canceled || !filePath) return { canceled: true };
  await fs.promises.writeFile(filePath, JSON.stringify(data));
  return { canceled: false, filePath };
});

handle("project:import", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Import Project",
    filters: [{ name: "Slack Intake Project", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths.length) return { canceled: true };
  if (fs.statSync(filePaths[0]).size > 140 * 1024 * 1024) throw new Error("File import maksimal 140 MB.");
  const payload = JSON.parse(await fs.promises.readFile(filePaths[0], "utf8"));
  const newId = projects.importProject(payload);
  return { canceled: false, projectId: newId };
});

// ---------- Items ----------
handle("item:addManual", (_e, { projectId, name, artistId, artistName }) =>
  projects.addItem(projectId, { name, artistId, artistName, source: "manual" })
);
handle("item:update", (_e, itemId, patch) => projects.updateItem(itemId, patch));
handle("item:remove", (_e, itemId) => projects.removeItem(itemId));
handle("item:merge", (_e, itemIds, separator) => projects.mergeItems(itemIds, separator));
handle("item:unmerge", (_e, snapshot) => projects.unmergeItems(snapshot));
handle("item:restore", (_e, snapshot) => projects.restoreItem(snapshot));

handle("item:pickFiles", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
  return canceled ? [] : filePaths;
});

handle("item:attachFiles", (_e, itemId, filePaths) => projects.addItemFiles(itemId, filePaths));
// General Display (poin C2) — file referensi statis nempel ke item, gak nempel reply/kategori
// manapun. `addItemFiles`/item.files sudah ada dari alur lama, cuma remove yang belum diekspos.
handle("item:removeFile", (_e, fileId) => projects.removeItemFile(fileId));

handle("reply:add", (_e, payload) => projects.addReplyWithFiles(payload.itemId, payload));
handle("reply:update", (_e, replyId, patch) => projects.updateReply(replyId, patch));
handle("reply:remove", (_e, replyId) => projects.removeReply(replyId));
handle("reply:removeMany", (_e, replyIds) => projects.removeReplies(replyIds));
handle("reply:removeFile", (_e, fileId) => projects.removeReplyFile(fileId));
handle("reply:removeManyEverywhere", (_e, projectId, categories) => projects.removeRepliesByCategory(projectId, categories));
handle("reply:reorder", (_e, itemId, orderedReplyIds) => projects.reorderReplies(itemId, orderedReplyIds));
handle("reply:addFiles", (_e, replyId, itemId, filePaths) => projects.addFilesToReply(replyId, itemId, filePaths));
handle("reply:broadcast", (_e, replyId, projectId) => projects.broadcastReply(replyId, projectId));
handle("reply:addCaptured", (_e, itemId, dataUrl, filename) => projects.addCapturedFile(itemId, dataUrl, filename));
handle("reply:addCapturedToReply", (_e, replyId, itemId, dataUrl, filename) => projects.addCapturedFileToReply(replyId, itemId, dataUrl, filename));

// ---------- Artist groups & templates ----------
handle("artistGroup:list", () => projects.listArtistGroups());
handle("artistGroup:save", (_e, payload) => projects.saveArtistGroup(payload));
handle("artistGroup:delete", (_e, id) => projects.deleteArtistGroup(id));
handle("template:list", () => projects.listTemplates());
handle("template:save", (_e, payload) => projects.saveTemplate(payload));
handle("template:delete", (_e, id) => projects.deleteTemplate(id));

// ---------- Hyperlink presets ----------
handle("hyperlink:list", () => projects.listHyperlinkPresets());
handle("hyperlink:save", (_e, payload) => projects.saveHyperlinkPreset(payload));
handle("hyperlink:delete", (_e, id) => projects.deleteHyperlinkPreset(id));

// ---------- Preset Emoji (poin revisi) — global, bukan per-project ----------
handle("emojiPreset:list", () => projects.listEmojiPresets());
handle("emojiPreset:addUnicode", (_e, { char, shortcode }) => projects.addUnicodeEmojiPreset(char, shortcode));
handle("emojiPreset:addCustom", (_e, { name, filePath }) => projects.addCustomEmojiPreset(name, filePath));
handle("emojiPreset:remove", (_e, id) => projects.removeEmojiPreset(id));
handle("emojiPreset:pickImage", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "Gambar", extensions: ["png"] }] });
  return canceled ? null : filePaths[0];
});

// ---------- Reaction (poin revisi) ----------
// PENDING per item — dikirim bareng lewat send:start (lihat loop-nya di atas), bukan langsung.
handle("itemReaction:list", (_e, itemId) => projects.listItemReactions(itemId));
handle("itemReaction:add", (_e, itemId, payload) => projects.addItemReaction(itemId, payload));
// Poin revisi: "React semua Item" — antre reaction yang sama ke SEMUA item di project ini.
handle("itemReaction:addToProject", (_e, projectId, payload) => projects.addReactionToAllItems(projectId, payload));
handle("itemReaction:remove", (_e, id) => projects.removeItemReaction(id));

// INSTAN — overlay hover pil item, fire-and-forget, gak pernah nyentuh item_reactions. Butuh
// thread yang UDAH ADA (item pernah dikirim) — gak auto-bikin thread baru cuma buat reaction.
handle("reaction:sendInstant", async (_e, { projectId, itemId, slackShortcode }) => {
  const project = projects.getProject(projectId);
  if (!project) throw new Error("Project tidak ditemukan untuk akun/workspace ini.");
  const item = project.items.find((i) => i.id === itemId);
  if (!item) throw new Error("Item tidak ditemukan.");
  const info = slack.findThreadInfo(threadKey(projectId, item.id));
  if (!info) throw new Error("Item ini belum pernah dikirim ke Slack — kirim dulu sebelum kasih reaction.");
  await slack.addReaction({ token: currentToken(), channelId: info.channelId, timestamp: info.threadTs, name: slackShortcode });
  projects.addLog("info", `Reaction instan :${slackShortcode}: ke "${item.name}": berhasil.`);
  return true;
});

// ---------- Message Log ----------
handle("log:list", (_e, limit) => projects.listLogs(limit));
handle("log:clear", () => projects.clearLogs());

// ---------- Batch File: user pilih banyak file, dicocokkan (strict, nama tanpa ekstensi ==
// nama item) client-side di renderer (udah punya project.items), IPC ini cuma buka dialog. ----------
handle("batchFile:pickFiles", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ["openFile", "multiSelections"] });
  return canceled ? [] : filePaths;
});
handle("batchFile:listSections", (_e, projectId) => projects.listBatchSections(projectId));
handle("batchFile:saveSections", (_e, projectId, sections) => projects.saveBatchSections(projectId, sections));
handle("batchFile:apply", (_e, projectId) => projects.applyBatchSections(projectId));

// Baca bytes file lewat main process (bukan fetch(file://) di renderer) — port dari Hej
// Breakdown (pdfViewer.js), pola yang sama sudah terbukti diandalkan buat pdf.js: fetch/XHR
// untuk skema file:// perilakunya gak konsisten di Electron dengan contextIsolation.
handle("file:readBytes", async (_e, filePath) => {
  if (!projects.isManagedFile(filePath)) throw new Error("File tidak terdaftar di project.");
  const stat = fs.statSync(filePath);
  if (stat.size > 500 * 1024 * 1024) throw new Error("File terlalu besar untuk dibaca sekaligus (maks. 500 MB).");
  return fs.promises.readFile(filePath);
});

// ---------- Kirim ke Slack ----------
handle("send:cancel", () => {
  cancelRequested = true;
  return true;
});

// Judul reply opsional: ada judul -> bold di baris 1, baris kosong, lanjut isi di baris 3.
// Gak ada judul -> isi polos mulai baris 1. Dua-duanya kosong -> undefined (gak dikirim).
function composeReplyText(title, text) {
  const t = (title || "").trim();
  const body = (text || "").trim();
  if (t && body) return `*${t}*\n\n${body}`;
  if (t) return `*${t}*`;
  if (body) return body;
  return undefined;
}

// 1 reply -> 1 "post" buat sendItem (teks + file sekaligus kalau ada) — null kalau reply-nya
// kosong (gak ada judul/isi/file). Dipakai bareng di send:start (semua reply) DAN send:quick
// (poin revisi "Instant Intake", satu reply doang).
function replyToPost(reply) {
  const text = composeReplyText(reply.title, reply.text_value);
  if (!reply.files.every((f) => projects.isManagedFile(f.stored_path))) throw new Error("Attachment tidak berada dalam penyimpanan project.");
  const files = reply.files.map((f) => ({ path: f.stored_path, filename: f.original_name }));
  if (files.length) return { text, files };
  if (text) return { text };
  return null;
}

// `scope` (poin revisi: overlay Instant Intake di HEADER kolom Item/Artis/Reply) — sama seperti
// send:quick, tapi diterapkan ke SEMUA item terpilih sekaligus lewat loop send:start yang udah
// ada (progress bar, notifikasi selesai, cancel, satu openSlack doang di awal — bukan spam buka
// Slack per item kayak kalau send:quick dipanggil berkali-kali). undefined = perilaku lama
// (semua: file+reply+artis), gak ada breaking change buat caller lama (SlackViewPreview).
handle("send:start", async (event, { projectId, itemIds, channelId, scope }) => {
  if (activeSend) throw new Error("Masih ada proses kirim yang berjalan.");
  const jobId = require("node:crypto").randomUUID();
  activeSend = jobId;
  cancelRequested = false;
  try {
    const project = projects.getProject(projectId);
    if (!project) throw new Error("Project tidak ditemukan untuk akun/workspace ini.");
    const token = currentToken();
    const targets = project.items.filter((i) => itemIds.includes(i.id));
    const results = [];
  // Override dari Slack View Preview (poin baru: user bisa ganti channel tujuan cuma buat
  // kiriman ini) — kalau gak dikasih, pakai channel default project seperti biasa.
    const targetChannelId = channelId || project.channel_id;

    openSlack({ channelId: targetChannelId });

    for (let i = 0; i < targets.length; i++) {
    if (cancelRequested) {
      results.push({ itemId: targets[i].id, itemName: targets[i].name, status: "dibatalkan" });
      continue;
    }
    const item = targets[i];
    if (!event.sender.isDestroyed()) event.sender.send("send:progress", { projectId, jobId, index: i, total: targets.length, itemName: item.name });
    try {
      let artistId = item.artist_id;
      let posts = [];
      if (scope === "item") {
        artistId = null; // cuma mastiin/bikin thread `*itemName*`, gak ada artis/reply/file.
      } else if (scope === "artist") {
        if (!artistId) throw new Error("Item ini belum ada artis yang ditugaskan.");
      } else if (scope === "replies") {
        artistId = null;
        posts = item.replies.map(replyToPost).filter(Boolean);
      } else {
        // Default (gak ada scope, dipakai SlackViewPreview/"Preview & Kirim") — kirim SEMUANYA:
        // attach langsung dulu (kompatibilitas item_files lama), lalu tiap Reply (Batch File/
        // Drawer/Template) sesuai sort_order — teks jadi 1 pesan, file jadi 1 upload (+ caption
        // judul reply-nya).
        if (!item.files.every((f) => projects.isManagedFile(f.stored_path))) throw new Error("Attachment item tidak berada dalam penyimpanan project.");
        if (item.files.length) {
          posts.push({ files: item.files.map((f) => ({ path: f.stored_path, filename: f.original_name })) });
        }
        for (const reply of item.replies) {
          const post = replyToPost(reply);
          if (post) posts.push(post);
        }
      }

      await confirmLegacyThread(projectId, item, targetChannelId);
      const { threadTs, isNew, permalink } = await slack.sendItem({
        token,
        channelId: targetChannelId,
        itemName: item.name,
        threadKey: threadKey(projectId, item.id),
        artistId,
        posts,
      });
      results.push({ itemId: item.id, itemName: item.name, status: "berhasil", isNew, threadTs, permalink, channelId: targetChannelId });

      // Reaction PENDING (poin revisi) — urutan: pesan utama -> semua reply (di atas) -> reaction
      // di sini, paling akhir. Gagal per-reaction (mis. custom emoji belum ada di workspace Slack
      // tujuan) SENGAJA gak nggagalin seluruh item (pesan/reply udah kekirim duluan) — dicatat log
      // doang, reaction itu TETAP pending (gak dihapus) biar bisa dicoba lagi lain kali.
      for (const reaction of projects.listItemReactions(item.id)) {
        try {
          await slack.addReaction({ token, channelId: targetChannelId, timestamp: threadTs, name: reaction.slack_shortcode });
          projects.removeItemReaction(reaction.id);
        } catch (err) {
          projects.addLog("error", `Gagal kasih reaction :${reaction.slack_shortcode}: ke "${item.name}": ${err.message}`);
        }
      }
    } catch (err) {
      results.push({ itemId: item.id, itemName: item.name, status: "gagal", channelId: targetChannelId, reason: err.message });
      projects.addLog("error", `Gagal kirim "${item.name}": ${err.message}`);
    }
    }

    const okCount = results.filter((r) => r.status === "berhasil").length;
  projects.addLog("info", `Kirim selesai (${project.name}): ${okCount}/${results.length} berhasil.`);
  if (Notification.isSupported()) {
    new Notification({
      title: "Slack Intake Apps",
      icon: appIcon,
      body: `Selesai kirim: ${okCount}/${results.length} berhasil.`,
    }).show();
  }
    if (!event.sender.isDestroyed()) event.sender.send("send:done", { results, jobId, projectId });
    return { results, jobId };
  } finally {
    if (activeSend === jobId) activeSend = null;
  }
});

// "Instant Intake" (poin revisi) — overlay pesawat per-kolom/per-field, kirim LANGSUNG tanpa
// modal preview/channel-picker, dan CUMA sebagian dari item (bukan full send:start yang selalu
// nyertain judul+artis+semua reply). `scope` nentuin apa yang disertain ke `slack.sendItem`:
//   - "item"    -> gak ada artistId, gak ada posts (cuma mastiin/bikin thread `*itemName*`-nya).
//   - "artist"  -> cuma mention artis (posts kosong).
//   - "replies" -> cuma SEMUA reply/field item ini (gak ada mention artis).
//   - "field"   -> cuma SATU reply/field (`replyId`) — dipicu dari overlay di Drawer/ReplyRow.
// Thread anchor (`*itemName*`) selalu kebentuk/dipakai (keharusan struktural slack.sendItem,
// bukan "isi" yang dikirim user) — kalau thread-nya udah ada dari sebelumnya, dipakai ulang persis
// kayak send:start biasa (idempoten per itemName+channelId).
handle("send:quick", async (event, { projectId, itemId, channelId, scope, replyId }) => {
  if (activeSend) throw new Error("Masih ada proses kirim yang berjalan.");
  activeSend = require("node:crypto").randomUUID();
  try {
  const project = projects.getProject(projectId);
  if (!project) throw new Error("Project tidak ditemukan untuk akun/workspace ini.");
  const item = project.items.find((i) => i.id === itemId);
  if (!item) throw new Error("Item tidak ditemukan.");
  const token = currentToken();
  // Urutan preferensi channel: eksplisit dari caller > channel tempat item ini SUDAH punya
  // thread (kalau ada — cegah bikin thread DUPLIKAT kalau kiriman asli dulu dikirim ke channel
  // lain lewat override Slack View Preview, project.channel_id sekarang beda) > default project.
  const targetChannelId = channelId || slack.findThreadChannel(threadKey(projectId, item.id)) || project.channel_id;

  let artistId = null;
  let posts = [];
  if (scope === "artist") {
    artistId = item.artist_id;
    if (!artistId) throw new Error("Item ini belum ada artis yang ditugaskan.");
  } else if (scope === "replies") {
    posts = item.replies.map(replyToPost).filter(Boolean);
  } else if (scope === "field") {
    const reply = item.replies.find((r) => r.id === replyId);
    if (!reply) throw new Error("Field tidak ditemukan.");
    const post = replyToPost(reply);
    posts = post ? [post] : [];
  }
  // scope === "item" (default): artistId null, posts kosong.

  await confirmLegacyThread(projectId, item, targetChannelId);
  const { threadTs, isNew, permalink } = await slack.sendItem({ token, channelId: targetChannelId, itemName: item.name, threadKey: threadKey(projectId, item.id), artistId, posts });
  projects.addLog("info", `Instant Intake (${scope}) "${item.name}": berhasil.`);
  // Buka LANGSUNG ke thread pesan yang baru/di-update (bukan cuma channel-nya doang kayak
  // send:start) — instant-send 1 aksi, jadi hasilnya juga langsung ketauan, gak perlu scroll
  // nyari sendiri (poin revisi: "sama seperti kirim ke slack dan langsung new window").
  openSlack({ channelId: targetChannelId, ts: threadTs });
  return { itemId: item.id, itemName: item.name, threadTs, isNew, permalink, channelId: targetChannelId };
  } finally { activeSend = null; }
});

// ---------- Buka link eksternal (dipakai buat "buka di Slack" per pesan/thread) ----------
handle("shell:openExternal", (_e, url) => {
  if (!url.startsWith("https://") && !url.startsWith("slack://")) throw new Error("URL tidak diizinkan.");
  return shell.openExternal(url);
});
// Prioritaskan app desktop Slack (bukan cuma buka link web permalink-nya) — dipakai tombol
// "buka di Slack" per item hasil kirim.
handle("shell:openSlackMessage", (_e, { channelId, ts }) => openSlack({ channelId, ts }));

// ---------- Update check ----------
handle("update:check", () => checkForUpdate(process.env.GITHUB_REPO, process.env.GITHUB_RELEASES_TOKEN));

// ---------- Saran install Slack Desktop (poin revisi) ----------
// Cek EKSISTENSI FILE di lokasi install baku Slack per-platform — lebih reliable daripada
// app.getApplicationInfoForProtocol("slack://...") (perilakunya pas gak ada handler kebukti gak
// konsisten antar OS di dokumentasi Electron). SENGAJA gak nyimpen/redistribute installer Slack
// sendiri (lisensi mereka larang redistribusi) — cuma ngarahin ke link download RESMI, di-fetch
// user langsung dari server Slack pas diklik.
const SLACK_DOWNLOAD_URL = { darwin: "https://slack.com/downloads/mac", win32: "https://slack.com/downloads/windows" };
function hasSlackDesktop() {
  const candidates =
    process.platform === "darwin"
      ? ["/Applications/Slack.app"]
      : process.platform === "win32"
        ? [path.join(process.env.LOCALAPPDATA || "", "slack", "slack.exe"), path.join(process.env.LOCALAPPDATA || "", "Programs", "slack", "slack.exe")]
        : [];
  return candidates.some((p) => { try { return fs.existsSync(p); } catch { return false; } });
}
// downloadUrl dihitung di sini (main process, `process.platform` gak ambigu) — bukan di renderer
// (navigator.platform browser sifatnya deprecated/gak selalu akurat buat deteksi platform native).
handle("system:hasSlackDesktop", () => ({ installed: hasSlackDesktop(), downloadUrl: SLACK_DOWNLOAD_URL[process.platform] || SLACK_DOWNLOAD_URL.win32 }));

// Only preload calls this after Electron obtains a path from an OS-backed File.
ipcMain.on("file:grantDrop", (event, file) => {
  try {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !trustedURL(event.senderFrame.url) || !currentToken()) throw new Error("Drop ditolak.");
    allowFiles([file]);
    event.returnValue = true;
  } catch { event.returnValue = false; }
});

handle("template:applyAll", (_e, projectId, templateId) => projects.applyTemplate(projectId, templateId));

handle("send:recover", async (_e, { projectId, itemId, channelId, threadLink }) => {
  if (activeSend) throw new Error("Tunggu pengiriman selesai.");
  const project = projects.getProject(projectId);
  if (!project?.items.some((i) => i.id === itemId)) throw new Error("Item tidak ditemukan.");
  const key = threadKey(projectId, itemId);
  const target = channelId || slack.findThreadChannel(key) || project.channel_id;
  const attempt = slack.pendingAttempt(key, target);
  if (!attempt) return { message: "Tidak ada kiriman tertunda." };
  let threadTs;
  if (threadLink) {
    const url = new URL(threadLink);
    const match = url.pathname.match(/^\/archives\/([^/]+)\/p(\d{10})(\d+)$/);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".slack.com") || !match || match[1] !== target) throw new Error("Gunakan link pesan Slack pada channel tujuan yang sama.");
    threadTs = match[2] + "." + match[3];
  }
  const pending = attempt.pending_phase;
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    title: "Pulihkan kiriman",
    message: pending ? "Periksa langkah terakhir di Slack sebelum melanjutkan." : "Isi telah berubah sejak kiriman parsial.",
    detail: pending ? `Langkah: ${pending}; reply selesai: ${attempt.next_post}. Untuk upload multi-file, periksa SELURUH file. Jika hanya sebagian terkirim, hapus bagian itu di Slack sebelum memilih belum terkirim.` : "Memulai ulang akan mengirim seluruh isi lagi. Hapus kiriman parsial di Slack terlebih dahulu jika ingin menggantinya.",
    buttons: pending ? ["Batal", "Sudah terkirim lengkap", "Belum terkirim / sudah saya hapus"] : ["Batal", "Mulai ulang seluruh isi"],
    defaultId: 0, cancelId: 0,
  });
  if (response === 0) return { message: "Pemulihan dibatalkan." };
  if (pending === "root" && response === 1 && !threadTs) return { needsThreadLink: true };
  slack.resolveAttempt({ threadKey: key, channelId: target, action: !pending ? "restart" : response === 1 ? "received" : "retry", threadTs });
  return { message: "Status dipulihkan. Klik Kirim lagi untuk melanjutkan." };
});

handle("project:releaseUndo", (_e, id) => projects.releaseUndo(id));
handle("project:legacyCount", () => projects.legacyCount());
handle("project:recoverLegacy", async () => {
  if (activeSend) throw new Error("Tunggu pengiriman selesai.");
  const info = authStore.loadToken(), count = projects.legacyCount();
  if (!count) return 0;
  const { response } = await dialog.showMessageBox(win, {
    type: "question", title: "Pulihkan project versi lama",
    message: `Ada ${count} project lama yang belum memiliki informasi pemilik.`,
    detail: `Pulihkan hanya jika data lokal ini memang milik Anda. Seluruh project lama tersebut akan dikaitkan ke akun ${info.userId}, workspace ${info.team}. Project akun lain yang sudah teridentifikasi tidak dipindahkan.`,
    buttons: ["Batal", "Pulihkan ke akun ini"], defaultId: 0, cancelId: 0,
  });
  return response === 1 ? projects.recoverLegacyProjects() : 0;
});

async function confirmLegacyThread(projectId, item, channelId) {
  const key = threadKey(projectId, item.id);
  if (slack.findThreadInfo(key) || slack.pendingAttempt(key, channelId)) return;
  const legacy = slack.legacyThread(item.name, channelId);
  if (!legacy) return;
  const { response } = await dialog.showMessageBox(win, {
    type: "question", title: "Cocokkan thread versi lama",
    message: `Ada mapping thread lama untuk "${item.name}".`,
    detail: `Channel: ${channelId}; timestamp: ${legacy.thread_ts}. Mapping lama belum mencatat project/workspace. Periksa di Slack dan gunakan hanya jika itu thread item ini di workspace akun sekarang.`,
    buttons: ["Batal", "Gunakan thread lama ini", "Buat thread baru"], defaultId: 0, cancelId: 0,
  });
  if (response === 0) throw new Error("Pencocokan thread dibatalkan.");
  if (response === 1) slack.bindLegacyThread(key, channelId, legacy);
}
