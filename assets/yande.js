/* Static daily archive: no Drive authorization or cross-origin API required. */
(() => {
  "use strict";
  const START = "2022-01-01", END = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()), PAGE_SIZE = 60;
  function validDate(value) {
    return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      value >= START && value <= END && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
  }
  function selectWorks(archives, start, end, sort = "date", rating = "all", favoriteIds = null) {
    if (!validDate(start) || !validDate(end) || start > end) throw new Error(`请选择 ${START} 至 ${END} 内的有效日期范围。`);
    const works = new Map();
    for (const archive of archives) {
      for (const day of archive.days) {
        if (day.date < start || day.date > end) continue;
        for (const post of day.posts) {
          if ((rating !== "all" && post.rating !== rating) || !/^https:\/\/files\.yande\.re\//.test(post.original) || (favoriteIds && !favoriteIds.has(post.id))) continue;
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
  function rankWeekRange(date) { const d = new Date(date + "T00:00:00"); const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day); const start = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`; const endDate = new Date(d); endDate.setDate(d.getDate()+6); const end = `${endDate.getFullYear()}-${String(endDate.getMonth()+1).padStart(2,"0")}-${String(endDate.getDate()).padStart(2,"0")}`; return [start < START ? START : start, end > END ? END : end]; }
  const rankMonthRange = date => { const prefix = date.slice(0,7); const end = new Date(Number(prefix.slice(0,4)),Number(prefix.slice(5,7)),0).getDate(); const last = `${prefix}-${String(end).padStart(2,"0")}`; return [prefix+"-01",last > END ? END : last]; };
  const core = { START, END, validDate, selectWorks, rankWeekRange, rankMonthRange };
  if (typeof module !== "undefined" && module.exports) module.exports = core;
  if (typeof document === "undefined") return;

  let savedFavorites = [];
  try { savedFavorites = JSON.parse(localStorage.getItem("hoshi_yande_favorites") || "[]"); } catch (_) {}
  const favorites = new Set(savedFavorites.map(Number));
  let savedAuthors = [], savedTags = [];
  try { savedAuthors = JSON.parse(localStorage.getItem("hoshi_yande_authors") || "[]"); } catch (_) {}
  try { savedTags = JSON.parse(localStorage.getItem("hoshi_yande_tags") || "[]"); } catch (_) {}
  const favoriteAuthors = new Set(savedAuthors), favoriteTags = new Set(savedTags);
  const selected = new Set();
  function persistFavorites() { localStorage.setItem("hoshi_yande_favorites", JSON.stringify([...favorites])); }
  const norm = value => String(value || "").trim().toLowerCase();
  const postTags = post => Array.isArray(post.tags) ? post.tags.map(t => typeof t === "string" ? t : t.name).filter(Boolean) : String(post.tags || "").split(/[\s,]+/).filter(Boolean);
  function metadata(post) {
    const raw = String(post.original || "").split("/").pop().replace(/\.[^.]+$/, "");
    let title = raw; try { title = decodeURIComponent(raw); } catch (_) {}
    const tokens = title.replace(/^yande\.re\s+\d+\s+/i, "").split(/[\s]+/).filter(Boolean);
    const tags = [...new Set([...postTags(post), ...tokens.map(t => t.replace(/\s+/g, "_")).filter(t => !/^\d+$/.test(t))])];
    const authorTags = tags.filter(t => /^(artist|circle|studio):/i.test(t));
    const nameMatch = title.match(/\(([^()]*)\)(?=\s|$)/g) || [];
    const authors = [...new Set([...authorTags.map(t => t.replace(/^[^:]+:/, "")), ...nameMatch.map(t => t.slice(1,-1))])];
    return { tags, authors };
  }
  const postAuthor = post => metadata(post).authors[0] || "";
  const $ = id => document.getElementById(id);
  const cache = new Map();
  let manifest, works = [], allWorks = [], shown = 0, viewerIndex = 0, loadGeneration = 0, imageGeneration = 0;
  let returnFocus = null, viewerImage = null;
  window.__yandeWorks = () => works;
  const form = $("rangeForm"), startInput = $("startDate"), endInput = $("endDate");
  const dialog = $("artViewer"), stage = $("artStage");

  /* Minimal gzip (RFC 1952 + DEFLATE) inflater used when DecompressionStream is unavailable.
     Android WebView builds before Chrome 80 lack it; the archive must still open there. */
  function inflateRaw(bytes) {
    const state = { pos: 0, bit: 0, out: [] };
    const readBit = () => {
      const b = (bytes[state.pos] >> state.bit) & 1;
      state.bit += 1;
      if (state.bit === 8) { state.bit = 0; state.pos += 1; }
      return b;
    };
    const readBits = n => { let v = 0; for (let i = 0; i < n; i++) v |= readBit() << i; return v; };
    const buildTree = lengths => {
      const maxBits = Math.max(...lengths, 0);
      const blCount = new Array(maxBits + 1).fill(0);
      for (const len of lengths) if (len) blCount[len]++;
      const nextCode = new Array(maxBits + 1).fill(0);
      let code = 0;
      for (let bits = 1; bits <= maxBits; bits++) { code = (code + (blCount[bits - 1] || 0)) << 1; nextCode[bits] = code; }
      const map = new Map();
      lengths.forEach((len, sym) => {
        if (!len) return;
        let c = nextCode[len]++;
        let reversed = 0;
        for (let i = 0; i < len; i++) { reversed = (reversed << 1) | (c & 1); c >>= 1; }
        map.set(len + ':' + reversed, sym);
      });
      return { map, maxBits };
    };
    const decode = tree => {
      let code = 0;
      for (let len = 1; len <= tree.maxBits; len++) {
        code |= readBit() << (len - 1);
        const sym = tree.map.get(len + ':' + code);
        if (sym !== undefined) return sym;
      }
      throw new Error('gzip 数据损坏');
    };
    const LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
    const LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
    const DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
    const DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
    const CLC_ORDER = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];
    let last = 0;
    while (!last) {
      last = readBit();
      const type = readBits(2);
      if (type === 0) {
        if (state.bit) { state.bit = 0; state.pos += 1; }
        const len = bytes[state.pos] | (bytes[state.pos + 1] << 8);
        state.pos += 4;
        for (let i = 0; i < len; i++) state.out.push(bytes[state.pos++]);
      } else if (type === 1 || type === 2) {
        let litTree, distTree;
        if (type === 1) {
          const litLens = new Array(288);
          for (let i = 0; i < 144; i++) litLens[i] = 8;
          for (let i = 144; i < 256; i++) litLens[i] = 9;
          for (let i = 256; i < 280; i++) litLens[i] = 7;
          for (let i = 280; i < 288; i++) litLens[i] = 8;
          litTree = buildTree(litLens);
          distTree = buildTree(new Array(30).fill(5));
        } else {
          const hlit = readBits(5) + 257, hdist = readBits(5) + 1, hclen = readBits(4) + 4;
          const clcLens = new Array(19).fill(0);
          for (let i = 0; i < hclen; i++) clcLens[CLC_ORDER[i]] = readBits(3);
          const clcTree = buildTree(clcLens);
          const lens = [];
          while (lens.length < hlit + hdist) {
            const sym = decode(clcTree);
            if (sym < 16) lens.push(sym);
            else if (sym === 16) { const prev = lens[lens.length - 1]; let r = readBits(2) + 3; while (r--) lens.push(prev); }
            else if (sym === 17) { let r = readBits(3) + 3; while (r--) lens.push(0); }
            else { let r = readBits(7) + 11; while (r--) lens.push(0); }
          }
          litTree = buildTree(lens.slice(0, hlit));
          distTree = buildTree(lens.slice(hlit, hlit + hdist));
        }
        for (;;) {
          const sym = decode(litTree);
          if (sym === 256) break;
          if (sym < 256) state.out.push(sym);
          else {
            const li = sym - 257;
            const len = LEN_BASE[li] + readBits(LEN_EXTRA[li]);
            const di = decode(distTree);
            const dist = DIST_BASE[di] + readBits(DIST_EXTRA[di]);
            const start = state.out.length - dist;
            for (let i = 0; i < len; i++) state.out.push(state.out[start + i]);
          }
        }
      } else throw new Error('gzip 数据损坏');
    }
    return Uint8Array.from(state.out);
  }

  function gunzip(bytes) {
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('归档格式不正确');
    // Skip the 10-byte header, honouring the optional FEXTRA/FNAME/FCOMMENT/FHCRC fields.
    const flags = bytes[3];
    let pos = 10;
    if (flags & 4) { pos += 2 + (bytes[pos] | (bytes[pos + 1] << 8)); }
    if (flags & 8) { while (bytes[pos++]) {} }
    if (flags & 16) { while (bytes[pos++]) {} }
    if (flags & 2) { pos += 2; }
    return inflateRaw(bytes.subarray(pos, bytes.length - 8));
  }

  /* Read a .json.gz archive. Android WebView may hand back a response without a readable body
     stream for assets served by shouldInterceptRequest, so take the bytes first and decompress
     explicitly instead of piping the response stream. */
  async function readGzipJSON(response) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (window.DecompressionStream) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
        return JSON.parse(await new Response(stream).text());
      } catch (error) {
        // Fall through to the built-in inflater rather than failing the whole page.
        console.warn("DecompressionStream 解压失败，改用内置解压：", error);
      }
    }
    const text = new TextDecoder("utf-8").decode(gunzip(bytes));
    return JSON.parse(text);
  }

  async function readJSON(path) {
    const response = await fetch(path);
    if (!response.ok) throw new Error("读取画廊数据失败，请稍后重试。");
    if (path.endsWith(".gz")) return readGzipJSON(response);
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
      const card = document.createElement("div");
      card.className = "art-card";
      card.tabIndex = 0;
      card.setAttribute("role", "group");
      card.setAttribute("aria-label", `作品 #${post.id}，${post.width} × ${post.height}`);
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
      const authorNames = metadata(post).authors;
      const actions = document.createElement("span");
      actions.className = "card-actions";
      const favorite = document.createElement("button");
      favorite.type = "button";
      favorite.className = "card-action favorite-toggle";
      favorite.textContent = favorites.has(post.id) ? "♥ 已收藏" : "♡ 收藏";
      favorite.setAttribute("aria-pressed", String(favorites.has(post.id)));
      favorite.addEventListener("click", event => {
        event.stopPropagation();
        if (favorites.has(post.id)) favorites.delete(post.id); else favorites.add(post.id);
        persistFavorites();
        favorite.textContent = favorites.has(post.id) ? "♥ 已收藏" : "♡ 收藏";
        favorite.setAttribute("aria-pressed", String(favorites.has(post.id)));
        if ($("viewFilter").value === "favorites" && !favorites.has(post.id)) loadRange();
      });
      const pick = document.createElement("input");
      pick.type = "checkbox";
      pick.className = "batch-pick";
      pick.dataset.postId = String(post.id);
      pick.setAttribute("aria-label", `选择作品 #${post.id} 上传到 Drive`);
      pick.addEventListener("click", event => event.stopPropagation());
      pick.addEventListener("change", () => {
        if (pick.checked) selected.add(post.id); else selected.delete(post.id);
        $("batchCount").textContent = `已选 ${selected.size} 张`;
      });
      actions.append(favorite);
      if (authorNames.length) {
        const authorButton = document.createElement("button");
        authorButton.type = "button"; authorButton.className = "card-action author-favorite";
        authorButton.textContent = favoriteAuthors.has(norm(authorNames[0])) ? `♥ ${authorNames[0]}` : `☆ ${authorNames[0]}`;
        authorButton.title = "收藏/取消收藏作者"; authorButton.setAttribute("aria-pressed", String(favoriteAuthors.has(norm(authorNames[0]))));
        authorButton.addEventListener("click", event => { event.stopPropagation(); const key = norm(authorNames[0]); if (favoriteAuthors.has(key)) favoriteAuthors.delete(key); else favoriteAuthors.add(key); localStorage.setItem("hoshi_yande_authors", JSON.stringify([...favoriteAuthors])); authorButton.setAttribute("aria-pressed", String(favoriteAuthors.has(key))); authorButton.textContent = favoriteAuthors.has(key) ? `♥ ${authorNames[0]}` : `☆ ${authorNames[0]}`; if ($("viewFilter").value === "favoriteAuthors") applySearch(); });
        actions.append(authorButton);
      }
      const tags = metadata(post).tags.slice(0, 4);
      if (tags.length) {
        const tagWrap = document.createElement("span"); tagWrap.className = "card-tags";
        for (const tag of tags) { const b = document.createElement("button"); b.type = "button"; b.className = "tag-favorite"; b.textContent = (favoriteTags.has(norm(tag)) ? "♥ " : "+ ") + tag; b.title = "收藏标签"; b.setAttribute("aria-pressed", String(favoriteTags.has(norm(tag)))); b.addEventListener("click", event => { event.stopPropagation(); const key = norm(tag); if (favoriteTags.has(key)) favoriteTags.delete(key); else favoriteTags.add(key); localStorage.setItem("hoshi_yande_tags", JSON.stringify([...favoriteTags])); b.textContent = (favoriteTags.has(key) ? "♥ " : "+ ") + tag; b.setAttribute("aria-pressed", String(favoriteTags.has(key))); if ($("viewFilter").value === "favoriteTags") applySearch(); }); tagWrap.appendChild(b); }
        actions.append(tagWrap);
      }
      actions.append(pick);
      card.append(thumb, meta, actions);
      card.addEventListener("click", () => openViewer(index, card));
      card.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openViewer(index, card); } });
      fragment.appendChild(card);
    }
    $("archiveGrid").appendChild(fragment);
    shown = next;
    $("loadMore").hidden = shown >= works.length;
    $("gridProgress").textContent = works.length ? `已显示 ${shown} / ${works.length} 张` : "";
  }
  function applySearch() {
    const query = norm($("archiveSearch").value);
    const mode = $("viewFilter").value;
    works = allWorks.filter(post => {
      const meta = metadata(post), authorMatch = meta.authors.some(name => favoriteAuthors.has(norm(name)));
      const tagMatch = meta.tags.some(tag => favoriteTags.has(norm(tag)));
      if (mode === "favoriteAuthors" && !authorMatch) return false;
      if (mode === "favoriteTags" && !tagMatch) return false;
      if (!query) return true;
      return [post.id, post.date, post.rating, post.score, ...meta.authors, ...meta.tags].some(value => norm(value).includes(query));
    });
    shown = 0; $("archiveGrid").replaceChildren(); appendWorks();
    $("archiveStatus").textContent = works.length ? `${works.length.toLocaleString()} 张作品 · 重复作品已合并` : "没有匹配的作品。";
    $("randomButton").disabled = !works.length;
  }
  async function loadRange() {
    const generation = ++loadGeneration;
    selected.clear();
    $("batchCount").textContent = "已选 0 张";
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
      if (!validDate(start) || !validDate(end) || start > end) throw new Error(`开始日期不能晚于结束日期，范围为 ${START} 至 ${END}。`);
      $("archiveStatus").textContent = "正在加载所选日期的收藏…";
      manifest ||= await readJSON("./data/manifest.json");
      const months = manifest.months.filter(month => month.month >= start.slice(0, 7) && month.month <= end.slice(0, 7));
      const archives = [];
      for (let offset = 0; offset < months.length; offset += 4) {
        archives.push(...await Promise.all(months.slice(offset, offset + 4).map(readMonth)));
        if (generation !== loadGeneration) return;
      }
      if (generation !== loadGeneration) return;
      allWorks = selectWorks(archives, start, end, $("sortOrder").value, $("ratingFilter").value,
        $("viewFilter").value === "favorites" ? favorites : null);
      works = allWorks;
      updateMonthTabs(start, end);
      const viewTitles = { favorites: "作品收藏", favoriteAuthors: "收藏作者", favoriteTags: "收藏标签" };
      $("rangeTitle").textContent = viewTitles[$("viewFilter").value] || (start === START && end === END ? "全部作品" : start === end ? start + " 日榜" : `${start} — ${end}`);
      $("archiveStatus").textContent = works.length ? `${works.length.toLocaleString()} 张作品 · 重复作品已合并` : "这段日期暂无可展示的作品。";
      $("randomButton").disabled = !works.length;
      $("snapshotDate").textContent = " 数据更新于 " + manifest.fetchedAt.slice(0, 10) + "。";
      const url = new URL(location.href);
      url.searchParams.set("start", start);
      url.searchParams.set("end", end);
      url.searchParams.set("sort", $("sortOrder").value);
      history.replaceState(null, "", url);
      applySearch();
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
    $("artImage").replaceWith(image);
    viewerImage = image;
    // Originals are often several megabytes and can take a long time on a slow link. Show the
    // grid preview immediately so opening a work is instant, then upgrade to the original.
    const preview = /^https:\/\/(assets|files)\.yande\.re\//.test(post.preview) ? post.preview : null;
    if (preview) image.src = preview;
    let upgraded = false;
    const showOriginal = () => {
      if (upgraded || generation !== imageGeneration) return;
      upgraded = true;
      image.src = post.original;
    };
    image.addEventListener("load", () => {
      if (generation !== imageGeneration) return;
      $("artLoading").hidden = true;
      // The preview just painted: fetch the original in the background and swap it in.
      if (preview && image.src === preview) {
        const loader = new Image();
        loader.referrerPolicy = "no-referrer";
        loader.onload = () => { if (generation === imageGeneration) { upgraded = true; image.src = post.original; } };
        loader.onerror = () => {
          if (generation !== imageGeneration) return;
          $("artLoading").hidden = false;
          $("artLoading").textContent = "原图加载失败，当前显示预览图；可点击「打开原图」重试。";
        };
        loader.src = post.original;
      }
    });
    image.addEventListener("error", () => {
      if (generation !== imageGeneration) return;
      // The preview itself failed (offline or blocked): fall back to requesting the original.
      if (preview && !upgraded) { showOriginal(); return; }
      $("artLoading").hidden = false;
      $("artLoading").textContent = "原图加载失败，可点击「打开原图」重试。";
    });
    if (!preview) image.src = post.original;
    // Large originals paint progressively; drop the badge as soon as pixels exist.
    (function watchFirstPaint() {
      let frames = 0;
      const tick = () => {
        if (generation !== imageGeneration) return;
        if (!image.isConnected) return;
        if (image.naturalWidth > 0) { $("artLoading").hidden = true; return; }
        if (image.complete) return; // finished without pixels: the error handler speaks
        if (++frames < 3000) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })();
    if (document.fullscreenElement === dialog) preloadNextImages(viewerIndex);
  }
  function preloadNextImages(index) {
    for (let step = 1; step <= Math.min(3, works.length - 1); step++) {
      const next = works[(index + step) % works.length];
      if (!next || !next.original) continue;
      const preload = new Image(); preload.decoding = "async"; preload.referrerPolicy = "no-referrer"; preload.src = next.original;
    }
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
      else { await dialog.requestFullscreen(); preloadNextImages(viewerIndex); }
    } catch (_) { $("artLoading").textContent = "浏览器暂不支持全屏。"; $("artLoading").hidden = false; }
  });
  $("selectVisible").addEventListener("click", () => {
    document.querySelectorAll(".batch-pick").forEach(box => {
      box.checked = true;
      const post = works.find(item => item.id === Number(box.dataset.postId));
      if (post) selected.add(post.id);
    });
    $("batchCount").textContent = `已选 ${selected.size} 张`;
  });
  $("clearSelected").addEventListener("click", () => {
    selected.clear();
    document.querySelectorAll(".batch-pick").forEach(box => { box.checked = false; });
    $("batchCount").textContent = "已选 0 张";
  });
  $("uploadSelected").addEventListener("click", async () => {
    const batch = [...selected].map(id => works.find(post => post.id === id)).filter(Boolean);
    if (!batch.length) { $("batchProgress").textContent = "先选择作品。"; return; }
    if (!window.__hoshiYandeUploadBatch) { $("batchProgress").textContent = "Drive 上传模块尚未就绪，请稍候重试。"; return; }
    const button = $("uploadSelected"); button.disabled = true;
    try {
      await window.__hoshiYandeUploadBatch(batch, (done, total, post, sent, bytes) => {
        const percent = bytes ? ` · ${Math.floor(sent * 100 / bytes)}%` : "";
        $("batchProgress").textContent = `${done}/${total} · #${post.id}${percent}`;
      });
      $("batchProgress").textContent = `队列完成：${batch.length} 张`;
    } catch (error) { $("batchProgress").textContent = "队列中断：" + error.message; }
    finally { button.disabled = false; }
  });
  $("randomButton").addEventListener("click", () => openViewer(Math.floor(Math.random() * works.length)));
  $("loadMore").addEventListener("click", appendWorks);
  $("retryButton").addEventListener("click", loadRange);
  form.addEventListener("submit", event => { event.preventDefault(); loadRange(); });
  $("sortOrder").addEventListener("change", loadRange);
  $("ratingFilter").addEventListener("change", loadRange);
  $("viewFilter").addEventListener("change", loadRange);
  $("archiveSearch").addEventListener("input", applySearch);
  $("periodTabs").addEventListener("click", event => {
    const button = event.target.closest("button[data-period]"); if (!button) return;
    const now = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
    const [start, end] = button.dataset.period === "week" ? rankWeekRange(now) : rankMonthRange(now);
    startInput.value = start; endInput.value = end; $("sortOrder").value = "score"; loadRange();
  });
  const rank = document.createDocumentFragment();
  for (const [label, period] of [["本周榜", "week"], ["本月榜", "month"]]) { const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.dataset.period = period; rank.appendChild(button); }
  $("periodTabs").appendChild(rank);
  startInput.value = START;
  endInput.value = END;
  addMonthButton("全部", START, END);
  for (let cursor = new Date(2022, 0, 1); cursor <= new Date(END + "T00:00:00"); cursor.setMonth(cursor.getMonth() + 1)) {
    const year = cursor.getFullYear(), month = cursor.getMonth() + 1;
    const prefix = `${year}-${String(month).padStart(2, "0")}`;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (prefix <= END.slice(0, 7)) addMonthButton(prefix, prefix + "-01", prefix === END.slice(0, 7) ? END : prefix + "-" + last);
  }
  const params = new URL(location.href).searchParams;
  if (validDate(params.get("start"))) startInput.value = params.get("start");
  if (validDate(params.get("end"))) endInput.value = params.get("end");
  if (params.get("sort") === "score") $("sortOrder").value = "score";
  loadRange();
})();
