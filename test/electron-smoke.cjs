const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const electron = require('electron');
const { app, BrowserWindow } = electron;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-smoke-'));
app.setPath('userData', temp);
// No real configuration, Slack requests, visible windows, or tray icons in this test.
require('dotenv').config = () => ({});
delete process.env.VITE_DEV;
electron.BrowserWindow = class extends BrowserWindow {
  constructor(options) { super({ ...options, show: false }); }
  show() {}
};
electron.Tray = class { setToolTip() {} setContextMenu() {} on() {} destroy() {} };
electron.shell.openExternal = async () => { throw new Error('External navigation during smoke test'); };
// Poin revisi (bug ditemukan lewat audit, Q03) -- main.cjs (non-packaged, Windows) register
// `slackintakeapps://` protocol handler ke process.argv[1], yang pas dijalanin dari smoke test
// ini NUNJUK KE FILE SMOKE TEST INI SENDIRI (bukan entry point app asli) -- efek sampingnya
// nyantol PERMANEN ke registry OS developer (HKCU/.../slackintakeapps), ngerusak login OAuth
// beneran (callback selanjutnya buka smoke test ini, bukan app). Stub total SEBELUM main.cjs
// di-require di bawah, biar smoke test SAMA SEKALI gak nyentuh registry OS.
app.setAsDefaultProtocolClient = () => true;
let completed = false;
const deadline = setTimeout(() => { console.error('Electron smoke timeout'); app.exit(1); }, 20000);
app.on('browser-window-created', (_event, win) => {
  win.webContents.once('did-finish-load', async () => {
    try {
      const state = await win.webContents.executeJavaScript(`(async () => {
        const status = await window.api.auth.status();
        const denied = await window.api.project.create({name: 'unauthenticated', channelId: 'CA', channelName: 'a'}).then(() => false, () => true);
        let body = document.body.innerText;
        for (let i = 0; i < 50 && !/Slack/.test(body); i++) {
          await new Promise((r) => setTimeout(r, 100));
          body = document.body.innerText;
        }
        return { status, body, denied };
      })()`);
      assert.equal(state.status.loggedIn, false);
      assert.equal(state.denied, true);
      assert.match(state.body, /Slack/);
      assert.equal(win.getTitle(), `Slack Intake Apps v${app.getVersion()}`);
      require('../electron/auth-store.cjs').loadToken = () => ({ userId: 'SMOKE', teamId: 'SMOKE', team: 'Test', accessToken: 'FAKE' });
      const fixture = path.join(temp, 'fixture.txt');
      fs.writeFileSync(fixture, 'fixture');
      // Poin revisi (bug ditemukan lewat audit, Q01) -- test LAMA nganggep file yang BARU aja
      // dipilih lewat picker (picked[0]) harusnya DITOLAK dibaca, padahal kebijakan akses
      // SEKARANG sengaja ngizinin file yang udah dapet picker grant (allowFiles, main.cjs) --
      // itu bukan bug, itu kontrak yang emang diinginkan. File TERPISAH yang gak PERNAH lewat
      // picker/grant apa pun (ungranted) yang seharusnya jadi bukti nyata proteksi akses masih
      // jalan, bukan pakai file yang justru UDAH dikasih akses.
      const ungranted = path.join(temp, 'ungranted.txt');
      fs.writeFileSync(ungranted, 'never granted');
      electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
      const files = await win.webContents.executeJavaScript(`(async () => {
        await window.api.auth.status();
        const p = await window.api.project.create({name: 'Smoke', channelId: 'CA', channelName: 'test'});
        const picked = await window.api.item.pickFiles();
        await window.api.project.attachFiles(p.id, picked);
        const loaded = await window.api.project.load(p.id);
        const bytes = await window.api.file.readBytes(loaded.files[0].stored_path);
        const pickedReadable = await window.api.file.readBytes(picked[0]).then(() => true, () => false);
        const denied = await window.api.file.readBytes(${JSON.stringify(ungranted)}).then(() => false, () => true);
        return { count: loaded.files.length, bytes: new TextDecoder().decode(bytes), pickedReadable, denied };
      })()`);
      assert.equal(files.count, 1);
      assert.equal(files.bytes, 'fixture');
      assert.equal(files.pickedReadable, true); // file yang DIPILIH tetap boleh dibaca (kebijakan picker-grant SEKARANG)
      assert.equal(files.denied, true); // file LAIN yang gak pernah di-grant TETAP ditolak
      completed = true;
      console.log('PASS: real Electron preload, login renderer, IPC auth, picker grants, managed read, and external read rejection');
      clearTimeout(deadline);
      require('../electron/db.cjs').db.close();
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  });
});
process.on('exit', () => {
  if (!completed) return;
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith('intake-smoke-'));
  // Chromium can retain handles until process exit; parent test command may clean this temp later.
  try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
});
require('../electron/main.cjs');
