from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"{label}: anchor not found")
    return text.replace(old, new, 1)


def remove_between(text: str, start: str, end: str, label: str) -> str:
    a = text.find(start)
    if a < 0:
        raise SystemExit(f"{label}: start marker not found")
    b = text.find(end, a + len(start))
    if b < 0:
        raise SystemExit(f"{label}: end marker not found")
    return text[:a] + text[b:]


index_path = Path("index.html")
text = index_path.read_text(encoding="utf-8")

# ------------------------------------------------------------------
# 1) Remove the decorative Drive-image background feature completely.
# ------------------------------------------------------------------
text = remove_between(
    text,
    "    #backgroundShowcase {\n",
    "    video {\n",
    "background showcase css",
)

text = remove_between(
    text,
    "    /* ============================================================\n     * Sharp Background Slideshow · 5 s\n",
    "</style>",
    "background slideshow css",
)

text = replace_once(
    text,
    '  <div id="pageBgSlideA" class="page-bg-slide is-visible" aria-hidden="true"></div>\n'
    '  <div id="pageBgSlideB" class="page-bg-slide" aria-hidden="true"></div>\n'
    '  <div class="page-bg-dim" aria-hidden="true"></div>\n\n',
    "",
    "background body layers",
)

text = remove_between(
    text,
    '  <section id="backgroundShowcase" aria-label="背景展示区">\n',
    "</main>",
    "background showcase html",
)

text = remove_between(
    text,
    "  // 背景直接来自 1433223 递归目录中的图片，不再打包静态壁纸。\n",
    "  let videoPlayerEventsReady = false;\n",
    "background state variables",
)

text = text.replace(
    "  let driveBackgroundSlideshowStarted = false;\n",
    "",
    1,
)

text = replace_once(
    text,
    '''      for (const file of data.files || []) {
        if (isImageFile(file)) {
          backgroundImageFiles.push(file);
          continue;
        }

        if (isDriveFolder(file) || isVideoFile(file)) {
''',
    '''      for (const file of data.files || []) {
        if (isDriveFolder(file) || isVideoFile(file)) {
''',
    "stop collecting background images",
)

text = remove_between(
    text,
    '''    /*
     * 找到第一批图片后即可启动背景轮播。
''',
    '''    if (
      !finished
    ) {
''',
    "background scan startup",
)

text = text.replace(
    '''    backgroundImageFiles =
      [];

    driveBackgroundSlideshowStarted =
      false;

''',
    "",
    1,
)

text = text.replace(
    "  syncDriveBackgroundPauseState();\n",
    "",
    1,
)

text = remove_between(
    text,
    "  function shuffleBackgroundFiles(files) {\n",
    "  function renderVideoPlaylist() {\n",
    "background runtime functions",
)

text = text.replace(
    '''      document.body.classList.add(
        "media-ready"
      );

''',
    "",
    1,
)

# ------------------------------------------------------------------
# 2) V11 instant-switch: prioritize +1 and require real start buffer.
# ------------------------------------------------------------------
text = replace_once(
    text,
    '''  let hotStandbyPrerollTime = 0;
  let lastHotSwitchUsed = false;
''',
    '''  let hotStandbyPrerollTime = 0;
  let lastHotSwitchUsed = false;

  /*
   * V11 · Instant Start Hot Standby
   *
   * V9/V10 already decoded a real first frame. V11 goes one step further:
   * the +1 video is not considered "instant-ready" until its first frame
   * AND a short contiguous start buffer are both resident.
   */
  const HOT_STANDBY_PREFIX_SECONDS = 4.0;
  const HOT_STANDBY_TARGET_BUFFER_SECONDS = 2.0;
  const HOT_STANDBY_MIN_BUFFER_SECONDS = 0.8;
  const HOT_STANDBY_CLICK_WAIT_MS = 450;
  let hotStandbyBufferedSeconds = 0;
  let hoverHotStandbyTimer = null;
''',
    "V11 hot standby constants",
)

text = replace_once(
    text,
    '''    hotStandbyDecodedFrame = false;
    hotStandbyPrerollTime = 0;

    if (hotStandbyRetryTimer) {
''',
    '''    hotStandbyDecodedFrame = false;
    hotStandbyPrerollTime = 0;
    hotStandbyBufferedSeconds = 0;

    if (hoverHotStandbyTimer) {
      clearTimeout(
        hoverHotStandbyTimer
      );
      hoverHotStandbyTimer = null;
    }

    if (hotStandbyRetryTimer) {
''',
    "reset hot standby buffer",
)

