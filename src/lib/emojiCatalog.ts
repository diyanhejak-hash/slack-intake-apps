export type EmojiChoice = {
  key: string;
  type: "unicode" | "custom";
  value: string;
  shortcode: string;
  name: string;
  imageUrl?: string;
  category: string;
  keywords: string;
};

export type EmojiCategory = { id: string; label: string; icon: string; emojis: EmojiChoice[] };

type EmojiMartEntry = { id: string; name: string; keywords?: string[]; skins?: { native: string }[] };
type EmojiMartData = {
  categories: { id: string; emojis: string[] }[];
  emojis: Record<string, EmojiMartEntry>;
};

const CATEGORY_META: Record<string, { label: string; icon: string }> = {
  people: { label: "Ekspresi & orang", icon: "😀" },
  nature: { label: "Hewan & alam", icon: "🐻" },
  foods: { label: "Makanan & minuman", icon: "🍜" },
  activity: { label: "Aktivitas", icon: "⚽" },
  places: { label: "Perjalanan & tempat", icon: "🚗" },
  objects: { label: "Objek", icon: "💡" },
  symbols: { label: "Simbol", icon: "❤️" },
  flags: { label: "Bendera", icon: "🏁" },
};

let unicodePromise: Promise<EmojiCategory[]> | null = null;
let slackPromise: Promise<EmojiChoice[]> | null = null;
let imageCache = new Map<string, string>();
let unicodeCache = new Map<string, string>();
const listeners = new Set<() => void>();

export function loadUnicodeEmoji(): Promise<EmojiCategory[]> {
  if (!unicodePromise) {
    unicodePromise = import("@emoji-mart/data").then((module) => {
      const data = module.default as EmojiMartData;
      const nextUnicode = new Map<string, string>();
      const categories = data.categories.map((category) => {
        const meta = CATEGORY_META[category.id] || { label: category.id, icon: "•" };
        const emojis = category.emojis.flatMap((id): EmojiChoice[] => {
          const entry = data.emojis[id];
          const native = entry?.skins?.[0]?.native;
          if (!entry || !native) return [];
          nextUnicode.set(id, native);
          return [{
            key: `unicode:${id}`,
            type: "unicode",
            value: native,
            shortcode: id,
            name: entry.name,
            category: category.id,
            keywords: `${entry.name} ${id} ${(entry.keywords || []).join(" ")}`.toLowerCase(),
          }];
        });
        return { id: category.id, label: meta.label, icon: meta.icon, emojis };
      });
      unicodeCache = nextUnicode;
      listeners.forEach((listener) => listener());
      return categories;
    });
  }
  return unicodePromise;
}

export function loadSlackEmoji(force = false): Promise<EmojiChoice[]> {
  if (force) {
    slackPromise = null;
    imageCache = new Map();
  }
  if (!slackPromise) {
    slackPromise = window.api.slack.listCustomEmojis().then((items) => {
      const next = new Map(imageCache);
      const choices = items.map((item): EmojiChoice => {
        next.set(item.name, item.url);
        return {
          key: `slack:${item.name}`,
          type: "custom",
          value: item.name,
          shortcode: item.name,
          name: item.name,
          imageUrl: item.url,
          category: "slack",
          keywords: item.name.toLowerCase(),
        };
      });
      imageCache = next;
      listeners.forEach((listener) => listener());
      return choices;
    }).catch((error) => {
      slackPromise = null;
      throw error;
    });
  }
  return slackPromise;
}

export async function refreshEmojiCatalogCache(): Promise<void> {
  const [, artistPresets] = await Promise.all([
    loadUnicodeEmoji(),
    window.api.artistPreset.list(),
    loadSlackEmoji(true).catch(() => []),
  ]);
  const nextImages = new Map(imageCache);
  const nextUnicode = new Map(unicodeCache);
  for (const preset of artistPresets) {
    if (!preset.code_name) continue;
    if (preset.image_path) nextImages.set(preset.code_name, preset.image_path);
    else if (preset.unicode_value) nextUnicode.set(preset.code_name, preset.unicode_value);
  }
  imageCache = nextImages;
  unicodeCache = nextUnicode;
  listeners.forEach((listener) => listener());
}

export function getEmojiImageSource(name: string): string | undefined {
  return imageCache.get(name);
}

export function getEmojiUnicode(name: string): string | undefined {
  return unicodeCache.get(name);
}

export function subscribeEmojiCatalog(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
