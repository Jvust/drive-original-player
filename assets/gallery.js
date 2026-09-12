const OAUTH_BRIDGE = "https://drive-oauth-bridge.143322378jb.workers.dev";
const SESSION_KEY = "drive_oauth_session";
let serviceWorkerReady = false;
let currentAccessToken = null;
let driveIds = [];
let resourceKeys = {};
let galleryFiles = [];
let galleryBgQueue = [];
let galleryBgTimer = null;
let galleryBgVisibleLayer = null;
let galleryBgHiddenLayer = null;
let galleryBgVisibleObjectUrl = null;
let galleryBgPending = false;
let galleryTreeRoot = null;
let galleryRootFolder = null;
const expandedGalleryFolders = new Set();
const GALLERY_ROOT_FOLDER_NAME = "1433223";
let currentIndex = 0;
let gallerySlideshowTimer = null;
let gallerySlideshowActive = false;
let gallerySlideshowQueue = [];
let galleryFolderSlideshowTimer = null;
let galleryFolderSlideshowPaused = false;
let gallerySlideshowPaused = false;
let gallerySlideshowOrientation = null;
let lastGalleryViewportOrientation = null;
const GALLERY_SLIDESHOW_INTERVAL_MS = 20000;
const GALLERY_SLIDESHOW_PRELOAD_COUNT = 3;
const GALLERY_FOLDER_SLIDESHOW_INTERVAL_MS = 10000;
let viewerImageLoadGeneration = 0;
let zoomScale = 1;
let panX = 0;
let panY = 0;
let tokenRefreshRunning = false;

let touchStartX = 0;
let touchStartY = 0;
let touchStartDistance = 0;
let pinchStartScale = 1;
let pinchStartPanX = 0;
let pinchStartPanY = 0;
let pinchStartCenterX = 0;
let pinchStartCenterY = 0;

let panStartX = 0;
let panStartY = 0;
let panStartOffsetX = 0;
let panStartOffsetY = 0;
let isTouchPanning = false;

let mouseDragging = false;
let mouseStartX = 0;
let mouseStartY = 0;
let mouseStartPanX = 0;
let mouseStartPanY = 0;

const originalPreloadCache = new Map();
let lastNavigationDirection = 1;
let edgeSwipeDelta = 0;
let hqRenderTimer = null;
let hqRenderRaf = null;
let hqColorSpace = "srgb";
let hqRenderActive = false;

function setStatus(text) { document.getElementById("status").textContent = text; }
function showError(text) { document.getElementById("error").textContent = text || ""; }

function parseDriveState() {
  const rawState = new URLSearchParams(window.location.search).get("state");
  if (!rawState) return null;
  try {
    const state = JSON.parse(rawState);
    if (state.action === "open" && Array.isArray(state.ids) && state.ids.length) {
      return { ids: state.ids, resourceKeys: state.resourceKeys || {} };
    }
  } catch (error) { console.error("Drive state 解析失败:", error); }
  return null;
}

async function getBridgeAccessToken() {
  const session = localStorage.getItem(SESSION_KEY);
  if (!session) return null;
  try {
    const response = await fetch(OAUTH_BRIDGE + "/token", {
      method: "GET", headers: { "Authorization": "Bearer " + session }, cache: "no-store"
    });
    if (!response.ok) {
      if (response.status === 401) localStorage.removeItem(SESSION_KEY);
      return null;
    }
    const data = await response.json();
    return data.access_token || null;
  } catch (error) { console.error("获取 Access Token 失败:", error); return null; }
}

function authorizeDrive() { window.location.href = OAUTH_BRIDGE + "/auth"; }

async function initServiceWorker() {
  if (!("serviceWorker" in navigator)) throw new Error("当前浏览器不支持 Service Worker。");
  await navigator.serviceWorker.register("./sw.js", { scope: "./" });
  await navigator.serviceWorker.ready;
  serviceWorkerReady = true;
  await new Promise(resolve => setTimeout(resolve, 120));
}

async function sendTokenToWorker(token) {
  if (!serviceWorkerReady || !token) return;
  const registration = await navigator.serviceWorker.ready;
  const worker = navigator.serviceWorker.controller || registration.active || registration.waiting;
  if (worker) worker.postMessage({ type: "SET_TOKEN", token });
}

async function refreshWorkerAccessToken() {
  if (tokenRefreshRunning || !serviceWorkerReady) return;
  tokenRefreshRunning = true;
  try {
    const token = await getBridgeAccessToken();
    if (!token) return;
    currentAccessToken = token;
    await sendTokenToWorker(token);
  } finally { tokenRefreshRunning = false; }
}

function fileResourceKey(fileId) { return resourceKeys && resourceKeys[fileId] ? resourceKeys[fileId] : null; }

async function fetchFileMetadata(fileId) {
  const fields = ["id","name","mimeType","size","thumbnailLink","capabilities","imageMediaMetadata","parents","driveId","resourceKey"].join(",");
  const url = "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(fileId) + "?supportsAllDrives=true&fields=" + encodeURIComponent(fields);
  const headers = { "Authorization": "Bearer " + currentAccessToken };
  const key = fileResourceKey(fileId);
  if (key) headers["X-Goog-Drive-Resource-Keys"] = fileId + "/" + key;
  const response = await fetch(url, { headers, cache: "no-store" });
  if (!response.ok) throw new Error("读取图片信息失败：HTTP " + response.status);
  const file = await response.json();
  file.resourceKey = file.resourceKey || key || null;
  return file;
}

function escapeDriveQueryValue(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'");
}

function isDriveFolder(file) {
  return !!(
    file &&
    file.mimeType ===
      "application/vnd.google-apps.folder"
  );
}

function isImageFile(file) {
  if (!file) return false;
  if (
    file.mimeType &&
    file.mimeType.startsWith("image/")
  ) {
    return true;
  }

  return /\.(jpg|jpeg|png|webp|gif|bmp|avif)$/i
    .test(file.name || "");
}

