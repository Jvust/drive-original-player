/* Keep each view's selection; never send an image to the video view by mistake. */
(() => {
  "use strict";
  const base = new URL("../", document.currentScript.src);
  const page = document.body.classList.contains("gallery-page") ? "gallery" : "player";
  const key = "drive-original-selections-v2";
  let selected = null;

  function parse(raw) {
    try {
      const state = JSON.parse(raw);
      return state?.action === "open" && Array.isArray(state.ids) &&
        state.ids.length && state.ids.every(id => typeof id === "string" && id)
        ? state : null;
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
    // A new library must not reuse another library's remembered selection.
    if (saved && (!source || saved.ids[0] === source.ids[0] ||
        (snapshot && index.findFile(snapshot.tree, saved.ids[0])))) return saved;
    const predicate = target === "player" ? window.isVideoFile : window.isImageFile;
    const file = snapshot && typeof predicate === "function"
      ? index.findFirstFile(snapshot.tree, predicate) : null;
    return file ? fileState(file) : source;
  }
  function decorate(anchor) {
    const raw = anchor.getAttribute("href");
    if (!raw || raw.startsWith("#") || anchor.hasAttribute("download") ||
        anchor.hasAttribute("target")) return;
    const url = new URL(raw, location.href);
    if (url.origin !== base.origin) return;
    const target = [base.pathname, base.pathname + "index.html"].includes(url.pathname)
      ? "player" : [base.pathname + "gallery/", base.pathname + "gallery/index.html"].includes(url.pathname)
        ? "gallery" : null;
    if (!target) return;
    const state = targetState(target);
    if (state) url.searchParams.set("state", JSON.stringify(state));
    else url.searchParams.delete("state");
    // Distinguishes explicit navigation from Drive's image-to-gallery open route.
    url.searchParams.set("view", target);
    anchor.href = url.href;
  }
  function decorateLinks() { document.querySelectorAll("a[href]").forEach(decorate); }
  function remember(file) {
    selected = fileState(file);
    try {
      const saved = readSelections();
      saved[page] = selected;
      sessionStorage.setItem(key, JSON.stringify(saved));
    } catch (_) { /* Navigation still works when storage is unavailable. */ }
    decorateLinks();
  }
  window.DriveNavigation = { remember };
  document.addEventListener("click", event => {
    const anchor = event.target.closest?.("a[href]");
    if (anchor) decorate(anchor);
  }, true);
  window.addEventListener("pageshow", event => {
    decorateLinks();
    if (event.persisted) window.refreshWorkerAccessToken?.().catch(console.error);
  });
})();
