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
import type { EmojiPreset, ItemReaction } from "../global";
import { useFileBlobUrl } from "../lib/fileUrl";
import EmojiPresetModal from "./EmojiPresetModal";

// "Kelola preset..." (poin revisi: wajib ada di TIAP modal emoji, bukan cuma EmojiPicker.tsx) —
// popover ini dipakai 2 tempat (ItemReactionBar pending DAN InstantReactionOverlay), taruh di
// sini sekali biar dua-duanya konsisten dapet akses Kelola Preset yang sama.
function ReactionPickerPopover({ onPick, style }: { onPick: (preset: EmojiPreset) => void; style?: React.CSSProperties }) {
  const [presets, setPresets] = useState<EmojiPreset[]>([]);
  const [showManage, setShowManage] = useState(false);

  function refresh() {
    window.api.emojiPreset.list().then((list) => setPresets(list.filter((p) => p.slack_shortcode)));
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

// Chip pending cuma nampilin teks (unicode karakter, atau ":nama:" buat custom) — item_reactions
// gak nyimpen image_path (itu ada di emoji_presets), jadi gak coba nampilin thumbnail PNG di sini
// biar gak perlu cross-reference-in ulang. ":nama:" doang udah cukup informatif buat antrean.
// Poin revisi: gak ada tombol X lagi — klik CHIP-nya langsung (seluruh badge) = hapus dari
// antrean. Poin revisi lagi: gak ada border/background lagi — cukup tampilin react-nya doang.
function ReactionChip({ reaction, onRemove }: { reaction: ItemReaction; onRemove: () => void }) {
  return (
    <button
      onClick={onRemove}
      title={`:${reaction.slack_shortcode}: — pending, klik buat batal (hapus dari antrean)`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        border: "none",
        background: "none",
        padding: 2,
        fontSize: 15,
        cursor: "pointer",
      }}
    >
      {reaction.emoji_type === "unicode" ? reaction.emoji_value : `:${reaction.emoji_value}:`}
    </button>
  );
}

// `variant`:
//   - "inline" (default, Tab Reply — sebelah Pil Item) — icon SELALU KELIHATAN + chip pending
//     sejajar (flow biasa).
//   - "overlay" (Tab Table, poin revisi) — tombol jadi overlay (posisi sama kayak QuickSendButton
//     variant "overlay", DI SAMPING KANAN Instant Intake — top:-8/left:16),
//     cuma nongol pas hover cell (`.row-quicksend`). Chip pending di-render IN-FLOW (bukan absolute) — caller
//     (MainTable.tsx) yang bungkus <input>+komponen ini dalam satu flex row, jadi chip otomatis
//     nempel di KANAN input (poin revisi: "kolom Item dibagi 2 kalau ada react"). Ini TETAP jalur
//     pending (antre), BUKAN instant — beda dari InstantReactionOverlay.
// `hideButton` (overlay doang) — sembunyiin TOMBOLNYA aja pas cell lagi diedit (poin revisi,
// sama kayak QuickSendButton), tapi CHIP tetap tampil (gak ganggu proses edit).
export function ItemReactionBar({ projectId, itemId, variant = "inline", hideButton = false }: { projectId: string; itemId: string; variant?: "inline" | "overlay"; hideButton?: boolean }) {
  const [pending, setPending] = useState<ItemReaction[]>([]);
  const [open, setOpen] = useState(false);
  // Poin revisi: "React semua Item, atau React hanya item ini" — toggle scope SEBELUM milih
  // emoji, biar 1 klik emoji langsung nentuin ke mana reaction-nya keantre. Default "item"
  // (paling aman) tiap kali popover dibuka lagi.
  const [scope, setScope] = useState<"item" | "all">("item");

  function refresh() {
    window.api.itemReaction.list(itemId).then(setPending);
  }
  useEffect(() => {
    refresh();
  }, [itemId]);

  async function addPending(preset: EmojiPreset) {
    if (!preset.slack_shortcode) return;
    if (scope === "all") {
      if (!confirm(`Antrekan reaction ${preset.type === "unicode" ? preset.value : `:${preset.slack_shortcode}:`} ke SEMUA item di project ini?`)) return;
      const payload = { emojiType: preset.type, emojiValue: preset.value, slackShortcode: preset.slack_shortcode };
      const result = await window.api.itemReaction.addToProject(projectId, payload);
      setOpen(false);
      setScope("item");
      refresh();
      alert(`Reaction diantrekan ke ${result.added}/${result.total} item (sisanya udah pernah diantre reaction yang sama).`);
      return;
    }
    await window.api.itemReaction.add(itemId, { emojiType: preset.type, emojiValue: preset.value, slackShortcode: preset.slack_shortcode });
    setOpen(false);
    setScope("item");
    refresh();
  }

  async function removePending(id: string) {
    await window.api.itemReaction.remove(id);
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
  const chips = pending.map((r) => <ReactionChip key={r.id} reaction={r} onRemove={() => removePending(r.id)} />);

  if (variant === "overlay") {
    return (
      <>
        {!hideButton && (
          <button
            className="row-quicksend quicksend-btn"
            title="Tambah reaction (antre, dikirim bareng pas Kirim ke Slack) — BUKAN kirim instan"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
            style={{
              // Di SAMPING KANAN tombol Instant Intake (poin revisi) — Instant Intake di
              // top:-8/left:-8 (22px), jadi tombol ini nempel di kanannya (left:16, top sama).
              position: "absolute", top: -8, left: 16, width: 22, height: 22, borderRadius: "50%",
              background: "var(--accent)", border: "2px solid var(--surface)", color: "#fff",
              display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
              cursor: "pointer", zIndex: 2, boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            }}
          >
            <SmilePlus size={12} />
          </button>
        )}
        {/* In-flow (BUKAN absolute) — sengaja, biar jadi flex item alami di samping <input> pas
            dibungkus flex row sama caller (poin revisi: "kolom Item dibagi 2 kalau ada react",
            chip di KANAN input, bukan di bawah lagi). */}
        {pending.length > 0 && <div style={{ display: "flex", flexShrink: 0, gap: 3 }}>{chips}</div>}
        {open && (
          <div style={{ position: "absolute", top: "calc(100% + 4px)", left: 16, zIndex: 20 }} onMouseDown={(e) => e.preventDefault()}>
            {scopeToggle}
            <ReactionPickerPopover onPick={addPending} style={{ position: "static" }} />
          </div>
        )}
      </>
    );
  }

  return (
    <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 4 }}>
      <button className="icon-btn" title="Tambah reaction (antre, dikirim bareng pas Kirim ke Slack)" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}>
        <SmilePlus size={14} />
      </button>
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
    <>
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
    </>
  );
}
