/* 收藏目录偏好：用户自选目录 > 专用版固定目录 > 默认 1433223。
   Android 走原生桥持久化；桌面版退回 localStorage（bridge 不提供时）。 */
(function () {
  'use strict';
  var KEY = 'hoshi_picked_folder';

  function bridge() {
    return window.AndroidHost || null;
  }

  function readLocal() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      return data && data.id ? data : null;
    } catch (_) { return null; }
  }

  function picked() {
    var host = bridge();
    if (host && typeof host.getPickedFolder === 'function') {
      try {
        var raw = host.getPickedFolder();
        if (raw) {
          var data = JSON.parse(raw);
          if (data && data.id) return data;
        }
        return null;
      } catch (_) { /* 落到本地存储 */ }
    }
    return readLocal();
  }

  function flavor() {
    var host = bridge();
    if (host && typeof host.getFlavor === 'function') {
      try { return JSON.parse(host.getFlavor() || '{}') || {}; } catch (_) { }
    }
    return window.__hoshiFlavor || {};
  }

  function save(id, name) {
    if (!id) return false;
    var host = bridge();
    if (host && typeof host.setPickedFolder === 'function') {
      try { host.setPickedFolder(id, name || ''); return true; } catch (_) { }
    }
    try {
      localStorage.setItem(KEY, JSON.stringify({ id: id, name: name || '' }));
      return true;
    } catch (_) { return false; }
  }

  function clear() {
    var host = bridge();
    if (host && typeof host.clearPickedFolder === 'function') {
      try { host.clearPickedFolder(); } catch (_) { }
    }
    try { localStorage.removeItem(KEY); } catch (_) { }
  }

  /** 当前生效的收藏目录：{id, name, source} */
  function current() {
    var pick = picked();
    if (pick) return { id: pick.id, name: pick.name || '自选目录', source: 'picked' };
    var fl = flavor();
    if (fl && fl.rootFolderId) {
      return { id: fl.rootFolderId, name: fl.rootFolderName || '收藏目录', source: 'flavor' };
    }
    if (fl && fl.rootFolderName) {
      return { id: '', name: fl.rootFolderName, source: 'flavor' };
    }
    return { id: '', name: '1433223', source: 'default' };
  }

  window.HoshiRootPref = { current: current, picked: picked, save: save, clear: clear };
})();