async function fetchGalleryDriveMetadata(fileId) {
  const fields = [
    "id",
    "name",
    "mimeType",
    "size",
    "thumbnailLink",
    "capabilities",
    "imageMediaMetadata",
    "parents",
    "driveId",
    "resourceKey"
  ].join(",");

  const url =
    "https://www.googleapis.com/drive/v3/files/" +
    encodeURIComponent(fileId) +
    "?supportsAllDrives=true&fields=" +
    encodeURIComponent(fields);

  const headers = {
    "Authorization":
      "Bearer " + currentAccessToken
  };

  const key = fileResourceKey(fileId);

  if (key) {
    headers["X-Goog-Drive-Resource-Keys"] =
      fileId + "/" + key;
  }

  const response = await fetch(url, {
    headers,
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(
      "读取 Google Drive 文件夹信息失败：HTTP " +
      response.status
    );
  }

  const file = await response.json();

  file.resourceKey =
    file.resourceKey ||
    key ||
    null;

  return file;
}

async function findGalleryRootFolder(openedFile) {
  const parents =
    Array.isArray(openedFile.parents)
      ? openedFile.parents
      : [];

  if (!parents.length) return null;

  let parentId = parents[0];
  let firstParent = null;
  let matched = null;
  let guard = 0;

  while (parentId && guard < 80) {
    const folder =
      await fetchGalleryDriveMetadata(
        parentId
      );

    if (!firstParent) {
      firstParent = folder;
    }

    if (
      isDriveFolder(folder) &&
      folder.name === GALLERY_ROOT_FOLDER_NAME
    ) {
      matched = folder;
    }

    const folderParents =
      Array.isArray(folder.parents)
        ? folder.parents
        : [];

    parentId =
      folderParents.length
        ? folderParents[0]
        : null;

    guard += 1;
  }

  return matched || firstParent;
}

async function listGalleryTreeChildren(folderFile) {
  const allItems = [];
  let pageToken = null;

  do {
    const params =
      new URLSearchParams({
        q:
          "'" +
          escapeDriveQueryValue(folderFile.id) +
          "' in parents and trashed = false",
        spaces: "drive",
        pageSize: "1000",
        supportsAllDrives: "true",
        includeItemsFromAllDrives: "true",
        fields:
          "nextPageToken,files(" +
          [
            "id",
            "name",
            "mimeType",
            "size",
            "thumbnailLink",
            "capabilities",
            "imageMediaMetadata",
            "resourceKey",
            "parents",
            "driveId"
          ].join(",") +
          ")"
      });

    if (folderFile.driveId) {
      params.set(
        "corpora",
        "drive"
      );
      params.set(
        "driveId",
        folderFile.driveId
      );
    } else {
      params.set(
        "corpora",
        "user"
      );
    }

    if (pageToken) {
      params.set(
        "pageToken",
        pageToken
      );
    }

    const response =
      await fetch(
        "https://www.googleapis.com/drive/v3/files?" +
          params.toString(),
        {
          headers: {
            "Authorization":
              "Bearer " + currentAccessToken
          },
          cache: "no-store"
        }
      );

    if (!response.ok) {
      throw new Error(
        "读取文件夹内容失败：" +
        folderFile.name +
        " · HTTP " +
        response.status
      );
    }

    const data =
      await response.json();

    for (const file of data.files || []) {
      file.resourceKey =
        file.resourceKey ||
        fileResourceKey(file.id) ||
        null;

      if (
        isDriveFolder(file) ||
        isImageFile(file)
      ) {
        allItems.push(file);
      }
    }

    pageToken =
      data.nextPageToken || null;
  } while (pageToken);

  const collator =
    new Intl.Collator(
      undefined,
      {
        numeric: true,
        sensitivity: "base"
      }
    );

  allItems.sort((a, b) => {
    const aFolder =
      isDriveFolder(a) ? 0 : 1;

    const bFolder =
      isDriveFolder(b) ? 0 : 1;

    if (aFolder !== bFolder) {
      return aFolder - bFolder;
    }

    return collator.compare(
      a.name || "",
      b.name || ""
    );
  });

  return allItems;
}

async function buildGalleryFolderTree(rootFolder) {
  const rootNode = {
    file: rootFolder,
    children: []
  };

  const queue = [rootNode];
  let scannedFolders = 0;
  const MAX_FOLDERS = 5000;

  while (queue.length) {
    const batch = queue.splice(0, 4);

    await Promise.all(
      batch.map(async node => {
        const items =
          await listGalleryTreeChildren(
            node.file
          );

        node.children =
          items.map(file => ({
            file,
            children: []
          }));

        for (const child of node.children) {
          if (isDriveFolder(child.file)) {
            queue.push(child);
          }
        }

        scannedFolders += 1;

        setStatus(
          "正在读取 " +
          (rootFolder.name ||
            GALLERY_ROOT_FOLDER_NAME) +
          " · " +
          scannedFolders +
          " 个文件夹"
        );
      })
    );

    if (
      scannedFolders +
        queue.length >
      MAX_FOLDERS
    ) {
      throw new Error(
        "文件夹数量超过 " +
        MAX_FOLDERS +
        "，为避免浏览器卡死已停止读取。"
      );
    }
  }

  return rootNode;
}

function flattenImagesFromTree(rootNode) {
  const result = [];

  function walk(node, pathParts) {
    if (!node || !node.file) return;

    const currentPath = [
      ...pathParts,
      node.file.name || "Folder"
    ];

    for (
      const child
      of node.children || []
    ) {
      if (isDriveFolder(child.file)) {
        walk(
          child,
          currentPath
        );
      } else if (isImageFile(child.file)) {
        child.file._folderPath =
          currentPath.join(" / ");

        result.push(child.file);
      }
    }
  }

  if (rootNode) {
    walk(rootNode, []);
  }

  result.forEach((file, index) => {
    file._galleryIndex = index;
  });

  return result;
}


/*
 * 计算一个文件夹子树里一共有多少张图片。
 * 返回 0 的文件夹在图片页面完全不显示。
 */
function countSubtreeImages(node) {
  if (!node) return 0;

  let count = 0;

  for (const child of node.children || []) {
    if (isImageFile(child.file)) {
      count += 1;
    } else if (isDriveFolder(child.file)) {
      count += countSubtreeImages(child);
    }
  }

  return count;
}

/*
 * 初始只展开“当前目标图片”所在路径。
 * 兄弟文件夹全部保持折叠。
 */
function expandOnlyPathToImage(
  rootNode,
  targetImageId
) {
  expandedGalleryFolders.clear();

  if (!rootNode || !targetImageId) {
    return false;
  }

  function findTarget(node) {
    if (!node || !node.file) {
      return false;
    }

    for (const child of node.children || []) {
      if (
        isImageFile(child.file) &&
        child.file.id === targetImageId
      ) {
        expandedGalleryFolders.add(
          node.file.id
        );
        return true;
      }

      if (
        isDriveFolder(child.file) &&
        countSubtreeImages(child) > 0 &&
        findTarget(child)
      ) {
        expandedGalleryFolders.add(
          node.file.id
        );
        return true;
      }
    }

    return false;
  }

  return findTarget(rootNode);
}

/*
 * 统计真正会显示的文件夹：
 * 只计算“其子树里至少有一张图片”的文件夹。
 */
function countVisibleGalleryFolders(rootNode) {
  let count = 0;

  function walk(node, includeSelf) {
    if (!node) return;

    const subtreeCount =
      countSubtreeImages(node);

    if (subtreeCount <= 0) {
      return;
    }

    if (includeSelf) {
      count += 1;
    }

    for (const child of node.children || []) {
      if (
        isDriveFolder(child.file) &&
        countSubtreeImages(child) > 0
      ) {
        walk(child, true);
      }
    }
  }

  walk(rootNode, false);
  return count;
}

function countGalleryFolders(rootNode) {
  let count = 0;

  function walk(node, includeSelf) {
    if (!node) return;

    if (includeSelf) {
      count += 1;
    }

    for (
      const child
      of node.children || []
    ) {
      if (isDriveFolder(child.file)) {
        walk(child, true);
      }
    }
  }

  walk(rootNode, false);
  return count;
}

function originalUrl(file, retryValue = null) {
  const params = new URLSearchParams();
  if (file.resourceKey) params.set("resourceKey", file.resourceKey);
  if (retryValue !== null) params.set("retry", String(retryValue));
  const query = params.toString();
  return "./media/" + encodeURIComponent(file.id) + (query ? "?" + query : "");
}


function shuffleGalleryBackgrounds(files) {
  const copy = files.slice();

  for (
    let i = copy.length - 1;
    i > 0;
    i--
  ) {
    const j =
      Math.floor(
        Math.random() *
        (i + 1)
      );

    [copy[i], copy[j]] =
      [copy[j], copy[i]];
  }

  return copy;
}

const GALLERY_BACKGROUND_INTERVAL_MS =
  10000;

const GALLERY_BACKGROUND_THUMB_SIZE =
  1920;

function getGalleryBackgroundThumbnailUrl(
  file,
  size =
    GALLERY_BACKGROUND_THUMB_SIZE
) {
  const raw =
    file &&
    file.thumbnailLink
      ? String(
          file.thumbnailLink
        )
      : "";

  if (!raw) {
    return null;
  }

  if (
    /=s\d+(?:-c)?$/i.test(raw)
  ) {
    return raw.replace(
      /=s\d+(?:-c)?$/i,
      `=s${size}`
    );
  }

  return raw;
}

function preloadGalleryBackgroundThumbnail(
  url,
  timeout = 8000
) {
  return new Promise(
    (resolve, reject) => {
      if (!url) {
        reject(
          new Error(
            "没有可用的 Drive thumbnailLink"
          )
        );

        return;
      }

      const img =
        new Image();

      let settled = false;

      const finish =
        (ok, error) => {
          if (settled) return;

          settled = true;
          clearTimeout(timer);

          img.onload = null;
          img.onerror = null;

          if (ok) {
            resolve(url);
          } else {
            reject(
              error ||
              new Error(
                "Gallery 背景缩略图加载失败"
              )
            );
          }
        };

      img.decoding =
        "async";

      img.referrerPolicy =
        "no-referrer";

      img.onload =
        () => finish(true);

      img.onerror =
        () =>
          finish(
            false,
            new Error(
              "Gallery 背景缩略图加载失败"
            )
          );

      const timer =
        setTimeout(
          () =>
            finish(
              false,
              new Error(
                "Gallery 背景缩略图加载超时"
              )
            ),
          timeout
        );

      img.src = url;
    }
  );
}

function isGalleryBackgroundPaused() {
  if (document.hidden) {
    return true;
  }

  /*
   * 正在观看原图时背景完全暂停。
   */
  const viewer =
    document.getElementById(
      "viewer"
    );

  return !!(
    viewer &&
    viewer.classList.contains(
      "open"
    )
  );
}

function scheduleGalleryBackgroundNext(
  delay =
    GALLERY_BACKGROUND_INTERVAL_MS
) {
  clearTimeout(
    galleryBgTimer
  );

  galleryBgTimer =
    setTimeout(
      showNextGalleryBackground,
      delay
    );
}

function pauseGalleryBackgroundSlideshow() {
  clearTimeout(
    galleryBgTimer
  );

  galleryBgTimer = null;
}

function resumeGalleryBackgroundSlideshow(
  delay =
    GALLERY_BACKGROUND_INTERVAL_MS
) {
  if (
    !galleryFiles.length ||
    isGalleryBackgroundPaused()
  ) {
    return;
  }

  scheduleGalleryBackgroundNext(
    delay
  );
}

async function showNextGalleryBackground() {
  if (
    galleryBgPending ||
    !galleryFiles.length
  ) {
    scheduleGalleryBackgroundNext(
      1000
    );

    return;
  }

  if (
    isGalleryBackgroundPaused()
  ) {
    scheduleGalleryBackgroundNext(
      1000
    );

    return;
  }

  galleryBgPending = true;

  try {
    let thumbnailUrl = null;

    for (
      let attempt = 0;
      attempt < 8;
      attempt++
    ) {
      if (
        !galleryBgQueue.length
      ) {
        galleryBgQueue =
          shuffleGalleryBackgrounds(
            galleryFiles
          );
      }

      const file =
        galleryBgQueue.shift();

      thumbnailUrl =
        getGalleryBackgroundThumbnailUrl(
          file
        );

      if (thumbnailUrl) {
        break;
      }
    }

    if (!thumbnailUrl) {
      scheduleGalleryBackgroundNext(
        GALLERY_BACKGROUND_INTERVAL_MS
      );

      return;
    }

    await preloadGalleryBackgroundThumbnail(
      thumbnailUrl
    );

    /*
     * 如果加载过程中打开了原图，
     * 不执行背景切换。
     */
    if (
      isGalleryBackgroundPaused()
    ) {
      scheduleGalleryBackgroundNext(
        GALLERY_BACKGROUND_INTERVAL_MS
      );

      return;
    }

    galleryBgHiddenLayer
      .style
      .backgroundImage =
        `url("${thumbnailUrl}")`;

    await new Promise(
      resolve =>
        requestAnimationFrame(
          () =>
            requestAnimationFrame(
              resolve
            )
        )
    );

    galleryBgHiddenLayer
      .classList
      .add(
        "is-visible"
      );

    galleryBgVisibleLayer
      .classList
      .remove(
        "is-visible"
      );

    const oldLayer =
      galleryBgVisibleLayer;

    galleryBgVisibleLayer =
      galleryBgHiddenLayer;

    galleryBgHiddenLayer =
      oldLayer;

    galleryBgVisibleObjectUrl =
      null;

    scheduleGalleryBackgroundNext(
      GALLERY_BACKGROUND_INTERVAL_MS
    );
  } catch (error) {
    console.debug(
      "Gallery 背景缩略图轮播失败：",
      error
    );

    scheduleGalleryBackgroundNext(
      2500
    );
  } finally {
    galleryBgPending = false;
  }
}

function startGalleryBackgroundSlideshow() {
  pauseGalleryBackgroundSlideshow();

  const a =
    document.getElementById(
      "pageBgSlideA"
    );

  const b =
    document.getElementById(
      "pageBgSlideB"
    );

  if (
    !a ||
    !b ||
    !galleryFiles.length
  ) {
    return;
  }

  galleryBgVisibleLayer = a;
  galleryBgHiddenLayer = b;
  galleryBgQueue = [];

  a.style.backgroundImage =
    "none";

  b.style.backgroundImage =
    "none";

  a.classList.add(
    "is-visible"
  );

  b.classList.remove(
    "is-visible"
  );

  showNextGalleryBackground();
}

function syncGalleryBackgroundPauseState() {
  if (
    isGalleryBackgroundPaused()
  ) {
    pauseGalleryBackgroundSlideshow();
    return;
  }

  /*
   * 关闭原图查看器以后，
   * 从完整 10 秒重新计时。
   */
  resumeGalleryBackgroundSlideshow(
    GALLERY_BACKGROUND_INTERVAL_MS
  );
}

document.addEventListener(
  "visibilitychange",
  syncGalleryBackgroundPauseState
);

function renderGallery() {
  const grid =
    document.getElementById("grid");

  grid.innerHTML = "";

  const title =
    document.getElementById(
      "galleryTitle"
    );

  if (title) {
    title.textContent =
      (galleryRootFolder
        ? galleryRootFolder.name
        : GALLERY_ROOT_FOLDER_NAME) +
      " · 原图文件树";
  }

  if (galleryTreeRoot) {
    /*
     * 图片页不再把每个文件夹做成平铺 section。
     * 改成和视频一样的可折叠树。
     *
     * 规则：
     * - 子树没有图片：整个文件夹不渲染。
     * - 初始：只展开当前图片所在路径。
     * - 其他文件夹：折叠。
     */
    function renderFolder(
      node,
      depth = 0
    ) {
      const subtreeImageCount =
        countSubtreeImages(node);

      if (subtreeImageCount <= 0) {
        return null;
      }

      const folderWrap =
        document.createElement("div");

      folderWrap.className =
        "gallery-tree-folder";

      folderWrap.dataset.folderId =
        node.file.id;

      if (
        !expandedGalleryFolders.has(
          node.file.id
        )
      ) {
        folderWrap.classList.add(
          "collapsed"
        );
      }

      const row =
        document.createElement("button");

      row.type = "button";
      row.className =
        "gallery-folder-row";

      row.style.paddingLeft =
        Math.min(
          8 + depth * 2,
          22
        ) + "px";

      const chevron =
        document.createElement("span");

      chevron.className =
        "gallery-folder-chevron";

      chevron.textContent = "›";

      const icon =
        document.createElement("span");

      icon.className =
        "gallery-folder-icon";

      icon.textContent = "";

      const name =
        document.createElement("span");

      name.className =
        "gallery-folder-name";

      name.textContent =
        node.file.name || "Folder";

      const count =
        document.createElement("span");

      count.className =
        "gallery-folder-count";

      count.textContent =
        subtreeImageCount +
        " 张";

      row.append(
        chevron,
        icon,
        name,
        count
      );

      const children =
        document.createElement("div");

      children.className =
        "gallery-folder-children";

      row.addEventListener(
        "click",
        () => {
          const id =
            node.file.id;

          if (
            expandedGalleryFolders.has(id)
          ) {
            expandedGalleryFolders.delete(id);
            folderWrap.classList.add(
              "collapsed"
            );
          } else {
            expandedGalleryFolders.add(id);
            folderWrap.classList.remove(
              "collapsed"
            );
          }
        }
      );

      const directImages =
        (node.children || [])
          .filter(child =>
            isImageFile(child.file)
          );

      if (directImages.length) {
        const imageGrid =
          document.createElement("div");

        imageGrid.className =
          "gallery-folder-images";

        for (
          const child
          of directImages
        ) {
          imageGrid.appendChild(
            createGalleryCard(
              child.file,
              child.file._galleryIndex
            )
          );
        }

        children.appendChild(
          imageGrid
        );
      }

      /*
       * 只渲染“内部至少存在一张图片”的子文件夹。
       * 所以不会再出现：
       * “此层没有图片，下面还有子文件夹”
       * “此文件夹没有图片”
       */
      for (
        const child
        of node.children || []
      ) {
        if (
          isDriveFolder(child.file) &&
          countSubtreeImages(child) > 0
        ) {
          const childFolder =
            renderFolder(
              child,
              depth + 1
            );

          if (childFolder) {
            children.appendChild(
              childFolder
            );
          }
        }
      }

      folderWrap.append(
        row,
        children
      );

      return folderWrap;
    }

    const root =
      renderFolder(
        galleryTreeRoot,
        0
      );

    if (root) {
      grid.appendChild(root);
    }
  } else {
    const fallbackGrid =
      document.createElement("div");

    fallbackGrid.className =
      "gallery-folder-images";

    galleryFiles.forEach(
      (file, index) => {
        fallbackGrid.appendChild(
          createGalleryCard(
            file,
            index
          )
        );
      }
    );

    grid.appendChild(
      fallbackGrid
    );
  }

  document.getElementById(
    "count"
  ).textContent =
    (galleryTreeRoot
      ? countVisibleGalleryFolders(
          galleryTreeRoot
        ) + " 个图片文件夹 · "
      : "") +
    galleryFiles.length +
    " 张图片";

  document.getElementById(
    "welcome"
  ).style.display = "none";

  document.getElementById(
    "gallery"
  ).style.display = "block";
}

function createGalleryCard(file, index) {
  const card =
    document.createElement("div");

  card.className = "card";
  card.tabIndex = 0;
  card.dataset.index =
    String(index);

  const fallback =
    document.createElement("div");

  fallback.className = "fallback";
  fallback.textContent =
    file.name || "Image";

  const img =
    document.createElement("img");

  img.alt =
    file.name ||
    "Google Drive image";

  img.loading = "lazy";
  img.decoding = "async";

  const label =
    document.createElement("div");

  label.className = "label";
  label.textContent =
    file.name || "Image";

  let triedOriginal = false;

  img.onload =
    () => img.classList.add(
      "loaded"
    );

  img.onerror = () => {
    if (!triedOriginal) {
      triedOriginal = true;
      img.src =
        originalUrl(file);
    }
  };

  if (file.thumbnailLink) {
    img.src =
      file.thumbnailLink;
  } else {
    triedOriginal = true;
    img.src =
      originalUrl(file);
  }

  card.append(
    fallback,
    img,
    label
  );

  card.addEventListener(
    "click",
    () => openViewer(index)
  );

  card.addEventListener(
    "keydown",
    event => {
      if (
        event.key === "Enter" ||
        event.key === " "
      ) {
        event.preventDefault();
        openViewer(index);
      }
    }
  );

  return card;
}

function createHQ2DContext(canvas) {
  const wantsP3 = !!(
    window.matchMedia &&
    window.matchMedia("(color-gamut: p3)").matches
  );

  if (wantsP3) {
    try {
      const ctx = canvas.getContext("2d", {
        alpha: false,
        colorSpace: "display-p3"
      });
      if (ctx) {
        hqColorSpace = "display-p3";
        return ctx;
      }
    } catch (_) {}
  }

  hqColorSpace = "srgb";
  return canvas.getContext("2d", { alpha: false });
}

function hideHQRender() {
  const canvas = document.getElementById("viewerHQCanvas");
  const img = document.getElementById("viewerImage");
  if (canvas) canvas.classList.remove("active");
  if (img) img.style.opacity = "1";
  hqRenderActive = false;
}

function scheduleHQRender(delay = 70) {
  clearTimeout(hqRenderTimer);
  if (hqRenderRaf !== null) {
    cancelAnimationFrame(hqRenderRaf);
    hqRenderRaf = null;
  }

  hqRenderTimer = setTimeout(() => {
    hqRenderRaf = requestAnimationFrame(() => {
      hqRenderRaf = null;
      renderHQImage();
    });
  }, delay);
}

function drawHighQualityImage(ctx, img, dx, dy, dw, dh, pixelRatio) {
  const targetW = Math.max(1, Math.round(Math.abs(dw) * pixelRatio));
  const targetH = Math.max(1, Math.round(Math.abs(dh) * pixelRatio));
  const srcW = img.naturalWidth || 1;
  const srcH = img.naturalHeight || 1;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  const reduction = Math.max(
    srcW / targetW,
    srcH / targetH
  );

  // 大幅缩小时做两阶段高质量重采样，减少一次性缩小造成的细纹丢失/闪烁。
  if (reduction > 1.6) {
    const midW = Math.max(
      1,
      Math.min(srcW, Math.round(targetW * 1.9), 4096)
    );
    const midH = Math.max(
      1,
      Math.min(srcH, Math.round(targetH * 1.9), 4096)
    );

    const temp = document.createElement("canvas");
    temp.width = midW;
    temp.height = midH;

    const tempCtx = createHQ2DContext(temp);
    if (tempCtx) {
      tempCtx.imageSmoothingEnabled = true;
      tempCtx.imageSmoothingQuality = "high";
      tempCtx.drawImage(img, 0, 0, srcW, srcH, 0, 0, midW, midH);
      ctx.drawImage(temp, dx, dy, dw, dh);
      return;
    }
  }

  ctx.drawImage(img, dx, dy, dw, dh);
}

function renderHQImage() {
  const viewer = document.getElementById("viewer");
  const stage = document.getElementById("imageStage");
  const img = document.getElementById("viewerImage");
  const canvas = document.getElementById("viewerHQCanvas");

  if (
    !viewer.classList.contains("open") ||
    !img ||
    !canvas ||
    !img.complete ||
    !img.naturalWidth ||
    !img.naturalHeight ||
    img.style.visibility === "hidden"
  ) {
    hideHQRender();
    return;
  }

  const stageRect = stage.getBoundingClientRect();
  if (!stageRect.width || !stageRect.height) return;

  // 以物理像素输出；为避免超大 DPR 屏幕占用过多内存，限制到约 12MP / 4096 边长。
  const rawDpr = Math.max(1, window.devicePixelRatio || 1);
  let effectiveDpr = Math.min(rawDpr, 3);
  const maxPixels = 12_000_000;
  const maxDim = 4096;

  const dimScale = Math.min(
    1,
    maxDim / Math.max(stageRect.width * effectiveDpr, stageRect.height * effectiveDpr)
  );
  const pixelScale = Math.min(
    1,
    Math.sqrt(
      maxPixels /
      Math.max(1, stageRect.width * stageRect.height * effectiveDpr * effectiveDpr)
    )
  );
  effectiveDpr *= Math.min(dimScale, pixelScale);

  const width = Math.max(1, Math.round(stageRect.width * effectiveDpr));
  const height = Math.max(1, Math.round(stageRect.height * effectiveDpr));

  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;

  const ctx = createHQ2DContext(canvas);
  if (!ctx) {
    hideHQRender();
    return;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, width, height);
  ctx.setTransform(effectiveDpr, 0, 0, effectiveDpr, 0, 0);

  const baseW = img.offsetWidth;
  const baseH = img.offsetHeight;
  const drawW = baseW * zoomScale;
  const drawH = baseH * zoomScale;
  const dx = stageRect.width / 2 + panX - drawW / 2;
  const dy = stageRect.height / 2 + panY - drawH / 2;

  drawHighQualityImage(
    ctx,
    img,
    dx,
    dy,
    drawW,
    drawH,
    effectiveDpr
  );

  canvas.classList.add("active");
  // 保留 img 的命中区域，但让最终静止画面由高质量 Canvas 输出。
  img.style.opacity = "0";
  hqRenderActive = true;
}

function getImageStageCenter() {
  const rect = document.getElementById("imageStage").getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height
  };
}

