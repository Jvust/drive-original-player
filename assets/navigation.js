/* Keep each view's selection and commit directory progress before leaving. */
(() => {
  "use strict";
  const base = new URL("../", document.currentScript.src);
  const page = document.body.classList.contains("gallery-page") ? "gallery" : "player";
  const key = "drive-original-selections-v2";
  const leaveHandlers = new Set();
  let selected = null, navigating = false, refreshing = false;
  function parse(raw) {
    try {
      const state = JSON.parse(raw);
      return state?.action === "open" && Array.isArray(state.ids) &&
        state.ids.length && state.ids.every(id => typeof id === "string" && id) ? state : null;
    } catch (_) { return null; }
  }
  function readSelections() {
    try { return JSON.parse(sessionStorage.getItem(key)) || {}; }
    catch (_) { return {}; }
  }
  function fileState(file) {
    return { action: "open", ids: [file.id], resourceKeys:
      file.resourceKey ? { [file.id]: file.resourceKey } : {} };
  }
  function targetState(target) {
    const index = window.DriveMediaIndex;
    const source = selected || parse(new URL(location.href).searchParams.get("state"));
    const snapshot = source ? index?.findSnapshotForFile(source.ids[0]) : index?.loadSnapshot();
    const saved = parse(JSON.stringify(readSelections()[target]));
    if (saved && ((!source && snapshot && index.getFile(snapshot, saved.ids[0])) ||
        saved.ids[0] === source?.ids[0] || (snapshot && index.getFile(snapshot, saved.ids[0])))) return saved;
    const predicate = target === "player" ? window.isVideoFile : window.isImageFile;
    const file = snapshot && typeof predicate === "function"
      ? index.findFirstFile(snapshot.tree, predicate) || (snapshot.sources || []).find(predicate) : null;
    return file ? fileState(file) : source;
  }
  function decorate(anchor) {
    const raw = anchor.getAttribute("href");
    if (!raw || raw.startsWith("#") || anchor.hasAttribute("download") || anchor.hasAttribute("target")) return null;
    const url = new URL(raw, location.href);
    if (url.origin !== base.origin) return null;
    const target = [base.pathname, base.pathname + "index.html"].includes(url.pathname)
      ? "player" : [base.pathname + "gallery/", base.pathname + "gallery/index.html"].includes(url.pathname)
        ? "gallery" : null;
    if (!target) return null;
    const state = targetState(target);
    if (state) url.searchParams.set("state", JSON.stringify(state));
    else url.searchParams.delete("state");
    url.searchParams.set("view", target);
    anchor.href = url.href;
    return target;
  }
  function decorateLinks() { document.querySelectorAll("a[href]").forEach(decorate); }
  function remember(file) {
    selected = fileState(file);
    try {
      const saved = readSelections(); saved[page] = selected;
      sessionStorage.setItem(key, JSON.stringify(saved));
    } catch (_) { /* The URL still carries the selection if storage is blocked. */ }
    decorateLinks();
  }
  function capture() {
    if (refreshing) return;
    for (const handler of leaveHandlers) {
      try { handler(); } catch (error) { console.warn("保存浏览位置失败", error); }
    }
  }
  async function refreshLibrary() {
    if (navigating) return;
    navigating = refreshing = true;
    const url = new URL(location.href);
    const state = selected || parse(url.searchParams.get("state"));
    if (state) url.searchParams.set("state", JSON.stringify(state));
    url.searchParams.set("view", page);
    try { await window.DriveMediaIndex?.clear(); }
    finally { location.assign(url.href); }
  }
  window.DriveNavigation = {
    remember, refreshLibrary,
    beforeLeave(handler) { leaveHandlers.add(handler); return () => leaveHandlers.delete(handler); }
  };
  document.addEventListener("click", event => {
    const anchor = event.target.closest?.("a[href]");
    const target = anchor && decorate(anchor);
    if (!target || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
        (event.button !== undefined && event.button !== 0) || typeof event.preventDefault !== "function") return;
    event.preventDefault();
    if (navigating || target === page) return;
    navigating = true;
    (async () => {
      try {
        // A BFCache-restored page may have an older tree than the other view.
        await window.DriveMediaIndex?.ready(true);
        capture();
        await window.DriveMediaIndex?.flush();
        decorate(anchor);
      } catch (error) { console.warn("保存目录缓存失败，继续切换", error); }
      finally { location.assign(anchor.href); }
    })();
  }, true);
  window.addEventListener("pagehide", () => { capture(); window.DriveMediaIndex?.flush(); });
  window.addEventListener("pageshow", event => {
    navigating = false;
    decorateLinks();
    if (event.persisted) {
      window.DriveMediaIndex?.ready(true).then(decorateLinks);
      window.refreshWorkerAccessToken?.().catch(console.error);
    }
  });
})();
