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
      require('../electron/auth-store.cjs').loadToken = () => ({ userId: 'SMOKE', teamId: 'SMOKE', team: 'Test', accessToken: 'FAKE' });
      const fixture = path.join(temp, 'fixture.txt');
      fs.writeFileSync(fixture, 'fixture');
      electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fixture] });
      const files = await win.webContents.executeJavaScript(`(async () => {
        await window.api.auth.status();
        const p = await window.api.project.create({name: 'Smoke', channelId: 'CA', channelName: 'test'});
        const picked = await window.api.item.pickFiles();
        await window.api.project.attachFiles(p.id, picked);
        const loaded = await window.api.project.load(p.id);
        const bytes = await window.api.file.readBytes(loaded.files[0].stored_path);
        const denied = await window.api.file.readBytes(picked[0]).then(() => false, () => true);
        return { count: loaded.files.length, bytes: new TextDecoder().decode(bytes), denied };
      })()`);
      assert.equal(files.count, 1);
      assert.equal(files.bytes, 'fixture');
      assert.equal(files.denied, true);
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
