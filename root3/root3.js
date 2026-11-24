/* 单目录视频库：只列出固定 Drive 目录里的视频，支持搜索与播放（不含任何网站来源）。 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var H = window.AndroidHost;
  var MEDIA = new URL('../media/', location.href).pathname;
  var SW_URL = new URL('../sw.js?v=media-prefix-4', location.href).href;
  var SW_SCOPE = new URL('../', location.href).pathname;

  var OAUTH_BRIDGE = 'https://drive-oauth-bridge.143322378jb.workers.dev';
  var flavor = {};
  try { flavor = JSON.parse((H && H.getFlavor && H.getFlavor()) || '{}') || {}; } catch (_) { flavor = {}; }
  var ROOT_NAME = flavor.rootFolderName || '1433223';
  var ROOT_ID = flavor.rootFolderId || '';

  /* 桌面版没有原生桥：从站点根目录的 app-flavor.json 读取同一个配置。 */
  async function loadFlavor() {
    if (ROOT_ID) return flavor;
    try {
      var res = await fetch('../app-flavor.json', { cache: 'no-store' });
      if (res.ok) {
        var data = await res.json();
        flavor = Object.assign({}, flavor, data || {});
        ROOT_NAME = flavor.rootFolderName || ROOT_NAME;
        ROOT_ID = flavor.rootFolderId || ROOT_ID;
      }
    } catch (_) { /* 没有配置文件就用默认目录 */ }
    return flavor;
  }

  var token = '';
  var videos = [];
  var shown = [];
  var playing = null;
  var triedTranscode = false;
  var DESKTOP = !!(window.__hoshiDesktop || (window.AndroidHost && !window.hoshiNativeDriveToken));
  var swReady = null;

  function status(text) { $('status').textContent = text; }
  function fail(text) {
    var el = $('error');
    el.hidden = !text;
    el.textContent = text || '';
  }
  function human(size) {
    var n = Number(size) || 0;
    if (!n) return '';
    var units = ['B', 'KB', 'MB', 'GB'];
    var i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : n) + ' ' + units[i];
  }
  function isVideo(file) {
    if (!file) return false;
    if (file.mimeType && file.mimeType.indexOf('video/') === 0) return true;
    return /\.(mp4|m4v|mov|webm|mkv|avi|ts)$/i.test(file.name || '');
  }
  function isFolder(file) {
    return file && file.mimeType === 'application/vnd.google-apps.folder';
  }
  function esc(v) { return String(v == null ? '' : v); }

  /* ---------------------------------------------------------------- 授权 */

  async function getToken() {
    // Android：走原生桥；桌面（Electron）：用本机保存的 oauth_session 换令牌。
    if (typeof window.hoshiNativeDriveToken === 'function') {
      var value = await window.hoshiNativeDriveToken(true);
      if (!value) throw new Error('未取得 Drive 访问令牌');
      token = value;
      return token;
    }
    var session = '';
    try { session = localStorage.getItem('drive_oauth_session') || ''; } catch (_) { session = ''; }
    if (!session) throw new Error('需要登录 Google 账号（桌面版请用菜单「网络 → 浏览器授权」）');
    var response = await fetch(OAUTH_BRIDGE + '/token', {
      headers: { Authorization: 'Bearer ' + session }, cache: 'no-store'
    });
    if (!response.ok) throw new Error('授权已失效，请重新授权（HTTP ' + response.status + '）');
    var data = await response.json();
    if (!data || !data.access_token) throw new Error('授权服务没有返回令牌');
    token = data.access_token;
    return token;
  }

  async function request(url) {
    var auth = { Authorization: 'Bearer ' + token };
    if (!H || typeof H.httpRequest !== 'function') {
      var direct = await fetch(url, { headers: auth, cache: 'no-store' });
      if (!direct.ok) throw Object.assign(new Error('HTTP ' + direct.status), { status: direct.status });
      return direct.json();
    }
    var headers = JSON.stringify(auth);
    var raw;
    try {
      raw = H.httpRequest(url, 'GET', headers, '');
      // 桌面桥（Electron preload）是异步的，返回 Promise；必须等它，否则拿到 "[object Promise]"。
      if (raw && typeof raw.then === 'function') raw = await raw;
    } catch (e) {
      // 原生 DNS 偶发失败时改用 WebView 自己的网络栈
      var response = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
      if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { status: response.status });
      return response.json();
    }