function getPanBounds() {
  const img = document.getElementById("viewerImage");
  const stage = document.getElementById("imageStage");
  if (!img || !stage) return { maxX: 0, maxY: 0 };

  const stageRect = stage.getBoundingClientRect();
  const scaledWidth = img.offsetWidth * zoomScale;
  const scaledHeight = img.offsetHeight * zoomScale;

  return {
    maxX: Math.max(0, (scaledWidth - stageRect.width) / 2),
    maxY: Math.max(0, (scaledHeight - stageRect.height) / 2)
  };
}

function clampPan() {
  const { maxX, maxY } = getPanBounds();
  panX = Math.max(-maxX, Math.min(maxX, panX));
  panY = Math.max(-maxY, Math.min(maxY, panY));
}

function applyZoom({ animate = false, clamp = true } = {}) {
  const img = document.getElementById("viewerImage");
  if (!img) return;

  if (clamp) clampPan();

  img.style.transition = animate
    ? "transform .14s ease-out"
    : "none";

  img.style.transform =
    `translate3d(${panX}px, ${panY}px, 0) scale(${zoomScale})`;

  img.classList.toggle("zoomed", zoomScale > 1.001);

  // 拖拽/捏合时优先响应速度；停止操作后重新生成高质量静态画面。
  hideHQRender();
  scheduleHQRender(90);
}

