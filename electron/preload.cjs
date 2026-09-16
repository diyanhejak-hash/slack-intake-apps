const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Renderer cuma boleh manggil aksi lewat sini — gak pernah pegang token/secret/filesystem
// langsung (poin 7 rancangan).
contextBridge.exposeInMainWorld("api", {
  auth: {
    status: () => ipcRenderer.invoke("auth:status"),
    login: () => ipcRenderer.invoke("auth:login"),
    logout: () => ipcRenderer.invoke("auth:logout"),
  },
  slack: {
    listChannels: () => ipcRenderer.invoke("slack:listChannels"),
    listUsers: () => ipcRenderer.invoke("slack:listUsers"),
    createChannel: (payload) => ipcRenderer.invoke("slack:createChannel", payload),
  },
  project: {
    releaseUndo: (id) => ipcRenderer.invoke("project:releaseUndo", id),
    legacyCount: () => ipcRenderer.invoke("project:legacyCount"),
    recoverLegacy: () => ipcRenderer.invoke("project:recoverLegacy"),
    create: (payload) => ipcRenderer.invoke("project:create", payload),
    list: () => ipcRenderer.invoke("project:list"),
    load: (id) => ipcRenderer.invoke("project:load", id),
    rename: (id, name) => ipcRenderer.invoke("project:rename", id, name),
    delete: (id) => ipcRenderer.invoke("project:delete", id),
    duplicate: (id, newName) => ipcRenderer.invoke("project:duplicate", id, newName),
    export: (id) => ipcRenderer.invoke("project:export", id),
    import: () => ipcRenderer.invoke("project:import"),
    attachFiles: (projectId, filePaths) => ipcRenderer.invoke("project:attachFiles", projectId, filePaths),
    removeFile: (fileId) => ipcRenderer.invoke("project:removeFile", fileId),
  },
  item: {
    addManual: (payload) => ipcRenderer.invoke("item:addManual", payload),
    update: (itemId, patch) => ipcRenderer.invoke("item:update", itemId, patch),
    remove: (itemId) => ipcRenderer.invoke("item:remove", itemId),
    merge: (itemIds, separator) => ipcRenderer.invoke("item:merge", itemIds, separator),
    unmerge: (snapshot) => ipcRenderer.invoke("item:unmerge", snapshot),
    restore: (snapshot) => ipcRenderer.invoke("item:restore", snapshot),
    pickFiles: () => ipcRenderer.invoke("item:pickFiles"),
    attachFiles: (itemId, filePaths) => ipcRenderer.invoke("item:attachFiles", itemId, filePaths),
    removeFile: (fileId) => ipcRenderer.invoke("item:removeFile", fileId),
  },
  reply: {
    add: (payload) => ipcRenderer.invoke("reply:add", payload),
    update: (replyId, patch) => ipcRenderer.invoke("reply:update", replyId, patch),
    remove: (replyId) => ipcRenderer.invoke("reply:remove", replyId),
    removeMany: (replyIds) => ipcRenderer.invoke("reply:removeMany", replyIds),
    removeFile: (fileId) => ipcRenderer.invoke("reply:removeFile", fileId),
    removeManyEverywhere: (projectId, categories) => ipcRenderer.invoke("reply:removeManyEverywhere", projectId, categories),
    reorder: (itemId, orderedReplyIds) => ipcRenderer.invoke("reply:reorder", itemId, orderedReplyIds),
    addFiles: (replyId, itemId, filePaths) => ipcRenderer.invoke("reply:addFiles", replyId, itemId, filePaths),
    broadcast: (replyId, projectId) => ipcRenderer.invoke("reply:broadcast", replyId, projectId),
    addCaptured: (itemId, dataUrl, filename) => ipcRenderer.invoke("reply:addCaptured", itemId, dataUrl, filename),
    addCapturedToReply: (replyId, itemId, dataUrl, filename) => ipcRenderer.invoke("reply:addCapturedToReply", replyId, itemId, dataUrl, filename),
  },
  artistGroup: {
    list: () => ipcRenderer.invoke("artistGroup:list"),
    save: (payload) => ipcRenderer.invoke("artistGroup:save", payload),
    delete: (id) => ipcRenderer.invoke("artistGroup:delete", id),
  },
  template: {
    applyAll: (projectId, templateId) => ipcRenderer.invoke("template:applyAll", projectId, templateId),
    list: () => ipcRenderer.invoke("template:list"),
    save: (payload) => ipcRenderer.invoke("template:save", payload),
    delete: (id) => ipcRenderer.invoke("template:delete", id),
  },
  hyperlink: {
    list: () => ipcRenderer.invoke("hyperlink:list"),
    save: (payload) => ipcRenderer.invoke("hyperlink:save", payload),
    delete: (id) => ipcRenderer.invoke("hyperlink:delete", id),
  },
  emojiPreset: {
    list: () => ipcRenderer.invoke("emojiPreset:list"),
    addUnicode: (payload) => ipcRenderer.invoke("emojiPreset:addUnicode", payload),
    addCustom: (payload) => ipcRenderer.invoke("emojiPreset:addCustom", payload),
    remove: (id) => ipcRenderer.invoke("emojiPreset:remove", id),
    pickImage: () => ipcRenderer.invoke("emojiPreset:pickImage"),
  },
  artistPreset: {
    list: () => ipcRenderer.invoke("artistPreset:list"),
    save: (payload) => ipcRenderer.invoke("artistPreset:save", payload),
    remove: (id) => ipcRenderer.invoke("artistPreset:remove", id),
  },
  artistAssignMode: {
    get: () => ipcRenderer.invoke("artistAssignMode:get"),
    set: (mode) => ipcRenderer.invoke("artistAssignMode:set", mode),
  },
  instantIntake: {
    get: () => ipcRenderer.invoke("instantIntake:get"),
    set: (enabled) => ipcRenderer.invoke("instantIntake:set", enabled),
  },
  itemReaction: {
    list: (itemId) => ipcRenderer.invoke("itemReaction:list", itemId),
    add: (itemId, payload) => ipcRenderer.invoke("itemReaction:add", itemId, payload),
    addToProject: (projectId, payload) => ipcRenderer.invoke("itemReaction:addToProject", projectId, payload),
    remove: (id) => ipcRenderer.invoke("itemReaction:remove", id),
  },
  reaction: {
    sendInstant: (payload) => ipcRenderer.invoke("reaction:sendInstant", payload),
  },
  send: {
    recover: (payload) => ipcRenderer.invoke("send:recover", payload),
    start: (payload) => ipcRenderer.invoke("send:start", payload),
    quick: (payload) => ipcRenderer.invoke("send:quick", payload),
    cancel: () => ipcRenderer.invoke("send:cancel"),
    onProgress: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on("send:progress", listener);
      return () => ipcRenderer.removeListener("send:progress", listener);
    },
    onDone: (cb) => {
      const listener = (_e, data) => cb(data);
      ipcRenderer.on("send:done", listener);
      return () => ipcRenderer.removeListener("send:done", listener);
    },
  },
  update: {
    check: () => ipcRenderer.invoke("update:check"),
  },
  app: {
    version: () => ipcRenderer.invoke("app:version"),
  },
  hbStatus: {
    shouldShowModal: () => ipcRenderer.invoke("hbStatus:shouldShowModal"),
    goOnline: () => ipcRenderer.invoke("hbStatus:goOnline"),
    skip: () => ipcRenderer.invoke("hbStatus:skip"),
    onClosing: (cb) => {
      const listener = () => cb();
      ipcRenderer.on("hbStatus:closing", listener);
      return () => ipcRenderer.removeListener("hbStatus:closing", listener);
    },
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
    openSlackMessage: (payload) => ipcRenderer.invoke("shell:openSlackMessage", payload),
  },
  system: {
    hasSlackDesktop: () => ipcRenderer.invoke("system:hasSlackDesktop"),
  },
  log: {
    list: (limit) => ipcRenderer.invoke("log:list", limit),
    clear: () => ipcRenderer.invoke("log:clear"),
  },
  batchFile: {
    pickFiles: () => ipcRenderer.invoke("batchFile:pickFiles"),
    listSections: (projectId) => ipcRenderer.invoke("batchFile:listSections", projectId),
    saveSections: (projectId, sections) => ipcRenderer.invoke("batchFile:saveSections", projectId, sections),
    apply: (projectId) => ipcRenderer.invoke("batchFile:apply", projectId),
  },
  // Drag-drop file native dari OS (File Explorer) — Electron 32+ udah gak nempelin `.path`
  // otomatis ke File object lagi (dihapus, alasan keamanan), harus lewat webUtils.getPathForFile.
  // Ini panggilan SINKRON di proses renderer (bukan IPC ke main), aman diekspos langsung.
  file: {
    getPathForFile: (file) => {
      const filePath = webUtils.getPathForFile(file);
      if (!filePath || !ipcRenderer.sendSync("file:grantDrop", filePath)) throw new Error("File drop tidak valid.");
      return filePath;
    },
    readBytes: (filePath) => ipcRenderer.invoke("file:readBytes", filePath),
  },
});
