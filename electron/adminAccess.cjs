// Sistem Admin/Member (poin revisi, diminta user) — keanggotaan 1 channel PRIVAT ("hb-adm",
// nama baku) JADI daftar admin-nya sendiri, bukan data custom (JSON/dsb) yang perlu ditulis-baca
// manual. Owner (akun Slack dengan email tertentu) yang atur siapa aja anggota channel ini
// (invite/kick lewat modal "Manage Member Admin" di main.cjs); user LAIN cukup diminta login
// ulang abis ditambahin, app ngecek ulang keanggotaan channel ini dan otomatis nyalain fitur
// Sync Realtime (event) + Otomasi Kata Kunci kalau ketemu jadi anggota -- Slack sendiri yang
// jadi "database" access control-nya, app cuma nanya.
//
// Kenapa channel WAJIB privat: users.conversations (dipakai listChannels(), slack.cjs) cuma
// nampilin channel privat yang si USER YANG LOGIN beneran anggotanya -- channel publik nongol ke
// SEMUA orang di workspace terlepas dari member apa enggak, jadi gate ini jebol kalau publik.
const ADMIN_CHANNEL_NAME = "hb-adm";
const OWNER_EMAIL = "diyanhejak@gmail.com";

let cachedChannelId = null;
let scanned = false;

// findAdminChannel — SENGAJA reuse listChannels() yang udah ada (bukan panggilan API baru):
// "ketemu di listChannels() milik user ini" = "dia anggota channel privat ini", gak perlu
// conversations.members/conversations.info terpisah. Cache SEKALI per proses app, pola sama
// persis kayak hbStatus.cjs findStatusChannel (di-refresh otomatis tiap restart app/re-login).
//
// Poin revisi (bug ditemukan lewat audit, D05/D06) — 2 fix:
// 1. WAJIB cek c.isPrivate juga, bukan cocokin NAMA doang -- siapa pun anggota workspace bisa
//    bikin channel PUBLIK bernama "hb-adm" (kebetulan/iseng), yang otomatis nongol ke listChannels
//    SEMUA orang (beda dari privat yang cuma kelihatan ke member beneran) -- tanpa cek ini,
//    gate-nya jebol total buat siapa aja.
// 2. `scanned=true` cuma dipasang abis request BENERAN sukses (dulu dipasang SEBELUM request) --
//    kegagalan network/API dianggap "belum pasti", BUKAN "gak ketemu", jadi panggilan berikutnya
//    nyoba lagi. Sebelumnya sekali gagal (mis. hiccup jaringan) langsung ke-cache negatif SELAMA
//    proses app hidup, gak akan retry otomatis walau internet udah pulih.
async function findAdminChannel(slack, token) {
  if (cachedChannelId) return cachedChannelId;
  if (scanned) return null;
  try {
    const channels = await slack.listChannels(token);
    scanned = true; // cuma tandain "udah pasti gak ketemu" abis request BENERAN sukses
    const found = channels.find((c) => c.name.toLowerCase() === ADMIN_CHANNEL_NAME && c.isPrivate);
    if (found) cachedChannelId = found.id;
  } catch { /* gagal (network/API) -- JANGAN cache, biar dicoba lagi panggilan berikutnya */ }
  return cachedChannelId;
}

async function isAdminMember(slack, token) {
  return !!(await findAdminChannel(slack, token));
}

function isOwner(email) {
  return !!email && email.toLowerCase() === OWNER_EMAIL;
}

// Dipakai abis owner bikin/invite ke channel-nya sendiri (channel baru ketemu, cache lama masih
// "null" dari scan sebelum channel-nya ada) -- biar findAdminChannel scan ulang, bukan nyangkut
// di cache negatif permanen.
function invalidateCache() {
  cachedChannelId = null;
  scanned = false;
}

module.exports = { ADMIN_CHANNEL_NAME, OWNER_EMAIL, findAdminChannel, isAdminMember, isOwner, invalidateCache };
