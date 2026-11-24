/* 全部文件：列出所选 Drive 目录里的所有文件（不限图片/视频），可搜索、可下载/打开。 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var H = window.AndroidHost;
  var OAUTH_BRIDGE = 'https://drive-oauth-bridge.143322378jb.workers.dev';
  var token = '';
  var all = [];
  var shown = [];
  var renderTimer = null;

  var prefs = window.HoshiRootPref ? window.HoshiRootPref.current() : { name: '1433223', id: '' };
  var ROOT_NAME = prefs.name || '1433223';
  var ROOT_ID = prefs.id || '';
  var DESKTOP = !!(window.__hoshiDesktop || (H && typeof window.hoshiNativeDriveToken !== 'function'));

  function status(t) { $('status').textContent = t; }
  function fail(t) { var e = $('error'); e.hidden = !t; e.textContent = t || ''; }

  async function getToken() {
    if (typeof window.hoshiNativeDriveToken === 'function') {
      var v = await window.hoshiNativeDriveToken(true);
      if (!v) throw new Error('未取得 Drive 访问令牌');
      return v;
    }
    var session = '';
    try { session = localStorage.getItem('drive_oauth_session') || ''; } catch (_) { }
    if (!session) throw new Error('需要登录 Google 账号');
    var res = await fetch(OAUTH_BRIDGE + '/token', { headers: { Authorization: 'Bearer ' + session }, cache: 'no-store' });
    if (!res.ok) throw new Error('授权已失效（HTTP ' + res.status + '）');
    var data = await res.json();
    if (!data || !data.access_token) throw new Error('授权服务没有返回令牌');
    return data.access_token;
  }

  async function request(url) {
    var auth = { Authorization: 'Bearer ' + token };
    if (!H || typeof H.httpRequest !== 'function') {
      var direct = await fetch(url, { headers: auth, cache: 'no-store' });
      if (!direct.ok) throw Object.assign(new Error('HTTP ' + direct.status), { status: direct.status });
      return direct.json();
    }
    var raw = H.httpRequest(url, 'GET', JSON.stringify(auth), '');
    if (raw && typeof raw.then === 'function') raw = await raw;
    var result = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    var code = Number(result.status || result.statusCode || 0);
    var body = result.body != null ? result.body : (result.text != null ? result.text : '');
    if (code === 0 || (code >= 200 && code < 300)) {
      if (body && typeof body === 'object') return body;
      return JSON.parse(body || '{}');
    }
    throw Object.assign(new Error('HTTP ' + code + ' ' + String(body).slice(0, 120)), { status: code });
  }

  function isFolder(f) { return f && f.mimeType === 'application/vnd.google-apps.folder'; }
  function human(size) {
    var n = Number(size) || 0;
    if (!n) return '';
    var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i ? n.toFixed(1) : n) + ' ' + u[i];
  }
  function icon(f) {
    if (isFolder(f)) return '📁';
    var n = (f.name || '').toLowerCase();
    if (/\.(jpg|jpeg|png|webp|gif|avif)$/.test(n)) return '🖼';
    if (/\.(mp4|mkv|avi|mov|webm|ts|rmvb)$/.test(n)) return '🎬';
    if (/\.(zip|rar|7z|tar|gz)$/.test(n)) return '📦';
    if (/\.(json|ipynb|txt|md|log)$/.test(n)) return '📄';
    if (/\.(pdf)$/.test(n)) return '📕';
    return '📄';
  }

  async function listChildren(folderId) {
    var out = [], pageToken = '';
    for (var page = 0; page < 40; page++) {
      var q = "'" + String(folderId).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "' in parents and trashed = false";
      var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
        '&fields=' + encodeURIComponent('nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,resourceKey)') +
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
      } catch (_) { }
    }
    var q = "name = '" + String(ROOT_NAME).replace(/\\/g, '\\\\').replace(/'/g, "\\'") +
      "' and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    var found = await request('https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
      '&fields=files(id,name,mimeType)&supportsAllDrives=true&includeItemsFromAllDrives=true&pageSize=10');
    var files = found.files || [];
    if (!files.length) throw new Error('Drive 里没有名为「' + ROOT_NAME + '」的文件夹');
    return files[0];
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(function () { renderTimer = null; render(); }, 400);
  }

  function render() {
    var term = ($('search').value || '').trim().toLowerCase();
    shown = term
      ? all.filter(function (f) { return (f.name + ' ' + f.path).toLowerCase().indexOf(term) >= 0; })
      : all.slice();
    var list = $('list');
    var keep = window.scrollY;
    list.replaceChildren();
    shown.forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'row';
      row.tabIndex = 0;
      var ic = document.createElement('div'); ic.className = 'ic'; ic.textContent = icon(f);
      var meta = document.createElement('div'); meta.className = 'meta';
      var name = document.createElement('div'); name.className = 'name'; name.textContent = f.name;
      var path = document.createElement('div'); path.className = 'path'; path.textContent = f.path;
      meta.append(name, path);
      var right = document.createElement('div'); right.className = 'right';
      right.textContent = isFolder(f) ? '文件夹' : human(f.size);
      row.append(ic, meta, right);
      row.addEventListener('click', function () { open(f); });
      list.append(row);
    });
    if (keep > 0 && window.scrollY !== keep) window.scrollTo(0, keep);
    $('empty').hidden = shown.length > 0 || all.length === 0;
  }

  function mediaUrlFor(id, name) {
    var base = new URL('../media/', location.href).pathname;
    return base + encodeURIComponent(id) + (name ? ('?download=1&filename=' + encodeURIComponent(name)) : '');
  }

  function open(f) {
    if (isFolder(f)) { location.href = '../files/?root=' + encodeURIComponent(f.id); return; }
    var n = (f.name || '').toLowerCase();
    if (/\.(jpg|jpeg|png|webp|gif|avif|mp4|mkv|avi|mov|webm)$/.test(n)) {
      location.href = '../gallery/?state=' + encodeURIComponent(JSON.stringify({ action: 'open', ids: [f.id] }));
      return;
    }
    // 其它类型：直接下载
    var a = document.createElement('a');
    a.href = mediaUrlFor(f.id, f.name);
    a.download = f.name || 'file';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function scan(root) {
    all = [];
    var MAX = 1500, CONC = 4;
    var queue = [{ id: root.id, path: '' }];
    var folders = 0, active = 0;
    await new Promise(function (resolve) {
      function pump() {
        if ((!queue.length && active === 0) || folders >= MAX) { resolve(); return; }
        while (queue.length && active < CONC && folders < MAX) {
          (function (cur) {
            folders++; active++;
            status('正在读取「' + (cur.path || root.name) + '」 · ' + all.length + ' 项 · ' + folders + ' 个目录');
            listChildren(cur.id).then(function (children) {
              children.forEach(function (f) {
                var path = cur.path ? cur.path + ' / ' + f.name : f.name;
                if (isFolder(f)) queue.push({ id: f.id, path: path });
                all.push({ id: f.id, name: f.name, path: cur.path || root.name, size: f.size, mimeType: f.mimeType, modifiedTime: f.modifiedTime, folder: isFolder(f) });
              });
              scheduleRender();
            }).catch(function () { }).then(function () { active--; pump(); });
          })(queue.shift());
        }
      }
      pump();
    });
    all.sort(function (a, b) {
      if (a.folder !== b.folder) return a.folder ? -1 : 1;
      return (a.path + '/' + a.name).localeCompare(b.path + '/' + b.name, undefined, { numeric: true });
    });
    status('「' + (root.name || ROOT_NAME) + '」 · 共 ' + all.length + ' 项' + (folders >= MAX ? '（已截断）' : ''));
    render();
  }

  async function start() {
    fail('');
    $('rootLabel').textContent = ROOT_NAME;
    status('正在授权…');
    try {
      token = await getToken();
    } catch (e) {
      status('需要登录 Google 账号');
      fail(e.message);
      return;
    }
    try {
      var root = await resolveRoot();
      $('rootLabel').textContent = root.name || ROOT_NAME;
      await scan(root);
    } catch (e) {
      status('读取失败');
      fail(e.message);
    }
  }

  $('search').addEventListener('input', render);
  $('refresh').addEventListener('click', start);
  $('back').addEventListener('click', function () { location.href = '../index.html'; });
  start();
})();
