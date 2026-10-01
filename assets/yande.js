/* Static daily archive: no Drive authorization or cross-origin API required. */
(() => {
  "use strict";
  const START = "2026-01-01", END = "2026-09-30", PAGE_SIZE = 60;
  function validDate(value) {
    return typeof value === "string" && /^2026-\d{2}-\d{2}$/.test(value) &&
      value >= START && value <= END && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
  }
  function selectWorks(archives, start, end, sort = "date", rating = "all") {
    if (!validDate(start) || !validDate(end) || start > end) throw new Error("请选择 2026-01-01 至 2026-09-30 内的有效日期范围。");
    const works = new Map();
    for (const archive of archives) {
      for (const day of archive.days) {
        if (day.date < start || day.date > end) continue;
        for (const post of day.posts) {
          if ((rating !== "all" && post.rating !== rating) || !/^https:\/\/files\.yande\.re\//.test(post.original)) continue;
          const existing = works.get(post.id);
          if (existing) {
            existing.dates.push(day.date);
            existing.date = existing.dates.sort().at(-1);
          } else works.set(post.id, { ...post, date: day.date, dates: [day.date] });
        }
      }
    }
    return [...works.values()].sort((a, b) => sort === "score"
      ? b.score - a.score || b.date.localeCompare(a.date) || b.id - a.id
      : b.date.localeCompare(a.date) || b.score - a.score || b.id - a.id);
  }
  const core = { START, END, validDate, selectWorks };
  if (typeof module !== "undefined" && module.exports) module.exports = core;
  if (typeof document === "undefined") return;

  const $ = id => document.getElementById(id);
  const cache = new Map();
  let manifest, works = [], shown = 0, viewerIndex = 0, loadGeneration = 0, imageGeneration = 0;
  let returnFocus = null, viewerImage = null;
  const form = $("rangeForm"), startInput = $("startDate"), endInput = $("endDate");
  const dialog = $("artViewer"), stage = $("artStage");

  async function readJSON(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error("读取画廊数据失败，请稍后重试。");
    if (path.endsWith(".gz")) {
      if (!window.DecompressionStream) throw new Error("当前浏览器不支持归档解压，请更新浏览器后重试。");
      const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
      return JSON.parse(await new Response(stream).text());
    }
    return response.json();
  }
  function readMonth(month) {
    if (!cache.has(month.file)) {
      const promise = readJSON("./data/" + month.file).catch(error => { cache.delete(month.file); throw error; });
      cache.set(month.file, promise);
    }
    return cache.get(month.file);
  }
  function updateMonthTabs(start, end) {
    $("monthTabs").querySelectorAll("button").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.start === start && button.dataset.end === end));
    });
  }
  function addMonthButton(label, start, end) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.dataset.start = start;
    button.dataset.end = end;
    button.addEventListener("click", () => {
      startInput.value = start;
      endInput.value = end;
      loadRange();
    });
    $("monthTabs").appendChild(button);
  }
  function sizeLabel(bytes) {
    return bytes >= 1024 * 1024 ? (bytes / (1024 * 1024)).toFixed(1) + " MB" : Math.round(bytes / 1024) + " KB";
  }
  function appendWorks() {
    const fragment = document.createDocumentFragment();
    const next = Math.min(shown + PAGE_SIZE, works.length);
    for (let index = shown; index < next; index++) {
      const post = works[index];
      const card = document.createElement("button");
      card.className = "art-card";
      card.type = "button";
      card.setAttribute("aria-label", `查看作品 #${post.id} 原图，${post.width} × ${post.height}`);
      const thumb = document.createElement("span");
      thumb.className = "art-thumb";
      const img = document.createElement("img");
      img.alt = "Yande.re 插画 #" + post.id;
      img.loading = "lazy";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.src = /^https:\/\/(assets|files)\.yande\.re\//.test(post.preview) ? post.preview : post.original;
      img.addEventListener("error", () => {
        const message = document.createElement("span");
        message.className = "thumb-error";
        message.textContent = "预览暂不可用 · 点击打开原图";
        thumb.replaceChildren(message);
      }, { once: true });
      thumb.appendChild(img);
      const meta = document.createElement("span");
      meta.className = "card-meta";
      const title = document.createElement("strong"), detail = document.createElement("span");
      title.textContent = "#" + post.id + " · " + post.date;
      detail.textContent = `${post.width} × ${post.height} · ${String(post.rating || "u").toUpperCase()} · ★ ${post.score}`;
      meta.append(title, detail);
      card.append(thumb, meta);
      card.addEventListener("click", () => openViewer(index, card));
      fragment.appendChild(card);
    }
    $("archiveGrid").appendChild(fragment);
    shown = next;
    $("loadMore").hidden = shown >= works.length;
    $("gridProgress").textContent = works.length ? `已显示 ${shown} / ${works.length} 张` : "";
  }
  async function loadRange() {
    const generation = ++loadGeneration;
    const start = startInput.value, end = endInput.value;
    $("archiveError").hidden = true;
    $("retryButton").hidden = true;
    $("randomButton").disabled = true;
    $("loadMore").hidden = true;
    $("archiveGrid").replaceChildren();
    works = [];
    shown = 0;
    $("gridProgress").textContent = "";
    try {
      if (!validDate(start) || !validDate(end) || start > end) throw new Error("开始日期不能晚于结束日期，范围为 2026-01-01 至 2026-09-30。");
      $("archiveStatus").textContent = "正在加载所选日期的收藏…";
      manifest ||= await readJSON("./data/manifest.json");
      const months = manifest.months.filter(month => month.month >= start.slice(0, 7) && month.month <= end.slice(0, 7));
      const archives = await Promise.all(months.map(readMonth));
      if (generation !== loadGeneration) return;
      works = selectWorks(archives, start, end, $("sortOrder").value, $("ratingFilter").value);
      updateMonthTabs(start, end);
      $("rangeTitle").textContent = start === START && end === END ? "全部收藏" : start === end ? start + " 日榜" : `${start} — ${end}`;
      $("archiveStatus").textContent = works.length ? `${works.length.toLocaleString()} 张作品 · 重复作品已合并` : "这段日期暂无可展示的作品。";
      $("randomButton").disabled = !works.length;
      $("snapshotDate").textContent = " 数据更新于 " + manifest.fetchedAt.slice(0, 10) + "。";
      const url = new URL(location.href);
      url.searchParams.set("start", start);
      url.searchParams.set("end", end);
      url.searchParams.set("sort", $("sortOrder").value);
      history.replaceState(null, "", url);
      appendWorks();
    } catch (error) {
      if (generation !== loadGeneration) return;
      $("archiveError").textContent = error.message;
      $("archiveError").hidden = false;
      $("archiveStatus").textContent = "未能打开所选收藏";
      $("retryButton").hidden = false;
    }
  }
  function showArt(index) {
    if (!works.length) return;
    viewerIndex = (index + works.length) % works.length;
    const post = works[viewerIndex], generation = ++imageGeneration;
    stage.classList.remove("zoomed");
    stage.scrollTo(0, 0);
    $("zoomButton").setAttribute("aria-pressed", "false");
    $("artTitle").textContent = `#${post.id} · ${post.date}`;
    $("artMeta").textContent = `${post.width} × ${post.height} · ${sizeLabel(post.bytes)} · ★ ${post.score}`;
    $("artCounter").textContent = `${viewerIndex + 1} / ${works.length}`;
    $("originalLink").href = post.original;
    $("artLoading").hidden = false;
    $("artLoading").textContent = "正在加载原图…";
    // Replace the image to prevent a late load/error from the previous work updating this one.
    const image = document.createElement("img");
    image.id = "artImage";
    image.alt = "Yande.re 原图 #" + post.id;
    image.referrerPolicy = "no-referrer";
    image.addEventListener("load", () => { if (generation === imageGeneration) $("artLoading").hidden = true; });
    image.addEventListener("error", () => {
      if (generation === imageGeneration) $("artLoading").textContent = "原图加载失败，可点击「打开原图」重试。";
    });
    $("artImage").replaceWith(image);
    viewerImage = image;
    image.src = post.original;
  }
  function openViewer(index, focus = document.activeElement) {
    returnFocus = focus;
    showArt(index);
    if (!dialog.open) dialog.showModal();
    document.body.style.overflow = "hidden";
  }
  async function closeViewer() {
    if (document.fullscreenElement === dialog) {
      try { await document.exitFullscreen(); } catch (_) {}
    }
    dialog.close();
  }
  dialog.addEventListener("close", () => {
    imageGeneration++;
    viewerImage?.removeAttribute("src");
    document.body.style.overflow = "";
    returnFocus?.focus();
  });
  dialog.addEventListener("cancel", event => { event.preventDefault(); closeViewer(); });
  dialog.addEventListener("keydown", event => {
    if (event.key === "ArrowLeft") { event.preventDefault(); showArt(viewerIndex - 1); }
    if (event.key === "ArrowRight") { event.preventDefault(); showArt(viewerIndex + 1); }
  });
  $("closeViewer").addEventListener("click", closeViewer);
  $("previousArt").addEventListener("click", () => showArt(viewerIndex - 1));
  $("nextArt").addEventListener("click", () => showArt(viewerIndex + 1));
  $("zoomButton").addEventListener("click", () => {
    const zoomed = stage.classList.toggle("zoomed");
    $("zoomButton").setAttribute("aria-pressed", String(zoomed));
  });
  $("fullscreenButton").hidden = !dialog.requestFullscreen;
  $("fullscreenButton").addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await dialog.requestFullscreen();
    } catch (_) { $("artLoading").textContent = "浏览器暂不支持全屏。"; $("artLoading").hidden = false; }
  });
  $("randomButton").addEventListener("click", () => openViewer(Math.floor(Math.random() * works.length)));
  $("loadMore").addEventListener("click", appendWorks);
  $("retryButton").addEventListener("click", loadRange);
  form.addEventListener("submit", event => { event.preventDefault(); loadRange(); });
  $("sortOrder").addEventListener("change", loadRange);
  $("ratingFilter").addEventListener("change", loadRange);
  addMonthButton("全部", START, END);
  for (let month = 1; month <= 9; month++) {
    const prefix = `2026-${String(month).padStart(2, "0")}`;
    const last = new Date(Date.UTC(2026, month, 0)).getUTCDate();
    addMonthButton(month + " 月", prefix + "-01", prefix + "-" + last);
  }
  const params = new URL(location.href).searchParams;
  if (validDate(params.get("start"))) startInput.value = params.get("start");
  if (validDate(params.get("end"))) endInput.value = params.get("end");
  if (params.get("sort") === "score") $("sortOrder").value = "score";
  loadRange();
})();
