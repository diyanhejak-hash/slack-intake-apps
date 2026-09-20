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
import { useEffect, useRef, useState } from "react";
import { SmilePlus, Loader2 } from "lucide-react";
import type { EmojiPreset, ItemReaction } from "../global";
import { useFileBlobUrl } from "../lib/fileUrl";
import { getCustomEmojiImagePath, getCustomEmojiUnicode, subscribeEmojiPresets } from "../lib/emojiPresetStore";
import EmojiPresetModal from "./EmojiPresetModal";

// "Kelola preset..." (poin revisi: wajib ada di TIAP modal emoji, bukan cuma EmojiPicker.tsx) —
// popover ini dipakai 2 tempat (ItemReactionBar pending DAN InstantReactionOverlay), taruh di
// sini sekali biar dua-duanya konsisten dapet akses Kelola Preset yang sama.
function ReactionPickerPopover({ onPick, style }: { onPick: (preset: EmojiPreset) => void; style?: React.CSSProperties }) {
  const [presets, setPresets] = useState<EmojiPreset[]>([]);
  const [showManage, setShowManage] = useState(false);

  // Poin revisi: Artis Preset yang UDAH punya code_name + PNG lengkap otomatis JUGA muncul di
  // sini sebagai opsi react — gak perlu didaftarin ulang manual di Preset Emoji. Diperlakukan
  // persis kayak custom emoji preset biasa (type "custom", slack_shortcode = code_name-nya).
  function refresh() {
    Promise.all([window.api.emojiPreset.list(), window.api.artistPreset.list()]).then(([emojiList, artistList]) => {
      const artistAsPresets: EmojiPreset[] = artistList
        .filter((p) => p.code_name && p.image_path)
        .map((p) => ({ id: `artist-${p.id}`, type: "custom", value: p.code_name as string, image_path: p.image_path, slack_shortcode: p.code_name, sort_order: 9999 }));
      setPresets([...emojiList.filter((p) => p.slack_shortcode), ...artistAsPresets]);
    });
  }
  useEffect(() => {
    refresh();
  }, []);

  return (
    <div className="card" style={{ position: "absolute", padding: 8, width: 200, zIndex: 20, ...style }} onMouseDown={(e) => e.preventDefault()}>
      {presets.length === 0 ? (
        <div className="caption" style={{ padding: "10px 4px", textAlign: "center" }}>
          Belum ada preset emoji.
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 4 }}>
          {presets.map((p) => (
            <ReactionPresetButton key={p.id} preset={p} onClick={() => onPick(p)} />
          ))}
        </div>
      )}
      <button
        className="btn"
        style={{ width: "100%", marginTop: 6, justifyContent: "center", fontSize: 11, padding: "4px 0" }}
        onClick={() => setShowManage(true)}
      >
        Kelola preset...
      </button>
      {showManage && (
        <EmojiPresetModal
          onClose={() => {
            setShowManage(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function ReactionPresetButton({ preset, onClick }: { preset: EmojiPreset; onClick: () => void }) {
  const url = useFileBlobUrl(preset.type === "custom" ? preset.image_path : null);
  return (
    <button
      onClick={onClick}
      title={`:${preset.slack_shortcode}:`}
      style={{ border: "none", background: "none", fontSize: 16, cursor: "pointer", padding: 4, display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26 }}
    >
      {preset.type === "unicode" ? preset.value : url ? <img src={url} alt="" style={{ width: 18, height: 18, objectFit: "contain" }} /> : null}
    </button>
  );
}

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
  useEffect(() => subscribeEmojiPresets(() => forceTick((v) => v + 1)), []);
  const imagePath = reaction.emoji_type === "custom" ? getCustomEmojiImagePath(reaction.emoji_value) : undefined;
  const url = useFileBlobUrl(imagePath || null);
  // Poin revisi (bug dilaporkan: "emoji tidak show") — reaction dari artis/status yang preset-nya
  // pakai emoji STANDAR (bukan PNG custom) gak punya image_path, jatuh ke fallback teks doang.
  // Cek cache unicode SEBELUM nyerah ke teks ":nama:".
  const unicodeChar = reaction.emoji_type === "custom" && !imagePath ? getCustomEmojiUnicode(reaction.emoji_value) : undefined;

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
      ) : imagePath ? (
        <img src={url || undefined} alt={`:${reaction.emoji_value}:`} style={{ width: 16, height: 16, objectFit: "contain" }} />
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
  const [open, setOpen] = useState(false);
  // Klik di luar popover = tutup (poin revisi — sebelumnya cuma bisa ketutup lewat re-klik
  // tombol trigger-nya sendiri, "nyangkut" kalau user klik/gerak di tempat lain). Pola sama kayak
  // MenuBar (Chrome.tsx). containerRef bungkus TRIGGER+popover jadi 1 (display:contents, gak
  // ganggu layout absolute-nya) — klik tombol trigger sendiri masih di DALAM container, jadi gak
  // ke-treat sebagai "klik luar" (gak race sama toggle onClick-nya).
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);
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

  async function addPending(preset: EmojiPreset) {
    if (!preset.slack_shortcode) return;
    if (scope === "all") {
      const payload = { emojiType: preset.type, emojiValue: preset.value, slackShortcode: preset.slack_shortcode };
      const result = await window.api.itemReaction.addToProject(projectId, payload);
      setOpen(false);
      setScope("item");
      refresh();
      onBulkAdded?.();
      alert(`Reaction diantrekan ke ${result.added}/${result.total} item (sisanya udah pernah diantre reaction yang sama).`);
      return;
    }
    await window.api.itemReaction.add(itemId, { emojiType: preset.type, emojiValue: preset.value, slackShortcode: preset.slack_shortcode });
    setOpen(false);
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
      <div ref={containerRef} style={{ display: "contents" }}>
        {!hideButton && (
          <button
            className="row-quicksend quicksend-btn"
            title="Tambah reaction (antre, dikirim bareng pas Kirim ke Slack) — BUKAN kirim instan"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
            style={{
              // Di SAMPING KANAN tombol Instant Intake (poin revisi, balik ke posisi ini) —
              // Instant Intake di top:-3/left:-8 (22px), jadi tombol ini nempel di kanannya. top
              // -3 (bukan -8, poin revisi) — sama alasan kayak QuickSendButton, biar clip-nya
              // minim pas baris ini jadi baris paling atas nempel header sticky.
              position: "absolute", top: -3, left: 16, width: 22, height: 22, borderRadius: "50%",
              background: "var(--accent)", border: "2px solid var(--surface)", color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
              cursor: "pointer", zIndex: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            }}
          >
            <SmilePlus size={12} />
          </button>
        )}
        {/* CHIP hasil react (poin revisi) — BUKAN tombolnya, ini "React emoji itu sendiri". Absolute
            di BAWAH item rata kiri (top:26/left:0, beda dari tombol yang poking kanan-atas) —
            SELALU tampil (gak dihover-gate kayak tombol), soalnya ini info status pending yang
            relevan buat dilihat kapan aja, bukan aksi sesaat. */}
        {visiblePending.length > 0 && (
          <div style={{ position: "absolute", top: 26, right: 0, display: "flex", gap: 1, zIndex: 1 }}>{chips}</div>
        )}
        {open && (
          <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 16, zIndex: 20 }} onMouseDown={(e) => e.preventDefault()}>
            {scopeToggle}
            <ReactionPickerPopover onPick={addPending} style={{ position: "static" }} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ position: "relative", display: "flex", alignItems: "center", gap: 4 }}>
      {!hideButton && (
        <button className="icon-btn" title="Tambah reaction (antre, dikirim bareng pas Kirim ke Slack)" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}>
          <SmilePlus size={14} />
        </button>
      )}
      {chips}
      {open && (
        <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 20 }} onMouseDown={(e) => e.preventDefault()}>
          {scopeToggle}
          <ReactionPickerPopover onPick={addPending} style={{ position: "static" }} />
        </div>
      )}
    </div>
  );
}