text = replace_once(
    text,
    '''     * 不让热备抢一个本来就快断流的当前视频。
     * 4 秒以上前向缓冲即可启动下一条预热。
''',
    '''     * +1 是秒切关键路径：只要当前视频已有约 1 秒前向缓冲
     * 就尽早启动热备；+2/+3 仍使用更保守的片头预读门槛。
''',
    "hot preload comment",
)

text = replace_once(
    text,
    "        getBufferedAhead(player) < 2\n",
    "        getBufferedAhead(player) < 1\n",
    "hot preload threshold",
)

text = replace_once(
    text,
    '''  function scheduleHotStandbyRetryByFileId(
    fileId,
    delay = 800
''',
    '''  function scheduleHotStandbyRetryByFileId(
    fileId,
    delay = 350
''',
    "hot retry default",
)

text = text.replace(
    '''      scheduleHotStandbyRetryByFileId(
        file.id,
        700
      );
''',
    '''      scheduleHotStandbyRetryByFileId(
        file.id,
        350
      );
''',
    1,
)

wait_helpers = r'''
  function getBufferedStartSeconds(video) {
    if (!video) {
      return 0;
    }

    try {
      for (
        let i = 0;
        i < video.buffered.length;
        i++
      ) {
        const start =
          video.buffered.start(i);
        const end =
          video.buffered.end(i);

        /*
         * 起播缓存必须覆盖片头，而不是只在某个后续时间点有数据。
         */
        if (start <= 0.15) {
          return Math.max(
            0,
            end
          );
        }
      }
    } catch (_) {}

    return 0;
  }

  async function waitForHotStandbyStartBuffer(
    video,
    generation,
    fileId,
    targetSeconds =
      HOT_STANDBY_TARGET_BUFFER_SECONDS,
    timeout = 5500
  ) {
    const started =
      performance.now();

    let best =
      getBufferedStartSeconds(
        video
      );

    while (
      performance.now() -
        started <
        timeout
    ) {
      if (
        generation !==
          hotStandbyGeneration ||
        hotStandbyFileId !==
          fileId
      ) {
        return 0;
      }

      best = Math.max(
        best,
        getBufferedStartSeconds(
          video
        )
      );

      if (
        best >=
          targetSeconds
      ) {
        return best;
      }

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            70
          )
      );
    }

    return best;
  }

  async function waitForHotStandbyUsable(
    index,
    timeout =
      HOT_STANDBY_CLICK_WAIT_MS
  ) {
    const file =
      videoPlaylist[index];

    if (!file?.id) {
      return false;
    }

    const started =
      performance.now();

    while (
      performance.now() -
        started <
        timeout
    ) {
      if (
        isHotStandbyUsable(
          index
        )
      ) {
        return true;
      }

      if (
        hotStandbyFileId !==
          file.id ||
        !hotStandbyLoading
      ) {
        break;
      }

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            30
          )
      );
    }

    return isHotStandbyUsable(
      index
    );
  }

'''

anchor = "  async function prerollHotStandbyFirstFrame(\n"
if wait_helpers.strip() not in text:
    if anchor not in text:
        raise SystemExit("hot standby helper anchor not found")
    text = text.replace(anchor, wait_helpers + anchor, 1)

text = replace_once(
    text,
    '''    const decoded =
      await waitForVideoFrame(
        standby,
        3500
      );

    try {
      standby.pause();
''',
    '''    const decoded =
      await waitForVideoFrame(
        standby,
        3500
      );

    /*
     * 首帧出现后继续保持静音 preroll，直到片头已有约 2 秒连续缓冲。
     * 这样热切后不只是“立刻看到画面”，而是能立刻继续运动。
     */
    hotStandbyBufferedSeconds =
      await waitForHotStandbyStartBuffer(
        standby,
        generation,
        fileId
      );

    try {
      standby.pause();
''',
    "hot standby start buffer wait",
)

text = replace_once(
    text,
    '''    return !!(
      decoded &&
      standby.readyState >=
        HTMLMediaElement
          .HAVE_CURRENT_DATA
    );
''',
    '''    return !!(
      decoded &&
      standby.readyState >=
        HTMLMediaElement
          .HAVE_CURRENT_DATA &&
      (
        hotStandbyBufferedSeconds >=
          HOT_STANDBY_MIN_BUFFER_SECONDS ||
        standby.readyState >=
          HTMLMediaElement
            .HAVE_FUTURE_DATA
      )
    );
''',
    "hot standby readiness rule",
)

text = replace_once(
    text,
    '''    hotStandbyReady =
      false;

    hotStandbyLoading =
      true;
''',
    '''    hotStandbyReady =
      false;

    hotStandbyBufferedSeconds =
      0;

    hotStandbyLoading =
      true;
''',
    "reset buffer before prepare",
)