function resetZoom({ animate = false } = {}) {
  zoomScale = 1;
  panX = 0;
  panY = 0;
  applyZoom({ animate });
}

/*
 * 围绕指定屏幕坐标缩放。
 * 这样双击/双指缩放时，被手指指着的内容会尽量留在原位置，
 * 而不是永远从图片中心放大。
 */
function zoomAt(clientX, clientY, targetScale, { animate = false } = {}) {
  const oldScale = zoomScale;
  const newScale = Math.max(1, Math.min(6, targetScale));
  const center = getImageStageCenter();

  if (Math.abs(newScale - oldScale) < 0.0001) return;

  const ratio = newScale / oldScale;

  panX =
    clientX - center.x -
    ratio * (clientX - center.x - panX);

  panY =
    clientY - center.y -
    ratio * (clientY - center.y - panY);

  zoomScale = newScale;

  if (zoomScale <= 1.001) {
    panX = 0;
    panY = 0;
  }

  applyZoom({ animate });
}

function toggleZoomAt(clientX, clientY) {
  if (zoomScale > 1.05) {
    resetZoom({ animate: true });
  } else {
    zoomAt(clientX, clientY, 2.5, { animate: true });
  }
}

function toggleZoom() {
  const center = getImageStageCenter();
  toggleZoomAt(center.x, center.y);
}

/*
 * Gallery 原图热预加载：
 * 默认沿当前浏览方向提前加载 5 张，反方向保留 1 张。
 *
 * 例如向右浏览：
 * 当前图 -> +1 -> +2 -> +3 -> +4 -> +5
 *
 * 这样连续翻图时，后面 5 张都可以直接命中浏览器缓存/已解码 Image。
 * 如果浏览器开启 Data Saver，则仍只预加载相邻 1 张，避免移动网络一次拉取大量原图。
 */
