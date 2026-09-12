(function () {
  "use strict";

  /*
   * 视频页和图片页共用一份“文件树索引”，但各自只展示自己的媒体类型。
   * 使用 sessionStorage 是为了让同一个标签页来回切换时不重复读取，
   * 同时避免把 Drive 文件内容本身下载到浏览器存储里。
   */
  const CACHE_KEY =
    "drive-original-player-media-index-v1";
  const CACHE_VERSION = 1;

  const FILE_FIELDS = [
    "id",
    "name",
    "mimeType",
    "size",
    "thumbnailLink",
    "resourceKey",
    "parents",
    "driveId",
    "capabilities",
    "videoMediaMetadata",
    "imageMediaMetadata"
  ];

  function getStorage() {
    try {
      return window.sessionStorage;
    } catch (error) {
      return null;
    }
  }

  function copyFile(file) {
    if (!file) return null;

    const result = {};

    for (const field of FILE_FIELDS) {
      if (file[field] !== undefined) {
        result[field] = file[field];
      }
    }

    return result;
  }

  function copyTree(node) {
    if (!node || !node.file) return null;

    return {
      file: copyFile(node.file),
      scanned:
        node.mediaIndexScanned === true ||
        node.scanned === true,
      children: (node.children || [])
        .map(copyTree)
        .filter(Boolean)
    };
  }

  function hydrateTree(node) {
    if (!node) return null;

    node.mediaIndexScanned =
      node.scanned === true;

    for (const child of node.children || []) {
      hydrateTree(child);
    }

    return node;
  }

  function isValidSnapshot(snapshot) {
    return !!(
      snapshot &&
      snapshot.version === CACHE_VERSION &&
      typeof snapshot.complete === "boolean" &&
      snapshot.rootFolder &&
      snapshot.rootFolder.id &&
      snapshot.tree &&
      snapshot.tree.file &&
      snapshot.tree.file.id
    );
  }

  function loadSnapshot() {
    const storage = getStorage();
    if (!storage) return null;

    try {
      const raw = storage.getItem(CACHE_KEY);
      if (!raw) return null;

      const snapshot = JSON.parse(raw);

      if (isValidSnapshot(snapshot)) {
        hydrateTree(snapshot.tree);
      }

      return isValidSnapshot(snapshot)
        ? snapshot
        : null;
    } catch (error) {
      console.warn(
        "读取 Drive 媒体索引缓存失败：",
        error
      );
      return null;
    }
  }

  function saveSnapshot(
    rootFolder,
    rootNode,
    complete = true
  ) {
    const storage = getStorage();
    if (!storage || !rootFolder || !rootNode) {
      return false;
    }

    const tree = copyTree(rootNode);

    if (!tree) return false;

    const snapshot = {
      version: CACHE_VERSION,
      complete: complete === true,
      savedAt: Date.now(),
      rootFolder: copyFile(rootFolder),
      tree
    };

    try {
      storage.setItem(
        CACHE_KEY,
        JSON.stringify(snapshot)
      );
      return true;
    } catch (error) {
      /*
       * sessionStorage 额度不足时不影响正常播放/浏览，
       * 只是下一次切页会重新读取目录。
       */
      console.warn(
        "保存 Drive 媒体索引缓存失败：",
        error
      );
      return false;
    }
  }

  function findFile(rootNode, fileId) {
    if (!rootNode || !fileId) return null;

    if (
      rootNode.file &&
      rootNode.file.id === fileId
    ) {
      return rootNode.file;
    }

    for (const child of rootNode.children || []) {
      const found = findFile(child, fileId);
      if (found) return found;
    }

    return null;
  }

  function findSnapshotForFile(fileId) {
    const snapshot = loadSnapshot();

    return snapshot &&
      findFile(snapshot.tree, fileId)
      ? snapshot
      : null;
  }

  function findSnapshotForRoot(rootId) {
    const snapshot = loadSnapshot();

    return snapshot &&
      snapshot.rootFolder &&
      snapshot.rootFolder.id === rootId
      ? snapshot
      : null;
  }

  function findFirstFile(rootNode, predicate) {
    if (!rootNode) return null;

    if (
      rootNode.file &&
      predicate(rootNode.file)
    ) {
      return rootNode.file;
    }

    for (const child of rootNode.children || []) {
      const found = findFirstFile(child, predicate);
      if (found) return found;
    }

    return null;
  }

  function countFolders(rootNode) {
    let count = 0;

    function walk(node, includeSelf) {
      if (!node) return;
      if (includeSelf) count += 1;

      for (const child of node.children || []) {
        if (
          child &&
          child.file &&
          child.file.mimeType ===
            "application/vnd.google-apps.folder"
        ) {
          walk(child, true);
        }
      }
    }

    walk(rootNode, false);
    return count;
  }

  window.DriveMediaIndex = {
    countFolders,
    findFile,
    findFirstFile,
    findSnapshotForFile,
    findSnapshotForRoot,
    loadSnapshot,
    isFolderScanned: node =>
      !!(
        node &&
        (
          node.mediaIndexScanned === true ||
          node.scanned === true
        )
      ),
    saveSnapshot
  };
})();

