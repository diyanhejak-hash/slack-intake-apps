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
  /** Tahap alur kerja (poin revisi, diminta user; nama lama "Assign") — "setup" (nyusun daftar
   * item, kolom Artis/Status/Pull/Push disembunyiin) atau "input" (kolom lengkap, tombol "Kirim
   * ke Slack" diganti Pull/Push/Toggle). Project BARU mulai dari "setup"; project LAMA (sebelum
   * kolom ini ada) default "input" biar gak kehilangan fitur yang udah dipakai. Setup->Input
   * digate backend (projects.cjs setProjectPhase): SEMUA item harus has_thread dulu. */
  phase: "setup" | "input";
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
  /** Poin revisi (diminta user) — field ini UDAH PERNAH kekirim ke Slack (lewat Instant Intake
   * atau batch "Kirim ke Slack") apa belum. Dipakai Tab Input buat mutusin field-nya boleh
   * diedit lagi atau dikunci read-only (isi Slack gak ikut ke-update kalau field diedit
   * setelah terkirim — lihat diskusi rename item yang gak nyampe ke pesan root). */
  sent: boolean;
  /** Slack member ID yang melakukan pengiriman terakhir. */
  sent_by_user_id?: string | null;
}

/** Multi-artist per item (poin revisi) — ganti artist_id/artist_name tunggal yang lama. */
export interface ItemArtist {
  id: string;
  artist_id: string;
  artist_name: string | null;
}

