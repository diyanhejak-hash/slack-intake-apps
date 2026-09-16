export interface AuthStatus {
  loggedIn: boolean;
  userId?: string;
  team?: string;
}

export interface SlackChannel {
  id: string;
  name: string;
  isPrivate: boolean;
}

export interface SlackUser {
  id: string;
  name: string;
  avatar?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  channel_id: string;
  channel_name: string;
  created_at: string;
  updated_at: string;
}

export interface ItemFile {
  id: string;
  stored_path: string;
  original_name: string;
  sort_order: number;
}

export interface ReplyFile {
  id: string;
  stored_path: string;
  original_name: string;
}

export interface Reply {
  id: string;
  item_id: string;
  category: string;
  title: string;
  text_value: string | null;
  sort_order: number;
  files: ReplyFile[];
}

export interface ProjectItem {
  id: string;
  project_id: string;
  name: string;
  artist_id: string | null;
  artist_name: string | null;
  source: "manual" | "folder-import";
  sort_order: number;
  files: ItemFile[];
  replies: Reply[];
}

export interface Project extends ProjectSummary {
  items: ProjectItem[];
  /** General Display (Tab Reply, panel kiri) — level project, gak reset pas ganti item. */
  files: ItemFile[];
}

export interface SendResult {
  itemId: string;
  itemName: string;
  status: "berhasil" | "gagal" | "dibatalkan";
  isNew?: boolean;
  threadTs?: string;
  permalink?: string;
  channelId?: string;
  reason?: string;
}

export interface ArtistGroup {
  id: string;
  name: string;
  memberIds: string[];
}

export interface TemplateField {
  label: string;
}

export interface Template {
  id: string;
  name: string;
  is_builtin: number;
  fields: TemplateField[];
}

export interface MergeSnapshot {
  keepId: string;
  keepOriginalName: string;
  separator: string;
  itemIds: string[];
  items: Array<{
    id: string;
    project_id: string;
    name: string;
    artist_id: string | null;
    artist_name: string | null;
    sort_order: number;
    source: string;
    fileIds: string[];
    replies: Reply[];
  }>;
}

export interface BatchFileEntry {
  id: string;
  path: string;
  filename: string;
  connectedItemIds: string[];
}

export interface BatchSection {
  id: string;
  name: string;
  files: BatchFileEntry[];
}

export interface LogEntry {
  id: string;
  level: "info" | "error";
  message: string;
  created_at: string;
}

export interface HyperlinkPreset {
  id: string;
  label: string;
  url: string;
}

export interface EmojiPreset {
  id: string;
  type: "unicode" | "custom";
  /** unicode: karakter emoji-nya sendiri. custom: nama TANPA titik dua (dipakai jadi ":value:" pas insert). */
  value: string;
  /** cuma ada buat type "custom" — path PNG lokal, buat preview picker doang. */
  image_path: string | null;
  /** nama Slack TANPA titik dua (poin revisi fitur Reaction) — dibutuhin buat reactions.add. */
  slack_shortcode: string | null;
  sort_order: number;
}

export interface ItemReaction {
  id: string;
  item_id: string;
  emoji_type: "unicode" | "custom";
  emoji_value: string;
  slack_shortcode: string;
  sort_order: number;
}

/** Artis Preset (poin revisi) — satu per Slack member_id, lihat catatan skema di electron/db.cjs. */
export interface ArtistPreset {
  id: string;
  member_id: string;
  /** ganti tampilan nama di dropdown Artis — null = fallback ke nama Slack asli. */
  nickname: string | null;
  /** shortcode custom emoji TANPA titik dua, buat workflow "assign via reaction". */
  code_name: string | null;
  /** PNG lokal — preview doang (chip/manajemen preset), gak disinkronkan ke Slack. */
  image_path: string | null;
  /** Mode assign GLOBAL (poin revisi, bukan per-item lagi) — 2 toggle independen (Mention/React).
   * 'mention' (default) | 'react' | 'both' (dua-duanya aktif) | 'none' (dua-duanya nonaktif). */
  mode: "mention" | "react" | "both" | "none";
}

