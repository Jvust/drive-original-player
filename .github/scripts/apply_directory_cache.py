"""Apply narrow, hash-checked edits to the verified remote source; never replace it with a transcript."""
from pathlib import Path
import re
import subprocess

EXPECTED = {
    'assets/player.js': '32715568641d1a8864e5ea7201bbeadbcf0f768d',
    'assets/gallery.js': 'cba480ab8554df5441e61403e281787090dad450',
    'index.html': 'fc0e798e9ad8d3a32b4ae392cea1c3afa63a5bac',
    'gallery/index.html': 'b62935f6a92c1f569b6188dac1c39417710f46d8',
    '.github/workflows/navigation-tests.yml': 'af19ee0dd7d62d1afb24b672ae1cf21cf5457303',
}
texts = {}
for name, expected in EXPECTED.items():
    actual = subprocess.check_output(['git', 'hash-object', '--', name], text=True).strip()
    if actual != expected:
        raise RuntimeError(f'Refusing to patch changed/unverified source: {name}: {actual}')
    texts[name] = Path(name).read_bytes().decode('utf-8')

def edit(name, old, new):
    text = texts[name]
    if text.count(old) != 1:
        old, new = old.replace('\n', '\r\n'), new.replace('\n', '\r\n')
    if text.count(old) != 1:
        raise RuntimeError(f'Expected one exact edit in {name}: {old[:100]!r}')
    texts[name] = text.replace(old, new, 1)

def regex(name, pattern, replacement, count=1):
    updated, n = re.subn(pattern, replacement, texts[name])
    if n != count:
        raise RuntimeError(f'Expected {count} matches in {name}, got {n}: {pattern}')
    texts[name] = updated

for name in ('assets/player.js', 'assets/gallery.js'):
    edit(name, '  await window.DriveWorkerClient.ready();',
         '  await Promise.all([window.DriveWorkerClient.ready(), window.DriveMediaIndex.ready()]);')

p = 'assets/player.js'
edit(p, ' window.addEventListener("load", async () => {',
     ' window.addEventListener("load", async () => {\n    captureOAuthSession(); // Set the account scope before restoring cached metadata.')
regex(p, r'mediaIndex\.findFile\(\s*cachedSnapshot\.tree,\s*currentFileId\s*\)',
      'mediaIndex.getFile(cachedSnapshot, currentFileId)')
root_assignment = '''      videoTreeRoot =
        existingRootNode || {
          file: videoRootFolder,
          children: []
        };'''
edit(p, root_assignment, root_assignment + '''

      // Preserve the verified root/seed relationship before the first directory request.
      window.DriveMediaIndex?.saveSnapshot(videoRootFolder, videoTreeRoot, false, openedFile);''')
edit(p, '''      await switchVideoByIndex(
        0,
        true
      );''', '''      const storedPlayerView = mediaIndex?.getView("player", cachedSnapshot?.rootFolder.id);
      const savedPlayerView = storedPlayerView?.fileId === openedFile.id ? storedPlayerView : null;
      await switchVideoByIndex(0, savedPlayerView ? !savedPlayerView.paused : true);''')
edit(p, '''        startVideoTreeScanInBackground(
          openedFile,
          accessToken
        );
      }
    } catch (err) {''', '''        startVideoTreeScanInBackground(
          openedFile,
          accessToken
        );
      }
      restorePlayerNavigationState(savedPlayerView);
    } catch (err) {''')
texts[p] += '''

// A page switch saves metadata and UI state, never video bytes or access tokens.
window.DriveNavigation.beforeLeave(() => {
  if (!videoRootFolder || !videoTreeRoot) return;
  const index = window.DriveMediaIndex;
  const player = document.getElementById("player");
  const file = videoPlaylist[currentVideoIndex];
  if (file) window.DriveNavigation.remember(file);
  index.saveSnapshot(videoRootFolder, videoTreeRoot, !videoTreeScanInProgress, file);
  index.saveView("player", videoRootFolder.id, {
    fileId: currentFileId, time: Number.isFinite(player?.currentTime) ? player.currentTime : 0,
    paused: !!player?.paused, expandedFolders: [...expandedVideoFolders],
    playlistOpen: document.getElementById("playerWrap")?.classList.contains("playlist-open") || false,
    listScrollTop: document.getElementById("videoPlaylistItems")?.scrollTop || 0,
    scrollY: window.scrollY || 0
  });
});
function restorePlayerNavigationState(state) {
  if (!state || state.fileId !== currentFileId) return;
  for (const id of state.expandedFolders || []) {
    if (window.DriveMediaIndex.findFile(videoTreeRoot, id)) expandedVideoFolders.add(id);
  }
  if (state.playlistOpen) {
    document.getElementById("playerWrap").classList.add("playlist-open");
    videoPlaylistDomReady = false;
    renderVideoPlaylist();
  }
  const player = document.getElementById("player");
  const seek = () => {
    if (state.fileId !== currentFileId || !Number.isFinite(state.time)) return;
    const end = Number.isFinite(player.duration) ? Math.max(0, player.duration - 0.05) : state.time;
    try { player.currentTime = Math.max(0, Math.min(state.time, end)); } catch (_) {}
    if (state.paused) player.pause();
  };
  if (player.readyState >= 1) seek();
  else player.addEventListener("loadedmetadata", seek, { once: true });
  requestAnimationFrame(() => {
    const list = document.getElementById("videoPlaylistItems");
    if (list) list.scrollTop = Number(state.listScrollTop) || 0;
    window.scrollTo(0, Number(state.scrollY) || 0);
  });
}
'''