function preloadOriginalAt(index) {
  if (!galleryFiles.length) return;

  const normalized =
    (index + galleryFiles.length) %
    galleryFiles.length;

  const file =
    galleryFiles[normalized];

  if (
    !file ||
    originalPreloadCache.has(file.id)
  ) {
    return;
  }

  const preload =
    new Image();

  preload.decoding =
    "async";

  preload.src =
    originalUrl(file);

  originalPreloadCache.set(
    file.id,
    preload
  );

  if (
    typeof preload.decode ===
    "function"
  ) {
    preload
      .decode()
      .catch(() => {});
  }

  /*
   * 5 张前向 + 当前附近/反向 1 张，
   * 缓存上限提高到 12，避免第 4、5 张刚预加载就被清掉。
   */
  if (
    originalPreloadCache.size >
    12
  ) {
    for (
      const [id]
      of originalPreloadCache
    ) {
      const keep =
        isGallerySlideshowQueued(id) ||
        galleryFiles.some(
          (item, i) => {
            if (
              item.id !== id
            ) {
              return false;
            }

            const forward =
              (
                i -
                currentIndex +
                galleryFiles.length
              ) %
              galleryFiles.length;

            const backward =
              (
                currentIndex -
                i +
                galleryFiles.length
              ) %
              galleryFiles.length;

            /*
             * 保留当前前后 5 张范围，
             * 兼容用户突然反向翻图。
             */
            return (
              forward <= 5 ||
              backward <= 5
            );
          }
        );

      if (!keep) {
        originalPreloadCache.delete(
          id
        );

        if (
          originalPreloadCache.size <=
          12
        ) {
          break;
        }
      }
    }
  }
}

function isGallerySlideshowQueued(id) {
  if (
    !gallerySlideshowActive ||
    !gallerySlideshowQueue.length
  ) {
    return false;
  }

  return gallerySlideshowQueue
    .slice(
      0,
      GALLERY_SLIDESHOW_PRELOAD_COUNT
    )
    .some(index => {
      const file =
        galleryFiles[index];

      return !!(
        file &&
        file.id === id
      );
    });
}

function getGalleryViewportOrientation() {
  return window.innerHeight > window.innerWidth
    ? "portrait"
    : "landscape";
}

function getGalleryImageOrientation(file) {
  if (!file) {
    return "unknown";
  }

  const metadata =
    file.imageMediaMetadata || {};

  let width =
    Number(metadata.width || file.width);

  let height =
    Number(metadata.height || file.height);

  const rotation = Math.abs(Number(metadata.rotation || 0)) % 360;
  if (rotation === 90 || rotation === 270) {
    [width, height] = [height, width];
  }

  if (
    !(width > 0) ||
    !(height > 0)
  ) {
    return "unknown";
  }

  const squareTolerance =
    Math.max(width, height) * 0.02;

  if (
    Math.abs(width - height) <=
    squareTolerance
  ) {
    return "square";
  }

  return height > width
    ? "portrait"
    : "landscape";
}

function getGallerySlideshowPool(
  orientation = getGalleryViewportOrientation()
) {
  const allIndexes =
    galleryFiles.map((_, index) => index);

  const matchingIndexes =
    allIndexes.filter(index => {
      const imageOrientation =
        getGalleryImageOrientation(
          galleryFiles[index]
        );

      return (
        imageOrientation === orientation ||
        imageOrientation === "square"
      );
    });

  /*
   * 方向图片太少时回退到全量，避免画廊只剩一张图无法继续随机。
   */
  if (
    matchingIndexes.length >=
    Math.min(2, allIndexes.length)
  ) {
    return matchingIndexes;
  }

  return allIndexes;
}

function ensureGallerySlideshowOrientation() {
  const orientation =
    getGalleryViewportOrientation();

  if (
    gallerySlideshowOrientation !==
    orientation
  ) {
    gallerySlideshowOrientation =
      orientation;

    gallerySlideshowQueue = [];
  }

  return orientation;
}

function preloadGallerySlideshowNext() {
  if (
    !gallerySlideshowActive ||
    galleryFiles.length < 2
  ) {
    return;
  }

  const orientation =
    ensureGallerySlideshowOrientation();

  const pool =
    getGallerySlideshowPool(
      orientation
    );

  const currentIsInPool =
    pool.includes(currentIndex);

  const targetCount =
    Math.min(
      GALLERY_SLIDESHOW_PRELOAD_COUNT,
      Math.max(
        0,
        pool.length -
        (currentIsInPool ? 1 : 0)
      )
    );

  while (
    gallerySlideshowQueue.length <
    targetCount
  ) {
    const blocked =
      new Set([
        currentIndex,
        ...gallerySlideshowQueue
      ]);

    const candidates =
      pool.filter(
        index => !blocked.has(index)
      );

    for (
      let i = candidates.length - 1;
      i > 0;
      i--
    ) {
      const j =
        Math.floor(
          Math.random() *
          (i + 1)
        );

      [
        candidates[i],
        candidates[j]
      ] = [
        candidates[j],
        candidates[i]
      ];
    }

    if (!candidates.length) {
      break;
    }

    gallerySlideshowQueue.push(
      ...candidates
    );
  }

  for (
    let i = 0;
    i <
      Math.min(
        GALLERY_SLIDESHOW_PRELOAD_COUNT,
        gallerySlideshowQueue.length
      );
    i++
  ) {
    preloadOriginalAt(
      gallerySlideshowQueue[i]
    );
  }
}

function getNextGallerySlideshowIndex() {
  if (
    galleryFiles.length < 2
  ) {
    return currentIndex;
  }

  preloadGallerySlideshowNext();

  if (!gallerySlideshowQueue.length) {
    return currentIndex;
  }

  return gallerySlideshowQueue.shift();
}

function preloadNeighbors(
  index,
  direction = 1
) {
  if (
    galleryFiles.length < 2
  ) {
    return;
  }

  const saveData = !!(
    navigator.connection &&
    navigator.connection.saveData
  );

  /*
   * 省流量模式：
   * 仍只拉取当前浏览方向的下一张。
   */
  if (saveData) {
    preloadOriginalAt(
      index + direction
    );

    return;
  }

  /*
   * 正常模式：
   * 当前浏览方向一次提前准备 5 张原图。
   */
  const maxAhead =
    Math.min(
      5,
      galleryFiles.length - 1
    );

  for (
    let step = 1;
    step <= maxAhead;
    step++
  ) {
    preloadOriginalAt(
      index +
      direction * step
    );
  }

  /*
   * 额外保留反方向 1 张，
   * 方便用户临时返回上一张。
   */
  preloadOriginalAt(
    index - direction
  );
}

async function showViewerImage(
  index,
  options = {}
) {
  const slideshowMode = !!(
    options &&
    options.gallerySlideshow
  );
  if (!galleryFiles.length) return;

  currentIndex = (index + galleryFiles.length) % galleryFiles.length;
  const file = galleryFiles[currentIndex];

  if (!slideshowMode) {
    clearTimeout(galleryFolderSlideshowTimer);
    galleryFolderSlideshowTimer = null;
  }

  if (slideshowMode) {
    preloadGallerySlideshowNext();
  }

  const img = document.getElementById("viewerImage");
  const placeholder = document.getElementById("viewerPlaceholder");
  const loading = document.getElementById("viewerLoading");

  hideHQRender();
  resetZoom();
  edgeSwipeDelta = 0;

  loading.style.display = "block";
  loading.textContent = "正在加载原图…";
  img.style.visibility = "hidden";
  img.dataset.retry = "0";
  const loadGeneration = ++viewerImageLoadGeneration;

  document.getElementById("viewerName").textContent =
    file.name || "Google Drive Image";
  document.getElementById("viewerCounter").textContent =
    (currentIndex + 1) + " / " + galleryFiles.length;

  const caption = document.getElementById("slideshowCaption");
  if (caption) {
    caption.textContent = slideshowMode
      ? gallerySlideshowPaused
        ? "✦ 随机画廊 · 已暂停"
        : "✦ 随机画廊 · 20 秒换图"
      : galleryFolderSlideshowPaused
        ? "普通浏览 · 轮播已暂停"
        : "普通浏览 · 每 10 秒自动下一张";
  }

  // PhotoSwipe 风格的 placeholder：先铺缩略图，避免黑屏等待原图。
  placeholder.classList.remove("hidden");
  if (file.thumbnailLink) {
    placeholder.src = file.thumbnailLink;
    placeholder.style.display = "block";
  } else {
    placeholder.removeAttribute("src");
    placeholder.style.display = "none";
  }

  img.onload = async () => {
    if (loadGeneration !== viewerImageLoadGeneration) return;

    try {
      if (typeof img.decode === "function") await img.decode();
    } catch (_) {}

    loading.style.display = "none";
    img.style.visibility = "visible";
    img.style.opacity = "1";
    placeholder.classList.add("hidden");

    if (slideshowMode) {
      preloadGallerySlideshowNext();
    } else {
      preloadNeighbors(
        currentIndex,
        lastNavigationDirection
      );
      scheduleGalleryFolderSlideshow();
    }

    scheduleHQRender(40);
  };

  img.onerror = async () => {
    if (loadGeneration !== viewerImageLoadGeneration) return;

    const retry = Number(img.dataset.retry || "0");
    if (retry < 1) {
      img.dataset.retry = "1";
      await refreshWorkerAccessToken();
      img.src = originalUrl(file, Date.now());
      return;
    }
    loading.textContent = "原图加载失败，请重新打开相册后再试。";
  };

  const preloaded = originalPreloadCache.get(file.id);
  img.src = preloaded && preloaded.src
    ? preloaded.src
    : originalUrl(file);
}

