// Fitur Reaction (poin revisi) — koor pakai reaction Slack sebagai status/assignment di lapangan.
// 2 jalur BEDA, jangan digabung:
//   - ItemReactionBar: icon SELALU KELIHATAN di sebelah Pil Item, nambah ke daftar PENDING
//     (item_reactions, DB) — baru beneran kekirim ke Slack pas "Kirim ke Slack" biasa (urutan:
//     pesan utama -> semua reply -> reaction, lihat main.cjs send:start).
//   - InstantReactionOverlay: overlay yang nongol pas HOVER Pil Item (pola sama kayak Instant
//     Intake — delay 0.5s, `.row-quicksend`), klik = LANGSUNG kirim reactions.add ke Slack, gak
//     pernah nyentuh tabel item_reactions sama sekali. Butuh item yang UDAH PERNAH dikirim
//     (ada thread) — kalau belum, error jelas, BUKAN auto-bikin pesan baru cuma buat reaction.
//
// Preset TANPA slack_shortcode (harusnya gak ada lagi buat preset baru, tapi jaga-jaga) DIFILTER
// dari picker reaction — reactions.add WAJIB punya nama, beda dari insert teks reply yang cuma
// perlu ":value:" doang.
import { useEffect, useState } from "react";
import { SmilePlus, Loader2 } from "lucide-react";
import type { ItemReaction } from "../global";
import { useFileBlobUrl } from "../lib/fileUrl";
import { getEmojiImageSource, getEmojiUnicode, subscribeEmojiCatalog, type EmojiChoice } from "../lib/emojiCatalog";
import { UniversalEmojiPicker } from "./EmojiPicker";

// Chip pending — unicode tampil karakternya langsung, custom SEKARANG tampil PNG-nya (poin
// revisi, sebelumnya cuma teks ":nama:" karena item_reactions gak nyimpen image_path). Path-nya
// di-cross-reference dari cache global emojiPresetStore (sama persis pola EmojiImageNode.tsx
// buat custom emoji di Lexical editor) — SYNCHRONOUS, gak perlu fetch ulang di sini. Kalau
// preset-nya udah dihapus/cache belum kemuat, fallback teks ":nama:" biar gak keliatan "rusak".
// Poin revisi: gak ada tombol X lagi — klik CHIP-nya langsung (seluruh badge) = hapus dari
// antrean. Poin revisi lagi: gak ada border/background lagi — cukup tampilin react-nya doang.
// Poin revisi terbaru (bug: "chip hilang abis kekirim, ambigu keliatan kayak gak ada react") —
// chip yang UDAH sent TETAP tampil (baris item_reactions gak dihapus lagi abis reactions.add
// sukses, cuma ditandain sent=1) — dikasih tint hijau lembut biar beda jelas dari yang masih
// pending, klik-nya sekarang beneran reactions.remove ke Slack (bukan cuma batal antre lokal).
function ReactionChip({ reaction, onRemove }: { reaction: ItemReaction; onRemove: () => void }) {
  const [, forceTick] = useState(0);
  useEffect(() => subscribeEmojiCatalog(() => forceTick((v) => v + 1)), []);
  const imageSource = reaction.emoji_type === "custom" ? getEmojiImageSource(reaction.emoji_value) : undefined;
  const remoteImage = imageSource?.startsWith("http") ? imageSource : undefined;
  const localUrl = useFileBlobUrl(imageSource && !remoteImage ? imageSource : null);
  const imageUrl = remoteImage || localUrl;
  // Poin revisi (bug dilaporkan: "emoji tidak show") — reaction dari artis/status yang preset-nya
  // pakai emoji STANDAR (bukan PNG custom) gak punya image_path, jatuh ke fallback teks doang.
  // Cek cache unicode SEBELUM nyerah ke teks ":nama:".
  const unicodeChar = reaction.emoji_type === "custom" && !imageSource ? getEmojiUnicode(reaction.emoji_value) : undefined;

  return (
    <button
      onClick={onRemove}
      title={
        reaction.sent
          ? `:${reaction.slack_shortcode}: — udah terkirim ke Slack, klik buat hapus beneran`
          : `:${reaction.slack_shortcode}: — pending, klik buat batal (hapus dari antrean)`
      }
      style={{
        display: "inline-flex",
        alignItems: "center",
        border: "none",
        background: reaction.sent ? "var(--success-soft, rgba(34, 197, 94, 0.16))" : "none",
        borderRadius: reaction.sent ? 4 : 0,
        padding: 2,
        fontSize: 15,
        cursor: "pointer",
      }}
    >
      {reaction.emoji_type === "unicode" ? (
        reaction.emoji_value
      ) : imageSource ? (
        <img src={imageUrl || undefined} alt={`:${reaction.emoji_value}:`} style={{ width: 16, height: 16, objectFit: "contain" }} />
      ) : unicodeChar ? (
        unicodeChar
      ) : (
        `:${reaction.emoji_value}:`
      )}
    </button>
  );
}

