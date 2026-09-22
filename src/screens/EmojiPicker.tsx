import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Loader2, Search, Smile, Star, X } from "lucide-react";
import { loadSlackEmoji, loadUnicodeEmoji, type EmojiCategory, type EmojiChoice } from "../lib/emojiCatalog";

const FAVORITES_KEY = "slack-intake.emoji-favorites.v1";
const COLS = 9;
const ROW_HEIGHT = 42;
const VIEW_HEIGHT = 294;

function readFavorites(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(FAVORITES_KEY) || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function VirtualEmojiGrid({ emojis, favorites, onToggleFavorite, onPick }: {
  emojis: EmojiChoice[];
  favorites: Set<string>;
  onToggleFavorite: (emoji: EmojiChoice) => void;
  onPick: (emoji: EmojiChoice) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const rows = Math.ceil(emojis.length / COLS);
  const startRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 2);
  const endRow = Math.min(rows, Math.ceil((scrollTop + VIEW_HEIGHT) / ROW_HEIGHT) + 2);
  const visible = emojis.slice(startRow * COLS, endRow * COLS);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = 0;
    setScrollTop(0);
  }, [emojis]);

  if (!emojis.length) return <div className="emoji-empty">Emoji tidak ditemukan.</div>;

  return (
    <div ref={ref} className="emoji-grid-scroll scrollbar-thin" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
      <div className="emoji-grid" style={{ paddingTop: startRow * ROW_HEIGHT, paddingBottom: Math.max(0, (rows - endRow) * ROW_HEIGHT) }}>
        {visible.map((emoji) => {
          const favorite = favorites.has(emoji.key);
          const tooltip = emoji.type === "custom" ? `:${emoji.shortcode}:` : `${emoji.name} · :${emoji.shortcode}:`;
          return (
            <div className="emoji-cell" key={emoji.key}>
              <button className="emoji-tile" title={tooltip} aria-label={`Pilih ${tooltip}`} onMouseDown={(event) => event.preventDefault()} onClick={() => onPick(emoji)}>
                {emoji.imageUrl ? <img src={emoji.imageUrl} alt="" loading="lazy" /> : <span>{emoji.value}</span>}
              </button>
              <button
                className={`emoji-favorite ${favorite ? "active" : ""}`}
                title={favorite ? "Hapus dari favorit" : "Tambah ke favorit"}
                aria-label={favorite ? `Hapus ${tooltip} dari favorit` : `Tambahkan ${tooltip} ke favorit`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => { event.stopPropagation(); onToggleFavorite(emoji); }}
              >
                <Star size={10} fill={favorite ? "currentColor" : "none"} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function UniversalEmojiPicker({ onPick, disabled, title = "Emoji", triggerClassName = "icon-btn", triggerStyle, triggerContent, headerExtra }: {
  onPick: (emoji: EmojiChoice) => void | Promise<void>;
  disabled?: boolean;
  title?: string;
  triggerClassName?: string;
  triggerStyle?: CSSProperties;
  triggerContent?: ReactNode;
  headerExtra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [unicodeCategories, setUnicodeCategories] = useState<EmojiCategory[]>([]);
  const [slackEmoji, setSlackEmoji] = useState<EmojiChoice[]>([]);
  const [slackError, setSlackError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const [favorites, setFavorites] = useState(readFavorites);
  const [activeCategory, setActiveCategory] = useState(() => readFavorites().length ? "favorites" : "slack");

  useEffect(() => {
    if (!open || unicodeCategories.length) return;
    setLoading(true);
    Promise.allSettled([loadUnicodeEmoji(), loadSlackEmoji()]).then(([unicodeResult, slackResult]) => {
      if (unicodeResult.status === "fulfilled") setUnicodeCategories(unicodeResult.value);
      if (slackResult.status === "fulfilled") setSlackEmoji(slackResult.value);
      else setSlackError(slackResult.reason instanceof Error ? slackResult.reason.message : "Gagal memuat emoji Slack.");
    }).finally(() => setLoading(false));
  }, [open, unicodeCategories.length]);

  const allEmoji = useMemo(() => [...slackEmoji, ...unicodeCategories.flatMap((category) => category.emojis)], [slackEmoji, unicodeCategories]);
  const favoriteSet = useMemo(() => new Set(favorites), [favorites]);
  const favoriteEmoji = useMemo(() => favorites.map((key) => allEmoji.find((emoji) => emoji.key === key)).filter((emoji): emoji is EmojiChoice => Boolean(emoji)), [favorites, allEmoji]);
  const categories = useMemo(() => [
    ...(favoriteEmoji.length ? [{ id: "favorites", label: "Favorit", icon: "★", emojis: favoriteEmoji }] : []),
    { id: "slack", label: "Emoji Slack", icon: "S", emojis: slackEmoji },
    ...unicodeCategories,
  ], [favoriteEmoji, slackEmoji, unicodeCategories]);
  const shownEmoji = useMemo(() => deferredQuery
    ? allEmoji.filter((emoji) => emoji.keywords.includes(deferredQuery) || emoji.shortcode.includes(deferredQuery))
    : categories.find((category) => category.id === activeCategory)?.emojis || [], [activeCategory, allEmoji, categories, deferredQuery]);
  const shownLabel = deferredQuery ? `Hasil pencarian · ${shownEmoji.length}` : categories.find((category) => category.id === activeCategory)?.label || "Emoji";

  useEffect(() => {
    if (allEmoji.length && activeCategory === "favorites" && !favoriteEmoji.length) setActiveCategory("slack");
  }, [activeCategory, allEmoji.length, favoriteEmoji.length]);

  function toggleFavorite(emoji: EmojiChoice) {
    setFavorites((current) => {
      const next = current.includes(emoji.key) ? current.filter((key) => key !== emoji.key) : [emoji.key, ...current];
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function pick(emoji: EmojiChoice) {
    await onPick(emoji);
    setOpen(false);
  }

  return (
    <>
      <button className={triggerClassName} style={triggerStyle} title={title} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); setOpen(true); }}>
        {triggerContent || <Smile size={13} />}
      </button>
      {open && (
        <div className="emoji-dialog-backdrop" role="dialog" aria-modal="true" aria-label="Pilih emoji" onMouseDown={() => setOpen(false)}>
          <div className="emoji-dialog" onMouseDown={(event) => event.stopPropagation()}>
            <div className="emoji-dialog-header">
              <div className="emoji-search"><Search size={14} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Cari emoji atau shortcode…" /></div>
              <button className="icon-btn" title="Tutup" aria-label="Tutup pemilih emoji" onClick={() => setOpen(false)}><X size={15} /></button>
            </div>
            {headerExtra}
            <div className="emoji-category-bar scrollbar-thin" aria-label="Kategori emoji">
              {categories.map((category) => (
                <button key={category.id} className={activeCategory === category.id && !deferredQuery ? "active" : ""} title={category.label} aria-label={category.label} onClick={() => { setQuery(""); setActiveCategory(category.id); }}>
                  {category.id === "slack" ? <span className="emoji-slack-mark">S</span> : category.icon}
                </button>
              ))}
            </div>
            <div className="emoji-section-title"><span>{shownLabel}</span>{slackError && <span className="emoji-load-error" title={slackError}>Slack tidak tersedia</span>}</div>
            {loading && !allEmoji.length ? <div className="emoji-loading"><Loader2 size={18} className="spin" /> Memuat emoji…</div> : <VirtualEmojiGrid emojis={shownEmoji} favorites={favoriteSet} onToggleFavorite={toggleFavorite} onPick={pick} />}
            <div className="emoji-dialog-footer">Klik emoji untuk memilih · arahkan mouse untuk melihat shortcode</div>
          </div>
        </div>
      )}
    </>
  );
}

export default function EmojiPicker({ onPick }: { onPick: (emoji: EmojiChoice) => void | Promise<void> }) {
  return <UniversalEmojiPicker onPick={onPick} />;
}