function stopGalleryFolderSlideshow() {
  clearTimeout(galleryFolderSlideshowTimer);
  galleryFolderSlideshowTimer = null;
}

function getCurrentFolderImageIndexes() {
  const currentFile = galleryFiles[currentIndex];
  const folderPath = currentFile && currentFile._folderPath;

  if (!folderPath) {
    return galleryFiles.map((_, index) => index);
  }

  const indexes = galleryFiles.reduce((result, file, index) => {
    if (file && file._folderPath === folderPath) result.push(index);
    return result;
  }, []);

  return indexes.length ? indexes : galleryFiles.map((_, index) => index);
}

function getNextFolderImageIndex() {
  const indexes = getCurrentFolderImageIndexes();
  if (indexes.length < 2) return currentIndex;

  const position = indexes.indexOf(currentIndex);
  return indexes[(position + 1) % indexes.length];
}

function updateImageSlideshowUi() {
  const button = document.getElementById("slideshowToggleBtn");
  if (!button) return;

  const randomMode = gallerySlideshowActive;
  button.disabled = false;
  button.textContent = randomMode
    ? gallerySlideshowPaused
      ? "继续画廊"
      : "暂停画廊"
    : galleryFolderSlideshowPaused
      ? "继续轮播"
      : "暂停轮播";
  button.setAttribute(
    "aria-pressed",
    String(
      randomMode
        ? !gallerySlideshowPaused
        : !galleryFolderSlideshowPaused
    )
  );
}

function scheduleGalleryFolderSlideshow() {
  stopGalleryFolderSlideshow();

  if (
    galleryFolderSlideshowPaused ||
    gallerySlideshowActive ||
    !document.getElementById("viewer")?.classList.contains("open") ||
    getCurrentFolderImageIndexes().length < 2
  ) {
    updateImageSlideshowUi();
    return;
  }

  galleryFolderSlideshowTimer = setTimeout(() => {
    if (
      galleryFolderSlideshowPaused ||
      gallerySlideshowActive ||
      !document.getElementById("viewer")?.classList.contains("open")
    ) {
      return;
    }

    lastNavigationDirection = 1;
    showViewerImage(getNextFolderImageIndex());
  }, GALLERY_FOLDER_SLIDESHOW_INTERVAL_MS);
}

function toggleImageSlideshow() {
  if (gallerySlideshowActive) {
    gallerySlideshowPaused = !gallerySlideshowPaused;

    const orientationLabel =
      getGalleryViewportOrientation() === "portrait"
        ? "竖屏图片"
        : "横屏图片";

    setStatus(
      gallerySlideshowPaused
        ? "随机画廊 · 已暂停"
        : "画廊模式 · " +
          orientationLabel +
          " · 每 20 秒随机切换 · 已预加载后面 3 张"
    );

    const caption = document.getElementById("slideshowCaption");
    if (caption) {
      caption.textContent = gallerySlideshowPaused
        ? "✦ 随机画廊 · 已暂停"
        : "✦ 随机画廊 · 20 秒换图";
    }

    updateImageSlideshowUi();
    return;
  }

  galleryFolderSlideshowPaused = !galleryFolderSlideshowPaused;

  if (galleryFolderSlideshowPaused) {
    stopGalleryFolderSlideshow();
    setStatus("普通浏览 · 自动轮播已暂停");
  } else {
    scheduleGalleryFolderSlideshow();
    setStatus("普通浏览 · 每 10 秒自动下一张");
  }

  const caption = document.getElementById("slideshowCaption");
  if (caption) {
    caption.textContent = galleryFolderSlideshowPaused
      ? "普通浏览 · 轮播已暂停"
      : "普通浏览 · 每 10 秒自动下一张";
  }
  updateImageSlideshowUi();
}

function startGalleryFolderSlideshow() {
  stopGalleryFolderSlideshow();
  galleryFolderSlideshowPaused = false;

  if (
    getCurrentFolderImageIndexes().length < 2 ||
    gallerySlideshowActive
  ) {
    updateImageSlideshowUi();
    return;
  }

  scheduleGalleryFolderSlideshow();
  updateImageSlideshowUi();

  setStatus(
    "普通浏览 · 每 10 秒自动下一张"
  );
}

function openViewer(index, options = {}) {
  const viewer = document.getElementById("viewer");

  /*
   * 打开原图前先暂停背景轮播，
   * 避免原图加载期间仍发生装饰背景请求/切换。
   */
  pauseGalleryBackgroundSlideshow();

  viewer.classList.add("open");
  viewer.classList.remove("viewer-ui-hidden");
  viewer.setAttribute("aria-hidden","false");
  document.body.style.overflow = "hidden";
  showViewerUi();

  showViewerImage(index, options);

  if (
    options &&
    options.gallerySlideshow
  ) {
    stopGalleryFolderSlideshow();
    galleryFolderSlideshowPaused = false;
    updateImageSlideshowUi();
  } else {
    startGalleryFolderSlideshow();
  }
}

function isViewerFullscreen() {
  const viewer = document.getElementById("viewer");

  return !!(
    viewer &&
    (
      document.fullscreenElement === viewer ||
      document.webkitFullscreenElement === viewer
    )
  );
}

function requestViewerFullscreen() {
  const viewer = document.getElementById("viewer");

  if (!viewer) {
    return Promise.resolve(false);
  }

  const request =
    viewer.requestFullscreen ||
    viewer.webkitRequestFullscreen;

  if (typeof request !== "function") {
    setStatus(
      "当前浏览器不支持网页全屏，已使用全屏查看器。"
    );

    return Promise.resolve(false);
  }

  try {
    const result =
      request.call(viewer);

    return Promise.resolve(result)
      .then(() => {
        syncViewerFullscreenState();
        return true;
      })
      .catch(error => {
        console.warn(
          "进入图片全屏失败：",
          error
        );
        syncViewerFullscreenState();
        return false;
      });
  } catch (error) {
    console.warn(
      "进入图片全屏失败：",
      error
    );

    return Promise.resolve(false);
  }
}

function exitViewerFullscreen() {
  const exit =
    document.exitFullscreen ||
    document.webkitExitFullscreen;

  if (typeof exit !== "function") {
    return Promise.resolve(false);
  }

  try {
    const result =
      exit.call(document);

    return Promise.resolve(result)
      .then(() => {
        syncViewerFullscreenState();
        return true;
      })
      .catch(error => {
        console.warn(
          "退出图片全屏失败：",
          error
        );
        return false;
      });
  } catch (error) {
    console.warn(
      "退出图片全屏失败：",
      error
    );

    return Promise.resolve(false);
  }
}

function toggleViewerFullscreen() {
  const viewer = document.getElementById("viewer");

  if (!viewer) {
    return;
  }

  if (!viewer.classList.contains("open")) {
    openViewer(currentIndex);
  }

  if (isViewerFullscreen()) {
    exitViewerFullscreen();
  } else {
    requestViewerFullscreen();
  }
}

function openCurrentImageFullscreen() {
  if (!galleryFiles.length) {
    setStatus("当前没有可展示的图片。");
    return;
  }

  openViewer(currentIndex);
  requestViewerFullscreen();
}

function startFullscreenGallery() {
  if (!galleryFiles.length) {
    setStatus("当前没有可展示的图片。");
    return;
  }

  stopFullscreenGallery(false);
  gallerySlideshowActive = true;
  gallerySlideshowPaused = false;
  galleryFolderSlideshowPaused = false;
  updateImageSlideshowUi();

  openViewer(
    getNextGallerySlideshowIndex(),
    {
      gallerySlideshow: true
    }
  );

  requestViewerFullscreen();

  gallerySlideshowTimer =
    setInterval(
      () => {
        const activeViewer =
          document.getElementById("viewer");

        if (
          !gallerySlideshowActive ||
          !activeViewer ||
          !activeViewer.classList.contains("open")
        ) {
          stopFullscreenGallery(false);
          return;
        }

        if (gallerySlideshowPaused) return;

        if (galleryFiles.length < 2) {
          return;
        }

        const nextIndex =
          getNextGallerySlideshowIndex();

        lastNavigationDirection =
          nextIndex >= currentIndex
            ? 1
            : -1;

        showViewerImage(
          nextIndex,
          {
            gallerySlideshow: true
          }
        );
      },
      GALLERY_SLIDESHOW_INTERVAL_MS
    );

  const orientationLabel =
    getGalleryViewportOrientation() === "portrait"
      ? "竖屏图片"
      : "横屏图片";

  setStatus(
    "画廊模式 · " +
    orientationLabel +
    " · 每 20 秒随机切换 · 已预加载后面 3 张"
  );
}

