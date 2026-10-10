const FALLBACK_MEDIA = [
  {
    type: "image",
    src: "https://images.unsplash.com/photo-1519608487953-e999c86e7455?auto=format&fit=crop&w=2400&q=90",
    title: "Midnight Ridge",
    description: "A quiet horizon, saved for later."
  },
  {
    type: "image",
    src: "https://images.unsplash.com/photo-1500534623283-312aade485b7?auto=format&fit=crop&w=2400&q=90",
    title: "Open Road",
    description: "The long way home is still a good way."
  },
  {
    type: "video",
    src: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
    title: "A Small Motion",
    description: "A short video, ready for fullscreen playback.",
    poster: "https://images.unsplash.com/photo-1497250681960-ef046c08a56e?auto=format&fit=crop&w=1600&q=85"
  }
];

const state = {
  items: [],
  index: 0,
  fit: "contain",
  loop: false,
  objectUrls: new Set(),
  hideHintTimer: null
};

const $ = (selector) => document.querySelector(selector);
const stage = $("#stage");
const mediaWrap = $("#mediaWrap");
const image = $("#image");
const video = $("#video");
const loading = $("#mediaLoading");
const emptyState = $("#emptyState");
const centerControl = $("#centerControl");
const thumbnails = $("#thumbnails");

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "00:00";
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function isVideo(item) { return item.type === "video"; }

function normalizeItem(item) {
  const type = item.type === "video" || /\.(mp4|webm|ogg|mov)(\?|$)/i.test(item.src || "") ? "video" : "image";
  return {
    ...item,
    type,
    title: item.title || (type === "video" ? "Untitled video" : "Untitled image"),
    description: item.description || "Added to your gallery."
  };
}

async function loadManifest() {
  try {
    const response = await fetch("media.json", { cache: "no-store" });
    if (!response.ok) throw new Error("manifest unavailable");
    const data = await response.json();
    const items = Array.isArray(data) ? data : data.items;
    if (Array.isArray(items) && items.length) return items.map(normalizeItem);
  } catch (error) {
    // Opening index.html directly has no fetch origin; the fallback keeps the demo usable.
  }
  return FALLBACK_MEDIA.map(normalizeItem);
}

function renderThumbnails() {
  thumbnails.replaceChildren();
  state.items.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `thumb${index === state.index ? " active" : ""}`;
    button.title = item.title;
    button.setAttribute("aria-label", `打开 ${item.title}`);
    button.addEventListener("click", () => showItem(index));

    if (item.type === "video") {
      const preview = document.createElement("video");
      preview.src = item.src;
      preview.muted = true;
      preview.preload = "metadata";
      preview.playsInline = true;
      if (item.poster) preview.poster = item.poster;
      button.append(preview);
      const badge = document.createElement("span");
      badge.className = "thumb-video";
      badge.textContent = "▶";
      button.append(badge);
    } else {
      const preview = document.createElement("img");
      preview.src = item.src;
      preview.alt = "";
      preview.loading = "lazy";
      button.append(preview);
    }
    thumbnails.append(button);
  });
}

function showItem(nextIndex, options = {}) {
  if (!state.items.length) return;
  state.index = (nextIndex + state.items.length) % state.items.length;
  const item = state.items[state.index];
  const shouldAutoplay = options.autoplay ?? false;
  image.classList.remove("active");
  video.classList.remove("active");
  centerControl.hidden = true;
  loading.classList.remove("hidden");
  $("#mediaTitle").textContent = item.title;
  $("#mediaDescription").textContent = item.description;
  $("#mediaType").textContent = `${item.type.toUpperCase()} / ${String(state.index + 1).padStart(2, "0")}`;
  $("#counter").textContent = `${String(state.index + 1).padStart(2, "0")} / ${String(state.items.length).padStart(2, "0")}`;
  $("#progress").value = 0;
  $("#timeLabel").textContent = "00:00";

  video.pause();
  video.removeAttribute("src");
  video.load();
  if (item.type === "video") {
    video.src = item.src;
    if (item.poster) video.poster = item.poster;
    video.loop = state.loop;
    video.classList.add("active");
    video.load();
    video.addEventListener("loadedmetadata", () => {
      loading.classList.add("hidden");
      if (shouldAutoplay) video.play().catch(() => { centerControl.hidden = false; });
      updateControls();
    }, { once: true });
  } else {
    image.src = item.src;
    image.alt = item.title;
    image.classList.add("active");
    image.addEventListener("load", () => loading.classList.add("hidden"), { once: true });
    image.addEventListener("error", () => { loading.textContent = "媒体加载失败，请检查 media.json 中的路径"; }, { once: true });
  }
  renderThumbnails();
  updateControls();
  bumpHint();
}

function updateControls() {
  const item = state.items[state.index];
  const activeVideo = item && item.type === "video";
  const playing = activeVideo && !video.paused;
  $("#playButton").textContent = playing ? "Ⅱ" : "▶";
  $("#centerPlay").textContent = playing ? "Ⅱ" : "▶";
  $("#muteButton").textContent = activeVideo && video.muted ? "◌" : "◖";
  $("#progress").disabled = !activeVideo;
  $("#volume").disabled = !activeVideo;
  $("#timeLabel").textContent = activeVideo ? `${formatTime(video.currentTime)} / ${formatTime(video.duration)}` : "IMAGE";
}