text = replace_once(
    text,
    '''      if (file.thumbnailLink) {
        standby.poster =
          file.thumbnailLink;
      } else {
        standby.removeAttribute(
          "poster"
        );
      }
''',
    '''      /*
       * 热备槽位已经会解码真实首帧，不再额外请求 Drive poster，
       * 避免无意义的缩略图网络竞争。
       */
      standby.removeAttribute(
        "poster"
      );
''',
    "remove standby poster fetch",
)

text = replace_once(
    text,
    '''          "下一条已热备：",
          file.name,
          "readyState=",
          standby.readyState
''',
    '''          "下一条已热备：",
          file.name,
          "readyState=",
          standby.readyState,
          "startBuffer=",
          hotStandbyBufferedSeconds.toFixed(2)
''',
    "hot standby debug buffer",
)

text = replace_once(
    text,
    '''      hotStandbyDecodedFrame &&
      hotStandbyFileId ===
''',
    '''      hotStandbyDecodedFrame &&
      (
        hotStandbyBufferedSeconds >=
          HOT_STANDBY_MIN_BUFFER_SECONDS ||
        standby.readyState >=
          HTMLMediaElement
            .HAVE_FUTURE_DATA
      ) &&
      hotStandbyFileId ===
''',
    "hot standby usable buffer check",
)

text = replace_once(
    text,
    '''    hotStandbyFileId =
      null;

    lastHotSwitchUsed =
''',
    '''    hotStandbyFileId =
      null;

    hotStandbyBufferedSeconds =
      0;

    lastHotSwitchUsed =
''',
    "clear buffer after promotion",
)

text = replace_once(
    text,
    '''    setTimeout(
      scheduleAdjacentVideoPrime,
      350
    );
''',
    '''    setTimeout(
      scheduleAdjacentVideoPrime,
      80
    );
''',
    "re-prime immediately after hot switch",
)

text = replace_once(
    text,
    '''      await primeVideoPrefix(
        worker,
        target.file,
        VIDEO_PREFIX_PRELOAD_SECONDS
      );
''',
    '''      await primeVideoPrefix(
        worker,
        target.file,
        target.offset === 1
          ? HOT_STANDBY_PREFIX_SECONDS
          : VIDEO_PREFIX_PRELOAD_SECONDS
      );
''',
    "prioritize +1 prefix length",
)

text = replace_once(
    text,
    '''      if (
        target.offset === 1
      ) {
        prepareHotStandby(
          target.index
        );
      }
''',
    '''      if (
        target.offset === 1
      ) {
        /*
         * V11: +1 真热备是最高优先级。
         * 等首帧 + 起播缓冲真正就绪以后，再花带宽预读 +2/+3。
         */
        await prepareHotStandby(
          target.index
        );

        if (
          generation !==
            videoPrefixPrimeGeneration
        ) {
          return;
        }
      }
''',
    "await +1 hot preparation",
)

text = replace_once(
    text,
    '''        },
        90
      );
  }

  async function discoverCurrentFolderVideosEarly(
''',
    '''        },
        40
      );
  }

  async function discoverCurrentFolderVideosEarly(
''',
    "adjacent discovery debounce",
)

text = replace_once(
    text,
    '''        },
        180
      );
  }

  async function primeAdjacentVideos() {
''',
    '''        },
        60
      );
  }

  async function primeAdjacentVideos() {
''',
    "adjacent prime schedule",
)

text = replace_once(
    text,
    '''      const concurrency =
        (
          playing ||
          mediaSensitive
        )
          ? 2
          : 4;
''',
    '''      const hotPreloadBusy =
        hotStandbyLoading &&
        !hotStandbyReady;

      const concurrency =
        hotPreloadBusy
          ? 1
          : (
              (
                playing ||
                mediaSensitive
              )
                ? 2
                : 4
            );
''',
    "tree scan prioritizes hot standby",
)

text = replace_once(
    text,
    '''            mediaBusy ? 650 : 20
''',
    '''            (
              hotStandbyLoading &&
              !hotStandbyReady
            )
              ? 850
              : (
                  mediaBusy
                    ? 650
                    : 20
                )
''',
    "tree scan yield during hot standby",
)

text = replace_once(
    text,
    '''    /*
     * 如果目标就是已经 canplay 的隐藏热备 video，
     * 直接 DOM 槽位互换，不重新建立网络/解码链。
     */
    if (
      index !== currentVideoIndex &&
      isHotStandbyUsable(index)
    ) {
''',
    '''    /*
     * 如果用户正好在热备即将完成时点击，最多等约 450ms。
     * 这比立刻丢掉已经进行到一半的解码链再从头加载更快。
     */
    if (
      index !== currentVideoIndex &&
      hotStandbyFileId === file.id &&
      hotStandbyLoading &&
      !hotStandbyReady
    ) {
      await waitForHotStandbyUsable(
        index
      );
    }

    /*
     * 目标已经具备真实首帧 + 起播缓冲时，直接 DOM 槽位互换。
     */
    if (
      index !== currentVideoIndex &&
      isHotStandbyUsable(index)
    ) {
''',
    "bounded wait for nearly ready hot target",
)

