const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const FOLDER = 'application/vnd.google-apps.folder';
const folder = id => ({ id, name: id, mimeType: FOLDER });
const image = { id: 'image', name: 'image.png', mimeType: 'image/png', parents: ['done'] };
const video = { id: 'video', name: 'video.mp4', mimeType: 'video/mp4', size: '123', parents: ['pending'], resourceKey: 'video-key' };
const node = (file, scanned = false, children = []) => ({ file, scanned, children });
function storage() {
  const values = new Map();
  return { getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
}
function page(shared = storage()) {
  const c = { console, sessionStorage: shared, setTimeout: fn => setTimeout(fn, 0), clearTimeout,
    isDriveFolder: f => f?.mimeType === FOLDER, setStatus() {},
    seekRescueActivation: false, seekRescueSession: null, getBufferedAhead: () => 100,
    document: { getElementById: () => ({ paused: true, ended: false, currentSrc: '', readyState: 4 }) } };
  c.window = c; vm.createContext(c); vm.runInContext(source('assets/media-index.js'), c);
  return { c, shared, index: c.DriveMediaIndex };
}
function installScanner(p, kind) {
  const text = source('assets/' + kind + '.js');
  const startMarker = kind === 'gallery' ? 'async function buildGalleryFolderTree(' : 'async function buildVideoFolderTreeStreaming(';
  const endMarker = kind === 'gallery' ? 'function flattenImagesFromTree(' : 'function ensureOpenedVideoInPlaylist(';
  const start = text.indexOf(startMarker), end = text.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, 'load the actual checked-in scanner, not a copy');
  vm.runInContext(text.slice(start, end), p.c);
}
test('actual gallery → player scanners request only unfinished folders, then zero on return', async () => {
  const p = page(); await p.index.ready();
  const root = folder('root');
  p.index.saveSnapshot(root, node(root, true, [node(folder('done'), true, [node(image)]), node(folder('pending'))]), false, video);
  await p.index.flush();
  const g = page(p.shared); await g.index.ready(); installScanner(g, 'gallery');
  const calls = []; g.c.listGalleryTreeChildren = async f => { calls.push(f.id); return [video]; };
  const cached = g.index.findSnapshotForFile(video.id);
  await g.c.buildGalleryFolderTree(cached.rootFolder, cached.tree, video);
  assert.deepEqual(calls, ['pending']); assert.equal(g.index.loadSnapshot().complete, true);
  await g.index.flush();
  const back = page(p.shared); await back.index.ready(); installScanner(back, 'player');
  back.c.listVideoTreeChildren = async f => { throw Error('Unexpected directory request: ' + f.id); };
  const full = back.index.findSnapshotForFile(video.id);
  const result = await back.c.buildVideoFolderTreeStreaming(full.rootFolder, 'test-only', null, full.tree);
  assert.ok(back.index.findFile(result, image.id)); assert.ok(back.index.findFile(result, video.id));
});
test('a failed sibling request does not discard already scanned folders in the same batch', async () => {
  const g = page(); await g.index.ready(); installScanner(g, 'gallery');
  const root = folder('root'), tree = node(root, true, [node(folder('done')), node(folder('pending'))]);
  g.c.listGalleryTreeChildren = async f => {
    if (f.id === 'pending') { await new Promise(resolve => setTimeout(resolve, 5)); throw Error('network interrupted'); }
    return [image];
  };
  await assert.rejects(g.c.buildGalleryFolderTree(root, tree, video), /network interrupted/);
  await g.index.flush();
  const next = page(g.shared); await next.index.ready(); installScanner(next, 'gallery');
  const cached = next.index.findSnapshotForFile(video.id), calls = [];
  assert.equal(next.index.isFolderScanned(cached.tree.children[0]), true);
  next.c.listGalleryTreeChildren = async f => { calls.push(f.id); return [video]; };
  await next.c.buildGalleryFolderTree(root, cached.tree, video);
  assert.deepEqual(calls, ['pending']);
});
test('page bootstrap awaits directory cache readiness; opened-file lookup includes scan seeds', () => {
  for (const name of ['player', 'gallery']) {
    const text = source('assets/' + name + '.js');
    assert.match(text, /await Promise\.all\(\[window\.DriveWorkerClient\.ready\(\), window\.DriveMediaIndex\.ready\(\)\]\)/);
    assert.match(text, /mediaIndex\.getFile\(cachedSnapshot,/);
    assert.match(text, /DriveNavigation\.beforeLeave\(/);
  }
});
function navigationPage() {
  const p = page(), events = {}, winEvents = {}, base = 'https://example.test/drive-original-player/';
  const links = [], assigned = [];
  p.c.location = { href: base + '?state=' + encodeURIComponent(JSON.stringify({ action: 'open', ids: [video.id] })), assign: url => assigned.push(url) };
  p.c.URL = URL;
  p.c.document = { currentScript: { src: base + 'assets/navigation.js' },
    body: { classList: { contains: () => false } }, querySelectorAll: () => links,
    addEventListener: (event, fn) => events[event] = fn };
  p.c.addEventListener = (event, fn) => winEvents[event] = fn;
  p.c.isVideoFile = f => f?.mimeType?.startsWith('video/'); p.c.isImageFile = f => f?.mimeType?.startsWith('image/');
  const root = folder('root'); p.index.saveSnapshot(root, node(root, true, [node(video), node(image)]), true);
  vm.runInContext(source('assets/navigation.js'), p.c);
  let value = base + 'gallery/';
  const a = { getAttribute: key => key === 'href' ? value : null, hasAttribute: () => false,
    get href() { return value; }, set href(v) { value = v; } };
  links.push(a);
  return { ...p, events, winEvents, a, assigned };
}
test('real navigation waits for the directory transaction before changing pages', async () => {
  const p = navigationPage(); await p.index.flush();
  let commit, saved = false, prevented = false;
  p.index.ready = async () => {};
  p.index.flush = () => new Promise(resolve => { commit = resolve; });
  p.c.DriveNavigation.beforeLeave(() => saved = true);
  p.events.click({ target: { closest: () => p.a }, button: 0, preventDefault() { prevented = true; } });
  await new Promise(setImmediate);
  assert.equal(prevented, true); assert.equal(saved, true); assert.equal(p.assigned.length, 0);
  commit(true); await new Promise(setImmediate);
  assert.equal(p.assigned.length, 1);
  const url = new URL(p.assigned[0]); assert.equal(url.searchParams.get('view'), 'gallery');
  assert.equal(JSON.parse(url.searchParams.get('state')).ids[0], image.id);
});
test('Ctrl-click keeps normal browser navigation instead of trapping a new tab', async () => {
  const p = navigationPage(); await p.index.flush(); let prevented = false;
  p.events.click({ target: { closest: () => p.a }, button: 0, ctrlKey: true, preventDefault() { prevented = true; } });
  await new Promise(setImmediate); assert.equal(prevented, false); assert.equal(p.assigned.length, 0);
});
