// Socket Mode client tipis (poin revisi, sync 2 arah reaction Slack->app) — modul ini CUMA
// ngurusin lifecycle koneksi WebSocket-nya (start/stop/status), gak nyimpen logika bisnis apa
// pun (cocokin code_name ke artis/status dst ada di main.cjs, biar bisa reuse projects.cjs/
// slack.cjs/threadKey/reconcile yang udah ada tanpa import silang aneh-aneh).
//
// Kenapa Socket Mode (bukan HTTP webhook biasa) — app ini desktop, gak ada server publik buat
// nerima event HTTP dari Slack. Socket Mode bikin koneksi KELUAR (app -> Slack), jadi gak butuh
// endpoint publik sama sekali, cocok buat app lokal kayak ini.
const { SocketModeClient } = require("@slack/socket-mode");

let client = null;

async function stop() {
  if (!client) return;
  const old = client;
  client = null;
  old.removeAllListeners();
  try {
    await old.disconnect();
  } catch {
    /* best-effort -- lagi mau berhenti, gak masalah kalau disconnect-nya sendiri gagal */
  }
}

// onReaction(type, event) dipanggil tiap "reaction_added"/"reaction_removed" nyampe.
// onMessage(event) dipanggil tiap pesan baru (poin revisi, otomasi WIP) -- cuma kepake kalau
// Event Subscriptions message.channels/message.groups di-subscribe (lihat SlackSyncSettingsModal).
// onStatus(status, detail?) dipanggil tiap perubahan state koneksi -- "connecting" | "connected" |
// "disconnected" | "error" -- buat indikator di UI Settings.
// Poin revisi (bug ditemukan lewat audit, D09) — `client` DULU diisi SEBELUM await c.start(),
// tapi gak dikosongkan lagi kalau start()-nya GAGAL (token salah, network mati, dst). isRunning()
// cuma ngecek "ada objek client apa enggak", jadi abis start() gagal, isRunning() TETAP balikin
// true -- jalur reconnect (updateSocketModeConnectionState, main.cjs) ngira koneksi udah jalan,
// gak pernah nyoba start ulang. Sekarang `client` cuma diisi SETELAH c.start() BENERAN sukses;
// kalau gagal, listener dibersihin dan error dilempar ke pemanggil (biar keliatan jelas gagal).
async function start(appToken, { onReaction, onMessage, onStatus }) {
  await stop();
  const c = new SocketModeClient({ appToken });

  c.on("reaction_added", ({ event, ack }) => {
    ack().catch(() => {});
    onReaction?.("reaction_added", event);
  });
  c.on("reaction_removed", ({ event, ack }) => {
    ack().catch(() => {});
    onReaction?.("reaction_removed", event);
  });
  c.on("message", ({ event, ack }) => {
    ack().catch(() => {});
    onMessage?.(event);
  });
  c.on("connecting", () => onStatus?.("connecting"));
  c.on("connected", () => onStatus?.("connected"));
  c.on("disconnected", () => onStatus?.("disconnected"));
  c.on("error", (err) => onStatus?.("error", err?.message || String(err)));

  try {
    await c.start();
  } catch (err) {
    c.removeAllListeners();
    throw err;
  }
  client = c;
}

function isRunning() {
  return !!client;
}

module.exports = { start, stop, isRunning };
