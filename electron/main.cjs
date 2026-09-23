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
const hbStatus = require("./hbStatus.cjs");
const adminAccess = require("./adminAccess.cjs");
const slackSocket = require("./slackSocket.cjs");

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
// Satu aturan "file ini boleh diakses?" dipakai bareng validateFile() DAN file:readBytes — dulu
// file:readBytes cuma cek isManagedFile() doang (gak liat fileGrants sama sekali), jadi file yang
// BARU di-allowFiles (misal hasil slack:downloadEmojiImage) gagal di-preview sebelum sempat
// disimpan jadi managed file (bug dilaporkan: "Error file:readBytes ... tidak terdaftar di
// project" pas milih emoji Slack, padahal abis disimpan langsung muncul normal).
function isFileAccessible(real) {
  return fileGrants.has(real) || projects.isManagedFile(real);
}
function validateFile(file) {
  const real = fs.realpathSync(file);
  if (!isFileAccessible(real)) throw new Error("Pilih atau drop file terlebih dahulu.");
  // Gak ada batas ukuran sendiri lagi (poin revisi) — ikut aturan Slack, biar Slack yang nolak.
  if (!fs.statSync(real).isFile()) throw new Error("Yang dipilih bukan file.");
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
let userDirectoryRefresh = null;
const channelMemberRefreshes = new Map();
// Papan status HB Apps (poin revisi) — isOnline TRUE cuma kalau user klik "Mulai Sesi" di modal
// Start Menu (bisa di-skip, opsional). sessionModalShown biar modal cuma nongol SEKALI per
// proses app (bukan tiap balik ke Start Menu dari dalam project — itu navigasi SPA, bukan
// launch baru), gak ke-reset selama app-nya masih jalan.
let hbOnline = false;
let sessionModalShown = false;
let hbQuitting = false;

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

// Auto-refresh (poin revisi) — dipanggil dari handle() begitu ada panggilan Slack gagal dengan
// token_expired. Single-flight lewat refreshPromise: kalau BEBERAPA panggilan expired hampir
// bareng (misal app baru resume dari sleep semalaman), semuanya nunggu SATU refresh yang sama,
// bukan masing-masing nembak oauth.v2.access sendiri-sendiri — refresh_token biasanya SEKALI
// pakai (di-rotate tiap dipakai), refresh paralel bisa saling gagalin satu sama lain kalau gak
// di-single-flight. Balikin false (bukan throw) kalau gak ada refresh_token tersimpan atau
// refresh-nya sendiri gagal — caller tetap lempar error asli, user tetap harus login ulang manual.
let refreshPromise = null;
// Poin revisi (diagnosa: user masih kena token_expired berulang, gak jelas kenapa auto-refresh
// gak nolong) — dulu gagal diam-diam (return false doang, gak ada jejak KENAPA). Sekarang tiap
// jalur gagal di-log (Menu > Log Aktivitas) DAN caller (handle()) nyusun error yang beda buat
// masing-masing kasus, biar keliatan jelas di dialog: gak ada refresh_token tersimpan (login
// lama, sebelum fitur ini ada / App gak pakai Token Rotation) VS refresh-nya sendiri yang gagal.
// `var` (bukan `let`, poin revisi testability) — top-level `let`/`const` gak ke-expose lewat
// context object pas dijalanin via vm.runInNewContext (test regresi), `var` iya.
var lastRefreshFailureReason = null;
async function tryRefreshToken() {
  if (!refreshPromise) {
    const info = authStore.loadToken();
    if (!info?.refreshToken) {
      lastRefreshFailureReason = "no_refresh_token";
      projects.addLog("error", "Auto-refresh token dilewati: gak ada refresh_token tersimpan (login sebelum fitur auto-refresh ada, atau App Slack gak pakai Token Rotation) -- logout lalu login ulang.");
      return false;
    }
    refreshPromise = slack
      .refreshAccessToken({ clientId: process.env.SLACK_CLIENT_ID, refreshToken: info.refreshToken })
      .then((refreshed) => authStore.saveToken({ ...info, ...refreshed }))
      .finally(() => { refreshPromise = null; });
  }
  try {
    await refreshPromise;
    return true;
  } catch (err) {
    lastRefreshFailureReason = "refresh_call_failed";
    projects.addLog("error", `Auto-refresh token gagal: ${err.message}`);
    return false;
  }
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
      let result;
      try {
        result = await fn(event, ...args);
      } catch (err) {
        // Token Slack expired (poin revisi, auto-refresh) — coba tukar refresh_token ke
        // access_token baru SEKALI, retry panggilan yang gagal itu. Kalau App Slack-nya gak
        // pakai Token Rotation (gak ada refresh_token tersimpan) atau refresh-nya sendiri
        // gagal, error ASLI tetap dilempar — user tetap harus login ulang manual kayak sebelumnya.
        if (err?.data?.error === "token_expired") {
          if (await tryRefreshToken()) {
            result = await fn(event, ...args);
          } else {
            // Poin revisi (diagnosa) — pesan ke user sekarang BEDA tergantung KENAPA auto-refresh
            // gak nolong, bukan cuma nampilin "token_expired" mentah yang gak actionable.
            const hint = lastRefreshFailureReason === "no_refresh_token"
              ? "Sesi login ini gak punya refresh token tersimpan (login dari sebelum fitur auto-refresh, atau App Slack gak pakai Token Rotation). Logout lalu login ulang."
              : "Auto-refresh token gagal (cek Log Aktivitas buat detail). Logout lalu login ulang.";
            throw new Error(`Token Slack expired. ${hint}`);
          }
        } else {
          throw err;
        }
      }
      if (/:pickFiles$/.test(channel)) allowFiles(result || []);
      if (channel === "slack:downloadEmojiImage" && result) allowFiles([result]);
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
  if (channel === "artistPreset:save" && args[0].sourcePath) validateFile(args[0].sourcePath);
  if (channel === "statusPreset:save" && args[0].sourcePath) validateFile(args[0].sourcePath);
  if (channel === "batchFile:saveSections") {
    const previous = projects.listBatchSections(args[0]);
    for (const section of args[1]) for (const file of section.files) {
      const known = previous.flatMap((s) => s.files).find((f) => f.id === file.id);
      if (!known || (file.path !== known.path && file.path !== known.source_path)) validateFile(file.path);
    }
  }
  let valid = true;
  if (["project:load", "project:rename", "project:setPhase", "project:delete", "project:duplicate", "project:export", "project:attachFiles", "project:listChannelMemberIds", "project:refreshChannelMembers", "batchFile:listSections", "batchFile:saveSections", "batchFile:apply", "artistAssign:syncProject", "slackPull:syncProject"].includes(channel)) valid = projects.ownsProject(args[0]);
  else if (channel === "item:addManual") valid = projects.ownsProject(args[0]?.projectId);
  else if (["item:update", "item:remove", "item:attachFiles"].includes(channel)) valid = projects.ownsItem(args[0]);
  else if (["item:addArtist", "item:removeArtist", "item:setStatus", "item:pushRootName", "artistAssign:syncItem", "slackPull:syncItem"].includes(channel)) valid = projects.ownsProject(args[0]?.projectId) && projects.ownsItem(args[0]?.itemId);
  else if (channel === "item:merge") valid = Array.isArray(args[0]) && args[0].every(projects.ownsItem);
  else if (["reply:update", "reply:unlock", "reply:remove", "reply:broadcast", "reply:addFiles", "reply:addCapturedToReply"].includes(channel)) valid = projects.ownsReply(args[0]);
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
  const windowTitle = `Slack Intake Apps v${app.getVersion()}`;
  win = new BrowserWindow({
    title: windowTitle,
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
  // Nama di title bar native harus selalu memperlihatkan versi build yang benar. Halaman
  // renderer punya <title> sendiri, jadi cegah page title menimpa judul native ini saat load.
  win.on("page-title-updated", (event) => event.preventDefault());
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

  // Papan status HB Apps (poin revisi) — kalau user PERNAH online (klik "Mulai Sesi"), pas
  // ditutup: tahan close-nya sebentar, kasih tau renderer buat nampilin modal "Menutup sesi..."
  // (loading = proses kirim pesan Offline ini), baru bener-bener ditutup. Kalau user gak pernah
  // online (skip modal-nya), close jalan normal tanpa hambatan/pesan sama sekali. Timeout 5
  // detik jaga-jaga (network lambat/mati) — app TETAP ditutup abis itu walau pesan belum kekirim.
  win.on("close", (e) => {
    if (!hbOnline || hbQuitting) return;
    e.preventDefault();
    hbQuitting = true;
    win?.webContents.send("hbStatus:closing");
    (async () => {
      try {
        await Promise.race([
          hbStatus.postStatus(slack, currentToken(), ":radio_button: Offline"),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ]);
      } finally {
        win?.destroy();
      }
    })();
  });
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
  // Sync 2 arah reaction Slack->App (poin revisi) — auto-connect Socket Mode kalau App-Level
  // Token udah pernah disimpen sebelumnya (gak perlu paste ulang tiap buka app) DAN salah satu
  // toggle (Realtime Sync/Otomasi Kata Kunci) lagi ON (poin revisi lanjutan, Level 2) -- kalau
  // user terakhir nutup app dengan dua-duanya OFF, gak usah auto-connect, ngirit slot round-robin.
  updateSocketModeConnectionState().catch((err) => slackSocketStatusChanged("error", err.message));
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
  // Poin revisi (bug ditemukan lewat audit, D18) — akun baru login = cache admin (adminAccess.cjs)
  // punya akun SEBELUMNYA (kalau ada) harus di-invalidate, biar isAdminMember/isOwner dicek ULANG
  // buat identitas yang baru, bukan kepake status akun lama.
  adminAccess.invalidateCache();
  // Poin revisi (UX login via custom URL scheme) — tab browser abis klik Allow SERING nyangkut
  // loading (halaman itu punya Slack, kita gak kontrol) walau login-nya di app UDAH beneran
  // sukses di titik ini. Notifikasi OS + log eksplisit nyebut refresh_token biar user gak
  // bingung "ini kejadian apa enggak", dan bisa self-verify dari Message Log.
  projects.addLog("info", `Login berhasil (${info.team || info.userId}). Refresh token ${info.refreshToken ? "TERSIMPAN" : "TIDAK ADA (App Slack mungkin belum/gak pakai Token Rotation)"}.`);
  if (Notification.isSupported()) {
    new Notification({
      title: "Slack Intake Apps",
      icon: appIcon,
      body: "Login berhasil. Tab browser yang masih terbuka boleh ditutup.",
    }).show();
  }
  return { loggedIn: true, userId: info.userId, team: info.team };
  } finally { authenticating = false; }
});

// Diagnostik manual (poin revisi — user nanya "gimana tau refresh token udah aktif?", gak mau
// nunggu ~12 jam sampai token beneran expired) — paksa tukar refresh_token SEKARANG walau access
// token SAAT INI masih valid (oauth.v2.access grant_type=refresh_token gak digate validitas token
// lama, jadi ini beneran nguji mekanismenya, bukan cuma nunggu pasif). Hasil (sukses/gagal+alasan)
// SELALU ke-log ke Message Log juga (tryRefreshToken sendiri yang nge-log), biar user bisa lihat
// detail di sana kapan pun tanpa harus nunggu error beneran kejadian.
handle("auth:testRefresh", async () => {
  const ok = await tryRefreshToken();
  return { ok, reason: ok ? null : lastRefreshFailureReason };
});

handle("auth:logout", () => {
  if (authenticating) throw new Error("Tunggu login selesai.");
  fileGrants.clear();
  authStore.clearToken();
  projects.setScope(null, null);
  // Poin revisi (bug ditemukan lewat audit, D18) — cache admin (adminAccess.cjs) per PROSES app,
  // bukan per akun. Tanpa ini, ganti akun (logout admin -> login user biasa) di proses yang SAMA
  // (belum restart app) bisa nyisain status admin punya akun LAMA nempel ke akun BARU.
  adminAccess.invalidateCache();
  return { loggedIn: false };
});

// ---------- Sistem Admin/Member (poin revisi, diminta user) ----------
// isOwner: cocok-cocokan email akun Slack ke satu alamat hardcode (adminAccess.cjs), murni
// lokal. isAdminMember: keanggotaan channel privat "hb-adm" (lihat adminAccess.cjs kenapa ini
// cukup jadi sumber kebenaran, gak butuh data custom). Dipanggil sekali abis login (App.tsx).
handle("admin:getStatus", async () => {
  const info = authStore.loadToken();
  const owner = adminAccess.isOwner(info?.email);
  const adminMember = await adminAccess.isAdminMember(slack, currentToken());
  return { isOwner: owner, isAdminMember: adminMember };
});

function requireOwner() {
  const info = authStore.loadToken();
  if (!adminAccess.isOwner(info?.email)) throw new Error("Cuma owner app yang boleh ngatur member admin.");
}

// Poin revisi (bug ditemukan lewat audit, D08) — fitur Sync Realtime/Otomasi Kata Kunci
// sebelumnya CUMA disembunyiin di UI (isAdminMember && ...), handler IPC-nya sendiri gak pernah
// nge-cek apa pun -- user biasa yang manggil langsung lewat devtools/console tetap lolos. Guard
// ini nutup celah itu di lapisan backend, bukan cuma tampilan.
async function requireAdminMember() {
  if (!(await adminAccess.isAdminMember(slack, currentToken()))) {
    throw new Error("Fitur ini cuma buat member channel admin (\"hb-adm\").");
  }
}

// Auto-bikin channel "hb-adm" (privat) pas pertama kali owner buka modal Manage Member Admin
// -- gak perlu langkah "bikin channel" terpisah, langsung ada wadah buat di-invite.
async function ensureAdminChannel(token) {
  let channelId = await adminAccess.findAdminChannel(slack, token);
  if (!channelId) {
    const created = await slack.createPrivateChannel({ token, name: adminAccess.ADMIN_CHANNEL_NAME, memberIds: [] });
    channelId = created.channelId;
    adminAccess.invalidateCache();
  }
  return channelId;
}

handle("admin:listChannelMembers", async () => {
  requireOwner();
  const token = currentToken();
  const channelId = await ensureAdminChannel(token);
  const memberIds = await slack.getChannelMembers({ token, channelId });
  const users = projects.listCachedSlackUsers();
  const byId = new Map(users.map((u) => [u.id, u]));
  return { channelId, members: memberIds.map((id) => ({ id, name: byId.get(id)?.name || id })) };
});

handle("admin:addMember", async (_e, userId) => {
  requireOwner();
  const token = currentToken();
  const channelId = await ensureAdminChannel(token);
  await slack.inviteToChannel({ token, channelId, userId });
});

handle("admin:removeMember", async (_e, userId) => {
  requireOwner();
  const token = currentToken();
  const channelId = await adminAccess.findAdminChannel(slack, token);
  if (!channelId) throw new Error("Channel admin belum ada.");
  await slack.removeFromChannel({ token, channelId, userId });
});

// ---------- Slack data ----------
handle("slack:listChannels", () => slack.listChannels(currentToken()));
// listUsers renderer sekarang SELALU lokal. Refresh jaringan cuma dipanggil sekali oleh App
// setelah login; kalau gagal, cache lama tetap utuh dan renderer tetap mendapat daftar terakhir.
handle("slack:listUsers", () => projects.listCachedSlackUsers());
handle("slack:refreshUsers", async () => {
  if (userDirectoryRefresh) return userDirectoryRefresh;
  const cached = projects.listCachedSlackUsers();
  const teamId = authStore.loadToken()?.teamId;
  userDirectoryRefresh = (async () => {
    try {
      const users = await slack.listUsers(currentToken());
      if (authStore.loadToken()?.teamId !== teamId) return { refreshed: false, users: cached };
      projects.replaceCachedSlackUsers(users);
      win?.webContents.send("slack:usersUpdated", users);
      return { refreshed: true, users };
    } catch (error) {
      if (error?.data?.error === "token_expired") throw error;
      projects.addLog("error", `slack:refreshUsers: ${error.message}`);
      return { refreshed: false, users: cached };
    } finally {
      userDirectoryRefresh = null;
    }
  })();
  return userDirectoryRefresh;
});
handle("slack:listCustomEmojis", () => slack.listCustomEmojis(currentToken()));
// Download 1 gambar emoji custom (poin revisi, Preset Artis "ambil dari Slack") — domain
// divalidasi HARUS punya Slack (bukan URL sembarang lewat IPC ini), disimpen ke temp file lokal
// biar bisa lewat jalur staging yang SAMA kayak upload manual (artistPreset:save sourcePath),
// gak perlu bikin jalur simpan PNG baru.
handle("slack:downloadEmojiImage", async (_e, url) => {
  const parsed = new URL(url);
  if (!/(^|\.)slack-edge\.com$|(^|\.)slack\.com$/.test(parsed.hostname)) throw new Error("URL emoji tidak valid.");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Gagal ambil gambar emoji (${res.status}).`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = path.extname(parsed.pathname) || ".png";
  const tempPath = path.join(app.getPath("temp"), `slack-emoji-${require("node:crypto").randomUUID()}${ext}`);
  fs.writeFileSync(tempPath, buffer);
  return tempPath;
});
handle("slack:createChannel", (_e, { name, memberIds }) => slack.createPrivateChannel({ token: currentToken(), name, memberIds }));

// ---------- Projects ----------
handle("project:create", (_e, payload) => projects.createProject(payload));
handle("project:list", () => projects.listProjects());
handle("project:load", (_e, id) => projects.getProject(id));
handle("project:listChannelMemberIds", (_e, id) => {
  const project = projects.getProject(id);
  return projects.listCachedChannelMemberIds(project.channel_id);
});
handle("project:refreshChannelMembers", async (_e, id) => {
  const project = projects.getProject(id);
  const cached = projects.listCachedChannelMemberIds(project.channel_id);
  const teamId = authStore.loadToken()?.teamId;
  const key = `${teamId}:${project.channel_id}`;
  if (channelMemberRefreshes.has(key)) return channelMemberRefreshes.get(key);
  const refresh = (async () => {
    try {
      const memberIds = await slack.getChannelMembers({ token: currentToken(), channelId: project.channel_id });
      if (authStore.loadToken()?.teamId !== teamId) return { refreshed: false, memberIds: cached };
      projects.replaceCachedChannelMemberIds(project.channel_id, memberIds);
      return { refreshed: true, memberIds };
    } catch (error) {
      if (error?.data?.error === "token_expired") throw error;
      projects.addLog("error", `project:refreshChannelMembers: ${error.message}`);
      return { refreshed: false, memberIds: cached };
    } finally {
      channelMemberRefreshes.delete(key);
    }
  })();
  channelMemberRefreshes.set(key, refresh);
  return refresh;
});
handle("project:rename", (_e, id, name) => projects.renameProject(id, name));
// Tahap alur kerja Setup/Assign (poin revisi, diminta user) -- toggle manual, bukan otomatis.
handle("project:setPhase", (_e, id, phase) => projects.setProjectPhase(id, phase));
handle("project:delete", (_e, id) => projects.deleteProject(id));
handle("project:duplicate", (_e, id, newName) => projects.duplicateProject(id, newName));
// General Display (Tab Reply, panel kiri) — level PROJECT (poin b1 revisi), sengaja beda dari
// item:attachFiles/item:removeFile (item_files per-item, dipakai buat lampiran Main Thread).
handle("project:attachFiles", (_e, projectId, filePaths) => projects.addProjectFiles(projectId, filePaths));
handle("project:removeFile", (_e, fileId) => projects.removeProjectFile(fileId));

handle("project:export", async (_e, id) => {
  const project = projects.getProject(id);
  if (!project) throw new Error("Project tidak ditemukan.");
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: "Export Project",
    defaultPath: `${project.name}.slackintake`,
    filters: [{ name: "Slack Intake Project", extensions: ["slackintake"] }],
  });
  if (canceled || !filePath) return { canceled: true };
  projects.exportProjectToFile(id, filePath);
  return { canceled: false, filePath };
});

handle("project:import", async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: "Import Project",
    filters: [{ name: "Slack Intake Project", extensions: ["slackintake", "json"] }],
    properties: ["openFile"],
  });
  if (canceled || !filePaths.length) return { canceled: true };
  // Gak ada batas ukuran sendiri lagi (poin revisi, "ikuti aturan slack, tidak ada batasan") —
  // sama kayak attachment/export lain, biarin aja gede sesuai isi project-nya.
  const newId = projects.importProjectFile(filePaths[0]);
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
handle("reply:unlock", (_e, replyId) => projects.unlockReply(replyId));
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

// ---------- Artis Preset (poin revisi) — global, bukan per-project ----------
handle("artistPreset:list", () => projects.listArtistPresets());
handle("artistPreset:save", (_e, { id, memberId, nickname, codeName, sourcePath, unicodeValue }) => projects.saveArtistPreset({ id, memberId, nickname, codeName, sourcePath, unicodeValue }));
handle("artistPreset:remove", (_e, id) => projects.removeArtistPreset(id));
// artistPreset:pickImage DIHAPUS (poin revisi) — PNG artis sekarang dipilih lewat EmojiPicker
// (preset custom emoji, upload-nya lewat "Kelola preset..."), bukan dialog file langsung lagi.

// ---------- Status Preset (poin revisi, fitur "Status" per item) — global, mirip Artis Preset ----------
handle("statusPreset:list", () => projects.listStatusPresets());
handle("statusPreset:save", (_e, { id, name, codeName, sourcePath, unicodeValue }) => projects.saveStatusPreset({ id, name, codeName, sourcePath, unicodeValue }));
handle("statusPreset:remove", (_e, id) => projects.removeStatusPreset(id));
handle("statusPreset:reorder", (_e, orderedIds) => projects.reorderStatusPresets(orderedIds));
// Mode assign Mention/React (poin revisi — bisa DUA-duanya aktif bareng) — GLOBAL buat SEMUA
// artis, singleton (bukan per-preset), 2 flag independen.
handle("artistAssignMode:get", () => projects.getArtistAssignModes());
handle("artistAssignMode:setMention", (_e, enabled) => projects.setMentionEnabled(enabled));
handle("artistAssignMode:setReact", (_e, enabled) => projects.setReactEnabled(enabled));
handle("artistAssignMode:setMulti", (_e, enabled) => projects.setMultiAssignEnabled(enabled));

// Toggle global Instant Intake + Instant Reaction (poin revisi) — gak sentuh "Add React".
handle("instantIntake:get", () => projects.getInstantIntakeEnabled());
handle("instantIntake:set", (_e, enabled) => projects.setInstantIntakeEnabled(enabled));

// Toggle global "sesi assign artis realtime" (poin revisi, multi-artist) — dipakai bareng
// ArtistPicker Tab Table & Tab Reply, lihat item:addArtist/item:removeArtist buat sinkronnya.
// Poin revisi (diminta user) — toggle ini SEKARANG juga ngontrol arah Slack->App (lihat guard di
// handleIncomingReaction) + koneksi Socket Mode (updateSocketModeConnectionState, didefinisiin
// di bawah tapi function declaration di-hoist, aman dipanggil dari sini).
handle("artistRealtimeAssign:get", () => projects.getRealtimeAssignEnabled());
// Poin revisi (diminta user) — toggle ini SEKARANG kebuka buat SEMUA user (bukan admin-member
// doang lagi, beda dari slackSocket:setToken/keywordAutomation di bawah yang TETAP admin-only).
// Aman biarpun dibuka: updateSocketModeConnectionState no-op kalau device ini belum ada App-Level
// Token tersimpan (lihat guard `if (!token) return` di dalamnya) -- non-admin yang nyalain toggle
// ini di device TANPA token cuma nyalain flag doang, gak ada apa-apa yang beneran konek. Kalau
// device-nya UDAH ada token (admin yang setup duluan di device SAMA), toggle ini beneran nyalain
// koneksi buat siapa pun yang login di situ.
handle("artistRealtimeAssign:set", async (_e, enabled) => {
  const result = projects.setRealtimeAssignEnabled(enabled);
  await updateSocketModeConnectionState();
  return result;
});

// Serialize item:addArtist/removeArtist PER ITEM (poin revisi) -- tiap panggilan round-trip ke
// Slack (mode realtime), kalau user toggle 2 artis CEPAT sebelum panggilan pertama kelar,
// syncAssignMessage bisa race (dua-duanya baca "belum ada pesan" bareng, dua-duanya chat.postMessage
// -> pesan assignment DOBEL). Queue promise per itemId -- panggilan ke-2 nunggu ke-1 kelar dulu.
const itemArtistQueues = new Map();
function withItemArtistLock(itemId, fn) {
  const prev = itemArtistQueues.get(itemId) || Promise.resolve();
  const next = prev.then(fn, fn);
  itemArtistQueues.set(itemId, next.catch(() => {}));
  return next;
}

// Poin revisi (bug dilaporkan: "ganti mode, react lama masih tertinggal") — root cause versi
// lama: add/removeArtist cuma nanganin sisi yang cocok sama mode SAAT INI, jadi kalau artis
// di-assign pas mode react (reaction live), lalu mode diganti ke mention SEBELUM artis itu
// dilepas, reaction lama itu orphan selamanya (gak pernah ke-cek lagi). Fix: reconcile PENUH
// tiap kali item_artists berubah -- baca ULANG state React MAUPUN mention dari nol berdasarkan
// mode SAAT INI, bukan cuma nge-patch 1 sisi yang "kebetulan" cocok mode waktu itu:
//   - mode react: reaction HARUS live cuma buat artis yang MASIH assigned + punya code_name;
//     apa pun yang sent tapi gak seharusnya (mode udah ganti, ATAU artisnya udah dilepas)
//     di-reactions.remove. Mention message SELALU placeholder (gak peduli siapa assigned).
//   - mode mention: SEMUA reaction yang masih sent (nyisa dari kapan pun) di-reactions.remove.
//     Mention message diisi daftar artis TERKINI (atau placeholder kalau kosong).
// Dipakai addArtist/removeArtist (realtime ON, per-item) DAN "artistAssign:syncProject" (tombol
// manual "Update" — poin revisi: ganti mode GLOBAL SENGAJA gak auto-nembak Slack buat semua item
// seketika, itu lokal/instan doang; user yang mutusin KAPAN nge-push perubahan mode itu ke Slack
// lewat tombol ini, bisa dipakai walau realtime OFF makanya ada `force`) -- SATU fungsi, 1 sumber
// kebenaran buat "gimana harusnya state Slack item ini" berdasarkan item_artists + mode SAAT INI.
async function reconcileItemAssignState({ projectId, itemId, force = false }) {
  if (!force && !projects.getRealtimeAssignEnabled()) return;
  const info = slack.findThreadInfo(threadKey(projectId, itemId));
  if (!info) return; // gak ada thread -- gak ada apa pun buat disinkron (caller yang mutusin mau throw atau diem)
  const token = currentToken();
  // Poin revisi: mention & react sekarang INDEPENDEN (bisa dua-duanya aktif bareng) -- masing-
  // masing dicek flag-nya sendiri, bukan 1 mode string mutually-exclusive lagi.
  const { mention: mentionEnabled, react: reactEnabled } = projects.getArtistAssignModes();
  const artists = projects.listItemArtists(itemId);
  const presetByMember = new Map(projects.listArtistPresets().map((p) => [p.member_id, p]));
  const shouldBeLive = new Set(reactEnabled ? artists.map((a) => presetByMember.get(a.artist_id)?.code_name).filter(Boolean) : []);

  for (const r of projects.listItemReactions(itemId)) {
    if (r.sent && !shouldBeLive.has(r.slack_shortcode)) {
      try {
        await slack.removeReaction({ token, channelId: info.channelId, timestamp: info.threadTs, name: r.slack_shortcode });
      } catch (err) {
        projects.addLog("error", `Gagal bersihin reaction lama :${r.slack_shortcode}: (ganti mode/lepas artis): ${err.message}`);
      }
      projects.removeItemReaction(r.id, { unassignArtist: false }); // ini reconcile sistem, bukan user "batal assign"
    }
  }
  let addedNewArtistReaction = false;
  for (const codeName of shouldBeLive) {
    const existing = projects.listItemReactions(itemId).find((r) => r.slack_shortcode === codeName);
    if (existing?.sent) continue;
    if (!existing) projects.addItemReaction(itemId, { emojiType: "custom", emojiValue: codeName, slackShortcode: codeName });
    try {
      await slack.addReaction({ token, channelId: info.channelId, timestamp: info.threadTs, name: codeName });
      const flushed = projects.listItemReactions(itemId).find((r) => r.slack_shortcode === codeName);
      if (flushed) projects.markItemReactionSent(flushed.id);
      addedNewArtistReaction = true;
    } catch (err) {
      projects.addLog("error", `Gagal kasih reaction :${codeName}: (reconcile mode react): ${err.message}`);
    }
  }

  // Poin revisi (urutan tampilan, diminta user) — Slack nampilin reaction sesuai urutan
  // ditambahin ke pesan (gak ada API buat "reorder" reaction yang udah ada), jadi biar react
  // ARTIS selalu di kiri/duluan dibanding react STATUS: tiap kali ada react artis BARU yang
  // baru aja nempel (atau pas tombol "Update" manual dipencet -- `force`, biar bisa benerin
  // urutan item LAMA yang kejadiannya kebalik dari sebelum fitur ini ada) SEMENTARA react status
  // udah nempel duluan, react status itu di-lepas lalu dipasang ulang -- otomatis pindah ke
  // ujung PALING BELAKANG, alias selalu setelah react artis.
  if ((addedNewArtistReaction || force) && shouldBeLive.size > 0) {
    const statusRow = projects.getItemStatus(itemId);
    if (statusRow?.sent_shortcode) {
      try {
        await slack.removeReaction({ token, channelId: info.channelId, timestamp: info.threadTs, name: statusRow.sent_shortcode });
        await slack.addReaction({ token, channelId: info.channelId, timestamp: info.threadTs, name: statusRow.sent_shortcode });
      } catch (err) {
        projects.addLog("error", `Gagal urutin ulang reaction status :${statusRow.sent_shortcode}: (biar react artis tetap duluan): ${err.message}`);
      }
    }
  }

  // Mention message cuma nampilin nama BENERAN kalau flag mention lagi ON -- kalau OFF (react
  // doang, atau dua-duanya OFF) SELALU placeholder, gak peduli siapa assigned.
  const mentionArtistIds = mentionEnabled ? artists.map((a) => a.artist_id) : [];
  await slack.syncAssignMessage({ token, channelId: info.channelId, itemId, threadTs: info.threadTs, artistIds: mentionArtistIds });

  // Poin revisi: realtime assign PER-ITEM (force=false, satu-satunya jalur addArtist/removeArtist
  // lewat) langsung buka thread-nya di Slack -- user liat hasilnya seketika tanpa nyari manual.
  // SENGAJA cuma buat realtime, BUKAN bulk "Update" (force=true, artistAssign:syncProject) -- itu
  // bisa nyentuh puluhan item sekaligus, buka tab sebanyak itu jelas kacau.
  if (!force) openSlack({ channelId: info.channelId, ts: info.threadTs });
}

// Fitur "Status" per item (poin revisi) — CUMA 1 status aktif per item (dropdown, bukan multi
// kayak artis), dikirim sebagai 1 reaction. Ganti status = lepas reaction lama, pasang yang baru,
// sama semangatnya kayak reconcileItemAssignState tapi jauh lebih sederhana (gak ada mention,
// gak ada daftar banyak artis) -- SENGAJA fungsi + tabel TERPISAH (item_status, bukan nebeng ke
// item_reactions), biar gak ketaut/kehapus gak sengaja sama cleanup reaction mode artis-react.
async function reconcileItemStatusState({ projectId, itemId, force = false }) {
  if (!force && !projects.getRealtimeAssignEnabled()) return;
  const info = slack.findThreadInfo(threadKey(projectId, itemId));
  if (!info) return;
  const token = currentToken();
  const row = projects.getItemStatus(itemId);
  const preset = row?.status_id ? projects.listStatusPresets().find((p) => p.id === row.status_id) : null;
  const desiredShortcode = preset?.code_name || null;
  const liveShortcode = row?.sent_shortcode || null;
  if (liveShortcode === desiredShortcode) return; // udah sinkron, gak ada yang perlu diubah

  if (liveShortcode) {
    // Poin revisi (bug ditemukan lewat audit, D14) — sent_shortcode DULU dihapus TANPA PEDULI
    // removeReaction berhasil apa enggak (di luar try/catch). Kalau removeReaction GAGAL, DB
    // lokal tetap ngaku "udah bersih" -- panggilan berikutnya liveShortcode===null jadi nganggep
    // SUDAH sinkron (baris awal fungsi ini return duluan), reaction lama yang GAGAL kehapus di
    // Slack gak akan pernah dicoba dihapus lagi. Sekarang cuma di-null-in kalau BENERAN sukses,
    // biar reconcile berikutnya masih nyoba ulang.
    try {
      await slack.removeReaction({ token, channelId: info.channelId, timestamp: info.threadTs, name: liveShortcode });
      projects.setItemStatusSentShortcode(itemId, null);
    } catch (err) {
      projects.addLog("error", `Gagal bersihin reaction status lama :${liveShortcode}: ${err.message}`);
    }
  }
  if (desiredShortcode) {
    try {
      await slack.addReaction({ token, channelId: info.channelId, timestamp: info.threadTs, name: desiredShortcode });
      projects.setItemStatusSentShortcode(itemId, desiredShortcode);
    } catch (err) {
      projects.addLog("error", `Gagal kasih reaction status :${desiredShortcode}: ${err.message}`);
    }
  }
  if (!force) openSlack({ channelId: info.channelId, ts: info.threadTs });
}

// Assign/lepas 1 artis ke/dari item (poin revisi, multi-artist — ArtistPicker sekarang
// multi-select, tiap toggle klik = 1 panggilan ini). Assignment LOKAL selalu jalan duluan (gak
// pernah gagal gara-gara Slack) -- BARU kalau toggle realtime ON, reconcileItemAssignState yang
// sinkron ke Slack (lihat komentar fungsi itu). Butuh item yang UDAH PERNAH dikirim (ada thread)
// -- sama precondition InstantReactionOverlay, error jelas kalau belum ada (khusus addArtist).
handle("item:addArtist", (_e, { projectId, itemId, artistId, artistName }) => withItemArtistLock(itemId, async () => {
  const item = projects.getProject(projectId)?.items.find((i) => i.id === itemId);
  if (!item) throw new Error("Item tidak ditemukan.");
  projects.addItemArtist(itemId, artistId, artistName);
  // Flag react ON (poin revisi, independen dari mention): SELALU antre pending reaction lokal
  // begitu artis di-assign (gak soal realtime ON/OFF) -- realtime OFF, reaction ini nunggu
  // di-flush pas "Kirim ke Slack" biasa nanti.
  if (projects.getArtistAssignModes().react) {
    const preset = projects.listArtistPresets().find((p) => p.member_id === artistId);
    if (preset?.code_name) projects.addItemReaction(itemId, { emojiType: "custom", emojiValue: preset.code_name, slackShortcode: preset.code_name });
  }
  if (projects.getRealtimeAssignEnabled() && !slack.findThreadInfo(threadKey(projectId, itemId))) {
    throw new Error(`"${item.name}" belum pernah dikirim ke Slack (belum ada thread) — gak bisa realtime assign.`);
  }
  await reconcileItemAssignState({ projectId, itemId });
}));

handle("item:removeArtist", (_e, { projectId, itemId, artistId }) => withItemArtistLock(itemId, async () => {
  const item = projects.getProject(projectId)?.items.find((i) => i.id === itemId);
  if (!item) throw new Error("Item tidak ditemukan.");
  projects.removeItemArtist(itemId, artistId);
  // Batal antre reaction PENDING (belum sent) buat artis ini kalau ada -- yang UDAH sent (live di
  // Slack, mode kapan pun) dibersihin lewat reconcileItemAssignState di bawah.
  const preset = projects.listArtistPresets().find((p) => p.member_id === artistId);
  if (preset?.code_name) {
    const pending = projects.listItemReactions(itemId).find((r) => r.slack_shortcode === preset.code_name && !r.sent);
    if (pending) projects.removeItemReaction(pending.id, { unassignArtist: false });
  }
  await reconcileItemAssignState({ projectId, itemId });
}));

// Replace daftar artis dalam satu lock/reconcile. Dipakai mode Single Assignment supaya ganti
// artis tidak menembakkan rangkaian remove/add terpisah ke Slack, sekaligus menjaga Undo mampu
// mengembalikan daftar multi lama tanpa kehilangan data.
handle("item:setArtists", (_e, { projectId, itemId, artists }) => withItemArtistLock(itemId, async () => {
  const item = projects.getProject(projectId)?.items.find((i) => i.id === itemId);
  if (!item) throw new Error("Item tidak ditemukan.");
  const unique = Array.from(new Map((Array.isArray(artists) ? artists : []).filter((a) => a?.artistId).map((a) => [a.artistId, a])).values());
  const nextIds = new Set(unique.map((a) => a.artistId));
  const current = projects.listItemArtists(itemId);
  const presetByMember = new Map(projects.listArtistPresets().map((p) => [p.member_id, p]));

  for (const artist of current) {
    if (nextIds.has(artist.artist_id)) continue;
    projects.removeItemArtist(itemId, artist.artist_id);
    const codeName = presetByMember.get(artist.artist_id)?.code_name;
    if (codeName) {
      const pending = projects.listItemReactions(itemId).find((r) => r.slack_shortcode === codeName && !r.sent);
      if (pending) projects.removeItemReaction(pending.id, { unassignArtist: false });
    }
  }
  for (const artist of unique) {
    if (current.some((row) => row.artist_id === artist.artistId)) continue;
    projects.addItemArtist(itemId, artist.artistId, artist.artistName || null);
    const codeName = presetByMember.get(artist.artistId)?.code_name;
    if (projects.getArtistAssignModes().react && codeName) {
      projects.addItemReaction(itemId, { emojiType: "custom", emojiValue: codeName, slackShortcode: codeName });
    }
  }
  if (projects.getRealtimeAssignEnabled() && !slack.findThreadInfo(threadKey(projectId, itemId))) {
    throw new Error(`"${item.name}" belum pernah dikirim ke Slack (belum ada thread) — gak bisa realtime assign.`);
  }
  await reconcileItemAssignState({ projectId, itemId });
}));

// Ganti status 1 item (poin revisi, fitur Status) — dropdown single-select, beda dari artis
// (multi-select add/remove). `statusId` null/"" = lepas status (placeholder "— Status —").
// Lock per-item yang SAMA kayak addArtist/removeArtist -- kelas race yang sama (klik cepat
// ganti-ganti status sebelum reconcile pertama kelar).
handle("item:setStatus", (_e, { projectId, itemId, statusId }) => withItemArtistLock(itemId, async () => {
  const item = projects.getProject(projectId)?.items.find((i) => i.id === itemId);
  if (!item) throw new Error("Item tidak ditemukan.");
  projects.setItemStatus(itemId, statusId || null);
  if (projects.getRealtimeAssignEnabled() && !slack.findThreadInfo(threadKey(projectId, itemId))) {
    throw new Error(`"${item.name}" belum pernah dikirim ke Slack (belum ada thread) — gak bisa realtime assign.`);
  }
  await reconcileItemStatusState({ projectId, itemId });
}));

// Tombol manual "Update" (poin revisi) — dipicu USER, BUKAN otomatis pas mode assign global
// di-switch (itu sengaja tetap murni lokal/instan, gak nembak Slack sama sekali sendirian).
// Nyisir SEMUA item project yang lagi kebuka yang punya artis assigned DAN/ATAU status (poin
// revisi lanjutan, fitur Status ikut dibawa tombol yang sama), reconcile 1-1 ke state SAAT INI —
// jalan meski toggle realtime OFF (`force: true`, justru itu gunanya tombol ini).
// Push 1 item (poin revisi, dipisah biar bisa dipakai scope PROJECT (loop di bawah) MAUPUN
// scope ITEM tunggal — tombol Push sekarang beda perilaku tergantung tab aktif, lihat diskusi).
async function pushItemToSlack(projectId, item) {
  // Poin revisi (diminta user) — item yang UDAH py thread lalu di-rename di app: pesan root di
  // Slack ikut ke-update tiap kali Push jalan (overlay/tombol Update). Best-effort, gak boleh
  // ngeblok reconcile assign/status di bawah gara-gara ini doang.
  const info = slack.findThreadInfo(threadKey(projectId, item.id));
  if (info) {
    try {
      await slack.syncRootMessageName({ token: currentToken(), channelId: info.channelId, threadTs: info.threadTs, itemName: item.name });
    } catch (err) {
      projects.addLog("error", `Gagal update nama item di pesan Slack "${item.name}": ${err.message}`);
    }
  }
  // Poin revisi (bug ditemukan lewat audit, D13) — reconcile assign SEBELUMNYA cuma dipanggil
  // kalau item.artists.length > 0. Kalau user LEPAS artis TERAKHIR pas realtime OFF lalu Push,
  // reconcile ini gak pernah kepanggil -- mention/reaction LAMA yang masih live di Slack gak
  // pernah dibersihin. reconcileItemAssignState sendiri udah aman dipanggil unconditional (no-op
  // kalau emang gak ada apa-apa buat diubah, findThreadInfo internal juga udah nge-guard).
  await reconcileItemAssignState({ projectId, itemId: item.id, force: true });
  if (item.status_id || item.status_sent_shortcode) await reconcileItemStatusState({ projectId, itemId: item.id, force: true });
}

// Push dari overlay kolom Item sengaja hanya memperbarui nama pesan root. Assignment artis,
// status, reaction, dan isi reply punya tombol/jalur masing-masing dan tidak disentuh di sini.
handle("item:pushRootName", async (_e, { projectId, itemId, openAfter = true }) => {
  const item = projects.getProject(projectId)?.items.find((candidate) => candidate.id === itemId);
  if (!item) throw new Error("Item tidak ditemukan.");
  const info = slack.findThreadInfo(threadKey(projectId, itemId));
  if (!info) throw new Error(`"${item.name}" belum mempunyai thread Slack.`);
  await slack.syncRootMessageName({ token: currentToken(), channelId: info.channelId, threadTs: info.threadTs, itemName: item.name });
  if (openAfter) openSlack({ channelId: info.channelId, ts: info.threadTs });
  return { itemName: item.name };
});

handle("artistAssign:syncProject", async (_e, projectId) => {
  const project = projects.getProject(projectId);
  if (!project) throw new Error("Project tidak ditemukan untuk akun/workspace ini.");
  // Poin revisi (bug ditemukan lewat audit, D13) — filter LAMA (artists.length>0 || status)
  // ngelewatin item yang PUNYA thread tapi gak py artis/status SAAT INI -- termasuk item yang
  // baru aja DILEPAS artis terakhirnya (assignment lama harusnya ikut dibersihin) dan item
  // rename-only (nama barunya gak akan pernah ke-sync ke pesan root lewat tombol Update bulk).
  // Target sekarang: SEMUA item yang UDAH py thread (has_thread), bukan cuma yang py artis/status.
  const targets = project.items.filter((i) => i.has_thread);
  let synced = 0;
  const errors = [];
  for (const item of targets) {
    try {
      await pushItemToSlack(projectId, item);
      synced++;
    } catch (err) {
      errors.push(`"${item.name}": ${err.message}`);
      projects.addLog("error", `Update sinkron assign gagal buat "${item.name}": ${err.message}`);
    }
  }
  return { total: targets.length, synced, errors };
});

// Push SATU item (poin revisi, tombol Push scope per-item di Tab Input) — logic SAMA kayak di
// atas, target-nya cuma item yang lagi aktif.
handle("artistAssign:syncItem", async (_e, { projectId, itemId, openAfter = true }) => {
  const item = projects.getProject(projectId)?.items.find((i) => i.id === itemId);
  if (!item) throw new Error("Item tidak ditemukan.");
  await pushItemToSlack(projectId, item);
  // Poin revisi (diminta user) — samain UX kayak Instant Intake (send:quick, SELALU buka link
  // pesan abis kirim). openAfter=false dipakai overlay KOLOM (bisa nge-Push BANYAK item
  // sekaligus) biar gak spam buka tab, sama alasannya kayak artistAssign:syncProject (bulk)
  // sengaja diem juga.
  if (openAfter) {
    const info = slack.findThreadInfo(threadKey(projectId, itemId));
    if (info) openSlack({ channelId: info.channelId, ts: info.threadTs });
  }
  return { itemName: item.name };
});

// "Pull" manual (poin revisi) — kebalikan arah dari tombol di atas (Push/"Sinkron ulang", App ->
// Slack): ini Slack -> App, dipicu TOMBOL (bukan otomatis/background) — nutup celah "react/kata
// kunci kejadian pas SEMUA instalasi offline", event Socket Mode-nya ilang gak ketangkep siapa
// pun, gak ada cara nyusul lewat jalur realtime (lihat diskusi round-robin App-Level Token).
// 2 hal dicek per item yang PUNYA thread:
//   1. React TERKINI di pesan root (state-diff, BUKAN replay history -- lebih simpel/akurat,
//      reuse onIncomingArtistReaction/onIncomingStatusReaction yang SAMA kayak jalur Socket Mode
//      biasa, cuma dipicu manual di sini bukan event push).
//   2. Kata kunci di SEMUA reply thread (replay teks pesan, SATU-satunya cara -- kata kunci ada
//      di teks, bukan di reaction).
// Dipisah jadi fungsi 1-item (dipakai loop scope PROJECT di bawah MAUPUN handler scope ITEM
// tunggal) — THROW kalau fetch gagal, caller yang mutusin mau di-catch per-item (loop project)
// atau dibiarin nyampe ke renderer apa adanya (single item, gak ada "item lain" buat lanjut).
// Nama item ikut Pull (poin revisi, diminta user — "buat pull dan push bisa merubah nama item",
// Push arahnya udah jalan lewat syncRootMessageName, ini pelengkap arah sebaliknya) — pesan root
// SELALU di-post app ini sebagai `*nama item*` (lihat sendItem/ensureRoot), jadi kalau user edit
// LANGSUNG di Slack, lucutin tanda bintang pembungkusnya buat balikin nama mentahnya. Kalau
// user ngetik ulang teksnya TANPA bintang (edit total), tetap dipakai apa adanya.
function extractItemNameFromRootText(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const match = trimmed.match(/^\*([\s\S]+)\*$/);
  return (match ? match[1] : trimmed).trim() || null;
}

async function pullItemFromSlack(projectId, item, { token, artistPresets, statusPresets, keywordAutomations }) {
  const info = slack.findThreadInfo(threadKey(projectId, item.id));
  if (!info) return { reactionChanges: 0, keywordChanges: 0, nameChanged: false };
  const messages = await slack.fetchThreadReplies({ token, channelId: info.channelId, threadTs: info.threadTs });
  const root = messages.find((m) => m.ts === info.threadTs);
  const liveNames = new Set((root?.reactions || []).map((r) => r.name));
  let reactionChanges = 0, keywordChanges = 0;
  // Nama item ikut Pull -- di luar withItemArtistLock (itu buat serialize assign artis/status,
  // rename gak beririsan sama itu), best-effort (proses lain di bawah TETAP jalan walau ini gagal).
  let nameChanged = false;
  const pulledName = extractItemNameFromRootText(root?.text);
  if (pulledName && pulledName !== item.name) {
    projects.updateItem(item.id, { name: pulledName });
    item.name = pulledName; // biar log/return di bawah pake nama TERBARU, bukan nama lama yang udah basi
    nameChanged = true;
  }
  await withItemArtistLock(item.id, async () => {
    for (const preset of artistPresets) {
      const isLive = liveNames.has(preset.code_name);
      // Poin revisi (bug ditemukan: Pull berulang tanpa perubahan apa pun tetap ngelaporin
      // reactionChanges > 0) -- idempoten: cuma panggil+hitung kalau state lokal BENERAN beda
      // dari live Slack, sama gaya kayak loop statusPresets di bawah.
      const sentRow = projects.listItemReactions(item.id).find((r) => r.slack_shortcode === preset.code_name && r.sent);
      if (isLive) {
        const alreadyAssigned = projects.listItemArtists(item.id).some((a) => a.artist_id === preset.member_id);
        if (!alreadyAssigned || !sentRow) {
          await onIncomingArtistReaction(true, projectId, item.id, preset.member_id, preset.code_name, preset.nickname);
          reactionChanges++;
        }
      } else if (sentRow) {
        // Cuma lepas kalau app SEBELUMNYA yakin reaction ini live (ada baris item_reactions
        // sent) -- biar gak nge-unassign artis yang di-assign manual TANPA react sama sekali
        // (mis. mode mention doang), yang emang dari awal gak pernah punya reaction di Slack.
        await onIncomingArtistReaction(false, projectId, item.id, preset.member_id, preset.code_name, preset.nickname);
        reactionChanges++;
      }
    }
    const statusRow = projects.getItemStatus(item.id);
    for (const preset of statusPresets) {
      const isLive = liveNames.has(preset.code_name);
      if (isLive) {
        if (statusRow?.status_id !== preset.id || statusRow?.sent_shortcode !== preset.code_name) {
          await onIncomingStatusReaction(true, item.id, preset.id, preset.code_name);
          reactionChanges++;
        }
      } else if (statusRow?.sent_shortcode === preset.code_name) {
        await onIncomingStatusReaction(false, item.id, preset.id, preset.code_name);
        reactionChanges++;
      }
    }
  });

  if (keywordAutomations.length) {
    const replies = messages.filter((m) => m.ts !== info.threadTs && !m.subtype && m.text);
    for (const msg of replies) {
      const matched = keywordAutomations.filter((a) => keywordAutomationRegex(a.keyword).test(msg.text));
      for (const automation of matched) {
        await withItemArtistLock(item.id, async () => {
          if (automation.target_type === "status") {
            const preset = projects.listStatusPresets().find((p) => p.id === automation.target_id);
            if (!preset) return;
            projects.setItemStatus(item.id, preset.id);
            await reconcileItemStatusState({ projectId, itemId: item.id, force: true });
          } else {
            const current = projects.getProject(projectId)?.items.find((i) => i.id === item.id);
            if (!current) return;
            if (!current.artists.some((a) => a.artist_id === automation.target_id)) {
              const artistPreset = projects.listArtistPresets().find((p) => p.member_id === automation.target_id);
              projects.addItemArtist(item.id, automation.target_id, artistPreset?.nickname || null);
            }
            await reconcileItemAssignState({ projectId, itemId: item.id, force: true });
          }
        });
        keywordChanges++;
      }
    }
  }
  if (reactionChanges || keywordChanges || nameChanged) notifyItemChanged(projectId, item.id);
  return { reactionChanges, keywordChanges, nameChanged };
}

function pullPresetsAndAutomations() {
  return {
    token: currentToken(),
    artistPresets: projects.listArtistPresets().filter((p) => p.code_name),
    statusPresets: projects.listStatusPresets().filter((p) => p.code_name),
    keywordAutomations: projects.getKeywordAutomationEnabled() ? projects.listKeywordAutomations() : [],
  };
}

handle("slackPull:syncProject", async (_e, projectId) => {
  const project = projects.getProject(projectId);
  if (!project) throw new Error("Project tidak ditemukan untuk akun/workspace ini.");
  const ctx = pullPresetsAndAutomations();
  let reactionChanges = 0, keywordChanges = 0, namesChanged = 0;
  const errors = [];
  for (const item of project.items) {
    try {
      const result = await pullItemFromSlack(projectId, item, ctx);
      reactionChanges += result.reactionChanges;
      keywordChanges += result.keywordChanges;
      if (result.nameChanged) namesChanged++;
    } catch (err) {
      errors.push(`"${item.name}": ${err.message}`);
      projects.addLog("error", `Pull gagal buat "${item.name}": ${err.message}`);
    }
  }
  return { reactionChanges, keywordChanges, namesChanged, errors };
});

// Pull SATU item (poin revisi, tombol Pull scope per-item di Tab Input) — logic SAMA kayak di
// atas, target-nya cuma item yang lagi aktif.
handle("slackPull:syncItem", async (_e, { projectId, itemId }) => {
  const item = projects.getProject(projectId)?.items.find((i) => i.id === itemId);
  if (!item) throw new Error("Item tidak ditemukan.");
  const result = await pullItemFromSlack(projectId, item, pullPresetsAndAutomations());
  return { itemName: item.name, ...result };
});

// ---------- Sync 2 arah reaction Slack -> App (poin revisi, Socket Mode) ----------
// User nambah/lepas reaction MANUAL di Slack (bukan lewat app ini) -- kalau shortcode-nya cocok
// code_name Artis/Status yang udah ada presetnya, otomatis assign/lepas artis atau set/lepas
// status di app, SEARAH KEBALIKAN dari reconcileItemAssignState/reconcileItemStatusState (yang
// nyalurin app -> Slack).
//
// SENGAJA gak numpang reconcileItemAssignState/reconcileItemStatusState buat nge-APPLY hasilnya
// ke Slack -- reaction ini KAN UDAH ADA di Slack (itu kenapa event ini nyampe), manggil
// reconcile bakal nyoba mastiin "state Slack sesuai config app" (termasuk mode react OFF =
// HARUS gak ada reaction sama sekali) dan BISA nghapus balik reaction yang baru aja user
// tambahin manual kalau kebetulan mode react lagi OFF -- ngagetin/nyebelin. Di sini cukup catet
// "reaction ini SEKARANG udah/gak ada di Slack" ke DB lokal (idempoten, gak nembak reactions.add/
// remove lagi buat shortcode yang jadi sumber event ini), reconcile TETAP jalan normal buat sisi
// LAIN yang emang butuh API call beneran (pesan assignment mode mention).
async function onIncomingArtistReaction(added, projectId, itemId, artistId, codeName, artistName) {
  const item = projects.getProject(projectId)?.items.find((i) => i.id === itemId);
  if (!item) return;
  const alreadyAssigned = item.artists.some((a) => a.artist_id === artistId);
  if (added) {
    if (!alreadyAssigned) projects.addItemArtist(itemId, artistId, artistName);
    const existing = projects.listItemReactions(itemId).find((r) => r.slack_shortcode === codeName);
    if (!existing) projects.markItemReactionSent(projects.addItemReaction(itemId, { emojiType: "custom", emojiValue: codeName, slackShortcode: codeName }));
    else if (!existing.sent) projects.markItemReactionSent(existing.id);
  } else {
    if (alreadyAssigned) projects.removeItemArtist(itemId, artistId);
    const existing = projects.listItemReactions(itemId).find((r) => r.slack_shortcode === codeName);
    if (existing) projects.removeItemReaction(existing.id, { unassignArtist: false });
  }
  if (projects.getArtistAssignModes().mention) {
    const info = slack.findThreadInfo(threadKey(projectId, itemId));
    if (info) {
      const freshArtistIds = projects.listItemArtists(itemId).map((a) => a.artist_id);
      await slack.syncAssignMessage({ token: currentToken(), channelId: info.channelId, itemId, threadTs: info.threadTs, artistIds: freshArtistIds });
    }
  }
}

async function onIncomingStatusReaction(added, itemId, statusId, codeName) {
  const current = projects.getItemStatus(itemId);
  if (added) {
    if (current?.status_id !== statusId) projects.setItemStatus(itemId, statusId);
    projects.setItemStatusSentShortcode(itemId, codeName);
  } else {
    if (current?.status_id === statusId) projects.setItemStatus(itemId, null);
    if (current?.sent_shortcode === codeName) projects.setItemStatusSentShortcode(itemId, null);
  }
}

// Poin revisi (bug dilaporkan: klik chip react di app abis reaction ke-ubah dari Slack, dapet
// "Data tidak ditemukan untuk akun/workspace ini") — root cause: sync 2 arah ngubah data di
// backend, tapi renderer yang lagi kebuka gak tau sama sekali (state item_reactions/artis/status
// di sana cuma fetch pas mount/refreshToken, gak ada dorongan "ada perubahan" dari sync ini) —
// jadi user bisa klik chip yang KESANNYA masih ada tapi sebenernya udah kehapus di backend. Fix:
// push event ke renderer TIAP kali sync ini beneran ngubah sesuatu, biar UI auto-refresh sendiri.
function notifyItemChanged(projectId, itemId) {
  if (win && !win.isDestroyed()) win.webContents.send("item:changed", { projectId, itemId });
}

async function handleIncomingReaction(type, event) {
  try {
    // Poin revisi (diminta user) — toggle Realtime Sync sekarang beneran matiin DUA arah, bukan
    // App->Slack doang (reconcileItemAssignState/StatusState). Toggle OFF = react yang kejadian
    // di Slack DI-SKIP lokal (event tetap diterima instalasi ini kalau Socket Mode masih nyala,
    // cuma gak diproses) -- satu-satunya jalan sinkron balik ke Pull manual.
    if (!projects.getRealtimeAssignEnabled()) return;
    if (!event?.item || event.item.type !== "message" || !event.reaction) return;
    const found = slack.findItemByThread(event.item.channel, event.item.ts);
    if (!found) return; // bukan pesan root item manapun yang app ini kenal -- abaikan
    const { projectId, itemId } = found;
    if (!projects.ownsProject(projectId) || !projects.ownsItem(itemId)) return;
    const added = type === "reaction_added";

    const artistPreset = projects.listArtistPresets().find((p) => p.code_name === event.reaction);
    if (artistPreset) {
      await withItemArtistLock(itemId, () => onIncomingArtistReaction(added, projectId, itemId, artistPreset.member_id, event.reaction, artistPreset.nickname));
      notifyItemChanged(projectId, itemId);
      return;
    }
    const statusPreset = projects.listStatusPresets().find((p) => p.code_name === event.reaction);
    if (statusPreset) {
      await withItemArtistLock(itemId, () => onIncomingStatusReaction(added, itemId, statusPreset.id, event.reaction));
      notifyItemChanged(projectId, itemId);
    }
    // Reaction lain yang gak cocok preset apa pun -- SENGAJA diabaikan (poin revisi, cakupan
    // sync dipilih user cuma buat Artis/Status, bukan reaction bebas apa pun).
  } catch (err) {
    projects.addLog("error", `Gagal proses reaction dari Slack (sync 2 arah): ${err.message}`);
  }
}

function slackSocketStatusChanged(status, detail) {
  projects.addLog(status === "error" ? "error" : "info", `Sync 2 arah Slack: ${status}${detail ? ` (${detail})` : ""}`);
  if (win && !win.isDestroyed()) win.webContents.send("slackSocket:status", { status, detail: detail || null });
}

// Otomasi Kata Kunci (poin revisi — digeneralisasi dari "Otomasi WIP" yang awalnya hardcode
// "@WIP" -> status "Working on it" doang). Sekarang user bikin sendiri daftar mapping-nya lewat
// modal "Kelola Otomasi Kata Kunci": kata kunci bebas + target bebas (preset Status ATAU artis
// tertentu). Kata kunci diketik SIAPA PUN sebagai reply di thread item -- otomatis set status/
// assign artis yang di-mapping ke item itu. REUSE PENUH mekanisme yang udah ada — reconcile*State
// (force:true) yang beneran reactions.add/chat.update ke Slack + push item:changed, bukan jalur
// terpisah/nembak Slack manual.
// Poin revisi (bug ditemukan lewat audit, D07) — versi LAMA cuma nambah \b di BELAKANG kata,
// TANPA cek batas DEPAN sama sekali -- keyword "WIP" jadi ikut cocok di dalam "NEWIP" (P diikuti
// akhir kata = \b valid, padahal itu bukan kata "WIP" berdiri sendiri). \b juga gak reliable buat
// keyword yang DIAWALI/DIAKHIRI simbol (mis. "@WIP" atau "DONE!") — "!" itu karakter NON-WORD,
// jadi \b gak akan pernah nempel PERSIS setelah "!" (butuh transisi ke word-char, sementara abis
// "!" biasanya cuma spasi/akhir pesan) -- keyword "DONE!" jadi GAK PERNAH cocok sama sekali walau
// user ketik PERSIS "...DONE!" di reply. Ganti total ke lookbehind/lookahead NEGATIF: "gak boleh
// diapit huruf/angka/underscore" di KEDUA sisi -- ini kerja BENER buat keyword polos ("WIP")
// MAUPUN yang diawali/diakhiri simbol ("@WIP", "DONE!"), gak kayak \b yang cuma pas buat kata
// murni alfanumerik.
function keywordAutomationRegex(keyword) {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "i");
}

// Poin revisi (diagnosa: "udah setup semua, ketik kata kunci gak ada apa pun kejadian") — dulu
// semua jalur "diabaikan" DIEM-DIEM (gak ke-log), jadi kalau gagal user gak punya cara tau di
// TAHAP MANA gagalnya (event gak nyampe sama sekali? bukan reply thread? thread gak dikenal?
// target-nya udah kehapus?). Sekarang tiap pesan yang cocok SALAH SATU kata kunci (lolos cek kata
// dulu, BUKAN tiap pesan biasa -- biar Log Aktivitas gak kebanjiran noise) di-log jelas per tahap.
async function handleIncomingMessage(event) {
  try {
    if (!projects.getKeywordAutomationEnabled()) return;
    // subtype ada = bukan pesan "polos" baru (message_changed/deleted, bot_message, dst) -- abaikan.
    if (event?.subtype) return;
    if (!event.text) return;
    const automations = projects.listKeywordAutomations();
    const matched = automations.filter((a) => keywordAutomationRegex(a.keyword).test(event.text));
    if (matched.length === 0) return;
    const matchedKeywords = matched.map((a) => a.keyword).join(", ");
    // Reply-doang (thread_ts ada TAPI beda dari ts pesan ini sendiri) -- root message thread ini
    // sendiri gak diproses (gak masuk akal "react ke diri sendiri"), dan pesan di luar thread sama
    // sekali (gak ada thread_ts) diabaikan -- gak ada "pesan utama" yang relevan buat di-react.
    if (!event?.thread_ts || event.thread_ts === event.ts) {
      projects.addLog("info", `Otomasi kata kunci: "${matchedKeywords}" kedeteksi tapi BUKAN reply di dalam thread (harus dibales DI DALAM thread item, bukan pesan baru) — channel ${event.channel}`);
      return;
    }
    const found = slack.findItemByThread(event.channel, event.thread_ts);
    if (!found) {
      projects.addLog("info", `Otomasi kata kunci: "${matchedKeywords}" kedeteksi tapi thread ini bukan thread item manapun yang dikenal app — channel ${event.channel}, thread ${event.thread_ts}`);
      return;
    }
    const { projectId, itemId } = found;
    if (!projects.ownsProject(projectId) || !projects.ownsItem(itemId)) {
      projects.addLog("info", `Otomasi kata kunci: "${matchedKeywords}" kedeteksi tapi item/project-nya bukan punya akun yang lagi login ini — diabaikan`);
      return;
    }
    for (const automation of matched) {
      await withItemArtistLock(itemId, async () => {
        if (automation.target_type === "status") {
          const preset = projects.listStatusPresets().find((p) => p.id === automation.target_id);
          if (!preset) {
            projects.addLog("error", `Otomasi kata kunci "${automation.keyword}": preset Status target-nya udah gak ada (mungkin kehapus) — cek lagi di Kelola Otomasi Kata Kunci.`);
            return;
          }
          projects.setItemStatus(itemId, preset.id);
          await reconcileItemStatusState({ projectId, itemId, force: true });
          projects.addLog("info", `Otomasi kata kunci "${automation.keyword}": status "${preset.name}" di-set otomatis (item ${itemId})`);
        } else {
          const item = projects.getProject(projectId)?.items.find((i) => i.id === itemId);
          if (!item) return;
          if (!item.artists.some((a) => a.artist_id === automation.target_id)) {
            const preset = projects.listArtistPresets().find((p) => p.member_id === automation.target_id);
            projects.addItemArtist(itemId, automation.target_id, preset?.nickname || null);
          }
          await reconcileItemAssignState({ projectId, itemId, force: true });
          projects.addLog("info", `Otomasi kata kunci "${automation.keyword}": artis di-assign otomatis (item ${itemId})`);
        }
      });
      notifyItemChanged(projectId, itemId);
    }
  } catch (err) {
    projects.addLog("error", `Gagal proses otomasi kata kunci: ${err.message}`);
  }
}

async function startSlackSocket(appToken) {
  await slackSocket.start(appToken, { onReaction: handleIncomingReaction, onMessage: handleIncomingMessage, onStatus: slackSocketStatusChanged });
}

// Poin revisi (diminta user, "Level 2") — koneksi Socket Mode CUMA perlu nyala kalau ADA salah
// satu fitur yang butuh dia (Realtime Sync ATAU Otomasi Kata Kunci) lagi ON. Disconnect kalau
// DUA-duanya OFF — bukan cuma nge-skip proses lokal (lihat guard di handleIncomingReaction),
// tapi beneran keluar dari "kolam" round-robin App-Level Token, ngirit slot buat instalasi LAIN
// yang masih pakai realtime (lihat diskusi round-robin sebelumnya). Token TETAP TERSIMPAN
// (authStore.loadAppToken, beda dari slackSocket:clearToken yang HAPUS token) — begitu salah satu
// toggle di-ON-in lagi, reconnect otomatis pakai token yang sama, gak minta user paste ulang.
async function updateSocketModeConnectionState() {
  const token = authStore.loadAppToken();
  if (!token) return; // gak ada token tersimpan -- gak ada apa pun yang bisa dikerjain di sini
  const shouldRun = projects.getRealtimeAssignEnabled() || projects.getKeywordAutomationEnabled();
  if (shouldRun && !slackSocket.isRunning()) {
    await startSlackSocket(token).catch((err) => slackSocketStatusChanged("error", err.message));
  } else if (!shouldRun && slackSocket.isRunning()) {
    await slackSocket.stop();
    projects.addLog("info", "Sync 2 arah Slack: koneksi Socket Mode diputus (Realtime Sync & Otomasi Kata Kunci dua-duanya OFF).");
    slackSocketStatusChanged("disconnected");
  }
}

handle("slackSocket:hasToken", () => !!authStore.loadAppToken());
handle("slackSocket:isRunning", () => slackSocket.isRunning());
handle("slackSocket:setToken", async (_e, token) => {
  await requireAdminMember(); // poin revisi (audit D08) -- dulu cuma disembunyiin di UI
  const clean = String(token || "").trim();
  if (!clean.startsWith("xapp-")) throw new Error("App-Level Token Slack harus diawali \"xapp-\".");
  authStore.saveAppToken(clean);
  await startSlackSocket(clean);
  return true;
});
handle("slackSocket:clearToken", async () => {
  await requireAdminMember(); // poin revisi (audit D08)
  await slackSocket.stop();
  authStore.clearAppToken();
  return true;
});
handle("keywordAutomation:getEnabled", () => projects.getKeywordAutomationEnabled());
handle("keywordAutomation:setEnabled", async (_e, enabled) => {
  await requireAdminMember(); // poin revisi (audit D08) -- dulu cuma disembunyiin di UI
  const result = projects.setKeywordAutomationEnabled(enabled);
  await updateSocketModeConnectionState();
  return result;
});
handle("keywordAutomation:list", () => projects.listKeywordAutomations());
handle("keywordAutomation:save", async (_e, { id, keyword, targetType, targetId }) => {
  await requireAdminMember(); // poin revisi (audit D08)
  return projects.saveKeywordAutomation({ id, keyword, targetType, targetId });
});
handle("keywordAutomation:remove", async (_e, id) => {
  await requireAdminMember(); // poin revisi (audit D08)
  return projects.removeKeywordAutomation(id);
});

// ---------- Reaction (poin revisi) ----------
// PENDING per item — dikirim bareng lewat send:start (lihat loop-nya di atas), bukan langsung.
handle("itemReaction:list", (_e, itemId) => projects.listItemReactions(itemId));
handle("itemReaction:add", (_e, itemId, payload) => projects.addItemReaction(itemId, payload));
// Poin revisi: "React semua Item" — antre reaction yang sama ke SEMUA item di project ini.
handle("itemReaction:addToProject", (_e, projectId, payload) => projects.addReactionToAllItems(projectId, payload));
// Poin revisi (chip react persisten) — chip yang UDAH sent, klik = reactions.remove BENERAN ke
// Slack duluan (baris lokal BARU ikut kehapus kalau itu sukses -- gagal = baris lokal TETAP ada,
// biar lokal & Slack gak kepisah/gak sinkron). Chip yang masih pending (belum sent) tetap cuma
// batal antre lokal doang, gak ada panggilan Slack (sama kayak sebelumnya).
handle("itemReaction:remove", async (_e, id) => {
  const reaction = projects.getItemReaction(id);
  if (reaction?.sent) {
    const projectId = projects.projectIdForItem(reaction.item_id);
    const info = projectId && slack.findThreadInfo(threadKey(projectId, reaction.item_id));
    if (info) await slack.removeReaction({ token: currentToken(), channelId: info.channelId, timestamp: info.threadTs, name: reaction.slack_shortcode });
  }
  projects.removeItemReaction(id);
});

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
  const real = fs.realpathSync(filePath);
  if (!isFileAccessible(real)) throw new Error("File tidak terdaftar di project.");
  const stat = fs.statSync(real);
  if (stat.size > 500 * 1024 * 1024) throw new Error("File terlalu besar untuk dibaca sekaligus (maks. 500 MB).");
  return fs.promises.readFile(real);
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
// send:start — poin revisi urutan kirim: BUKAN lagi per-item (item A semua fase, baru item B),
// tapi per-FASE lintas SEMUA item terpilih: 1) pesan utama SEMUA item dulu, 2) assign
// (mention/react artis) SEMUA item, 3) react LAIN (di luar react artis) SEMUA item, 4) baru
// reply/file lain per item. `itemState` (Map per item.id) nampung status berjalan tiap item
// lintas ke-4 fase — begitu 1 fase gagal buat 1 item, item itu di-skip di fase-fase SISANYA
// (bukan nge-block item lain), ditandai gagal di hasil akhir (bisa di-retry manual belakangan).
handle("send:start", async (event, { projectId, itemIds, channelId, scope }) => {
  if (activeSend) throw new Error("Masih ada proses kirim yang berjalan.");
  const jobId = require("node:crypto").randomUUID();
  activeSend = jobId;
  cancelRequested = false;
  try {
    const project = projects.getProject(projectId);
    if (!project) throw new Error("Project tidak ditemukan untuk akun/workspace ini.");
    // let (poin revisi, bug ditemukan lewat audit D15) -- di-reassign runPass() abis auto-refresh
    // token sukses di tengah batch, closure fase (root/artist/react/post) baca ULANG binding ini
    // tiap kepanggil, bukan snapshot nilai lama.
    let token = currentToken();
    const targets = project.items.filter((i) => itemIds.includes(i.id));
  // Override dari Slack View Preview (poin baru: user bisa ganti channel tujuan cuma buat
  // kiriman ini) — kalau gak dikasih, pakai channel default project seperti biasa.
    const targetChannelId = channelId || project.channel_id;
    const presetByMember = new Map(projects.listArtistPresets().map((p) => [p.member_id, p]));

    openSlack({ channelId: targetChannelId });

    // Papan status HB Apps (poin revisi, himbauan MUTLAK — jalan terlepas dari user klik
    // "Mulai Sesi"/skip pas Start Menu) — kasih tau user lain kalau lagi ada job jalan, biar
    // gak rebutan rate-limit workspace bareng (reactions.add dkk berbagi kuota per-workspace).
    // Poin revisi: SATU pesan yang di-edit berkala (mulai -> progress -> selesai), bukan post
    // pesan baru tiap tahap lagi — lihat hbStatus.createProgressEditor.
    const estimateMinutes = hbStatus.estimateSendMinutes({ targets, scope, assignModes: projects.getArtistAssignModes(), presetByMember, projects });
    const statusHandle = await hbStatus.postJobStatus(slack, token, hbStatus.formatJobStart({ totalJobs: targets.length, estimateMinutes }));
    // Fase 4 (post/reply) di-skip buat scope "item"/"artist" (lihat di bawah) — totalSteps ikutan
    // ngurang biar persentase progress-nya tetap presisi nyampe 100% pas job kelar.
    const numPhases = scope === "item" || scope === "artist" ? 3 : 4;
    const stepDone = hbStatus.createProgressEditor({
      slack, token, handle: statusHandle, totalJobs: targets.length, totalSteps: targets.length * numPhases, estimateMinutes,
    });

    const itemState = new Map(targets.map((item) => [item.id, {}]));
    async function runPass(phase, label, fn, { blockLater = false } = {}) {
      for (let i = 0; i < targets.length; i++) {
        const item = targets[i];
        const state = itemState.get(item.id);
        // Hanya kegagalan root yang membuat fase sesudahnya mustahil dijalankan. Kegagalan
        // assign/status tidak boleh membuang Reply yang independen dan sudah siap dikirim.
        if (state.blocked) { await stepDone(); continue; }
        if (cancelRequested) { state.cancelled = true; await stepDone(); continue; }
        if (!event.sender.isDestroyed()) event.sender.send("send:progress", { projectId, jobId, index: i, total: targets.length, itemName: item.name, phase });
        try {
          await fn(item, state);
        } catch (err) {
          // Poin revisi (bug ditemukan lewat audit, D15) — token_expired PER-ITEM ditangkep DI
          // SINI, gak pernah nyampe wrapper handle() (yang punya logic auto-refresh) -- tanpa
          // ini, batch bakal ngegagalin SEMUA item sisanya satu-satu dengan alasan yang PERSIS
          // SAMA (token yang sama, masih expired), gak pernah nyoba refresh. Auto-refresh SEKALI
          // di sini, retry item yang lagi diproses kalau berhasil; kalau refresh GAGAL, hentikan
          // batch (reuse cancelRequested yang udah ada, item sisanya ke-skip cepat kayak alur
          // "dibatalkan" biasa) -- gak ada gunanya nyoba token yang udah pasti mati berkali-kali.
          if (err?.data?.error === "token_expired" && !cancelRequested) {
            if (await tryRefreshToken()) {
              token = currentToken();
              try {
                await fn(item, state);
                await stepDone();
                continue;
              } catch (retryErr) {
                err = retryErr;
              }
            } else {
              cancelRequested = true;
              projects.addLog("error", `Batch dihentikan: token Slack expired dan auto-refresh gagal (mulai dari "${item.name}"). Logout lalu login ulang.`);
            }
          }
          state.failed = true;
          state.reason ||= err.message;
          if (blockLater || cancelRequested) state.blocked = true;
          projects.addLog("error", `Gagal (${label}) "${item.name}": ${err.message}`);
        }
        await stepDone();
      }
    }

    // Fase 1 — pesan utama (bikin thread `*itemName*` kalau belum ada, idempoten kalau udah).
    await runPass("root", "kirim pesan utama", async (item, state) => {
      await confirmLegacyThread(projectId, item, targetChannelId);
      const { threadTs, isNew } = await slack.ensureRoot({
        token, channelId: targetChannelId, itemName: item.name, threadKey: threadKey(projectId, item.id),
      });
      state.threadTs = threadTs;
      state.isNew = isNew;
    }, { blockLater: true });

    // Fase 2 — assign: mention @artis (kalau scope & mode global ngizinin) DAN/ATAU react
    // pakai code_name artis (data-driven, gak digate scope/mode — sama kayak reaction flush
    // versi lama yang unconditional, cuma soal row MANA yang "milik artis" vs "lainnya").
    await runPass("artist", "assign artis", async (item, state) => {
      // Poin revisi: syncAssignMessage SELALU dipanggil (semua scope, termasuk "item"/"replies"/
      // Instant Intake per-kolom) dengan daftar artis TERKINI item ini (bukan di-skip/dikosongin
      // manual lagi) — placeholder ke-post kalau emang belum ada artis, TETAP akurat kalau
      // ternyata udah ada (gak ada resiko "nimpa" soalnya ini SELALU baca state asli item.artists,
      // bukan daftar yang dipalsuin per-scope).
      // scope "artist" (poin revisi): TIDAK throw lagi kalau item belum ada artis -- sama
      // alasan kayak send:quick, placeholder assign message (mode mention) justru BUTUH ini
      // buat kejadian. Mode react: gak ada yang di-react, no-op aman.
      const mentionArtistIds = item.artists.map((a) => a.artist_id);
      if (projects.getArtistAssignModes().mention) {
        await slack.syncAssignMessage({
          token, channelId: targetChannelId, itemId: item.id, threadTs: state.threadTs, artistIds: mentionArtistIds,
        });
      }
      // React artis (poin revisi multi-artist) — data-driven, gak digate scope (flush SEMUA
      // reaction pending yang "milik" salah satu artis di item ini, sama kayak sebelumnya cuma
      // sekarang loop per-artis bukan 1 doang).
      for (const artist of item.artists) {
        const codeName = presetByMember.get(artist.artist_id)?.code_name;
        // !r.sent (poin revisi, chip react persisten) — listItemReactions sekarang balikin
        // SEMUA reaction (pending + udah sent), jangan flush ulang yang udah sent.
        const artistReaction = codeName && projects.listItemReactions(item.id).find((r) => r.slack_shortcode === codeName && !r.sent);
        if (artistReaction) {
          try {
            await slack.addReaction({ token, channelId: targetChannelId, timestamp: state.threadTs, name: artistReaction.slack_shortcode });
            projects.markItemReactionSent(artistReaction.id);
          } catch (err) {
            projects.addLog("error", `Gagal kasih reaction :${artistReaction.slack_shortcode}: ke "${item.name}": ${err.message}`);
          }
        }
      }
      // Status (poin revisi) — data-driven sama kayak artis di atas, force:true biar tetap
      // kesinkron walau toggle realtime OFF (thread-nya UDAH ADA dari fase 1 di atas).
      await reconcileItemStatusState({ projectId, itemId: item.id, force: true });
    });

    // Fase 3 — react lain (di luar react artis, misal ditambah manual lewat "Add React"). Gagal
    // per-reaction SENGAJA gak nggagalin seluruh item — dicatat log doang, tetap pending (gak
    // dihapus) biar bisa dicoba lagi lain kali.
    await runPass("react", "kirim react", async (item, state) => {
      for (const reaction of projects.listItemReactions(item.id).filter((r) => !r.sent)) {
        try {
          await slack.addReaction({ token, channelId: targetChannelId, timestamp: state.threadTs, name: reaction.slack_shortcode });
          projects.markItemReactionSent(reaction.id);
        } catch (err) {
          projects.addLog("error", `Gagal kasih reaction :${reaction.slack_shortcode}: ke "${item.name}": ${err.message}`);
        }
      }
    });

    // Fase 4 — reply/file lain di dalam thread (attach langsung + tiap Reply sesuai sort_order).
    // scope "item"/"artist" gak butuh reply, di-skip seluruh fase-nya (posts selalu kosong).
    if (scope !== "item" && scope !== "artist") {
      await runPass("post", "kirim reply", async (item, state) => {
        // posts (poin revisi, bug dilaporkan: merge >10 file misahin field jadi 2, field HASIL
        // PECAHAN gak kekirim padahal field pertama sukses) — root cause versi lama: SEMUA field
        // digabung 1 array, dikirim lewat SATU panggilan slack.sendReplies yang berhenti TOTAL
        // begitu SATU field di tengah gagal (field-field SETELAHNYA gak sempat dicoba sama
        // sekali), dan markReplySent cuma jalan abis SELURUH array sukses -- field yang SEBENARNYA
        // udah kekirim ke Slack pun gak ke-lock, attempt row (send_attempts, key SATU per item)
        // nyangkut "pending" nge-block field LAIN yang gak ada hubungannya biar bisa dicoba lagi.
        // Fix: tiap field (attach langsung + tiap reply) dikirim lewat panggilan sendReplies
        // TERPISAH, `key` DI-NAMESPACE per-field (bukan cuma threadKey polos punya item) biar
        // attempt/resume state-nya sendiri-sendiri -- gagal di 1 field gak nyangkut ke field lain:
        // yang sukses TETAP di-lock (markReplySent langsung abis field itu SENDIRI kelar), yang
        // gagal TETAP dicoba (gak ke-skip diam-diam gara-gara urutan array) dan bisa dicoba lagi
        // manual (Instant Intake per-field) tanpa keblok status field tetangganya.
        const baseKey = threadKey(projectId, item.id);
        const posts = [];
        // reply.sent (poin revisi, bug ditemukan lewat audit D10) — field yang UDAH kekirim
        // sebelumnya HARUS di-skip di sini, bukan cuma dikunci dari EDIT (assertReplyEditable).
        // Tanpa filter ini, batch berikutnya nyusun ULANG SEMUA item.replies (termasuk yang udah
        // sent) ke `posts`, sendReplies ngirim ulang jadi pesan DOBEL di Slack.
        if (scope !== "replies") {
          // Default (gak ada scope, dipakai SlackViewPreview/"Preview & Kirim") — attach langsung
          // dulu (kompatibilitas item_files lama), lalu tiap Reply (Batch File/Drawer/Template)
          // sesuai sort_order — teks jadi 1 pesan, file jadi 1 upload (+ caption judul reply-nya).
          if (!item.files.every((f) => projects.isManagedFile(f.stored_path))) throw new Error("Attachment item tidak berada dalam penyimpanan project.");
          if (item.files.length) posts.push({ key: `${baseKey}#attach`, replyId: null, post: { files: item.files.map((f) => ({ path: f.stored_path, filename: f.original_name })) } });
        }
        for (const reply of item.replies) {
          if (reply.sent) continue;
          const post = replyToPost(reply);
          if (post) posts.push({ key: `${baseKey}#reply:${reply.id}`, replyId: reply.id, post });
        }
        if (!posts.length) {
          // Gak ada apa-apa buat dikirim -- tetap panggil sendReplies posts kosong (bareKey polos)
          // biar attempt lama (kalau ada, dari sebelum fix ini) ke-bersihin, sama kayak versi lama.
          await slack.sendReplies({ token, channelId: targetChannelId, threadKey: baseKey, threadTs: state.threadTs, posts: [] });
          return;
        }
        let firstError = null;
        for (const { key, replyId, post } of posts) {
          try {
            const { permalink } = await slack.sendReplies({ token, channelId: targetChannelId, threadKey: key, threadTs: state.threadTs, posts: [post] });
            if (permalink) state.permalink = permalink;
            if (replyId) projects.markReplySent(replyId);
          } catch (err) {
            firstError = firstError || err;
            projects.addLog("error", `Gagal kirim field pada "${item.name}": ${err.message}`);
          }
        }
        if (firstError) throw firstError;
      });
    }

    const results = targets.map((item) => {
      const state = itemState.get(item.id);
      if (state.cancelled) return { itemId: item.id, itemName: item.name, status: "dibatalkan" };
      if (state.failed) return { itemId: item.id, itemName: item.name, status: "gagal", channelId: targetChannelId, reason: state.reason };
      return { itemId: item.id, itemName: item.name, status: "berhasil", isNew: state.isNew, threadTs: state.threadTs, permalink: state.permalink, channelId: targetChannelId };
    });

    const okCount = results.filter((r) => r.status === "berhasil").length;
  projects.addLog("info", `Kirim selesai (${project.name}): ${okCount}/${results.length} berhasil.`);
  const failedNames = results.filter((r) => r.status === "gagal").map((r) => r.itemName);
  await hbStatus.updateJobStatus(slack, token, statusHandle, hbStatus.formatJobDone({ totalJobs: results.length, okCount, failedNames }));
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
  const targetChannelId = channelId || slack.findThreadChannel(threadKey(projectId, item.id), project.channel_id) || project.channel_id;

  await confirmLegacyThread(projectId, item, targetChannelId);
  const itemThreadKey = threadKey(projectId, item.id);
  // Poin revisi (diminta user, "Instant Intake jadi sumber kebenaran") — sendItem punya proteksi
  // "Isi berubah sejak kiriman parsial" buat kiriman BATCH biasa yang beresiko upload dobel/
  // kesenjangan lama. Buat Instant Intake (aksi SEKALI klik, sengaja gak ada modal recovery),
  // user maunya app SELALU nurut isi TERKINI, gak nolak/minta "Pulihkan Kiriman" dulu — jadi
  // bersihin bookkeeping percobaan lama (kalau ada) SEBELUM manggil sendItem, restart bersih.
  function restart() {
    slack.resolveAttempt({ threadKey: itemThreadKey, channelId: targetChannelId, action: "restart" });
  }
  let threadTs, isNew, permalink;
  if (scope === "replies") {
    // Root dulu (posts kosong) — sendItem bikin/pakai ulang thread yang udah ada, idempoten.
    restart();
    ({ threadTs, isNew, permalink } = await slack.sendItem({ token, channelId: targetChannelId, itemName: item.name, threadKey: itemThreadKey, artistIds: [], posts: [] }));
    // Poin revisi (bug dilaporkan: field hasil pecahan Merge >10 file — mis. field ke-2 "Animatic"
    // berisi banyak file mp4 gede — kadang gagal upload, field lain yang independen ikut gak
    // kekirim/gak ke-lock gara-gara dulu SEMUA field digabung 1 panggilan sendItem) — sama kayak
    // fix di send:start fase "post": tiap field sekarang dikirim TERPISAH, gagal 1 field gak
    // ngeblok field lain, yang sukses TETAP ke-lock walau field tetangganya gagal.
    let firstError = null;
    for (const reply of item.replies) {
      if (reply.sent) continue;
      const post = replyToPost(reply);
      if (!post) continue;
      try {
        restart();
        const result = await slack.sendItem({ token, channelId: targetChannelId, itemName: item.name, threadKey: itemThreadKey, artistIds: [], posts: [post] });
        if (result.permalink) permalink = result.permalink;
        projects.markReplySent(reply.id);
      } catch (err) {
        firstError = firstError || err;
        projects.addLog("error", `Instant Intake gagal kirim field pada "${item.name}": ${err.message}`);
      }
    }
    if (firstError) throw firstError;
  } else {
    let posts = [];
    if (scope === "field") {
      const reply = item.replies.find((r) => r.id === replyId);
      if (!reply) throw new Error("Field tidak ditemukan.");
      const post = reply.sent ? null : replyToPost(reply); // udah kekirim -- no-op, bukan resend
      posts = post ? [post] : [];
    }
    // scope === "item" (default): posts kosong.
    restart();
    // artistIds SELALU kosong ke sendItem (poin revisi) -- mention-nya sekarang lewat
    // syncAssignMessage di bawah (SATU pesan assignment yang di-edit, konsisten sama batch),
    // bukan sendItem nge-post mention sendiri lagi.
    ({ threadTs, isNew, permalink } = await slack.sendItem({ token, channelId: targetChannelId, itemName: item.name, threadKey: itemThreadKey, artistIds: [], posts }));
    if (scope === "field" && replyToPost(item.replies.find((r) => r.id === replyId))) {
      projects.markReplySent(replyId);
    }
  }
  // Poin revisi: assign message (mode mention) disinkron di SINI juga, buat SEMUA scope Instant
  // Intake (item/artist/replies/field) -- bukan cuma pas "Kirim ke Slack" batch. Placeholder
  // (lihat syncAssignMessage) ke-post walau item ini belum ada artis-nya sama sekali.
  if (projects.getArtistAssignModes().mention) {
    await slack.syncAssignMessage({
      token, channelId: targetChannelId, itemId: item.id, threadTs, artistIds: item.artists.map((a) => a.artist_id),
    });
  }
  projects.addLog("info", `Instant Intake (${scope}) "${item.name}": berhasil.`);

  // Poin revisi: Instant Intake JUGA nge-flush reaction pending (item_reactions) — sama kayak
  // send:start. sendItem() di atas IDEMPOTEN (thread yang UDAH ADA gak di-post ulang, dipakai
  // ulang), jadi alurnya otomatis: "pesan belum ada" -> sendItem bikin thread baru DULU baru
  // reaction nyusul; "pesan udah ada" -> sendItem gak ngapa-ngapain (threadTs lama dipakai),
  // efeknya cuma reaction pending yang beneran kekirim.
  for (const reaction of projects.listItemReactions(item.id).filter((r) => !r.sent)) {
    try {
      await slack.addReaction({ token, channelId: targetChannelId, timestamp: threadTs, name: reaction.slack_shortcode });
      projects.markItemReactionSent(reaction.id);
    } catch (err) {
      projects.addLog("error", `Gagal kasih reaction :${reaction.slack_shortcode}: ke "${item.name}": ${err.message}`);
    }
  }
  // Status (poin revisi) — sinkron juga di Instant Intake, sama semangatnya kayak mention/react
  // di atas (force:true, gak nunggu toggle realtime).
  await reconcileItemStatusState({ projectId, itemId: item.id, force: true });

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
// Versi app sendiri (poin revisi) — TERPISAH dari update:check yang butuh internet/GitHub API
// (bisa gagal/reason kalau offline). Ini murni baca app.getVersion() lokal, jadi user SELALU
// bisa liat versi yang lagi jalan walau lagi gak ada koneksi.
handle("app:version", () => app.getVersion());