// `variant`:
//   - "inline" (default, Tab Input — kanan item Pill) — icon + chip pending sejajar (flow biasa).
//   - "overlay" (Tab Table, poin revisi) — TOMBOL-nya overlay di SAMPING KANAN Instant Intake
//     (top:-8/left:16), cuma nongol pas hover cell (`.row-quicksend`). CHIP hasil react (bukan
//     tombolnya!) itu elemen BEDA — absolute DI BAWAH item rata kanan (top:26/right:0) dan SELALU
//     tampil (gak hover-gated), soalnya itu status pending yang relevan diliat kapan aja. Ini
//     TETAP jalur pending (antre), BUKAN instant — beda dari InstantReactionOverlay.
// `hideButton` — sembunyiin TOMBOLNYA doang, CHIP tetap tampil. Overlay: pas cell lagi diedit
// (poin revisi, sama kayak QuickSendButton). Inline (poin revisi terbaru, diminta user) — Tab
// Input sekarang murni nampilin chip di kanan item Pill, gak ada tombol "Add React" lagi di situ.
export function ItemReactionBar({
  projectId,
  itemId,
  variant = "inline",
  hideButton = false,
  refreshToken,
  onBulkAdded,
  excludeShortcodes,
}: {
  projectId: string;
  itemId: string;
  variant?: "inline" | "overlay";
  hideButton?: boolean;
  refreshToken?: unknown;
  onBulkAdded?: () => void;
  /** Poin revisi (diminta user) — react yang dari ASSIGNMENT ARTIS (code_name preset artis yang
   * lagi ditugaskan ke item ini) gak usah dobel ditampilin di sini lagi — udah kelihatan lewat
   * icon di ArtistPicker sendiri. Bar ini jadi murni buat reaction MANUAL ("Add React"), bukan
   * ngubah data/pengiriman-nya sama sekali, cuma nge-filter TAMPILAN doang. */
  excludeShortcodes?: string[];
}) {
  const [pending, setPending] = useState<ItemReaction[]>([]);
  // Poin revisi: "React semua Item, atau React hanya item ini" — toggle scope SEBELUM milih
  // emoji, biar 1 klik emoji langsung nentuin ke mana reaction-nya keantre. Default "item"
  // (paling aman) tiap kali popover dibuka lagi.
  const [scope, setScope] = useState<"item" | "all">("item");

  function refresh() {
    window.api.itemReaction.list(itemId).then(setPending);
  }
  // refreshToken (poin revisi) — Instant Intake (send:quick) DAN full send (send:start) sekarang
  // sama-sama nge-flush reaction pending ke Slack di server, tapi state `pending` di sini fetch
  // SENDIRI (gak otomatis tau). Caller (MainTable.tsx) bump refreshToken abis kirim sukses biar
  // chip yang udah kekirim ilang dari UI, bukan nyangkut keliatan pending padahal udah terkirim.
  useEffect(() => {
    refresh();
  }, [itemId, refreshToken]);

  async function addPending(emoji: EmojiChoice) {
    if (scope === "all") {
      const payload = { emojiType: emoji.type, emojiValue: emoji.value, slackShortcode: emoji.shortcode };
      const result = await window.api.itemReaction.addToProject(projectId, payload);
      setScope("item");
      refresh();
      onBulkAdded?.();
      alert(`Reaction diantrekan ke ${result.added}/${result.total} item (sisanya udah pernah diantre reaction yang sama).`);
      return;
    }
    await window.api.itemReaction.add(itemId, { emojiType: emoji.type, emojiValue: emoji.value, slackShortcode: emoji.shortcode });
    setScope("item");
    refresh();
  }

  async function removePending(id: string) {
    try {
      await window.api.itemReaction.remove(id);
    } catch (err) {
      // Poin revisi (bug dilaporkan) — chip ini bisa aja UDAH kehapus di backend duluan (sync 2
      // arah reaction Slack->App), state di sini baru ke-refresh belakangan. Daripada nge-alert
      // error yang ngagetin buat kasus "emang udah gak ada", cukup refresh diem-diem KECUALI
      // errornya beneran laen (mis. gagal koneksi Slack pas reactions.remove).
      if (!(err instanceof Error) || !err.message.includes("tidak ditemukan")) {
        alert(err instanceof Error ? err.message : "Gagal hapus reaction.");
      }
    }
    refresh();
  }

  const scopeToggle = (
    <div className="card" style={{ display: "flex", gap: 2, padding: 3, marginBottom: 4, width: 200 }}>
      <button
        className="btn"
        style={{ flex: 1, padding: "3px 0", justifyContent: "center", fontSize: 11, ...(scope === "item" ? { borderColor: "var(--accent)", color: "var(--accent)", background: "var(--accent-soft)" } : {}) }}
        onClick={() => setScope("item")}
      >
        Item ini
      </button>
      <button
        className="btn"
        style={{ flex: 1, padding: "3px 0", justifyContent: "center", fontSize: 11, ...(scope === "all" ? { borderColor: "var(--accent)", color: "var(--accent)", background: "var(--accent-soft)" } : {}) }}
        onClick={() => setScope("all")}
      >
        Semua item
      </button>
    </div>
  );
  const visiblePending = excludeShortcodes?.length ? pending.filter((r) => !excludeShortcodes.includes(r.slack_shortcode)) : pending;
  const chips = visiblePending.map((r) => <ReactionChip key={r.id} reaction={r} onRemove={() => removePending(r.id)} />);

  if (variant === "overlay") {
    return (
      <div style={{ display: "contents" }}>
        {!hideButton && (
          <UniversalEmojiPicker
            onPick={addPending}
            title="Tambah reaction (antre, dikirim saat Kirim ke Slack)"
            triggerClassName="row-quicksend quicksend-btn"
            triggerStyle={{
              position: "absolute", top: -3, left: 16, width: 22, height: 22, borderRadius: "50%",
              background: "var(--accent)", border: "2px solid var(--surface)", color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
              cursor: "pointer", zIndex: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            }}
            triggerContent={<SmilePlus size={12} />}
            headerExtra={scopeToggle}
          />
        )}
        {visiblePending.length > 0 && (
          <div style={{ position: "absolute", top: 26, right: 0, display: "flex", gap: 1, zIndex: 1 }}>{chips}</div>
        )}
      </div>
    );
  }

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 4 }}>
      {!hideButton && (
        <UniversalEmojiPicker
          onPick={addPending}
          title="Tambah reaction (antre, dikirim saat Kirim ke Slack)"
          triggerContent={<SmilePlus size={14} />}
          headerExtra={scopeToggle}
        />
      )}
      {chips}
    </div>
  );
}

export function InstantReactionOverlay({ projectId, itemId }: { projectId: string; itemId: string }) {
  const [sending, setSending] = useState(false);

  async function sendInstant(emoji: EmojiChoice) {
    if (sending) return;
    setSending(true);
    try {
      await window.api.reaction.sendInstant({ projectId, itemId, slackShortcode: emoji.shortcode });
    } catch (err) {
      alert(err instanceof Error ? err.message : "Gagal kasih reaction.");
    } finally {
      setSending(false);
    }
  }

  return (
    <UniversalEmojiPicker
      onPick={sendInstant}
      disabled={sending}
      title="Reaction instan - kirim langsung ke Slack"
      triggerClassName="row-quicksend quicksend-btn"
      triggerStyle={{
        position: "absolute", top: -8, left: -8, width: 22, height: 22, borderRadius: "50%",
        background: "var(--success)", border: "2px solid var(--surface)", color: "#fff",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
        cursor: "pointer", zIndex: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
      }}
      triggerContent={sending ? <Loader2 size={11} className="spin" /> : <SmilePlus size={12} />}
    />
  );
}
