/* 选择收藏目录：逐层浏览 Drive 文件夹，确认后写入偏好。 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var H = window.AndroidHost;
  var OAUTH_BRIDGE = 'https://drive-oauth-bridge.143322378jb.workers.dev';
  var token = '';
  var stack = [];          // [{id,name}] 面包屑
  var current = { id: 'root', name: '我的云端硬盘' };
  var folders = [];

  function status(t) { $('status').textContent = t; }
  function fail(t) { var e = $('error'); e.hidden = !t; e.textContent = t || ''; }

  async function getToken() {
    if (typeof window.hoshiNativeDriveToken === 'function') {
      var value = await window.hoshiNativeDriveToken(true);
      if (!value) throw new Error('未取得 Drive 访问令牌');
      return value;
    }
    var session = '';
    try { session = localStorage.getItem('drive_oauth_session') || ''; } catch (_) { }
    if (!session) throw new Error('需要先登录 Google 账号（菜单「网络 → 浏览器授权」）');
    var response = await fetch(OAUTH_BRIDGE + '/token', { headers: { Authorization: 'Bearer ' + session }, cache: 'no-store' });
    if (!response.ok) throw new Error('授权已失效，请重新授权（HTTP ' + response.status + '）');
    var data = await response.json();
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
    if (/Failed to fetch|Unable to resolve host|timed out/i.test(String(body))) {
      var retry = await fetch(url, { headers: auth, cache: 'no-store' });
      if (!retry.ok) throw Object.assign(new Error('HTTP ' + retry.status), { status: retry.status });
      return retry.json();
    }
    throw Object.assign(new Error('HTTP ' + code + ' ' + String(body).slice(0, 140)), { status: code });
  }

  function crumbs() {
    var parts = ['我的云端硬盘'].concat(stack.map(function (s) { return s.name; }));
    $('crumbs').textContent = parts.join('  /  ');
  }

  async function load() {
    fail('');
    folders = [];
    render();
    status('正在读取「' + (stack.length ? stack[stack.length - 1].name : '我的云端硬盘') + '」…');
    try {
      if (!token) token = await getToken();
      var out = [];
      var pageToken = '';
      for (var page = 0; page < 10; page++) {
        var parent = stack.length ? stack[stack.length - 1].id : 'root';
        var q = "'" + parent + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
        var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
          '&fields=' + encodeURIComponent('nextPageToken,files(id,name)') +
          '&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true';
        if (pageToken) url += '&pageToken=' + encodeURIComponent(pageToken);
        var data = await request(url);
        (data.files || []).forEach(function (f) { out.push(f); });
        pageToken = data.nextPageToken || '';
        if (!pageToken) break;
      }
      out.sort(function (a, b) { return a.name.localeCompare(b.name, undefined, { numeric: true }); });
      folders = out;
      status(out.length ? ('共 ' + out.length + ' 个子文件夹，选一个进入；或直接「使用此目录」') : '这里没有子文件夹，可以直接使用此目录');
    } catch (e) {
      status('读取失败');
      fail(e.message + '\n检查网络后点「返回」再进来重试。');
    }
    crumbs();
    render();
  }

  function render() {
    var term = ($('search').value || '').trim().toLowerCase();
    var list = $('list');
    list.replaceChildren();
    folders.filter(function (f) { return !term || f.name.toLowerCase().indexOf(term) >= 0; })
      .forEach(function (f) {
        var row = document.createElement('div');
        row.className = 'row';
        row.tabIndex = 0;
        var ic = document.createElement('div'); ic.className = 'ic'; ic.textContent = '📁';
        var nm = document.createElement('div'); nm.className = 'nm'; nm.textContent = f.name;
        var go = document.createElement('div'); go.className = 'go'; go.textContent = '进入 ›';
        row.append(ic, nm, go);
        row.addEventListener('click', function () {
          stack.push({ id: f.id, name: f.name });
          $('search').value = '';
          load();
        });
        list.append(row);
      });
  }

  function useCurrent() {
    var target = stack.length ? stack[stack.length - 1] : { id: '', name: '1433223' };
    if (!target.id) {
      // 根目录不作为一个可收藏的目录；提示进入具体文件夹
      fail('请先进入一个文件夹再点「使用此目录」。');
      return;
    }
    if (window.HoshiRootPref && window.HoshiRootPref.save(target.id, target.name)) {
      status('已选择「' + target.name + '」，正在返回…');
      setTimeout(function () { location.href = '../gallery/'; }, 400);
    } else {
      fail('保存失败，请重试。');
    }
  }

  $('back').addEventListener('click', function () {
    if (stack.length) { stack.pop(); $('search').value = ''; load(); return; }
    location.href = '../index.html';
  });
  $('use').addEventListener('click', useCurrent);
  $('search').addEventListener('input', render);

  crumbs();
  load();
})();
