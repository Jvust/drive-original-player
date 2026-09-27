/*
 * Shared navigation state for the player and gallery.
 *
 * Google Drive opens the site with a `state` query parameter containing the
 * selected file id. Normal links between the two pages used to drop that
 * parameter, so the destination could no longer recover the current media.
 * Keep the latest valid state in this tab and copy it to internal links.
 */
(() => {
  const STATE_KEY = "drive_original_last_state";
  const APP_PREFIX = "/drive-original-player/";

  function readStateFromUrl() {
    const value = new URL(window.location.href).searchParams.get("state");
    if (!value || !value.trim()) return null;
    try {
      const parsed = JSON.parse(value);
      if (parsed.action !== "open" || !Array.isArray(parsed.ids) || !parsed.ids.length) {
        return null;
      }
    } catch (_) {
      return null;
    }
    return value;
  }

  function rememberCurrentState() {
    const state = readStateFromUrl();
    if (state) {
      try {
        sessionStorage.setItem(STATE_KEY, state);
      } catch (_) {
        // Storage may be disabled; the current URL still remains usable.
      }
    }
    return state;
  }

  function rememberedState() {
    try {
      const state = sessionStorage.getItem(STATE_KEY);
      return state && state.trim() ? state : null;
    } catch (_) {
      return null;
    }
  }

  function stateForNavigation() {
    return readStateFromUrl() || rememberedState();
  }

  function isInternalAppLink(anchor) {
    if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) {
      return false;
    }
    const rawHref = anchor.getAttribute("href");
    if (!rawHref || rawHref.startsWith("#")) return false;

    let url;
    try {
      url = new URL(rawHref, window.location.href);
    } catch (_) {
      return false;
    }

    return (
      url.origin === window.location.origin &&
      url.pathname.startsWith(APP_PREFIX) &&
      (url.pathname === APP_PREFIX || url.pathname === APP_PREFIX + "gallery/" ||
        url.pathname === APP_PREFIX + "gallery")
    );
  }

  function decorateLink(anchor) {
    if (!isInternalAppLink(anchor)) return;
    const state = stateForNavigation();
    if (!state) return;

    const url = new URL(anchor.href, window.location.href);
    url.searchParams.set("state", state);
    anchor.href = url.href;
  }

  function decorateLinks(root = document) {
    root.querySelectorAll("a[href]").forEach(decorateLink);
  }

  function init() {
    rememberCurrentState();
    decorateLinks();

    // Covers links inserted by future UI updates.
    new MutationObserver(() => decorateLinks()).observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    // Pages restored from the back-forward cache can have an old DOM state.
    window.addEventListener("pageshow", event => {
      rememberCurrentState();
      decorateLinks();
      if (event.persisted && typeof window.refreshWorkerAccessToken === "function") {
        window.refreshWorkerAccessToken();
      }
    });

    document.addEventListener("click", event => {
      const anchor = event.target.closest && event.target.closest("a[href]");
      if (anchor) decorateLink(anchor);
    }, true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