function togglePlay() {
  const item = state.items[state.index];
  if (!item || item.type !== "video") return;
  if (video.paused) video.play().catch(() => {}); else video.pause();
  updateControls();
}

function nextItem() { showItem(state.index + 1, { autoplay: true }); }
function previousItem() { showItem(state.index - 1); }

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.();
}

function addFiles(files) {
  const accepted = [...files].filter((file) => file.type.startsWith("image/") || file.type.startsWith("video/"));
  if (!accepted.length) return;
  const added = accepted.map((file) => {
    const url = URL.createObjectURL(file);
    state.objectUrls.add(url);
    return normalizeItem({ type: file.type.startsWith("video/") ? "video" : "image", src: url, title: file.name.replace(/\.[^.]+$/, ""), description: "本次浏览临时加入的媒体" });
  });
  const firstNewIndex = state.items.length;
  state.items.push(...added);
  emptyState.hidden = true;
  renderThumbnails();
  showItem(firstNewIndex, { autoplay: false });
}

function bumpHint() {
  stage.classList.remove("hint-hidden");
  clearTimeout(state.hideHintTimer);
  state.hideHintTimer = setTimeout(() => stage.classList.add("hint-hidden"), 4800);
}

function setFit() {
  state.fit = state.fit === "contain" ? "cover" : "contain";
  mediaWrap.classList.toggle("cover", state.fit === "cover");
  mediaWrap.classList.toggle("contain", state.fit === "contain");
  $("#fitButton").title = state.fit === "cover" ? "当前：填满屏幕，点击显示完整媒体" : "当前：完整显示媒体，点击填满屏幕";
}

function setLoop() {
  state.loop = !state.loop;
  video.loop = state.loop;
  $("#loopButton").setAttribute("aria-pressed", String(state.loop));
  $("#loopButton").style.color = state.loop ? "var(--accent)" : "";
}

function handleKeyboard(event) {
  if (event.target.matches("input, textarea, select")) return;
  if (event.key === "ArrowRight") nextItem();
  if (event.key === "ArrowLeft") previousItem();
  if (event.key === " ") { event.preventDefault(); togglePlay(); }
  if (event.key.toLowerCase() === "f") toggleFullscreen();
  if (event.key.toLowerCase() === "m") { video.muted = !video.muted; updateControls(); }
}

function bindEvents() {
  $("#addButton").addEventListener("click", () => $("#fileInput").click());
  $("#emptyAddButton").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", (event) => addFiles(event.target.files));
  $("#fullscreenButton").addEventListener("click", toggleFullscreen);
  $("#previousButton").addEventListener("click", previousItem);
  $("#nextButton").addEventListener("click", nextItem);
  $("#playButton").addEventListener("click", togglePlay);
  $("#centerPlay").addEventListener("click", togglePlay);
  $("#muteButton").addEventListener("click", () => { video.muted = !video.muted; updateControls(); });
  $("#fitButton").addEventListener("click", setFit);
  $("#loopButton").addEventListener("click", setLoop);
  $("#volume").addEventListener("input", (event) => { video.volume = Number(event.target.value); video.muted = false; updateControls(); });
  $("#progress").addEventListener("input", (event) => { if (video.duration) video.currentTime = (Number(event.target.value) / 1000) * video.duration; });
  $("#thumbPrevious").addEventListener("click", () => thumbnails.scrollBy({ left: -180, behavior: "smooth" }));
  $("#thumbNext").addEventListener("click", () => thumbnails.scrollBy({ left: 180, behavior: "smooth" }));
  ["timeupdate", "play", "pause", "volumechange", "loadedmetadata", "ended"].forEach((eventName) => video.addEventListener(eventName, () => {
    if (eventName === "timeupdate" && video.duration) $("#progress").value = Math.round((video.currentTime / video.duration) * 1000);
    if (eventName === "ended" && !state.loop) nextItem();
    updateControls();
  }));
  stage.addEventListener("click", (event) => {
    if (event.target.closest("button, input, .thumbnail-dock, .topbar, .bottombar")) return;
    if (state.items[state.index]?.type === "video") togglePlay(); else nextItem();
  });
  document.addEventListener("keydown", handleKeyboard);
  document.addEventListener("fullscreenchange", bumpHint);
  ["dragenter", "dragover"].forEach((eventName) => stage.addEventListener(eventName, (event) => { event.preventDefault(); $("#dropOverlay").hidden = false; }));
  ["dragleave", "drop"].forEach((eventName) => stage.addEventListener(eventName, (event) => { event.preventDefault(); if (eventName === "drop") addFiles(event.dataTransfer.files); $("#dropOverlay").hidden = true; }));
  window.addEventListener("beforeunload", () => state.objectUrls.forEach((url) => URL.revokeObjectURL(url)));
}

async function init() {
  bindEvents();
  state.items = await loadManifest();
  if (!state.items.length) { emptyState.hidden = false; loading.classList.add("hidden"); return; }
  mediaWrap.classList.add("contain");
  $("#fitButton").title = "当前：完整显示媒体，点击填满屏幕";
  showItem(0);
}

init();
