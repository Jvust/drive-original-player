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


# -------------------- index.html --------------------
index_path = Path("index.html")
text = index_path.read_text(encoding="utf-8")

text = text.replace("  let adjacentPrimeTimer = null;\n", "")

# Remove all obsolete preload state, while keeping same-folder discovery state.
replacement = '''  /*\n   * 当前文件夹视频提前发现：只读取目录元数据，不下载任何视频字节。\n   */\n  let provisionalSiblingVideos = [];\n  let earlySiblingDiscoveryRunning = false;\n\n'''
text = replace_between(
    text,
    "  /*\n   * Hot Standby / 双播放器热备\n",
    "  function detectSmoothDevice() {\n",
    replacement,
    "obsolete preload state",
)

text = text.replace(
    "  // 仅用于相邻视频预热的带宽/设备启发式判断，不再控制画质模式。\n",
    "  // 设备类型仅用于播放器交互适配，不参与后台媒体加载。\n",
)

# Remove obsolete preload lines from diagnostics.
text = replace_between(
    text,
    '    "视频热备：        " +\n',
    '    "WebGPU：          " +\n',
    "",
    "preload diagnostics",
)

# Remove no-op compatibility hooks now that all call sites are gone.
text = text.replace(
    "  // 视频预加载已移除：目录发现不再触发后台媒体请求。\n"
    "  function maybeScheduleAdjacentPrime() {}\n\n",
    "",
)

text = replace_between(
    text,
    "  /*\n   * 视频预加载已移除。\n   * 这些 no-op 仅用于兼容旧调用路径，不创建隐藏播放器、不发 PRIME 请求。\n   */\n",
    "  function renderVideoPlaylist() {\n",
    "",
    "preload no-op hooks",
)

# Remove stale comments left from the old hot-standby design.
text = text.replace(
    "      /*\n       * 立即启动 +1 首帧 + 起播缓冲预热，\n       * 不等待 1433223 全树完成。\n       */\n",
    "",
)
text = text.replace(
    "       * 不让下一条热备被不完整的全局快照冲掉。\n",
    "       * 不让当前同目录列表被不完整的全局快照冲掉。\n",
)
text = re.sub(
    r'\n    /\*\n     \* 如果扫描补出了新的 \+1/\+2/\+3，[\s\S]*?\n     \*/\n',
    '\n',
    text,
    count=1,
)
text = re.sub(
    r'\n      /\*\n       \* 扫描完成以后，playlist index 才稳定。[\s\S]*?\n       \*/\n',
    '\n',
    text,
    count=1,
)

# Directory scan no longer yields to a nonexistent hot-preload task.
old = '''      const hotPreloadBusy =\n        hotStandbyLoading &&\n        !hotStandbyReady;\n\n      const concurrency =\n        hotPreloadBusy\n          ? 1\n          : (\n              (\n                playing ||\n                mediaSensitive\n              )\n                ? 2\n                : 4\n            );\n'''
new = '''      const concurrency =\n        (\n          playing ||\n          mediaSensitive\n        )\n          ? 2\n          : 4;\n'''
if old not in text:
    raise SystemExit("tree concurrency hot-preload block not found")
text = text.replace(old, new, 1)

old = '''            (\n              hotStandbyLoading &&\n              !hotStandbyReady\n            )\n              ? 850\n              : (\n                  mediaBusy\n                    ? 650\n                    : 20\n                )\n'''
new = '''            mediaBusy\n              ? 650\n              : 20\n'''
if old not in text:
    raise SystemExit("tree yield hot-preload block not found")
text = text.replace(old, new, 1)

# Remove an empty old seek-preheat comment and an old background comment.
text = text.replace(
    "        /*\n         * 用户尚未松手时先给目标位置做低风险启发式预热。\n         */\n",
    "",
)
text = text.replace(
    "  /*\n   * 视频全屏期间背景停止更换；\n   * 退出全屏后重新从 10 秒开始计时。\n   */\n",
    "",
)

index_path.write_text(text, encoding="utf-8")

# -------------------- sw.js --------------------
sw_path = Path("sw.js")
sw = sw_path.read_text(encoding="utf-8")
sw = sw.replace(
    " * 7. 支持拖动进度条时的启发式 Seek Scrub Prime。\n",
    " * 7. 不做后台媒体预加载；媒体字节只由实际播放 / Seek 请求触发。\n",
)

# Remove all preload constants / sizing logic.
sw = replace_between(
    sw,
    "/*\n * V8 视频片头预加载：\n",
    "// 不再只保存一个 currentFileId。\n",
    "",
    "sw preload constants",
)

# Remove all media-prime / seek-prime cache functions.
sw = replace_between(
    sw,
    "function touchPrimeCache(fileId, entry) {\n",
    'self.addEventListener("install", () => {\n',
    "",
    "sw preload functions",
)

# Keep only SET_TOKEN in the message channel.
clean_message = '''self.addEventListener("message", event => {\n  const data =\n    event.data || {};\n\n  const reply =\n    payload => {\n      try {\n        if (event.ports?.[0]) {\n          event.ports[0]\n            .postMessage(payload);\n        }\n      } catch (_) {}\n    };\n\n  if (\n    data.type === "SET_TOKEN" &&\n    data.fileId &&\n    data.token\n  ) {\n    const fileId =\n      String(data.fileId);\n\n    const state = {\n      accessToken: data.token,\n      fileSize: Number(data.fileSize)\n    };\n\n    const ok =\n      saveFileStateMemory(\n        fileId,\n        state\n      );\n\n    reply({ ok });\n\n    if (ok) {\n      event.waitUntil(\n        persistFileState(\n          fileId,\n          state\n        ).catch(error => {\n          console.error(\n            "SET_TOKEN 持久化失败:",\n            error\n          );\n        })\n      );\n    }\n\n    return;\n  }\n});\n\n'''
sw = replace_between(
    sw,
    'self.addEventListener("message", event => {\n',
    'self.addEventListener("fetch", event => {\n',
    clean_message,
    "sw message handler",
)

# Remove prime-cache interception from the actual media fetch path.
start = '''  if (\n    request.method === "GET" &&\n    parsedRange\n  ) {\n    /*\n     * V8 已经让 getPrimeResponse支持'''
# The exact comment contains a space between function name and Chinese text, so use a regex marker search.
m = re.search(
    r'  if \(\n    request\.method === "GET" &&\n    parsedRange\n  \) \{\n    /\*\n     \* V8 已经让 getPrimeResponse[\s\S]*?\n  try \{\n    const upstream =',
    sw,
)
if not m:
    raise SystemExit("sw prime fetch interception block not found")
sw = sw[:m.start()] + '  try {\n    const upstream =' + sw[m.end():]

sw_path.write_text(sw, encoding="utf-8")
