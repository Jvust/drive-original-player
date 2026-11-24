/*
 * 站内站点窗口：点导航里的按钮，直接在星映里新开一个增强窗口
 * （不走系统浏览器，不走 Electron 菜单）。每个按钮显示自己的实时状态：
 *   空闲 / 打开中 / 加载中 / 已打开（再点一次把已有窗口提到前台）。
 */
(function () {
  'use strict';

  var SITES = {
    x: { label: 'X' },
    pornhub: { label: 'Pornhub' },
    missav: { label: 'MissAV' },
    hanime: { label: 'Hanime1' },
    danbooru: { label: 'Danbooru' },
    gelbooru: { label: 'Gelbooru' },
    e621: { label: 'e621' }
  };

  var buttons = Array.prototype.slice.call(document.querySelectorAll('.site-open'));
  if (!buttons.length) return;

  function host() {
    return (window.AndroidHost && typeof window.AndroidHost.openSite === 'function')
      ? window.AndroidHost
      : null;
  }

  function paint(state) {
    var map = {};
    (state || []).forEach(function (item) { map[item.name] = item; });

    buttons.forEach(function (btn) {
      var name = btn.dataset.site;
      var st = map[name] || { open: false, loading: false };
      var em = btn.querySelector('em');

      btn.classList.toggle('is-open', !!st.open);
      btn.classList.toggle('is-loading', !!st.loading);
      btn.setAttribute('aria-pressed', st.open ? 'true' : 'false');

      if (em) {
        var base = btn.dataset.base || (btn.dataset.base = em.textContent);
        if (st.loading) em.textContent = '加载中…';
        else if (st.open) em.textContent = '已打开 · 再点切换';
        else em.textContent = base;
      }
    });
  }

  buttons.forEach(function (btn) {
    btn.addEventListener('click', async function (event) {
      event.preventDefault();
      var name = btn.dataset.site;
      var em = btn.querySelector('em');
      var base = btn.dataset.base || (btn.dataset.base = em ? em.textContent : '');
      btn.classList.add('is-loading');
      if (em) em.textContent = '打开中…';

      // Android 打开星映自己的聚合页；远程站点只在后台采集，不再显示原站外壳。
      var api = host();
      if (window.__hoshiMobile) {
        location.href = 'https://appassets.androidplatform.net/site/sources/index.html?site=' + encodeURIComponent(name);
        return;
      }

      // 桌面：走本地服务入口，由主进程开增强窗口
      if (location.protocol.startsWith('http')) {
        location.href = './__site/' + encodeURIComponent(name);
        return;
      }

      // 兜底：没有桥的浏览器预览
      if (!api) {
        if (em) em.textContent = base;
        return;
      }
      try {
        await api.openSite(name);
      } catch (err) {
        if (em) em.textContent = '打开失败：' + (err && err.message ? err.message : err);
      }
    });
  });

  async function refresh() {
    var api = host();
    if (!api) return;

    if (window.__hoshiMobile && typeof api.siteState === 'function') {
      try {
        var raw = api.siteState();
        paint(typeof raw === 'string' ? JSON.parse(raw) : raw);
      } catch (e) {
        /* ignore */
      }
      return;
    }
    if (!location.protocol.startsWith('http')) return;
    try {
      var res = await fetch('./__site-state', { cache: 'no-store' });
      if (res.ok) paint(await res.json());
    } catch (e) {
      /* ignore */
    }
  }

  window.addEventListener('hoshi:enhanced-state', function (ev) {
    paint(ev.detail);
  });

  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refresh();
  });

  refresh();
  setInterval(refresh, 4000);
})();
