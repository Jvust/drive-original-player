const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../assets/media-index.js'), 'utf8');
const CACHE = 'drive-original-player-media-index-v1';
const folder = id => ({ id, name: id, mimeType: 'application/vnd.google-apps.folder' });
const file = (id, type = 'image/png') => ({ id, name: id, mimeType: type, size: '123', parents: ['pending'] });
const node = (f, scanned = false, children = []) => ({ file: f, scanned, children });
function storage() {
  const values = new Map();
  return { values, getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
}
// The transaction completes after its request, matching the IndexedDB contract.
function database() {
  const values = new Map();
  let fail = false;
  const db = { objectStoreNames: { contains: () => true }, close() {},
    transaction() {
      const tx = { abort() { tx.onabort?.(); }, objectStore() {
        return Object.fromEntries(['get', 'put', 'delete'].map(op => [op, (...args) => {
          const request = {};
          setImmediate(() => {
            if (fail) { tx.onerror?.(); return; }
            if (op === 'get') request.result = structuredClone(values.get(args[0]));
            if (op === 'put') { values.set(args[1], structuredClone(args[0])); request.result = args[1]; }
            if (op === 'delete') values.delete(args[0]);
            request.onsuccess?.();
            setImmediate(() => tx.oncomplete?.());
          });
          return request;
        }]));
      }};
      return tx;
    }
  };
  return { values, fail: () => fail = true, open() {
    const request = { result: db }; setImmediate(() => request.onsuccess?.()); return request;
  }};
}
function page(shared = storage(), idb = database(), account = storage()) {
  const c = { sessionStorage: shared, localStorage: account, indexedDB: idb, crypto: webcrypto,
    TextEncoder, Uint8Array, setTimeout, clearTimeout, console };
  c.window = c; vm.createContext(c); vm.runInContext(source, c);
  return { index: c.DriveMediaIndex, shared, idb, account, context: c };
}
function partial(p) {
  const root = folder('root'), done = folder('done'), pending = folder('pending'), image = file('image'), video = file('video', 'video/mp4');
  const tree = node(root, true, [node(done, true, [node(image)]), node(pending)]);
  p.index.saveSnapshot(root, tree, false, video);
  return { root, tree, image, video };
}
test('partial snapshot retains an opened file not reached by the recursive scan', async () => {
  const p = page(); await p.index.ready(); const { video } = partial(p); await p.index.flush();
  const next = page(p.shared, p.idb, p.account); await next.index.ready();
  const snapshot = next.index.findSnapshotForFile(video.id);
  assert.equal(snapshot.complete, false);
  assert.equal(next.index.getFile(snapshot, video.id).mimeType, 'video/mp4');
  assert.equal(next.index.isFolderScanned(snapshot.tree.children[0]), true);
  assert.equal(next.index.isFolderScanned(snapshot.tree.children[1]), false);
  assert.equal(next.index.findSnapshotForFile('another-library'), null);
});
test('sessionStorage quota failure still restores a complete directory from IndexedDB', async () => {
  const shared = storage(), baseSet = shared.setItem;
  shared.setItem = (key, value) => { if (key === CACHE) throw Error('QuotaExceededError'); baseSet(key, value); };
  const p = page(shared); await p.index.ready();
  const root = folder('large'), files = Array.from({ length: 3000 }, (_, i) => node(file('image-' + i)));
  p.index.saveSnapshot(root, node(root, true, files), true); assert.equal(await p.index.flush(), true);
  const next = page(shared, p.idb, p.account); await next.index.ready();
  assert.equal(next.index.loadSnapshot().tree.children.length, 3000);
  assert.equal(next.index.loadSnapshot().complete, true);
});
test('quota failure removes an older hot snapshot instead of restoring stale data', async () => {
  const p = page(); await p.index.ready(); const { root, tree, video } = partial(p); await p.index.flush();
  const set = p.shared.setItem;
  p.shared.setItem = (k, v) => { if (k === CACHE) throw Error('quota'); set(k, v); };
  tree.children[1] = node(folder('pending'), true, [node(video)]);
  p.index.saveSnapshot(root, tree, true); await p.index.flush();
  assert.equal(p.shared.getItem(CACHE), null);
  const next = page(p.shared, p.idb, p.account); await next.index.ready();
  assert.equal(next.index.findSnapshotForFile('video').complete, true);
});
test('flush drains rapid checkpoints and view state before navigation', async () => {
  const p = page(); await p.index.ready(); const { root, tree, video } = partial(p);
  const pendingWrite = p.index.flush();
  tree.children[1] = node(folder('pending'), true, [node(video)]);
  p.index.saveSnapshot(root, tree, true);
  p.index.saveView('player', root.id, { fileId: video.id, time: 91, expandedFolders: ['pending'], scrollY: 80 });
  await pendingWrite; await p.index.flush();
  const next = page(p.shared, p.idb, p.account); await next.index.ready();
  assert.equal(next.index.loadSnapshot().complete, true);
  assert.equal(next.index.getView('player', root.id).time, 91);
  assert.equal(next.index.getView('player', 'different-root'), null);
});
test('an older partial view cannot erase a completed directory', async () => {
  const p = page(); await p.index.ready(); const { root, tree, video } = partial(p);
  const old = structuredClone(tree);
  tree.children[1] = node(folder('pending'), true, [node(video)]);
  p.index.saveSnapshot(root, tree, true);
  p.index.saveSnapshot(root, old, false);
  assert.equal(p.index.loadSnapshot().complete, true);
  assert.ok(p.index.findFile(p.index.loadSnapshot().tree, 'video'));
  await p.index.flush();
});
test('new root cannot inherit directory sources or view state from old root', async () => {
  const p = page(); await p.index.ready(); partial(p);
  p.index.saveView('gallery', 'root', { fileId: 'image' });
  const root = folder('new-root'); p.index.saveSnapshot(root, node(root, true), true);
  assert.equal(p.index.findSnapshotForFile('video'), null);
  assert.equal(p.index.getView('gallery', 'new-root'), null);
  await p.index.flush();
});
test('OAuth account/session changes invalidate the old directory without persisting tokens', async () => {
  const account = storage(); account.setItem('drive_oauth_session', 'account-A-secret');
  const p = page(storage(), database(), account); await p.index.ready(); partial(p); await p.index.flush();
  assert.equal(JSON.stringify([...p.idb.values.values()]).includes('account-A-secret'), false);
  account.setItem('drive_oauth_session', 'account-B-secret');
  const next = page(p.shared, p.idb, account); await next.index.ready();
  assert.equal(next.index.loadSnapshot(), null);
});
test('explicit refresh clears durable/hot data and blocks stale scan writes', async () => {
  const p = page(); await p.index.ready(); const { root, tree } = partial(p); await p.index.flush();
  await p.index.clear(); assert.equal(p.index.saveSnapshot(root, tree), false);
  const next = page(p.shared, p.idb, p.account); await next.index.ready();
  assert.equal(next.index.loadSnapshot(), null);
});
test('storage/IndexedDB failures degrade to memory, not a crash or a stuck switch', async () => {
  const shared = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  const p = page(shared, { open() { throw Error('blocked'); } }); await p.index.ready(); partial(p);
  assert.ok(p.index.loadSnapshot()); assert.equal(await p.index.flush(), false);
});
test('legacy snapshots remain readable and migrate to durable storage on the next checkpoint', async () => {
  const shared = storage(), root = folder('legacy');
  shared.setItem(CACHE, JSON.stringify({ version: 1, complete: true, savedAt: 1, rootFolder: root, tree: node(root, true) }));
  const p = page(shared); await p.index.ready(); assert.equal(p.index.loadSnapshot().rootFolder.id, 'legacy');
  p.index.saveSnapshot(root, p.index.loadSnapshot().tree, true); await p.index.flush();
  assert.equal(p.idb.values.size, 1);
});
