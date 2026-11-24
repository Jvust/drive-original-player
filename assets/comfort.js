/* Hoshi comfort layer: local appearance preferences, accessible help and non-destructive library search. */
(() => {
  "use strict";
  const KEY = "hoshi-comfort-v1";
  const defaults = { density: "comfortable", tone: "cinema", motion: "system" };
  let preferences;
  try { preferences = { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || "{}") }; }
  catch (_) { preferences = { ...defaults }; }
  const allowed = { density: ["comfortable", "compact"], tone: ["cinema", "soft"], motion: ["system", "reduced"] };
  function apply() {
    for (const [key, values] of Object.entries(allowed)) {
      if (!values.includes(preferences[key])) preferences[key] = defaults[key];
      document.body.dataset["ui" + key[0].toUpperCase() + key.slice(1)] = preferences[key];
    }
  }
  apply();
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  const header = document.querySelector(".site-header");
  if (!header) return;
  const toolbar = el("div", "comfort-toolbar");
  toolbar.setAttribute("aria-label", "界面与帮助");
  const helpButton = el("button", "comfort-help-button", "快捷键");
  helpButton.type = "button";
  helpButton.title = "查看操作说明（?）";
  const settingsButton = el("button", "comfort-settings-button", "界面设置");
  settingsButton.type = "button";
  settingsButton.title = "调整显示密度、背景和动效";
  toolbar.append(helpButton, settingsButton);
  header.append(toolbar);

  const dialog = el("dialog", "comfort-dialog");
  dialog.id = "comfortDialog";
  dialog.setAttribute("aria-labelledby", "comfortDialogTitle");
  const dialogHead = el("div", "comfort-dialog-head");
  const dialogTitle = el("h2", "", "界面设置");
  dialogTitle.id = "comfortDialogTitle";
  const close = el("button", "comfort-close", "关闭 ×");
  close.type = "button";
  close.setAttribute("aria-label", "关闭设置与帮助");
  const dialogBody = el("div", "comfort-dialog-body");
  dialogHead.append(dialogTitle, close);
  dialog.append(dialogHead, dialogBody);
  document.body.append(dialog);
  close.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", event => { if (event.target === dialog) {
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  } });
  // Prevent page-level playback/viewer shortcuts while a modal has keyboard focus.
  dialog.addEventListener("keydown", event => event.stopPropagation());
  function showDialog(title) {
    dialogTitle.textContent = title;
    dialogBody.replaceChildren();
    if (!dialog.open) dialog.showModal();
  }
  function setting(key, title, description, options) {
    const row = el("label", "comfort-setting");
    const copy = el("span", "comfort-setting-copy");
    copy.append(el("strong", "", title), el("small", "", description));
    const select = el("select");
    select.setAttribute("aria-label", title);
    for (const [value, label] of options) {
      const option = el("option", "", label); option.value = value; select.append(option);
    }
    select.value = preferences[key];
    select.addEventListener("change", () => {
      preferences[key] = select.value; apply();
      try { localStorage.setItem(KEY, JSON.stringify(preferences)); }
      catch (_) { note.textContent = "当前存储不可用，本次设置将在关闭后恢复默认。"; }
    });
    row.append(copy, select); dialogBody.append(row);
  }
  const note = el("p", "comfort-note", "设置仅保存在这台设备，不影响原文件、画质或播放进度。");
  settingsButton.addEventListener("click", () => {
    showDialog("按你的习惯，舒服一点。");
    setting("density", "显示密度", "舒适留白，或在同一屏看到更多内容。", [["comfortable", "舒适"], ["compact", "紧凑"]]);
    setting("tone", "背景氛围", "柔和模式降低封面与背景的视觉干扰。", [["cinema", "影院"], ["soft", "柔和"]]);
    setting("motion", "界面动效", "跟随系统偏好，或减少过渡与装饰动画。", [["system", "跟随系统"], ["reduced", "减少动效"]]);
    note.textContent = "设置仅保存在这台设备，不影响原文件、画质或播放进度。";
    dialogBody.append(note);
  });
  helpButton.addEventListener("click", () => {
    showDialog("少一点操作，多一点沉浸。");
    const sections = document.body.classList.contains("player-page") ? [
      ["播放控制", [["Space", "播放 / 暂停"], ["← / →", "后退 / 前进 5 秒"], ["J / L", "后退 / 前进 10 秒"], ["M", "静音 / 恢复音量"], ["F", "进入 / 退出全屏"], ["P / N", "上一条 / 下一条视频"]]],
      ["增强功能", [["Alt + W", "悬浮 / 还原播放器"], ["Alt + L", "单条循环"], ["Alt + P", "画中画"]]]
    ] : document.body.classList.contains("gallery-page") ? [
      ["图片浏览", [["← / →", "上一张 / 下一张（适应窗口时）"], ["+ / −", "放大 / 缩小"], ["0", "适应窗口"], ["Esc", "关闭图片"], ["滚轮 / 拖动", "缩放 / 移动画面"]]]
    ] : [["作品浏览", [["← / →", "上一张 / 下一张"], ["Esc", "关闭原图查看器"]]]];
    for (const [title, shortcuts] of sections) {
      dialogBody.append(el("h3", "comfort-help-heading", title));
      for (const [key, text] of shortcuts) {
        const row = el("div", "comfort-shortcut"); row.append(el("kbd", "", key), el("span", "", text)); dialogBody.append(row);
      }
    }
    dialogBody.append(el("p", "comfort-note", "目录搜索只筛选已经读取的文件；清空搜索即可回到原来的文件夹展开状态。"));
  });
  document.addEventListener("keydown", event => {
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || event.repeat) return;
    if (event.target?.closest?.("input, textarea, select, [contenteditable='true'], dialog")) return;
    if (event.key === "?" && !document.querySelector("#viewer.open, #artViewer[open]")) { event.preventDefault(); helpButton.click(); }
  });

  function installSearch(container, before, kind) {
    if (!container || !before) return;
    const wrap = el("div", "library-search-wrap");
    const field = el("input", "library-search");
    field.type = "search"; field.placeholder = kind === "video" ? "搜索视频或文件夹…" : "搜索图片或文件夹…";
    field.setAttribute("aria-label", field.placeholder.replace("…", ""));
    field.autocomplete = "off"; field.spellcheck = false;
    const meta = el("div", "library-search-meta");
    meta.setAttribute("role", "status"); meta.setAttribute("aria-live", "polite");
    wrap.append(field, meta); before.before(wrap);
    const itemSelector = kind === "video" ? ".video-playlist-item" : ".card";
    const folderSelector = kind === "video" ? ".drive-tree-folder" : ".gallery-tree-folder";
    const nameSelector = kind === "video" ? ".drive-folder-name" : ".gallery-folder-name";
    const rowSelector = kind === "video" ? ".drive-folder-row" : ".gallery-folder-row";
    let timer;
    function applyFilter() {
      const query = field.value.trim().toLocaleLowerCase();
      const items = [...container.querySelectorAll(itemSelector)];
      container.classList.toggle("comfort-search-active", Boolean(query));
      let count = 0;
      const folders = [...container.querySelectorAll(folderSelector)];
      const folderNames = new Map(folders.map(folder => [folder, (folder.querySelector(nameSelector)?.textContent || "").toLocaleLowerCase()]));
      for (const item of items) {
        let folder = item.closest(folderSelector), folderMatch = false;
        while (query && folder) {
          if (folderNames.get(folder)?.includes(query)) { folderMatch = true; break; }
          folder = folder.parentElement?.closest(folderSelector);
        }
        const match = !query || item.textContent.toLocaleLowerCase().includes(query) || folderMatch;
        item.classList.toggle("comfort-filter-hidden", !match);
        if (match) count++;
        if (kind === "gallery") { item.setAttribute("role", "button"); item.setAttribute("aria-label", item.querySelector(".label")?.textContent || "打开图片"); }
      }
      for (const folder of folders.reverse()) {
        const hasMatch = !query || [...folder.querySelectorAll(itemSelector)].some(item => !item.classList.contains("comfort-filter-hidden"));
        folder.classList.toggle("comfort-filter-hidden", !hasMatch);
        const row = folder.querySelector(rowSelector);
        if (row) row.setAttribute("aria-expanded", String(Boolean(query) || !folder.classList.contains("collapsed")));
      }
      meta.textContent = query ? (count ? `找到 ${count} 个匹配项 · 仅搜索已读取目录` : "没有匹配结果，试试其他名称。") : "";
    }
    field.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(applyFilter, 120); });
    field.addEventListener("keydown", event => { if (event.key === "Escape") { event.stopPropagation(); field.value = ""; applyFilter(); } });
    new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(applyFilter, 80); }).observe(container, { childList: true, subtree: true });
    // Class changes from expanding folders do not rebuild the tree.
    container.addEventListener("click", event => {
      const row = event.target.closest(rowSelector);
      if (row) requestAnimationFrame(() => row.setAttribute("aria-expanded", String(!row.closest(folderSelector)?.classList.contains("collapsed"))));
    });
    applyFilter();
  }
  installSearch(document.getElementById("videoPlaylistItems"), document.getElementById("videoPlaylistItems"), "video");
  installSearch(document.getElementById("grid"), document.getElementById("grid"), "gallery");
  const filename = document.getElementById("filename");
  if (filename) new MutationObserver(() => { filename.title = filename.textContent.trim(); }).observe(filename, { childList: true, characterData: true, subtree: true });
  const refresh = document.querySelector(".site-header button[onclick]");
  refresh?.addEventListener("click", () => { refresh.textContent = "正在刷新…"; refresh.disabled = true; refresh.setAttribute("aria-busy", "true"); });
})();
