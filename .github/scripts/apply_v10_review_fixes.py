from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if old not in text:
        raise SystemExit(f"{label}: anchor not found")
    return text.replace(old, new, 1)


index_path = Path("index.html")
text = index_path.read_text(encoding="utf-8")

old = '''    while (queue.length) {
      const player =
        document.getElementById(
          "player"
        );

      const playing =
        !!(
          player &&
          !player.paused &&
          !player.ended
        );

      const concurrency =
        playing ? 2 : 4;
'''
new = '''    const isMediaSensitiveForTreeScan =
      player =>
        !!(
          player &&
          (
            player.seeking ||
            seekRescueActivation ||
            seekRescueSession ||
            (
              player.currentSrc &&
              player.readyState < 3
            ) ||
            (
              !player.paused &&
              getBufferedAhead(player) < 4
            )
          )
        );

    while (queue.length) {
      const player =
        document.getElementById(
          "player"
        );

      const playing =
        !!(
          player &&
          !player.paused &&
          !player.ended
        );

      const mediaSensitive =
        isMediaSensitiveForTreeScan(
          player
        );

      const concurrency =
        (
          playing ||
          mediaSensitive
        )
          ? 2
          : 4;
'''
text = replace_once(text, old, new, "tree concurrency")

old = '''      const mediaBusy =
        !!(
          activePlayer &&
          !activePlayer.paused &&
          (
            activePlayer.seeking ||
            seekRescueActivation ||
            seekRescueSession ||
            activePlayer.readyState < 3 ||
            getBufferedAhead(
              activePlayer
            ) < 4
          )
        );
'''
new = '''      const mediaBusy =
        isMediaSensitiveForTreeScan(
          activePlayer
        );
'''
text = replace_once(text, old, new, "tree yield")
index_path.write_text(text, encoding="utf-8")

sw_path = Path("sw.js")
sw = sw_path.read_text(encoding="utf-8")
anchor = '''async function primeMediaFile({
'''
helper = '''function canUsePrimeFetchResponse(
  response,
  requestedStart,
  requestedEnd,
  fileSize
) {
  if (response.status === 206) {
    return true;
  }

  /*
   * PRIME 必须保持为有界的小范围读取。
   * 若上游忽略 Range 返回 200，只有请求窗口本来就是整个小文件时
   * 才允许 arrayBuffer；否则立即丢弃响应，避免把大文件读入 SW 内存。
   */
  return !!(
    response.status === 200 &&
    requestedStart === 0 &&
    requestedEnd === fileSize - 1
  );
}

async function discardPrimeResponse(response) {
  try {
    await response.body?.cancel();
  } catch (_) {}
}

'''
if helper not in sw:
    if anchor not in sw:
        raise SystemExit("prime helper: anchor not found")
    sw = sw.replace(anchor, helper + anchor, 1)

old = '''    if (
      response.status !== 206 &&
      !response.ok
    ) {
      return false;
    }

    const buffer =
      await response.arrayBuffer();
'''
new_media = '''    if (
      !canUsePrimeFetchResponse(
        response,
        0,
        end,
        fileSize
      )
    ) {
      await discardPrimeResponse(
        response
      );
      return false;
    }

    const buffer =
      await response.arrayBuffer();
'''
sw = replace_once(sw, old, new_media, "media prime guard")

new_seek = '''    if (
      !canUsePrimeFetchResponse(
        response,
        alignedStart,
        end,
        fileSize
      )
    ) {
      await discardPrimeResponse(
        response
      );
      return false;
    }

    const buffer =
      await response.arrayBuffer();
'''
sw = replace_once(sw, old, new_seek, "seek prime guard")
sw_path.write_text(sw, encoding="utf-8")