function stopFullscreenGallery(
  exitFullscreen = true
) {
  if (gallerySlideshowTimer) {
    clearInterval(
      gallerySlideshowTimer
    );
  }

  gallerySlideshowTimer = null;
  gallerySlideshowActive = false;
  gallerySlideshowPaused = false;
  gallerySlideshowQueue = [];
  gallerySlideshowOrientation = null;
  updateImageSlideshowUi();

  if (
    exitFullscreen &&
    isViewerFullscreen()
  ) {
    exitViewerFullscreen();
  }
}

function handleGalleryViewportOrientationChange() {
  const orientation =
    getGalleryViewportOrientation();

  if (
    lastGalleryViewportOrientation ===
    orientation
  ) {
    return;
  }

  lastGalleryViewportOrientation =
    orientation;

  if (
    !gallerySlideshowActive ||
    galleryFiles.length < 2
  ) {
    return;
  }

  gallerySlideshowOrientation =
    orientation;
  gallerySlideshowQueue = [];

  const activeViewer =
    document.getElementById(
      "viewer"
    );

  if (
    !activeViewer ||
    !activeViewer.classList.contains(
      "open"
    )
  ) {
    return;
  }

  const nextIndex =
    getNextGallerySlideshowIndex();

  lastNavigationDirection = 1;

  showViewerImage(
    nextIndex,
    {
      gallerySlideshow: true
    }
  );
}

window.addEventListener(
  "resize",
  handleGalleryViewportOrientationChange
);

window.addEventListener(
  "orientationchange",
  handleGalleryViewportOrientationChange
);

function syncViewerFullscreenState() {
  const fullscreen =
    isViewerFullscreen();

  const viewerButton =
    document.getElementById(
      "viewerFullscreenBtn"
    );

  if (viewerButton) {
    viewerButton.title =
      fullscreen
        ? "退出全屏"
        : "全屏";

    viewerButton.setAttribute(
      "aria-label",
      fullscreen
        ? "退出全屏"
        : "全屏"
    );
  }

  const galleryButton =
    document.getElementById(
      "fullscreenGalleryBtn"
    );

  if (galleryButton) {
    galleryButton.textContent =
      fullscreen
        ? "退出全屏"
        : "全屏";
  }

}

function handleViewerFullscreenChange() {
  syncViewerFullscreenState();

  if (
    gallerySlideshowActive &&
    !isViewerFullscreen()
  ) {
    stopFullscreenGallery(false);
    startGalleryFolderSlideshow();
  }
}

function closeViewer() {
  stopFullscreenGallery();
  stopGalleryFolderSlideshow();
  galleryFolderSlideshowPaused = false;
  const viewer = document.getElementById("viewer");
  clearTimeout(viewerUiTimer);
  viewerUiTimer = null;
  viewer.classList.remove("viewer-ui-hidden");
  viewer.classList.remove("open");
  viewer.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
  document.getElementById("viewerImage").removeAttribute("src");
  const placeholder = document.getElementById("viewerPlaceholder");
  placeholder.removeAttribute("src");
  placeholder.classList.remove("hidden");
  hideHQRender();
  const hqCanvas = document.getElementById("viewerHQCanvas");
  if (hqCanvas) hqCanvas.classList.remove("active");
  resetZoom();
  updateImageSlideshowUi();

  /*
   * 退出原图查看后，从完整 10 秒重新开始背景计时。
   */
  resumeGalleryBackgroundSlideshow(
    GALLERY_BACKGROUND_INTERVAL_MS
  );
}
function showPrev() {
  lastNavigationDirection = -1;
  showViewerImage(currentIndex - 1);
}
function showNext() {
  lastNavigationDirection = 1;
  showViewerImage(currentIndex + 1);
}

function touchDistance(touches) {
  if (touches.length < 2) return 0;
  return Math.hypot(
    touches[0].clientX - touches[1].clientX,
    touches[0].clientY - touches[1].clientY
  );
}

function touchCenter(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2
  };
}

let viewerUiTimer = null;
const VIEWER_UI_HIDE_DELAY = 2300;

function showViewerUi() {
  const el = document.getElementById("viewer");
  if (!el || !el.classList.contains("open")) return;

  el.classList.remove("viewer-ui-hidden");
  clearTimeout(viewerUiTimer);

  viewerUiTimer = setTimeout(() => {
    if (el.classList.contains("open")) {
      el.classList.add("viewer-ui-hidden");
    }
  }, VIEWER_UI_HIDE_DELAY);
}

const viewer = document.getElementById("viewer");
const viewerImage = document.getElementById("viewerImage");

document.addEventListener(
  "fullscreenchange",
  handleViewerFullscreenChange
);

document.addEventListener(
  "webkitfullscreenchange",
  handleViewerFullscreenChange
);

/*
 * 手机：
 * - 单指，未放大：保留左右滑动切图。
 * - 单指，已放大：拖动查看任意区域。
 * - 双指：围绕两指中心缩放，同时允许两指一起平移。
 */
viewer.addEventListener("touchstart", event => {
  hideHQRender();
  const img = document.getElementById("viewerImage");
  img.style.transition = "none";

  if (event.touches.length === 1) {
    const t = event.touches[0];
    touchStartX = t.clientX;
    touchStartY = t.clientY;

    if (zoomScale > 1.001) {
      edgeSwipeDelta = 0;
      isTouchPanning = true;
      panStartX = t.clientX;
      panStartY = t.clientY;
      panStartOffsetX = panX;
      panStartOffsetY = panY;
      img.classList.add("dragging");
    }
  } else if (event.touches.length === 2) {
    event.preventDefault();

    isTouchPanning = false;
    touchStartDistance = touchDistance(event.touches);
    pinchStartScale = zoomScale;
    pinchStartPanX = panX;
    pinchStartPanY = panY;

    const c = touchCenter(event.touches);
    pinchStartCenterX = c.x;
    pinchStartCenterY = c.y;

    img.classList.add("dragging");
  }
}, { passive: false });

viewer.addEventListener("touchmove", event => {
  if (event.touches.length === 2 && touchStartDistance > 0) {
    event.preventDefault();

    const distance = touchDistance(event.touches);
    const centerNow = touchCenter(event.touches);
    const centerBase = getImageStageCenter();

    const newScale = Math.max(
      1,
      Math.min(
        6,
        pinchStartScale * (distance / touchStartDistance)
      )
    );

    const ratio = newScale / pinchStartScale;

    /*
     * 初始两指中心对应的图像点，在新的两指中心下保持一致。
     * 因此既能“从手指位置放大”，也能在捏合时同步移动图片。
     */
    panX =
      centerNow.x - centerBase.x -
      ratio * (
        pinchStartCenterX -
        centerBase.x -
        pinchStartPanX
      );

    panY =
      centerNow.y - centerBase.y -
      ratio * (
        pinchStartCenterY -
        centerBase.y -
        pinchStartPanY
      );

    zoomScale = newScale;

    if (zoomScale <= 1.001) {
      zoomScale = 1;
      panX = 0;
      panY = 0;
    }

    applyZoom();
    return;
  }

  if (
    event.touches.length === 1 &&
    isTouchPanning &&
    zoomScale > 1.001
  ) {
    event.preventDefault();

    const t = event.touches[0];

    const desiredX =
      panStartOffsetX +
      (t.clientX - panStartX);

    const desiredY =
      panStartOffsetY +
      (t.clientY - panStartY);

    const { maxX, maxY } = getPanBounds();

    edgeSwipeDelta = 0;

    if (desiredX > maxX) {
      edgeSwipeDelta = desiredX - maxX;
      panX = maxX + edgeSwipeDelta * 0.22;
    } else if (desiredX < -maxX) {
      edgeSwipeDelta = desiredX + maxX;
      panX = -maxX + edgeSwipeDelta * 0.22;
    } else {
      panX = desiredX;
    }

    panY = Math.max(-maxY, Math.min(maxY, desiredY));

    // 边缘继续拖动时保留一点橡皮筋反馈，松手后决定是否切图。
    applyZoom({ clamp: false });
  }
}, { passive: false });