export interface ProjectItem {
  id: string;
  project_id: string;
  name: string;
  artists: ItemArtist[];
  /** Status aktif item ini (poin revisi, fitur Status) — null = belum ada status dipilih. */
  status_id: string | null;
  source: "manual" | "folder-import";
  sort_order: number;
  files: ItemFile[];
  replies: Reply[];
  /** Poin revisi — item ini UDAH PERNAH kirim ke Slack (ada baris di tabel `threads`) apa belum.
   * Dipakai overlay Instant Intake buat mutusin: has_thread true -> Push (sinkron ulang assign/
   * status doang), false -> Instant Intake beneran (bikin thread + kirim isi). */
  has_thread: boolean;
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

export interface ItemReaction {
  id: string;
  item_id: string;
  emoji_type: "unicode" | "custom";
  emoji_value: string;
  slack_shortcode: string;
  sort_order: number;
  /** Poin revisi (bug: "chip react hilang abis kekirim, ambigu") — 0 = masih pending (antre,
   * belum kekirim), 1 = UDAH beneran ada di Slack (reactions.add sukses). Baris TETAP disimpan
   * abis kekirim (dulu langsung dihapus) — chip tetap tampil, klik-nya jadi reactions.remove ke
   * Slack beneran (bukan cuma batal antre lokal lagi). SQLite INTEGER, bukan boolean asli. */
  sent: 0 | 1;
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
  /** Karakter emoji standar (poin revisi) — cuma keisi kalau BUKAN custom/PNG, mutually
   * exclusive sama image_path, biar tetep kepreview beneran abis reload. */
  unicode_value: string | null;
}

/** Preset Status (poin revisi, fitur "Status" per item) — daftar bebas, GLOBAL. */
export interface StatusPreset {
  id: string;
  /** nama tampilan di dropdown Status. */
  name: string;
  /** shortcode custom emoji TANPA titik dua, dikirim sebagai reaction di pesan root. */
  code_name: string;
  /** PNG lokal — preview doang (dropdown/modal Kelola Status), gak disinkronkan ke Slack. */
  image_path: string | null;
  /** Karakter emoji standar — mutually exclusive sama image_path, lihat catatan ArtistPreset. */
  unicode_value: string | null;
}

/** Otomasi Kata Kunci (poin revisi) — mapping bebas "kata kunci di reply thread" -> "set status
 * ATAU assign artis". Daftar bebas, GLOBAL, 1 keyword boleh punya beberapa baris (target beda). */
export interface KeywordAutomation {
  id: string;
  /** teks yang dicari di pesan Slack (word-boundary, case-insensitive), mis. "@WIP". */
  keyword: string;
  target_type: "status" | "artist";
  /** status_presets.id (target_type="status") ATAU Slack member_id (target_type="artist"). */
  target_id: string;
}

/** Mode assign Mention/React (poin revisi — balik bisa DUA-duanya aktif bareng, koreksi dari
 * percobaan sebelumnya yang sempat mutually-exclusive) — GLOBAL buat SEMUA artis, 2 flag
 * independen (bukan 1 mode string lagi). */
export interface ArtistAssignModes {
  mention: boolean;
  react: boolean;
  multi: boolean;
}

declare global {
  interface Window {
    api: {
      auth: {
        status: () => Promise<AuthStatus>;
        login: () => Promise<AuthStatus>;
        logout: () => Promise<AuthStatus>;
        /** Diagnostik manual (poin revisi) — paksa tukar refresh_token SEKARANG (gak nunggu
         * access token beneran expired), buat user ngetes mekanisme auto-refresh kapan aja. */
        testRefresh: () => Promise<{ ok: boolean; reason: string | null }>;
      };
      /** Sistem Admin/Member (poin revisi, diminta user) — isOwner: email akun Slack cocok
       * hardcode di adminAccess.cjs (buka modal "Manage Member Admin"). isAdminMember: anggota
       * channel privat "hb-adm" (buka fitur Sync Realtime/Otomasi Kata Kunci yang default
       * hidden). */
      admin: {
        getStatus: () => Promise<{ isOwner: boolean; isAdminMember: boolean }>;
        listChannelMembers: () => Promise<{ channelId: string; members: { id: string; name: string }[] }>;
        addMember: (userId: string) => Promise<void>;
        removeMember: (userId: string) => Promise<void>;
      };
      slack: {
        listChannels: () => Promise<SlackChannel[]>;
        listUsers: () => Promise<SlackUser[]>;
        refreshUsers: () => Promise<{ refreshed: boolean; users: SlackUser[] }>;
        onUsersUpdated: (cb: (users: SlackUser[]) => void) => () => void;
        createChannel: (payload: { name: string; memberIds: string[] }) => Promise<{ channelId: string; name: string }>;
        /** Custom emoji ASLI dari workspace (poin revisi, Preset Artis "ambil dari Slack") —
         * nama valid + URL gambar (alias di-resolve 1 level). Butuh scope `emoji:read` (login
         * ulang buat user lama yang belum punya scope ini). */
        listCustomEmojis: () => Promise<{ name: string; url: string }[]>;
        /** Download 1 gambar emoji ke temp file lokal — hasilnya dipakai sebagai `sourcePath`
         * buat artistPreset.save, reuse jalur staging yang sama kayak upload manual. */
        downloadEmojiImage: (url: string) => Promise<string>;
      };
      project: {
        releaseUndo: (id: string) => Promise<void>;
        legacyCount: () => Promise<number>;
        recoverLegacy: () => Promise<number>;
        create: (payload: { name: string; channelId: string; channelName: string }) => Promise<Project>;
        list: () => Promise<ProjectSummary[]>;
        load: (id: string) => Promise<Project>;
        listChannelMemberIds: (id: string) => Promise<string[]>;
        refreshChannelMembers: (id: string) => Promise<{ refreshed: boolean; memberIds: string[] }>;
        rename: (id: string, name: string) => Promise<void>;
        setChannel: (id: string, channelId: string, channelName: string) => Promise<Project>;
        setPhase: (id: string, phase: "setup" | "input") => Promise<void>;
        delete: (id: string) => Promise<void>;
        duplicate: (id: string, newName: string) => Promise<string>;
        export: (id: string) => Promise<{ canceled: boolean; filePath?: string }>;
        import: () => Promise<{ canceled: boolean; projectId?: string }>;
        attachFiles: (projectId: string, filePaths: string[]) => Promise<void>;
        removeFile: (fileId: string) => Promise<void>;
      };
      item: {
        pushRootName: (payload: { projectId: string; itemId: string; openAfter?: boolean }) => Promise<{ itemName: string }>;
        addManual: (payload: { projectId: string; name: string; artistId?: string; artistName?: string }) => Promise<string>;
        update: (itemId: string, patch: Record<string, unknown>) => Promise<void>;
        remove: (itemId: string) => Promise<void>;
        merge: (itemIds: string[], separator?: string) => Promise<{ keepId: string; snapshot: MergeSnapshot | null }>;
        unmerge: (snapshot: MergeSnapshot | null) => Promise<void>;
        restore: (snapshot: ProjectItem) => Promise<void>;
        pickFiles: () => Promise<string[]>;
        attachFiles: (itemId: string, filePaths: string[]) => Promise<void>;
        removeFile: (fileId: string) => Promise<void>;
        /** Multi-artist (poin revisi) — assign/lepas SATU artis, dipanggil tiap toggle klik di
         * ArtistPicker (multi-select). Sinkron realtime ke Slack (kalau togglenya ON) ditangani
         * backend, bisa throw kalau item belum pernah dikirim (belum ada thread). */
        addArtist: (payload: { projectId: string; itemId: string; artistId: string; artistName: string | null }) => Promise<void>;
        removeArtist: (payload: { projectId: string; itemId: string; artistId: string }) => Promise<void>;
        setArtists: (payload: { projectId: string; itemId: string; artists: Array<{ artistId: string; artistName: string | null }> }) => Promise<void>;
        /** Fitur Status (poin revisi) — single-select, beda dari artis (multi). `statusId` null =
         * lepas status. Sinkron realtime & precondition thread sama persis kayak addArtist. */
        setStatus: (payload: { projectId: string; itemId: string; statusId: string | null }) => Promise<void>;
        /** Push dari sync 2 arah reaction Slack->App (poin revisi) — item berubah di background,
         * renderer perlu tau biar auto-refresh (bukan hasil aksi user di jendela ini). */
        onChanged: (cb: (data: { projectId: string; itemId: string }) => void) => () => void;
      };
      reply: {
        // category gak dikirim dari renderer lagi — backend hitung sendiri dari title (title
        // kosong -> fallback ke id reply-nya sendiri, biar reply tanpa judul gak pernah
        // ke-match reply tanpa judul lain di Broadcast/Merge).
        add: (payload: { itemId: string; title: string; textValue?: string; filePaths?: string[] }) => Promise<string>;
        update: (replyId: string, patch: { title?: string; textValue?: string }) => Promise<void>;
        lock: (replyId: string) => Promise<void>;
        /** "Buka gembok" (poin revisi) — override manual field yang ke-lock (sent_at) padahal
         * gagal terkirim, biar bisa dikirim ulang lewat Instant Intake per-field. */
        unlock: (replyId: string) => Promise<void>;
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
      /** Artis Preset (poin revisi) — nickname/code_name/PNG per Slack member. `sourcePath`
       * (poin revisi) sekarang diisi dari image_path preset emoji custom yang dipilih lewat
       * EmojiPicker, bukan dialog file langsung lagi. */
      artistPreset: {
        list: () => Promise<ArtistPreset[]>;
        /** `id` dikasih = update; gak dikasih = insert baru (member_id wajib belum punya preset). */
        /** sourcePath/unicodeValue saling eksklusif — lihat catatan projects.saveArtistPreset. */
        save: (payload: { id?: string; memberId: string; nickname?: string; codeName?: string; sourcePath?: string; unicodeValue?: string }) => Promise<string>;
        remove: (id: string) => Promise<void>;
      };
      /** Preset Status (poin revisi, fitur "Status" per item) — daftar bebas, GLOBAL. */
      statusPreset: {
        list: () => Promise<StatusPreset[]>;
        /** `id` dikasih = update; gak dikasih = insert baru. sourcePath/unicodeValue saling
         * eksklusif — lihat catatan projects.saveStatusPreset. */
        save: (payload: { id?: string; name: string; codeName?: string; sourcePath?: string; unicodeValue?: string }) => Promise<string>;
        remove: (id: string) => Promise<void>;
        /** Drag-reorder (poin revisi) — urutan ini yang dipakai dropdown Status. */
        reorder: (orderedIds: string[]) => Promise<void>;
      };
      /** Mode assign Mention/React (poin revisi — bisa dua-duanya aktif bareng) — GLOBAL buat
       * SEMUA artis, singleton, 2 flag independen. */
      artistAssignMode: {
        get: () => Promise<ArtistAssignModes>;
        setMention: (enabled: boolean) => Promise<boolean>;
        setReact: (enabled: boolean) => Promise<boolean>;
        setMulti: (enabled: boolean) => Promise<boolean>;
      };
      /** Toggle global Instant Intake + Instant Reaction (poin revisi) — gak sentuh "Add React". */
      instantIntake: {
        get: () => Promise<boolean>;
        set: (enabled: boolean) => Promise<boolean>;
      };
      autoOpenSlack: {
        get: () => Promise<boolean>;
        set: (enabled: boolean) => Promise<boolean>;
      };
      /** Toggle global "sesi assign artis realtime" (poin revisi, multi-artist) — pas ON,
       * item.addArtist/removeArtist langsung sinkron ke Slack (bukan nunggu "Kirim ke Slack").
       * Shared state, dipakai di Tab Table & Tab Reply sama-sama. */
      artistRealtimeAssign: {
        get: () => Promise<boolean>;
        set: (enabled: boolean) => Promise<boolean>;
      };
      /** Tombol manual "Update" (poin revisi) — ganti mode assign GLOBAL sengaja gak auto-nembak
       * Slack, user yang mutusin kapan nge-push lewat ini. Reconcile SEMUA item project yang
       * punya artis assigned ke mode SAAT INI (jalan walau toggle realtime OFF). */
      artistAssign: {
        syncProject: (projectId: string) => Promise<{ total: number; synced: number; errors: string[] }>;
        /** Poin revisi — scope SATU item (dipakai pas Tab Input aktif, beda dari syncProject yang
         * scope-nya seluruh project/Tab Table). */
        /** openAfter (poin revisi, default true) — buka link pesan abis Push, samain UX kayak
         * Instant Intake. Overlay KOLOM (bisa Push banyak item sekaligus) pass false biar gak
         * spam buka tab. */
        syncItem: (payload: { projectId: string; itemId: string; openAfter?: boolean }) => Promise<{ itemName: string }>;
      };
      /** "Pull" manual (poin revisi) — kebalikan arah dari artistAssign.syncProject (App->Slack):
       * ini Slack->App, dipicu tombol. Nutup celah react/kata kunci yang kejadian pas semua
       * instalasi offline (Socket Mode event-nya ilang, gak ada cara nyusul otomatis). */
      slackPull: {
        syncProject: (projectId: string) => Promise<{ reactionChanges: number; keywordChanges: number; namesChanged: number; errors: string[] }>;
        /** Poin revisi — scope SATU item (dipakai pas Tab Input aktif). nameChanged (poin revisi
         * lanjutan, diminta user) — nama item ikut Pull, ngelengkapin arah Push yang udah ada. */
        syncItem: (payload: { projectId: string; itemId: string }) => Promise<{ itemName: string; reactionChanges: number; keywordChanges: number; nameChanged: boolean }>;
      };
      /** Sync 2 arah reaction Slack->App (poin revisi, Socket Mode) — App-Level Token (xapp-...)
       * disimpen LOKAL per-instalasi (enkripsi OS, bukan lewat installer), lihat catatan di
       * electron/auth-store.cjs kenapa. */
      slackSocket: {
        hasToken: () => Promise<boolean>;
        isRunning: () => Promise<boolean>;
        /** Simpan token + langsung coba konek. Throw kalau format token gak valid ATAU gagal konek. */
        setToken: (token: string) => Promise<boolean>;
        clearToken: () => Promise<boolean>;
        onStatus: (cb: (data: { status: "connecting" | "connected" | "disconnected" | "error"; detail: string | null }) => void) => () => void;
      };
      /** Otomasi Kata Kunci (poin revisi — digeneralisasi dari "Otomasi WIP" yang awalnya
       * hardcode). Kata kunci bebas diketik siapa pun sebagai reply di thread item, otomatis set
       * status/assign artis sesuai mapping yang user bikin sendiri. OFF default, butuh Socket
       * Mode (App-Level Token) yang sama kayak slackSocket di atas. */
      keywordAutomation: {
        getEnabled: () => Promise<boolean>;
        setEnabled: (enabled: boolean) => Promise<boolean>;
        list: () => Promise<KeywordAutomation[]>;
        /** `id` dikasih = update; gak dikasih = insert baru. */
        save: (payload: { id?: string; keyword: string; targetType: "status" | "artist"; targetId: string }) => Promise<string>;
        remove: (id: string) => Promise<void>;
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
        /** `phase` (poin revisi, send:start 4-fase) — cuma ada pas dari send:start (batch),
         * gak ada pas dari send:quick (Instant Intake, 1 panggilan doang gak ada fase). */
        onProgress: (cb: (data: { projectId: string; jobId: string; index: number; total: number; itemName: string; phase?: "root" | "artist" | "react" | "post"; counts?: { items: number; assigns: number; replies: number; files: number; total: number } }) => void) => () => void;
        onDone: (cb: (data: { projectId: string; jobId: string; results: SendResult[] }) => void) => () => void;
      };
      update: {
        check: () => Promise<{ available: boolean; latest?: string; current?: string; url?: string; reason?: string }>;
      };
      /** Versi app SEKARANG (poin revisi) — murni lokal (app.getVersion()), beda dari
       * update.check yang butuh internet/GitHub API dan bisa gagal kalau offline. */
      app: {
        version: () => Promise<string>;
      };
      /** Papan status HB Apps (poin revisi, hasil diskusi rate-limit) — channel "hb-apps"
       * jadi tempat broadcast Online/Offline/Eksekusi-job/Job-selesai, biar user lain tau
       * siapa lagi pakai app (koordinasi manual lewat DM Slack, kurangin rebutan rate-limit). */
      hbStatus: {
        /** True cuma SEKALI per proses app (belum pernah "Mulai Sesi"/"Lewati" di sesi ini). */
        shouldShowModal: () => Promise<boolean>;
        /** Post ":raised_hands: Online" ke channel status, tandain sesi ini online (dipakai buat
         * keputusan post ":yawning_face: Offline" pas app ditutup). */
        goOnline: () => Promise<void>;
        /** Modal di-skip — gak ada pesan Online, dan gak akan ada pesan Offline pas ditutup. */
        skip: () => Promise<void>;
        /** Nyala pas app mau ditutup DAN sesi ini online — renderer nampilin modal loading,
         * proses kirim pesan Offline jalan di balik layar sebelum app bener-bener ditutup. */
        onClosing: (cb: () => void) => () => void;
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
        generateItems: (projectId: string) => Promise<{ created: number; itemIds: string[] }>;
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
