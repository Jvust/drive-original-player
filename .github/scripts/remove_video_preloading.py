from pathlib import Path
import re


def replace_between(text: str, start: str, end: str, replacement: str, label: str) -> str:
    a = text.find(start)
    if a < 0:
        raise SystemExit(f"{label}: start marker not found")
    b = text.find(end, a + len(start))
    if b < 0:
        raise SystemExit(f"{label}: end marker not found")
    return text[:a] + replacement + text[b:]


index_path = Path("index.html")
text = index_path.read_text(encoding="utf-8")

# 1) Remove the hidden dual-player / hot-switch visual layer.
text = replace_between(
    text,
    "    /*\n     * 双播放器热备：\n",
    "    #videoStage {\n",
    "",
    "hot standby css",
)

# Remove the hidden preload video element entirely.
text, count = re.subn(
    r'\n\s*<video\n\s*id="preloadPlayer"[\s\S]*?</video>\n',
    "\n",
    text,
    count=1,
)
if count != 1:
    raise SystemExit("preloadPlayer element not found exactly once")

# The active video itself should not preload before the user asks it to play.
text = text.replace('preload="auto"', 'preload="none"')

# 2) Remove the early adjacent-prime scheduler; keep an inert compatibility hook.
text = replace_between(
    text,
    "  function getForwardPrimeSignature() {\n",
    "  async function discoverCurrentFolderVideosEarly(\n",
    "  // 视频预加载已移除：目录发现不再触发后台媒体请求。\n"
    "  function maybeScheduleAdjacentPrime() {}\n\n",
    "early adjacent prime",
)

# 3) Remove all actual hot-standby / prefix-prime / hover-prefetch / seek-prime logic.
# Keep tiny no-op hooks so any stale event path cannot trigger network preloading.
no_preload_hooks = '''  /*\n   * 视频预加载已移除。\n   * 这些 no-op 仅用于兼容旧调用路径，不创建隐藏播放器、不发 PRIME 请求。\n   */\n  function resetHotStandbyState() {}\n  async function prepareHotStandby() { return false; }\n  function isHotStandbyUsable() { return false; }\n  async function promoteHotStandby() { return false; }\n  function scheduleAdjacentVideoPrime() {}\n  async function primeAdjacentVideos() {}\n  function scheduleHoveredItemHotStandby() {}\n  function cancelHoveredItemHotStandby() {}\n  function prefetchPlaylistItemOnHover() {}\n  function resetSeekScrubPrefetchState() {}\n  function scheduleSeekScrubPrefetch() {}\n\n'''
text = replace_between(
    text,
    "  function resetHotStandbyState(\n",
    "  function renderVideoPlaylist() {\n",
    no_preload_hooks,
    "preload runtime section",
)

# 4) Playlist items no longer warm media on hover / touch.
text = replace_between(
    text,
    "    /*\n     * 列表任意视频的主动预热：\n",
    "    return button;\n",
    "",
    "playlist hover preloading",
)

# 5) Replace video switching with a pure on-demand path.
clean_switch = '''  async function switchVideoByIndex(index, autoplay = true) {\n    const file = videoPlaylist[index];\n    if (!file) return;\n\n    const generation =\n      ++switchGeneration;\n\n    /* 切换视频时仅停止旧的 Seek Rescue；不启动任何下一条预加载。 */\n    destroySeekRescue();\n\n    currentVideoIndex = index;\n    currentFileId = file.id;\n    currentResourceKey = file.resourceKey || null;\n    currentFileSize = Number(file.size);\n\n    ensureVideoPathExpanded(\n      videoTreeRoot,\n      file.id\n    );\n\n    updateVideoInfo(file);\n\n    if (videoPlaylistDomReady) {\n      syncVideoPlaylistDomState();\n    }\n\n    if (file.capabilities && file.capabilities.canDownload === false) {\n      showError("这个 Google Drive 文件禁止下载，因此无法播放原文件。");\n      return;\n    }\n\n    await sendCurrentVideoStateToWorker(file);\n\n    if (generation !== switchGeneration) {\n      return;\n    }\n\n    const mediaUrl =\n      getVideoMediaUrl(file);\n\n    const player =\n      document.getElementById("player");\n\n    if (!player) {\n      return;\n    }\n\n    if (sharpenMode === 0 && gpuActive) {\n      disableWebGPUEnhancement(\n        false,\n        true\n      );\n    }\n\n    if (file.thumbnailLink) {\n      player.poster = file.thumbnailLink;\n    } else {\n      player.removeAttribute("poster");\n    }\n\n    /*\n     * 纯按需加载：只有切换动作真正发生后才设置 src / load。\n     */\n    player.src = mediaUrl;\n    player.load();\n    applySharpenMode();\n\n    setStatus(\n      sharpenMode === 0\n        ? "Original · 流畅模式（按需加载）"\n        : (\n            gpuActive\n              ? "Original · WebGPU 高质量渲染 · 按需加载"\n              : "Original · 准备高质量渲染 · 按需加载"\n          )\n    );\n\n    if (autoplay) {\n      try {\n        const playPromise =\n          player.play();\n\n        playPromise?.catch?.(\n          error => {\n            console.log(\n              "等待用户点击播放：",\n              error\n            );\n          }\n        );\n      } catch (error) {\n        console.log(\n          "等待用户点击播放：",\n          error\n        );\n      }\n    }\n\n    showWatchUi();\n  }\n\n'''
text = replace_between(
    text,
    "  async function switchVideoByIndex(index, autoplay = true) {\n",
    "  function startGpuHealthMonitor() {\n",
    clean_switch,
    "on-demand switchVideoByIndex",
)