declare global {
  interface Window {
    api: {
      auth: {
        status: () => Promise<AuthStatus>;
        login: () => Promise<AuthStatus>;
        logout: () => Promise<AuthStatus>;
      };
      slack: {
        listChannels: () => Promise<SlackChannel[]>;
        listUsers: () => Promise<SlackUser[]>;
        createChannel: (payload: { name: string; memberIds: string[] }) => Promise<{ channelId: string; name: string }>;
      };
      project: {
        releaseUndo: (id: string) => Promise<void>;
        legacyCount: () => Promise<number>;
        recoverLegacy: () => Promise<number>;
        create: (payload: { name: string; channelId: string; channelName: string }) => Promise<Project>;
        list: () => Promise<ProjectSummary[]>;
        load: (id: string) => Promise<Project>;
        rename: (id: string, name: string) => Promise<void>;
        delete: (id: string) => Promise<void>;
        duplicate: (id: string, newName: string) => Promise<string>;
        export: (id: string) => Promise<{ canceled: boolean; filePath?: string }>;
        import: () => Promise<{ canceled: boolean; projectId?: string }>;
        attachFiles: (projectId: string, filePaths: string[]) => Promise<void>;
        removeFile: (fileId: string) => Promise<void>;
      };
      item: {
        addManual: (payload: { projectId: string; name: string; artistId?: string; artistName?: string }) => Promise<string>;
        update: (itemId: string, patch: Record<string, unknown>) => Promise<void>;
        remove: (itemId: string) => Promise<void>;
        merge: (itemIds: string[], separator?: string) => Promise<{ keepId: string; snapshot: MergeSnapshot | null }>;
        unmerge: (snapshot: MergeSnapshot | null) => Promise<void>;
        restore: (snapshot: ProjectItem) => Promise<void>;
        pickFiles: () => Promise<string[]>;
        attachFiles: (itemId: string, filePaths: string[]) => Promise<void>;
        removeFile: (fileId: string) => Promise<void>;
      };
      reply: {
        // category gak dikirim dari renderer lagi — backend hitung sendiri dari title (title
        // kosong -> fallback ke id reply-nya sendiri, biar reply tanpa judul gak pernah
        // ke-match reply tanpa judul lain di Broadcast/Merge).
        add: (payload: { itemId: string; title: string; textValue?: string; filePaths?: string[] }) => Promise<string>;
        update: (replyId: string, patch: { title?: string; textValue?: string }) => Promise<void>;
        remove: (replyId: string) => Promise<void>;
        removeMany: (replyIds: string[]) => Promise<void>;
        removeFile: (fileId: string) => Promise<void>;
        removeManyEverywhere: (projectId: string, categories: string[]) => Promise<void>;
        reorder: (itemId: string, orderedReplyIds: string[]) => Promise<void>;
        addFiles: (replyId: string, itemId: string, filePaths: string[]) => Promise<void>;
        broadcast: (replyId: string, projectId: string) => Promise<void>;
        addCaptured: (itemId: string, dataUrl: string, filename: string) => Promise<string>;
        addCapturedToReply: (replyId: string, itemId: string, dataUrl: string, filename: string) => Promise<void>;
      };
      artistGroup: {
        list: () => Promise<ArtistGroup[]>;
        save: (payload: { id?: string; name: string; memberIds: string[] }) => Promise<string>;
        delete: (id: string) => Promise<void>;
      };
      template: {
        applyAll: (projectId: string, templateId: string) => Promise<void>;
        list: () => Promise<Template[]>;
        save: (payload: { id?: string; name: string; fields: TemplateField[] }) => Promise<string>;
        delete: (id: string) => Promise<void>;
      };
      hyperlink: {
        list: () => Promise<HyperlinkPreset[]>;
        save: (payload: { id?: string; label: string; url: string }) => Promise<string>;
        delete: (id: string) => Promise<void>;
      };
      emojiPreset: {
        list: () => Promise<EmojiPreset[]>;
        addUnicode: (payload: { char: string; shortcode?: string }) => Promise<string | null>;
        addCustom: (payload: { name: string; filePath: string }) => Promise<string>;
        remove: (id: string) => Promise<void>;
        /** Dialog pilih file PNG lokal — null kalau dibatalkan. */
        pickImage: () => Promise<string | null>;
      };
      /** Artis Preset (poin revisi) — nickname/code_name/PNG/mode GLOBAL per Slack member. */
      artistPreset: {
        list: () => Promise<ArtistPreset[]>;
        /** `id` dikasih = update; gak dikasih = insert baru (member_id wajib belum punya preset).
         * `mode` opsional — gak diisi = 'mention' (insert) atau nilai lama dipertahankan (update). */
        save: (payload: { id?: string; memberId: string; nickname?: string; codeName?: string; sourcePath?: string; mode?: "mention" | "react" | "both" | "none" }) => Promise<string>;
        remove: (id: string) => Promise<void>;
        /** Dialog pilih file PNG lokal — null kalau dibatalkan. */
        pickImage: () => Promise<string | null>;
      };
      /** Reaction PENDING per item (poin revisi) — nunggu dikirim bareng lewat send.start. */
      itemReaction: {
        list: (itemId: string) => Promise<ItemReaction[]>;
        add: (itemId: string, payload: { emojiType: "unicode" | "custom"; emojiValue: string; slackShortcode: string }) => Promise<string | null>;
        /** Poin revisi "React semua Item" — antre reaction yang sama ke SEMUA item di project ini. */
        addToProject: (
          projectId: string,
          payload: { emojiType: "unicode" | "custom"; emojiValue: string; slackShortcode: string }
        ) => Promise<{ total: number; added: number }>;
        remove: (id: string) => Promise<void>;
      };
      /** Reaction INSTAN (poin revisi) — fire-and-forget, butuh thread yang udah ada. */
      reaction: {
        sendInstant: (payload: { projectId: string; itemId: string; slackShortcode: string }) => Promise<boolean>;
      };
      send: {
        recover: (payload: {projectId: string; itemId: string; channelId?: string; threadLink?: string}) => Promise<{message?: string; needsThreadLink?: boolean}>;
        /** `scope` opsional — Instant Intake per-KOLOM (poin revisi, overlay di header tabel):
         * terapkan ke SEMUA itemIds sekaligus lewat loop send:start yang sama (progress/cancel/
         * satu openSlack doang), bukan panggil `quick` berkali-kali. Gak diisi = perilaku lama
         * (kirim semuanya: file+reply+artis). */
        start: (payload: { projectId: string; itemIds: string[]; channelId?: string; scope?: "item" | "artist" | "replies" }) => Promise<{ results: SendResult[] }>;
        /** "Instant Intake" — kirim langsung TANPA modal preview, scoped ke sebagian item aja
         * (bukan full send:start). "field" wajib disertai replyId. */
        quick: (payload: {
          projectId: string;
          itemId: string;
          channelId?: string;
          scope: "item" | "artist" | "replies" | "field";
          replyId?: string;
        }) => Promise<{ itemId: string; itemName: string; threadTs: string; isNew: boolean; permalink?: string; channelId: string }>;
        cancel: () => Promise<boolean>;
        onProgress: (cb: (data: { projectId: string; jobId: string; index: number; total: number; itemName: string }) => void) => () => void;
        onDone: (cb: (data: { projectId: string; jobId: string; results: SendResult[] }) => void) => () => void;
      };
      update: {
        check: () => Promise<{ available: boolean; latest?: string; current?: string; url?: string; reason?: string }>;
      };
      shell: {
        openExternal: (url: string) => Promise<void>;
        openSlackMessage: (payload: { channelId: string; ts?: string }) => Promise<void>;
      };
      system: {
        /** Cek eksistensi file di lokasi install baku Slack Desktop (poin revisi) — dipakai buat
         * saran "install Slack Desktop" pas pertama kali app dibuka. downloadUrl dihitung di main
         * process (process.platform gak ambigu, beda dari navigator.platform di renderer). */
        hasSlackDesktop: () => Promise<{ installed: boolean; downloadUrl: string }>;
      };
      log: {
        list: (limit?: number) => Promise<LogEntry[]>;
        clear: () => Promise<void>;
      };
      batchFile: {
        pickFiles: () => Promise<string[]>;
        listSections: (projectId: string) => Promise<BatchSection[]>;
        saveSections: (projectId: string, sections: BatchSection[]) => Promise<void>;
        apply: (projectId: string) => Promise<{ added: number }>;
      };
      file: {
        /** Sinkron — Electron 32+ butuh ini buat dapetin path asli dari File hasil drag-drop OS. */
        getPathForFile: (file: File) => string;
        /** Baca bytes file lewat main process — pdf.js gak diandalkan fetch(file://) langsung. */
        readBytes: (filePath: string) => Promise<Uint8Array>;
      };
    };
  }
}