hover_helper = r'''
  function scheduleHoveredItemHotStandby(
    index,
    file
  ) {
    if (
      !file?.id ||
      index === currentVideoIndex ||
      !currentVideoStableEnoughForHotPreload()
    ) {
      return;
    }

    if (hoverHotStandbyTimer) {
      clearTimeout(
        hoverHotStandbyTimer
      );
    }

    hoverHotStandbyTimer =
      setTimeout(
        () => {
          hoverHotStandbyTimer =
            null;

          if (
            file.id !==
              currentFileId
          ) {
            prepareHotStandby(
              index
            );
          }
        },
        160
      );
  }

  function cancelHoveredItemHotStandby() {
    if (!hoverHotStandbyTimer) {
      return;
    }

    clearTimeout(
      hoverHotStandbyTimer
    );
    hoverHotStandbyTimer = null;
  }

'''

hover_anchor = "  function prefetchPlaylistItemOnHover(file) {\n"
if hover_helper.strip() not in text:
    if hover_anchor not in text:
        raise SystemExit("hover helper anchor not found")
    text = text.replace(hover_anchor, hover_helper + hover_anchor, 1)

text = replace_once(
    text,
    '''          prefetchPlaylistItemOnHover(
            file
          );
''',
    '''          prefetchPlaylistItemOnHover(
            file
          );

          scheduleHoveredItemHotStandby(
            index,
            file
          );
''',
    "desktop hover gets real hot standby",
)

pointerdown_anchor = '''    button.addEventListener(
      "pointerdown",
'''
if pointerdown_anchor not in text:
    raise SystemExit("pointerdown anchor not found")
text = text.replace(
    pointerdown_anchor,
    '''    button.addEventListener(
      "pointerleave",
      cancelHoveredItemHotStandby,
      { passive: true }
    );

''' + pointerdown_anchor,
    1,
)

text = replace_once(
    text,
    '''          prefetchPlaylistItemOnHover(
            file
          );
        }
''',
    '''          prefetchPlaylistItemOnHover(
            file
          );

          prepareHotStandby(
            index
          );
        }
''',
    "touch starts hot standby",
)

text = replace_once(
    text,
    '''              "下一条首帧已解码 · " +
              formatSeconds(
                hotStandbyPrerollTime
              ) +
              " · 可真实热切"
''',
    '''              "首帧+起播缓冲已就绪 · " +
              hotStandbyBufferedSeconds
                .toFixed(1) +
              "s · 可秒切"
''',
    "hot standby diagnostic",
)

text = replace_once(
    text,
    '''    "预读策略：        后续3条 × 前2.5秒",
''',
    '''    "预读策略：        +1优先4.0秒热备 · +2/+3各2.5秒",
''',
    "prime strategy diagnostic",
)

text = text.replace(
    "当前视频稳定后，preloadPlayer 会提前加载下一条到 canplay。",
    "当前视频稳定后，preloadPlayer 会提前解码下一条首帧并准备起播缓冲。",
    1,
)
text = text.replace(
    "立即启动 +1 真首帧预解码，",
    "立即启动 +1 首帧 + 起播缓冲预热，",
    1,
)

for forbidden in (
    "pageBgSlide",
    "backgroundShowcase",
    "backgroundImageFiles",
    "driveBackgroundSlideshowStarted",
    "startDriveBackgroundSlideshow",
    "syncDriveBackgroundPauseState",
    "showNextDriveBackground",
):
    if forbidden in text:
        raise SystemExit(f"background removal incomplete: {forbidden}")

index_path.write_text(text, encoding="utf-8")

# ------------------------------------------------------------------
# 3) SW: slightly enlarge only the bounded in-memory prefix ceiling.
# ------------------------------------------------------------------
sw_path = Path("sw.js")
sw = sw_path.read_text(encoding="utf-8")

sw = replace_once(
    sw,
    "const PRIME_MAX_BYTES = 8 * 1024 * 1024;\n",
    "const PRIME_MAX_BYTES = 12 * 1024 * 1024;\n",
    "prime max bytes",
)

sw = replace_once(
    sw,
    "const PRIME_MAX_ENTRIES = 6;\n",
    "const PRIME_MAX_ENTRIES = 4;\n",
    "prime cache entries",
)

sw_path.write_text(sw, encoding="utf-8")