viewer.addEventListener("touchend", event => {
  const img = document.getElementById("viewerImage");

  // 如果从双指变成单指，立即把剩下的手指接成拖动。
  if (event.touches.length === 1 && zoomScale > 1.001) {
    const t = event.touches[0];
    isTouchPanning = true;
    panStartX = t.clientX;
    panStartY = t.clientY;
    panStartOffsetX = panX;
    panStartOffsetY = panY;
    touchStartDistance = 0;
    return;
  }

  if (event.touches.length === 0) {
    img.classList.remove("dragging");
    img.style.transition = "transform .14s ease-out";

    const wasPanning = isTouchPanning;
    isTouchPanning = false;
    touchStartDistance = 0;

    if (zoomScale <= 1.001) {
      zoomScale = 1;
      panX = 0;
      panY = 0;
      applyZoom();
      scheduleHQRender(40);

      // 只有未放大状态才把单指横滑解释为上一张/下一张。
      if (!wasPanning && event.changedTouches.length === 1) {
        const dx =
          event.changedTouches[0].clientX -
          touchStartX;

        const dy =
          event.changedTouches[0].clientY -
          touchStartY;

        if (
          Math.abs(dx) > 55 &&
          Math.abs(dx) > Math.abs(dy) * 1.2
        ) {
          if (dx < 0) showNext();
          else showPrev();
        }
      }
    } else {
      const swipe = edgeSwipeDelta;
      edgeSwipeDelta = 0;

      if (swipe > 75) {
        showPrev();
      } else if (swipe < -75) {
        showNext();
      } else {
        clampPan();
        applyZoom({ animate: true });
      }
    }
  }
}, { passive: true });

viewer.addEventListener("touchcancel", () => {
  isTouchPanning = false;
  touchStartDistance = 0;
  viewerImage.classList.remove("dragging");
  clampPan();
  applyZoom({ animate: true });
}, { passive: true });

/*
 * 双击/双击触摸：从点击的位置放大，而不是从中心放大。
 */
let lastTap = 0;
let lastTapX = 0;
let lastTapY = 0;

viewer.addEventListener("click", event => {
  if (event.target !== document.getElementById("viewerImage")) return;

  const now = Date.now();

  if (
    now - lastTap < 320 &&
    Math.hypot(
      event.clientX - lastTapX,
      event.clientY - lastTapY
    ) < 60
  ) {
    toggleZoomAt(
      event.clientX,
      event.clientY
    );
    lastTap = 0;
    return;
  }

  lastTap = now;
  lastTapX = event.clientX;
  lastTapY = event.clientY;
});

/*
 * 电脑：滚轮以鼠标位置为中心缩放。
 */
viewer.addEventListener("wheel", event => {
  if (!document.getElementById("viewer").classList.contains("open")) return;

  event.preventDefault();

  const factor =
    Math.exp(-event.deltaY * 0.0015);

  zoomAt(
    event.clientX,
    event.clientY,
    zoomScale * factor
  );
}, { passive: false });

/*
 * 电脑：放大后按住图片任意拖动。
 */
viewerImage.addEventListener("mousedown", event => {
  if (event.button !== 0 || zoomScale <= 1.001) return;
  hideHQRender();

  event.preventDefault();

  mouseDragging = true;
  mouseStartX = event.clientX;
  mouseStartY = event.clientY;
  mouseStartPanX = panX;
  mouseStartPanY = panY;

  viewerImage.classList.add("dragging");
});

window.addEventListener("mousemove", event => {
  if (!mouseDragging) return;

  panX =
    mouseStartPanX +
    (event.clientX - mouseStartX);

  panY =
    mouseStartPanY +
    (event.clientY - mouseStartY);

  applyZoom();
});

window.addEventListener("mouseup", () => {
  if (!mouseDragging) return;

  mouseDragging = false;
  viewerImage.classList.remove("dragging");

  clampPan();
  applyZoom({ animate: true });
  scheduleHQRender(120);
});

window.addEventListener("resize", () => {
  if (
    document.getElementById("viewer")
      .classList.contains("open")
  ) {
    clampPan();
    applyZoom();
    scheduleHQRender(120);
  }
});

viewer.addEventListener("pointermove", showViewerUi, { passive: true });
viewer.addEventListener("pointerdown", showViewerUi, { passive: true });
viewer.addEventListener("touchstart", showViewerUi, { passive: true });
viewer.addEventListener("wheel", showViewerUi, { passive: true });

document.addEventListener("keydown", event => {
  if (!document.getElementById("viewer").classList.contains("open")) return;

  showViewerUi();
  const center = getImageStageCenter();

  if (event.key === "Escape") {
    closeViewer();
  } else if (
    event.key === "ArrowLeft" &&
    zoomScale <= 1.001
  ) {
    showPrev();
  } else if (
    event.key === "ArrowRight" &&
    zoomScale <= 1.001
  ) {
    showNext();
  } else if (
    event.key === "+" ||
    event.key === "="
  ) {
    zoomAt(
      center.x,
      center.y,
      zoomScale * 1.35,
      { animate: true }
    );
  } else if (
    event.key === "-" ||
    event.key === "_"
  ) {
    zoomAt(
      center.x,
      center.y,
      zoomScale / 1.35,
      { animate: true }
    );
  } else if (event.key === "0") {
    resetZoom({ animate: true });
  }
});

window.addEventListener("load", async () => {
  try {
    await initServiceWorker();
    const state = parseDriveState();
    if (!state) { setStatus("等待 Google Drive"); document.getElementById("welcomeText").innerHTML = "请回到 Google Drive，单选文件夹内任意一张图片后使用<br>打开方式 → Drive Original Player。"; return; }
    driveIds = state.ids; resourceKeys = state.resourceKeys || {};
    setStatus("正在授权"); currentAccessToken = await getBridgeAccessToken();
    if (!currentAccessToken) { setStatus("需要首次授权"); document.getElementById("welcomeText").textContent = "当前浏览器还没有长期授权。"; document.getElementById("authBtn").style.display = "inline-block"; return; }
    await sendTokenToWorker(currentAccessToken);
    setStatus("正在定位 " + GALLERY_ROOT_FOLDER_NAME);

    const openedFile =
      await fetchFileMetadata(
        driveIds[0]
      );

    if (!isImageFile(openedFile)) {
      throw new Error(
        "从 Google Drive 打开的文件不是图片。"
      );
    }

    try {
      galleryRootFolder =
        await findGalleryRootFolder(
          openedFile
        );

      if (galleryRootFolder) {
        setStatus(
          "正在读取 " +
          (galleryRootFolder.name ||
            GALLERY_ROOT_FOLDER_NAME) +
          " 文件树"
        );

        galleryTreeRoot =
          await buildGalleryFolderTree(
            galleryRootFolder
          );

        galleryFiles =
          flattenImagesFromTree(
            galleryTreeRoot
          );
      } else {
        galleryTreeRoot = null;
        galleryFiles = [openedFile];
      }
    } catch (treeError) {
      console.warn(
        "读取递归图片文件树失败，退回单图片模式：",
        treeError
      );

      galleryTreeRoot = null;
      galleryRootFolder = null;
      galleryFiles = [openedFile];
    }

    if (
      !galleryFiles.some(
        file => file.id === openedFile.id
      )
    ) {
      openedFile._galleryIndex = 0;
      openedFile._folderPath =
        galleryRootFolder
          ? galleryRootFolder.name
          : "";

      galleryFiles.unshift(
        openedFile
      );

      galleryFiles.forEach(
        (file, index) =>
          file._galleryIndex = index
      );
    }

    currentIndex =
      Math.max(
        0,
        galleryFiles.findIndex(
          file =>
            file.id === openedFile.id
        )
      );

    /*
     * 初始只展开目标图片所在路径。
     * 其它包含图片的文件夹仍会显示，但保持折叠。
     * 完全没有图片的文件夹不会显示。
     */
    if (galleryTreeRoot) {
      expandOnlyPathToImage(
        galleryTreeRoot,
        openedFile.id
      );
    }

    renderGallery();
    startGalleryBackgroundSlideshow();

    requestAnimationFrame(() => {
      const activeCard =
        document.querySelector(
          '.card[data-index="' +
          currentIndex +
          '"]'
        );

      if (activeCard) {
        activeCard.scrollIntoView({
          block: "center"
        });
      }
    });

    setStatus(
      "Original · " +
      (
        galleryRootFolder
          ? galleryRootFolder.name
          : "图片"
      ) +
      " · " +
      galleryFiles.length +
      " 张"
    );
  } catch (error) { console.error(error); setStatus("读取失败"); showError(error.message || String(error)); }
});

setInterval(refreshWorkerAccessToken, 30 * 60 * 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshWorkerAccessToken(); });
window.addEventListener("focus", refreshWorkerAccessToken);

/*
 * 从浏览器后退/前进缓存恢复时，重新建立页面和 Drive 目录读取流程。
 * 这样在视频页与图片页之间来回切换，不会复用旧页面的扫描结果。
 */
window.addEventListener("pageshow", event => {
  if (event.persisted) {
    window.location.reload();
  }
});