var result = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    var status = Number(result.status || result.statusCode || 0);
    var bodyText = result.body != null ? result.body : (result.text != null ? result.text : '');
    // 桌面桥只返回 {status, body}，没有 ok 字段；一律按状态码判定。
    if (status === 0 || (status >= 200 && status < 300)) {
      if (bodyText && typeof bodyText === 'object') return bodyText;
      return JSON.parse(bodyText || '{}');
    }
    if (/Failed to fetch|Unable to resolve host|timed out/i.test(String(bodyText))) {
      var retry = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, cache: 'no-store' });
      if (!retry.ok) throw Object.assign(new Error('HTTP ' + retry.status), { status: retry.status });
      return retry.json();
    }
    throw Object.assign(new Error('HTTP ' + status + ' ' + String(bodyText).slice(0, 160)), { status: status });
  }

  async function listChildren(folderId) {
    var out = [];
    var pageToken = '';
    for (var page = 0; page < 40; page++) {
      var q = "'" + folderId.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "' in parents and trashed = false";
      var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
        '&fields=' + encodeURIComponent('nextPageToken,files(id,name,mimeType,size,parents,resourceKey,videoMediaMetadata)') +
        '&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true';
      if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
      var data = await request(url);
      (data.files || []).forEach(function (f) { out.push(f); });
      pageToken = data.nextPageToken || '';
      if (!pageToken) break;
    }
    return out;
  }

  async function resolveRoot() {
    if (ROOT_ID) {
      try {
        var meta = await request('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(ROOT_ID) +
          '?fields=id,name,mimeType&supportsAllDrives=true');
        if (isFolder(meta)) return meta;
      } catch (e) { /* 回退按名称 */ }
    }
    var q = "name = '" + ROOT_NAME.replace(/\\/g, '\\\\').replace(/'/g, "\\'") +
      "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    var found = await request('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
      '&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=10');
    var files = found.files || [];
    if (!files.length) throw new Error('Drive 里没有名为「' + ROOT_NAME + '」的文件夹');
    return files[0];
  }

  /* ---------------------------------------------------------------- 扫描 */

