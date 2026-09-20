// Tombol Emoji + popover — SHARED, dipakai di toolbar field (Drawer.tsx/ReplyRow) DAN di Prefix
// modal Generate Item (MainTable.tsx). Poin revisi: popover ini SEKARANG cuma nampilin preset
// (bukan picker lengkap lagi) — daftar lengkapnya pindah ke dalam modal "Kelola preset" (buka
// lewat baris teks di bawah popover, ATAU dari menu Edit).
import { Suspense, useEffect, useState } from "react";
import { Smile, FileText, Loader2, X, Plus, ArrowLeft } from "lucide-react";
import type { EmojiPreset } from "../global";
import { useFileBlobUrl } from "../lib/fileUrl";
import { LazyEmojiPicker, type PickedEmoji } from "../lib/emojiPicker";
import EmojiPresetModal from "./EmojiPresetModal";

export default function EmojiPicker({ onPick }: { onPick: (text: string, preset: EmojiPreset) => void }) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<EmojiPreset[]>([]);
  const [showManage, setShowManage] = useState(false);

  function refresh() {
    window.api.emojiPreset.list().then(setPresets);
  }
  useEffect(() => {
    if (open) refresh();
  }, [open]);

  function pick(preset: EmojiPreset) {
    onPick(preset.type === "unicode" ? preset.value : `:${preset.value}:`, preset);
    setOpen(false);
  }

  return (
    <div style={{ position: "relative" }}>
      {/* onMouseDown preventDefault di tombol toggle DAN wrapper popover — biar fokus/selection di
          text area gak ilang duluan sebelum onPick jalan (bug lama: emoji gak ke-insert). */}
      <button className="icon-btn" title="Emoji" onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen((v) => !v)}>
        <Smile size={13} />
      </button>
      {open && (
        <div className="card" style={{ position: "absolute", bottom: 34, left: 0, padding: 8, width: 200, zIndex: 10 }} onMouseDown={(e) => e.preventDefault()}>
          {presets.length === 0 ? (
            <div className="caption" style={{ padding: "10px 4px", textAlign: "center" }}>
              Belum ada preset emoji.
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 4 }}>
              {presets.map((p) => (
                <EmojiPresetButton key={p.id} preset={p} onClick={() => pick(p)} />
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
        </div>
      )}
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

// Diexport — dipake ulang di picker gabungan preset+workspace Slack (ArtistPresetModal.tsx),
// biar gak duplikat render tombol grid preset.
export function EmojiPresetButton({ preset, onClick }: { preset: EmojiPreset; onClick: () => void }) {
  const url = useFileBlobUrl(preset.type === "custom" ? preset.image_path : null);
  return (
    <button
      onClick={onClick}
      title={preset.type === "custom" ? `:${preset.value}:` : undefined}
      style={{ border: "none", background: "none", fontSize: 16, cursor: "pointer", padding: 4, display: "flex", alignItems: "center", justifyContent: "center", width: 26, height: 26 }}
    >
      {preset.type === "unicode" ? preset.value : url ? <img src={url} alt="" style={{ width: 18, height: 18, objectFit: "contain" }} /> : <FileText size={14} className="muted" />}
    </button>
  );
}

// Picker GABUNGAN (poin revisi) — preset lokal (grid, sama kayak popover "Add React"), custom
// emoji workspace Slack (list nama+thumbnail, cari), DAN (poin revisi lanjutan) tombol "+" buka
// picker emoji STANDAR lengkap (emoji-mart, ribuan emoji unicode, sama yang dipakai EmojiPresetModal)
// — bisa langsung pilih tanpa perlu bikin preset dulu. Dipakai di modal Preset Artis DAN Kelola
// Status. Emoji workspace di-load 1x pas dialog dibuka (bukan disalin permanen ke preset lokal —
// "gabung" di sini artinya gabung TAMPILAN/pilihan doang).
//
// Poin revisi (bug dilaporkan): dulu render sebagai popover position:absolute nempel di tombol —
// kalau tombolnya ada di dalam container yang overflow:auto (kayak list Kelola Status/Preset
// Artis), popover-nya ke-CLIP sama scroll area itu, user harus scroll buat liat isinya. Sekarang
// dialog TERSENDIRI (position:fixed, di tengah layar, sama pola kayak modal lain di app ini) —
// gak mungkin ke-clip lagi, gak peduli tombolnya ada di mana pun.
export function CombinedEmojiPickerButton({
  onPickPreset,
  onPickSlack,
  onPickUnicode,
  disabled,
}: {
  onPickPreset: (preset: EmojiPreset) => void;
  onPickSlack: (name: string, url: string) => void;
  /** Pilih langsung dari picker emoji standar lengkap (tombol "+") — native = karakternya
   * sendiri, colons = shortcode Slack (":smile:", DENGAN titik dua) buat reactions.add. */
  onPickUnicode?: (native: string, colons: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [presets, setPresets] = useState<EmojiPreset[]>([]);
  const [slackEmojis, setSlackEmojis] = useState<{ name: string; url: string }[] | null>(null);
  const [loadingSlack, setLoadingSlack] = useState(false);
  const [slackError, setSlackError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showManage, setShowManage] = useState(false);

  function refreshPresets() {
    window.api.emojiPreset.list().then(setPresets);
  }

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      setShowFull(false);
      refreshPresets();
      if (slackEmojis === null && !loadingSlack) {
        setLoadingSlack(true);
        setSlackError(null);
        window.api.slack.listCustomEmojis()
          .then(setSlackEmojis)
          .catch((err) => setSlackError(err instanceof Error ? err.message : "Gagal ambil daftar emoji dari Slack."))
          .finally(() => setLoadingSlack(false));
      }
    }
  }

  function pickFull(emoji: PickedEmoji) {
    onPickUnicode?.(emoji.native, emoji.colons);
    setOpen(false);
  }

  const q = query.trim().toLowerCase();
  const filteredPresets = presets.filter((p) => !q || p.value.toLowerCase().includes(q) || (p.slack_shortcode || "").includes(q));
  const filteredSlack = (slackEmojis || []).filter((e) => e.name.includes(q));
  const nothingFound = !loadingSlack && filteredPresets.length === 0 && filteredSlack.length === 0;

  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button className="icon-btn" title="Pilih emoji (preset + workspace Slack)" disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={toggle}>
        <Smile size={13} />
      </button>
      {open && (
        <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 70, display: "flex", alignItems: "center", justifyContent: "center" }} onClick={() => setOpen(false)}>
          <div className="card" style={{ padding: 8, width: 280, maxHeight: "70vh", display: "flex", flexDirection: "column", background: "var(--surface)" }} onClick={(e) => e.stopPropagation()}>
            {showFull ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <button className="icon-btn" title="Kembali" onClick={() => setShowFull(false)}>
                    <ArrowLeft size={13} />
                  </button>
                  <span className="label" style={{ marginBottom: 0 }}>Semua Emoji</span>
                  <button className="icon-btn" style={{ marginLeft: "auto" }} onClick={() => setOpen(false)}>
                    <X size={13} />
                  </button>
                </div>
                <div style={{ flex: 1, overflow: "auto" }} className="scrollbar-thin">
                  <Suspense
                    fallback={
                      <div className="caption" style={{ textAlign: "center", padding: 20 }}>
                        Memuat emoji…
                      </div>
                    }
                  >
                    <LazyEmojiPicker onPick={pickFull} />
                  </Suspense>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <input
                    autoFocus
                    placeholder="Cari emoji…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    style={{ flex: 1, minWidth: 0 }}
                  />
                  {onPickUnicode && (
                    <button className="icon-btn" title="Semua emoji standar (bukan cuma preset)" onClick={() => setShowFull(true)}>
                      <Plus size={13} />
                    </button>
                  )}
                  <button className="icon-btn" onClick={() => setOpen(false)}>
                    <X size={13} />
                  </button>
                </div>
                <div style={{ flex: 1, overflow: "auto" }} className="scrollbar-thin">
                  {filteredPresets.length > 0 && (
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 4, marginBottom: 6 }}>
                      {filteredPresets.map((p) => (
                        <EmojiPresetButton key={p.id} preset={p} onClick={() => { onPickPreset(p); setOpen(false); }} />
                      ))}
                    </div>
                  )}
                  {loadingSlack && (
                    <div className="caption" style={{ textAlign: "center", padding: 10, display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                      <Loader2 size={13} className="spin" /> Memuat emoji workspace…
                    </div>
                  )}
                  {slackError && <div className="caption" style={{ color: "var(--danger)" }}>{slackError}</div>}
                  {!loadingSlack && filteredSlack.map((e) => (
                    <button
                      key={`slack-${e.name}`}
                      className="btn"
                      style={{ width: "100%", justifyContent: "flex-start", alignItems: "center", gap: 6, border: "none", fontSize: 12 }}
                      onClick={() => { onPickSlack(e.name, e.url); setOpen(false); }}
                    >
                      <img src={e.url} alt="" width={16} height={16} style={{ objectFit: "contain", flexShrink: 0 }} />
                      :{e.name}:
                    </button>
                  ))}
                  {nothingFound && <div className="caption" style={{ padding: "6px 0", textAlign: "center" }}>Gak ketemu.</div>}
                </div>
                <button
                  className="btn"
                  style={{ width: "100%", marginTop: 6, justifyContent: "center", fontSize: 11, padding: "4px 0", flexShrink: 0 }}
                  onClick={() => { setOpen(false); setShowManage(true); }}
                >
                  Kelola preset...
                </button>
              </>
            )}
          </div>
        </div>
      )}
      {showManage && <EmojiPresetModal onClose={() => { setShowManage(false); refreshPresets(); }} />}
    </div>
  );
}