# 6) Bind events only to the active player; there is no standby player anymore.
clean_init = '''  function initVideoPlayerEventsOnce() {\n    if (videoPlayerEventsReady) {\n      return;\n    }\n\n    videoPlayerEventsReady = true;\n\n    const player =\n      document.getElementById("player");\n\n    initGpuMediaControls();\n    initFullscreenAutoHide();\n    startGpuHealthMonitor();\n    bindVideoPlayerEvents(player);\n  }\n\n\n'''
text = replace_between(
    text,
    "  function initVideoPlayerEventsOnce() {\n",
    "  /*\n   * ================================================================\n   * Seek Rescue V2",
    clean_init,
    "active-player event init",
)

# Remove the remaining explicit scheduler call in loadeddata and any simple stale call sites.
text = re.sub(r'^\s*scheduleAdjacentVideoPrime\(\);\s*\n', '', text, flags=re.M)
text = re.sub(r'^\s*maybeScheduleAdjacentPrime\(\s*(?:true)?\s*\);\s*\n', '', text, flags=re.M)
text = re.sub(r'^\s*resetSeekScrubPrefetchState\(\);\s*\n', '', text, flags=re.M)

# Native seeking must go straight to normal Range / Seek Rescue, with no byte-position prefetch.
seek_prefetch_block = r'''\n\s*/\*\n\s*\* 原生 <video controls> 拖动没有 gpuSeek 的 input 事件，\n\s*\* 用 seeking 事件补一层启发式位置预热。\n\s*\*/\n\s*if \([\s\S]*?scheduleSeekScrubPrefetch\([\s\S]*?\n\s*\}\n'''
text, _ = re.subn(seek_prefetch_block, '\n', text, count=1)

# Also strip simple GPU seek prefetch calls if present elsewhere.
text = re.sub(
    r'\n[ \t]*scheduleSeekScrubPrefetch\([\s\S]{0,300}?\n[ \t]*\);',
    '',
    text,
)

# Mark dormant diagnostic states as disabled rather than "waiting".
text = text.replace('let videoPrefixPrimeState = "待命";', 'let videoPrefixPrimeState = "已移除";')
text = text.replace('let seekScrubPrimeState = "待命";', 'let seekScrubPrimeState = "已移除";')

index_path.write_text(text, encoding="utf-8")

# 7) Service Worker: explicitly reject every old PRIME request.
sw_path = Path("sw.js")
sw = sw_path.read_text(encoding="utf-8")
anchor = '''  if (\n    data.type === "SET_TOKEN" &&\n'''
guard = '''  /*\n   * 视频预加载已移除。旧标签页即使仍发送 PRIME 消息，\n   * 新 Service Worker 也直接拒绝，不产生任何 Drive 预读请求。\n   */\n  if (\n    data.type === "PRIME_MEDIA" ||\n    data.type === "PRIME_SEEK"\n  ) {\n    reply({ ok: false, disabled: true });\n    return;\n  }\n\n'''
if guard not in sw:
    if anchor not in sw:
        raise SystemExit("service worker SET_TOKEN anchor not found")
    sw = sw.replace(anchor, guard + anchor, 1)

sw_path.write_text(sw, encoding="utf-8")
