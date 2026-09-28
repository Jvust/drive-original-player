/* Shared directory metadata only: never cache OAuth tokens or media bytes here. */
(function () {
  "use strict";
  const CACHE_KEY = "drive-original-player-media-index-v1";
  const TAB_KEY = "drive-original-media-cache-tab-v2";
  const DB_NAME = "drive-original-media-index-v2";
  const STORE = "snapshots";
  const FOLDER = "application/vnd.google-apps.folder";
  const FIELDS = ["id", "name", "mimeType", "size", "thumbnailLink", "resourceKey",
    "parents", "driveId", "capabilities", "videoMediaMetadata", "imageMediaMetadata"];
  let memory = null, db = null, opening = null, loading = null, flushing = null;
  let revision = 0, written = -1, hotSaved = false, clearing = false, accountScope = null;
  const clone = value => JSON.parse(JSON.stringify(value));
  function storage() { try { return window.sessionStorage; } catch (_) { return null; } }
  function valid(s) {
    return !!(s && s.version === 1 && typeof s.complete === "boolean" &&
      s.rootFolder?.id && s.tree?.file?.id === s.rootFolder.id);
  }
  try {
    const cached = JSON.parse(storage()?.getItem(CACHE_KEY) || "null");
    if (valid(cached)) memory = cached;
  } catch (_) { /* A corrupt/blocked cache must not prevent opening Drive. */ }
  let tabId = null;
  try {
    const s = storage();
    tabId = s?.getItem(TAB_KEY);
    if (!tabId && s) {
      const id = window.crypto?.randomUUID?.() || Date.now() + "-" + Math.random();
      try { s.setItem(TAB_KEY, id); }
      catch (_) { s.removeItem?.(CACHE_KEY); s.setItem(TAB_KEY, id); }
      tabId = id;
    }
  } catch (_) { /* Session storage disabled: use memory without mixing tabs. */ }
  function copyFile(file) {
    if (!file) return null;
    return Object.fromEntries(FIELDS.filter(k => file[k] !== undefined).map(k => [k, file[k]]));
  }
  const isFolderScanned = node => !!(node && (node.scanned === true || node.mediaIndexScanned === true));
  function copyTree(node) {
    return node?.file ? { file: copyFile(node.file), scanned: isFolderScanned(node),
      children: (node.children || []).map(copyTree).filter(Boolean) } : null;
  }
  function hydrate(node) {
    node.mediaIndexScanned = node.scanned === true;
    for (const child of node.children || []) hydrate(child);
    return node;
  }
  function findFile(node, id) {
    if (!node || !id) return null;
    if (node.file?.id === id) return node.file;
    for (const child of node.children || []) { const found = findFile(child, id); if (found) return found; }
    return null;
  }
  function getFile(snapshot, id) {
    return snapshot && (findFile(snapshot.tree, id) || (snapshot.sources || []).find(f => f.id === id)) || null;
  }
  function findFirstFile(node, predicate) {
    if (!node) return null;
    if (node.file && predicate(node.file)) return node.file;
    for (const child of node.children || []) { const found = findFirstFile(child, predicate); if (found) return found; }
    return null;
  }
  function countFolders(node) {
    return (node?.children || []).reduce((n, child) => n +
      (child.file?.mimeType === FOLDER ? 1 + countFolders(child) : 0), 0);
  }
  function allScanned(node) {
    return node.file.mimeType !== FOLDER ||
      (isFolderScanned(node) && (node.children || []).every(allScanned));
  }
  // Scans only add knowledge. A resumed/BFCache page must not erase newer branches.
  // Explicit refresh clears the old tree before fetching changed/deleted files.
  function mergeTrees(old, next) {
    if (!old || old.file.id !== next.file.id) return next;
    const children = new Map((old.children || []).map(child => [child.file.id, child]));
    for (const child of next.children || []) children.set(child.file.id, mergeTrees(children.get(child.file.id), child));
    return { file: next.file, scanned: isFolderScanned(old) || isFolderScanned(next), children: [...children.values()] };
  }
  function openDatabase() {
    if (db) return Promise.resolve(db);
    if (opening) return opening;
    opening = new Promise(resolve => {
      let request, done = false;
      const finish = value => { if (!done) { done = true; clearTimeout(timer); db = value; resolve(value); } };
      const timer = setTimeout(() => finish(null), 2000);
      try {
        if (!tabId || !window.indexedDB) { finish(null); return; }
        request = window.indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
        };
        request.onsuccess = () => {
          if (done) { request.result.close(); return; }
          request.result.onversionchange = () => { request.result.close(); db = null; opening = null; };
          finish(request.result);
        };
        request.onerror = request.onblocked = () => finish(null);
      } catch (_) { finish(null); }
    });
    return opening;
  }
  function transaction(mode, operation) {
    if (!db || !tabId) return Promise.resolve({ ok: false });
    return new Promise(resolve => {
      let tx, request, done = false;
      const finish = value => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => { try { tx?.abort(); } catch (_) {} finish({ ok: false }); }, 2000);
      try {
        tx = db.transaction(STORE, mode);
        request = operation(tx.objectStore(STORE));
        tx.oncomplete = () => finish({ ok: true, value: request?.result });
        tx.onerror = tx.onabort = () => finish({ ok: false });
      } catch (_) { finish({ ok: false }); }
    });
  }
  async function currentAccountScope() {
    try {
      const session = window.localStorage?.getItem("drive_oauth_session") || "";
      if (!window.crypto?.subtle) return null;
      const bytes = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(session));
      return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
    } catch (_) { return null; }
  }
  function ready(refresh = false) {
    if (loading && !refresh) return loading;
    loading = (async () => {
      await openDatabase();
      const scope = await currentAccountScope();
      accountScope = scope;
      const result = scope ? await transaction("readonly", store => store.get(tabId)) : { ok: false };
      if (clearing) return;
      if (memory?.accountScope && memory.accountScope !== scope) {
        memory = null;
        try { storage()?.removeItem?.(CACHE_KEY); } catch (_) {}
      }
      const cached = result.value;
      if (valid(cached) && cached.accountScope === scope &&
          (!memory || cached.savedAt > memory.savedAt)) {
        memory = cached;
        written = revision;
      }
    })().catch(() => {});
    return loading;
  }
  function persist() {
    memory.savedAt = Math.max(Date.now(), (memory.savedAt || 0) + 1);
    memory.accountScope = accountScope;
    revision++;
    hotSaved = false;
    try { storage()?.setItem(CACHE_KEY, JSON.stringify(memory)); hotSaved = !!storage(); }
    catch (_) {
      // Never leave an older successful snapshot looking like the latest one.
      try { storage()?.removeItem?.(CACHE_KEY); } catch (_) {}
    }
    Promise.resolve().then(() => flush());
  }
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      await ready();
      while (!clearing && memory && written < revision) {
        if (!db || !accountScope) return hotSaved;
        const at = revision, snapshot = clone(memory);
        snapshot.accountScope = accountScope;
        const result = await transaction("readwrite", store => store.put(snapshot, tabId));
        if (!result.ok) return hotSaved;
        written = at;
      }
      return true;
    })().finally(() => { flushing = null; });
    return flushing;
  }
  function loadSnapshot() {
    if (!valid(memory)) return null;
    const snapshot = clone(memory);
    hydrate(snapshot.tree);
    return snapshot;
  }
  function saveSnapshot(rootFolder, rootNode, complete = true, sourceFile = null) {
    if (clearing || !rootFolder?.id || rootNode?.file?.id !== rootFolder.id) return false;
    const old = memory?.rootFolder.id === rootFolder.id ? memory : null;
    const tree = mergeTrees(old?.tree, copyTree(rootNode));
    const sources = new Map((old?.sources || []).map(f => [f.id, f]));
    if (sourceFile?.id) sources.set(sourceFile.id, copyFile(sourceFile));
    memory = { version: 1, complete: (complete === true || old?.complete === true) && allScanned(tree),
      savedAt: memory?.savedAt || 0, rootFolder: copyFile(rootFolder), tree,
      sources: [...sources.values()].filter(f => !findFile(tree, f.id)).slice(-16), views: old?.views || {} };
    persist();
    return true;
  }
  function saveView(page, rootId, state) {
    if (clearing || memory?.rootFolder.id !== rootId || !["player", "gallery"].includes(page)) return;
    memory.views = { ...memory.views, [page]: clone(state) };
    persist();
  }
  function getView(page, rootId) {
    return memory?.rootFolder.id === rootId && memory.views?.[page] ? clone(memory.views[page]) : null;
  }
  async function clear() {
    clearing = true;
    if (flushing) await flushing;
    await ready();
    memory = null;
    try { storage()?.removeItem?.(CACHE_KEY); } catch (_) {}
    await transaction("readwrite", store => store.delete(tabId));
  }
  window.DriveMediaIndex = {
    ready, flush, clear, getFile, saveView, getView, countFolders, findFile, findFirstFile,
    loadSnapshot, isFolderScanned, saveSnapshot,
    findSnapshotForFile(id) { const s = loadSnapshot(); return getFile(s, id) ? s : null; },
    findSnapshotForRoot(id) { const s = loadSnapshot(); return s?.rootFolder.id === id ? s : null; }
  };
})();