async function scan() {
    fail('');
    var root;
    try {
      status('正在定位「' + ROOT_NAME + '」…');
      root = await resolveRoot();
    } catch (e) {
      status('无法读取目录');
      fail(e.message + '\n检查网络后点「刷新」重试。');
      return;
    }
    videos = [];
    var MAX_FOLDERS = 1500;   // 电影库常见 3-4 层、上千个片名目录，上限太小会一个视频都扫不到
    var CONCURRENCY = 4;
    var queue = [{ id: root.id, path: '' }];
    var folders = 0;
    var active = 0;

    await new Promise(function (resolve) {
      function pump() {
        if ((!queue.length && active === 0) || folders >= MAX_FOLDERS) { resolve(); return; }
        while (queue.length && active < CONCURRENCY && folders < MAX_FOLDERS) {
          (function (current) {
            folders++;
            active++;
            status('正在读取「' + (current.path || root.name) + '」 · 已找到 ' + videos.length +
              ' 个视频 · ' + folders + ' 个目录');
            listChildren(current.id).then(function (children) {
              children.forEach(function (f) {
                var path = current.path ? current.path + ' / ' + f.name : f.name;
                if (isFolder(f)) queue.push({ id: f.id, path: path });
                else if (isVideo(f)) {
                  videos.push({
                    id: f.id, name: f.name, path: current.path || root.name,
                    size: Number(f.size) || 0, resourceKey: f.resourceKey || null
                  });
                }
              });
              // 边扫边出：每拿到一批就在列表里追加，不用等整棵树扫完
              if (children.some(isVideo)) scheduleRender();
            }).catch(function () {
              // 单个子目录失败不影响其它目录
            }).then(function () {
              active--;
              pump();
            });
          })(queue.shift());
        }
      }
      pump();
    });

    videos.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
    status('「' + (root.name || ROOT_NAME) + '」 · ' + videos.length + ' 个视频' +
      (folders >= MAX_FOLDERS ? '（目录过多，已截断至 ' + MAX_FOLDERS + ' 个）' : ''));
    render();
  }

  /* ---------------------------------------------------------------- 列表 */

  var renderTimer = null;
  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () { renderTimer = null; render(); }, 400);
  }

  function render() {
    var term = ($('search').value || '').trim().toLowerCase();
    shown = term
      ? videos.filter(function (v) {
          return (v.name + ' ' + v.path).toLowerCase().indexOf(term) >= 0;
        })
      : videos.slice();
    var list = $('list');
    var keepScroll = window.scrollY;
    list.replaceChildren();
    shown.forEach(function (v) {
      var row = document.createElement('div');
      row.className = 'row';
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      var badge = document.createElement('div');
      badge.className = 'badge';
      badge.textContent = '▶';
      var meta = document.createElement('div');
      meta.className = 'meta';
      var name = document.createElement('div');
      name.className = 'name';
      name.textContent = v.name;
      var path = document.createElement('div');
      path.className = 'path';
      path.textContent = v.path;
      meta.append(name, path);
      var size = document.createElement('div');
      size.className = 'size';
      size.textContent = human(v.size);
      row.append(badge, meta, size);
      row.addEventListener('click', function () { play(v); });
      row.addEventListener('keydown', function (e) { if (e.key === 'Enter') play(v); });
      list.append(row);
    });
    $('empty').hidden = shown.length > 0 || !videos.length;
    if (videos.length && !shown.length) $('empty').hidden = false;
    if (!videos.length) $('empty').hidden = true;
    if (keepScroll > 0 && window.scrollY !== keepScroll) window.scrollTo(0, keepScroll);
  }

  /* ---------------------------------------------------------------- 播放 */

  async function ensureWorker(fileId, fileSize) {
    if (!('serviceWorker' in navigator)) throw new Error('当前 WebView 不支持媒体服务');
    if (!swReady) {
      swReady = (async function () {
        await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
        var reg = await navigator.serviceWorker.ready;
        if (!navigator.serviceWorker.controller) {
          await new Promise(function (resolve) {
            var timer = setTimeout(resolve, 6000);
            navigator.serviceWorker.addEventListener('controllerchange', function () { clearTimeout(timer); resolve(); });
          });
        }
        return reg;
      })().catch(function (e) { swReady = null; throw e; });
    }
    await swReady;
    var worker = navigator.serviceWorker.controller;
    if (!worker) throw new Error('媒体服务未接管本页，请重开本页后重试');
    await new Promise(function (resolve, reject) {
      var channel = new MessageChannel();
      var timer = setTimeout(function () { reject(new Error('媒体服务未确认授权')); }, 8000);
      channel.port1.onmessage = function (event) {
        clearTimeout(timer);
        event.data && event.data.ok ? resolve() : reject(new Error('媒体服务拒绝了令牌'));
      };
      worker.postMessage({ type: 'SET_TOKEN', fileId: fileId, token: token, fileSize: fileSize }, [channel.port2]);
    });
  }

  function startTranscode(startAt) {
    if (!playing) return;
    var msg = $('playerMsg');
    var video = $('video');
    msg.hidden = false;
    msg.textContent = '正在转码播放（H.265 → H.264），首次约需几秒…';
    var t0 = Date.now();
    clearInterval(window.__hoshiTranscodeTimer);
    window.__hoshiTranscodeTimer = setInterval(function () {
      if (!playing || !$('viewer').open) { clearInterval(window.__hoshiTranscodeTimer); return; }
      var secs = Math.round((Date.now() - t0) / 1000);
      if (secs > 25) {
        clearInterval(window.__hoshiTranscodeTimer);
        msg.textContent = '转码较慢（已 ' + secs + ' 秒）。可继续等，或点「用其它播放器打开」。';
        $('externalBtn').hidden = !(H && (typeof H.openInPlayer === 'function' || typeof H.openExternalMedia === 'function'));
        return;
      }
      msg.textContent = '正在转码播放（H.265 → H.264）' + secs + 's…';
    }, 1000);
    $('transcodeBtn').hidden = true;
    var url = new URL('../__transcode/' + encodeURIComponent(playing.id) +
      '?t=' + Math.max(0, Math.floor(startAt || 0)), location.href).href;
    video.src = url;
    video.load();
    var p = video.play();
    if (p && p.catch) p.catch(function () { });
  }

  /** 失败原因判定：区分授权失效 / 网络读取失败 / 内容不是视频 / 真的解码不了。 */
  async function classifyFailure(videoEl) {
    try {
      var src = videoEl && (videoEl.currentSrc || videoEl.src);
      if (!src) return { kind: "unknown" };
      var res = await fetch(src, { headers: { Range: "bytes=0-1" }, cache: "no-store" });
      var type = res.headers.get("content-type") || "";
      if (res.status === 401 || res.status === 403) return { kind: "auth", status: res.status };
      if (res.status >= 400 || res.status === 0) return { kind: "network", status: res.status };
      var body = new Uint8Array(await res.arrayBuffer()).slice(0, 12);
      var head = "";
      for (var i = 0; i < body.length; i++) head += String.fromCharCode(body[i]);
      if (/^\s*[<{]/.test(head)) return { kind: "wrongbody", type: type };
      return { kind: "decode", type: type };
    } catch (e) {
      return { kind: "unreachable", detail: String(e && e.message || e) };
    }
  }

  async function play(item) {
    triedTranscode = false;
    var video = $('video');
    var msg = $('playerMsg');
    msg.hidden = true;
    $('playingTitle').textContent = item.name;
    playing = item;
    if (!$('viewer').open) $('viewer').showModal();
    try {
      status('正在准备播放「' + item.name + '」…');
      if (!token) await getToken();
      await ensureWorker(item.id, item.size || 1);
      var needsTranscode = DESKTOP && /\.(mkv|avi|ts|rmvb|flv|wmv)$/i.test(item.name || '');
      $('transcodeBtn').hidden = !needsTranscode;
      var url = MEDIA + encodeURIComponent(item.id) + (item.resourceKey ? '?resourceKey=' + encodeURIComponent(item.resourceKey) : '');
      video.src = url;
      video.load();
      try { await video.play(); } catch (_) { /* 需要用户再点一次 */ }
      status('正在播放「' + item.name + '」');
    } catch (e) {
      msg.hidden = false;
      msg.textContent = '播放失败：' + (e && e.message ? e.message : e);
    }
  }

  /* ---------------------------------------------------------------- 启动 */

  function wire() {
    $('appTitle').textContent = flavor.title || '星映';
    $('appSub').textContent = (ROOT_NAME || '').toUpperCase();
    $('search').addEventListener('input', render);
    $('refresh').addEventListener('click', start);
    $('connect').addEventListener('click', function () {
      // reauthorizeDrive() opens the "system browser / in-app page" chooser; keep it, but fall back
      // to the direct entry point if the build only exposes that one.
      if (H && typeof H.reauthorizeDrive === 'function') { H.reauthorizeDrive(); return; }
      if (H && typeof H.authorizeDrive === 'function') { H.authorizeDrive(); return; }
      if (H && typeof H.connectDrive === 'function') { H.connectDrive(); return; }
      // 兜底：直接跳授权地址；桌面主进程会拦截并改用系统浏览器
      location.href = OAUTH_BRIDGE + '/auth';
    });
    $('backToList').addEventListener('click', function () { $('closePlayer').click(); });
    $('closePlayer').addEventListener('click', function () {
      var video = $('video');
      video.pause();
      video.removeAttribute('src');
      video.load();
      $('viewer').close();
      status('「' + (ROOT_NAME || '') + '」 · ' + videos.length + ' 个视频');
    });
    $('viewer').addEventListener('cancel', function (event) { event.preventDefault(); $('closePlayer').click(); });
    // MKV / H.265 这类格式 Chromium 解不了：桌面版先用 ffmpeg 实时转码，失败再交给外部播放器。
    $('video').addEventListener('error', function () {
      if (!playing) return;
      var msg = $('playerMsg');
      if (DESKTOP) $('transcodeBtn').hidden = false;
      // 不自动转码：转码吃 CPU/带宽，等用户点「转码播放」
      var canExternal = !!(H && (typeof H.openExternalMedia === 'function' || typeof H.openInPlayer === 'function'));
      msg.hidden = false;
      msg.textContent = '正在判断失败原因…';
      classifyFailure($('video')).then(function (info) {
        if (info.kind === 'auth') msg.textContent = '授权已失效（HTTP ' + info.status + '），请点右上角「连接 Drive」重新授权。';
        else if (info.kind === 'network') msg.textContent = '读取失败（HTTP ' + info.status + '）：网络或中继异常，可稍后重试。';
        else if (info.kind === 'wrongbody') msg.textContent = '服务器返回的不是视频数据（' + (info.type || '未知') + '），检查授权/中继。';
        else if (info.kind === 'unreachable') msg.textContent = '连不上媒体地址：' + (info.detail || '网络不可用');
        else msg.textContent = '浏览器无法解码这个视频（MKV / H.265 常见）。' +
          (canExternal ? '可点「用系统播放器打开」。' : '可用 ffmpeg 转码播放。');
      });
      $('externalBtn').hidden = !canExternal;
      $('externalBtn').hidden = !canExternal;
    });
    $('transcodeBtn').addEventListener('click', function () { if (playing) startTranscode(0); });
    $('externalBtn').addEventListener('click', async function () {
      if (!playing) return;
      var msg = $('playerMsg');
      try {
        // Android：本机中继 + 系统播放器选择器；桌面：VLC/PotPlayer/mpv 或系统默认
        if (H && typeof H.openInPlayer === 'function') {
          H.openInPlayer(playing.id, playing.name);
          msg.hidden = false;
          msg.textContent = '已交给系统播放器打开：' + playing.name;
          return;
        }
        if (!H || typeof H.openExternalMedia !== 'function') return;
        var raw = await H.openExternalMedia(playing.id, playing.name);
        var info = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
        msg.hidden = false;
        msg.textContent = info.ok
          ? ('已用外部播放器打开：' + (info.player || ''))
          : ((info.error || '打不开外部播放器') + (info.url ? ('\n' + info.url) : ''));
      } catch (e) {
        msg.hidden = false;
        msg.textContent = '调用外部播放器失败：' + (e && e.message ? e.message : e);
      }
    });
  }

  async function start() {
    await loadFlavor();
    $('appTitle').textContent = flavor.title || '星映';
    $('appSub').textContent = (ROOT_NAME || '').toUpperCase();
    fail('');
    $('connect').hidden = true;
    status('正在授权…');
    try {
      await getToken();
    } catch (e) {
      status('需要登录 Google 账号');
      var hint = flavor.loginHint ? '\n建议账号：' + flavor.loginHint : '';
      fail(e.message + hint +
        '\n点「连接 Drive」打开 Google 登录页。' +
        '\n若出现「星映 尚未完成 Google 验证流程…仅供已获开发者批准的测试人员使用」，说明该邮箱不在 OAuth 测试名单：' +
        '把它加入 Google Cloud 项目的「测试用户」，或改用已获批准的账号（本目录所属账号 143322378jb@gmail.com）。');
      $('connect').hidden = false;
      return;
    }
    await scan();
  }

  wire();
  start();
})();