export function InstantReactionOverlay({ projectId, itemId }: { projectId: string; itemId: string }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  // Klik di luar popover = tutup. (Sempat pakai auto-close pas hover-zone mouse-out juga, tapi
  // itu bikin popover ketutup DULUAN pas mouse baru mau turun ngeklik emoji-nya — sebab popover-nya
  // render di luar kotak elemen hover-zone [absolute, escape ke bawah], jadi keluar-masuk hit-test-nya
  // ke-treat mouseleave walau DOM-nya masih descendant. Dicabut, klik-luar aja cukup.)
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  async function sendInstant(preset: EmojiPreset) {
    if (!preset.slack_shortcode || sending) return;
    setSending(true);
    try {
      await window.api.reaction.sendInstant({ projectId, itemId, slackShortcode: preset.slack_shortcode });
      setOpen(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : "Gagal kasih reaction.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div ref={containerRef} style={{ display: "contents" }}>
      <button
        className="row-quicksend quicksend-btn"
        title="Reaction instan — kirim langsung ke Slack"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        style={{
          position: "absolute",
          top: -8,
          left: -8,
          width: 22,
          height: 22,
          borderRadius: "50%",
          background: "var(--success)",
          border: "2px solid var(--surface)",
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          cursor: "pointer",
          zIndex: 2,
          boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
        }}
      >
        {sending ? <Loader2 size={11} className="spin" /> : <SmilePlus size={12} />}
      </button>
      {open && <ReactionPickerPopover onPick={sendInstant} style={{ top: "calc(100% + 4px)", left: 0 }} />}
    </div>
  );
}