g = 'assets/gallery.js'
regex(g, r'mediaIndex\.findFile\(\s*cachedSnapshot\.tree,\s*driveIds\[0\]\s*\)',
      'mediaIndex.getFile(cachedSnapshot, driveIds[0])')
edit(g, '''async function buildGalleryFolderTree(
  rootFolder,
  existingRootNode = null
) {''', '''async function buildGalleryFolderTree(
  rootFolder,
  existingRootNode = null,
  sourceFile = null
) {''')
edit(g, '''  collectUnscannedFolders(rootNode);

  while (queue.length) {''', '''  collectUnscannedFolders(rootNode);
  mediaIndex?.saveSnapshot(rootFolder, rootNode, false, sourceFile);

  while (queue.length) {''')
edit(g, '''        scannedFolders += 1;

        setStatus(''', '''        scannedFolders += 1;
        // A sibling request can fail or the user can leave before Promise.all completes.
        mediaIndex?.saveSnapshot(rootFolder, rootNode, false, sourceFile);

        setStatus(''')
edit(g, '''    let openedFile =
      cachedOpenedFile ||
      await fetchFileMetadata(''', '''    let openedFile =
      cachedOpenedFile ||
      mediaIndex?.getFile(cachedSnapshot, driveIds[0]) ||
      await fetchFileMetadata(''')
edit(g, '''          cachedSnapshot.rootFolder &&
          cachedOpenedFile
            ? cachedSnapshot.rootFolder''', '''          cachedSnapshot.rootFolder
            ? cachedSnapshot.rootFolder''')
regex(g, r'(await buildGalleryFolderTree\(\s*galleryRootFolder,[\s\S]*?\?\s*cachedSnapshot\.tree\s*:\s*null)(\s*\))',
      r'\1,\n              openedFile\2')
edit(g, '''    renderGallery();
    startGalleryBackgroundSlideshow();''', '''    const storedGalleryView = mediaIndex?.getView("gallery", galleryRootFolder?.id);
    const savedGalleryView = storedGalleryView?.fileId === openedFile.id ? storedGalleryView : null;
    if (savedGalleryView) {
      expandedGalleryFolders.clear();
      for (const id of savedGalleryView.expandedFolders || []) {
        if (mediaIndex.findFile(galleryTreeRoot, id)) expandedGalleryFolders.add(id);
      }
    }
    renderGallery();
    startGalleryBackgroundSlideshow();''')
edit(g, '''    requestAnimationFrame(() => {
      const activeCard =''', '''    requestAnimationFrame(() => {
      if (savedGalleryView) { window.scrollTo(0, Number(savedGalleryView.scrollY) || 0); return; }
      const activeCard =''')
texts[g] += '''

window.DriveNavigation.beforeLeave(() => {
  if (!galleryRootFolder || !galleryTreeRoot) return;
  const index = window.DriveMediaIndex;
  const file = galleryFiles[currentIndex];
  if (file) window.DriveNavigation.remember(file);
  const cached = index.findSnapshotForRoot(galleryRootFolder.id);
  index.saveSnapshot(galleryRootFolder, galleryTreeRoot, cached?.complete === true, file);
  index.saveView("gallery", galleryRootFolder.id, {
    fileId: file?.id, expandedFolders: [...expandedGalleryFolders], scrollY: window.scrollY || 0
  });
});
'''
for name in ('index.html', 'gallery/index.html'):
    regex(name, r'(assets/(?:media-index|navigation|player|gallery)\.js)\?v=[^"\s]+', r'\1?v=directory-cache-3', 3)
    edit(name, '<div id="status"',
         '<button type="button" class="quiet-link" onclick="DriveNavigation.refreshLibrary()" title="重新读取新增、删除或移动的 Drive 文件">刷新目录</button>\n  <div id="status"')
edit('.github/workflows/navigation-tests.yml', '          node --check assets/player.js',
     '          node --check assets/media-index.js\n          node --check assets/player.js')
# Do not write anything until every source hash and every edit anchor has passed.
for name, text in texts.items():
    Path(name).write_bytes(text.encode('utf-8'))
    print(f'Patched {name}: {len(text.encode("utf-8"))} bytes')