// ---------- Papan status HB Apps (poin revisi, hasil diskusi rate-limit) ----------
// Modal "Mulai Sesi Bersama HB Apps" — opsional, SEKALI per proses app. "Lewati" cuma nutup
// modalnya (hbOnline TETAP false, gak ada pesan Online DAN gak ada pesan Offline pas app
// ditutup nanti) — beda dari post status "Eksekusi job"/"Job selesai" pas kirim, yang WAJIB
// jalan terlepas dari status online/skip ini (himbauan mutlak, lihat send:start).
handle("hbStatus:shouldShowModal", () => !sessionModalShown);
handle("hbStatus:goOnline", async () => {
  sessionModalShown = true;
  hbOnline = true;
  const token = currentToken();
  await hbStatus.postStatus(slack, token, ":large_green_circle: Online");
  // Poin revisi (diminta user) — "Mulai Sesi" langsung buka Slack ke channel status (hb-apps),
  // biar user langsung liat siapa lagi online, gak perlu nyari channel-nya manual sendiri.
  const channelId = await hbStatus.findStatusChannel(slack, token);
  if (channelId) openSlack({ channelId });
});
handle("hbStatus:skip", () => { sessionModalShown = true; });

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
  const target = channelId || slack.findThreadChannel(key, project.channel_id) || project.channel_id;
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
