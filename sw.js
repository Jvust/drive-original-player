/*
 * Drive Original Player · Seek Robust Service Worker
 *
 * 重点：
 * 1. 每个视频分别保存授权/大小，避免批量播放时多个文件请求互相覆盖状态。
 * 2. 所有单段 Range 都限制为较小块，提高拖动进度条后的响应速度。
 * 3. 正确处理 start-end / start- / -suffix 三种 Range。
 * 4. HEAD 返回完整文件长度，而不是错误地返回 1 byte。
 * 5. 把浏览器的 abort signal 传给 Google Drive，拖动后旧请求能尽快停止。
 * 6. SET_TOKEN 先写内存并立即 ACK，Cache Storage 后台持久化。
 * 7. 原生视频由页面 preload=auto 提供首选路径；异常 MP4 由页面的 MSE Rescue 负责暂停态续缓冲。
 */

const MEDIA_PREFIX = "/drive-original-player/media/";
const AUTH_STATE_CACHE = "drive-original-player-auth-v2";
const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB：比旧版 16 MB 更适合 seek

// 不再只保存一个 currentFileId。
// 批量播放/切换视频时，不同文件可以同时存在短暂的请求。
const fileStates = new Map();

function authStateUrl(fileId) {
  return new URL(
    "__auth_state_v2__/" + encodeURIComponent(fileId),
    self.registration.scope
  ).href;
}

function saveFileStateMemory(fileId, state) {
  if (
    !fileId ||
    !state ||
    !state.accessToken
  ) {
    return false;
  }

  fileStates.set(fileId, {
    accessToken:
      state.accessToken,
    fileSize:
      Number(state.fileSize)
  });

  return true;
}

async function persistFileState(fileId, state) {
  try {
    const cache =
      await caches.open(
        AUTH_STATE_CACHE
      );

    await cache.put(
      authStateUrl(fileId),
      new Response(
        JSON.stringify({
          accessToken:
            state.accessToken,
          fileId,
          fileSize:
            Number(state.fileSize)
        }),
        {
          headers: {
            "Content-Type":
              "application/json",
            "Cache-Control":
              "no-store"
          }
        }
      )
    );
  } catch (error) {
    console.error(
      "保存 Drive 播放状态失败:",
      error
    );
  }
}

async function saveFileState(fileId, state) {
  if (
    !saveFileStateMemory(
      fileId,
      state
    )
  ) {
    return false;
  }

  await persistFileState(
    fileId,
    state
  );

  return true;
}

async function getFileState(fileId) {
  const memory = fileStates.get(fileId);

  if (
    memory &&
    memory.accessToken &&
    Number.isFinite(memory.fileSize) &&
    memory.fileSize > 0
  ) {
    return memory;
  }

  try {
    const cache = await caches.open(AUTH_STATE_CACHE);
    const response = await cache.match(authStateUrl(fileId));

    if (!response) return null;

    const data = await response.json();

    if (
      !data.accessToken ||
      data.fileId !== fileId ||
      !Number.isFinite(Number(data.fileSize)) ||
      Number(data.fileSize) <= 0
    ) {
      return null;
    }

    const restored = {
      accessToken: data.accessToken,
      fileSize: Number(data.fileSize)
    };

    fileStates.set(fileId, restored);
    return restored;
  } catch (error) {
    console.error("恢复 Drive 播放状态失败:", error);
    return null;
  }
}


self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", event => {
  const data =
    event.data || {};

  const reply =
    payload => {
      try {
        if (event.ports?.[0]) {
          event.ports[0]
            .postMessage(payload);
        }
      } catch (_) {}
    };

  if (
    data.type === "SET_TOKEN" &&
    data.fileId &&
    data.token
  ) {
    const fileId =
      String(data.fileId);

    const state = {
      accessToken: data.token,
      fileSize: Number(data.fileSize)
    };

    const ok =
      saveFileStateMemory(
        fileId,
        state
      );

    reply({ ok });

    if (ok) {
      event.waitUntil(
        persistFileState(
          fileId,
          state
        ).catch(error => {
          console.error(
            "SET_TOKEN 持久化失败:",
            error
          );
        })
      );
    }

    return;
  }
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  if (
    url.origin === self.location.origin &&
    url.pathname.startsWith(MEDIA_PREFIX)
  ) {
    event.respondWith(
      streamDriveFile(event.request, url)
    );
  }
});

function parseSingleRange(rangeHeader, fileSize) {
  if (!rangeHeader) return null;

  // 多段 Range 对 HTMLVideoElement 几乎用不到。
  // 不在这里自己拼 multipart/byteranges，交给上游。
  if (rangeHeader.includes(",")) {
    return {
      passthrough: true,
      original: rangeHeader
    };
  }

  let match = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader);

  if (match) {
    const start = Number(match[1]);

    if (!Number.isFinite(start) || start < 0 || start >= fileSize) {
      return { unsatisfiable: true };
    }

    const requestedEnd =
      match[2] === ""
        ? fileSize - 1
        : Number(match[2]);

    if (
      !Number.isFinite(requestedEnd) ||
      requestedEnd < start
    ) {
      return { unsatisfiable: true };
    }

    // 即使浏览器明确给了很大的 end，也只读取一个小块。
    // 这是旧版没有处理好的地方。
    const end = Math.min(
      requestedEnd,
      start + CHUNK_SIZE - 1,
      fileSize - 1
    );

    return {
      start,
      end,
      header: `bytes=${start}-${end}`
    };
  }

  match = /^bytes=-(\d+)$/i.exec(rangeHeader);

  if (match) {
    let suffixLength = Number(match[1]);

    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return { unsatisfiable: true };
    }

    suffixLength = Math.min(
      suffixLength,
      CHUNK_SIZE,
      fileSize
    );

    const start = Math.max(0, fileSize - suffixLength);
    const end = fileSize - 1;

    return {
      start,
      end,
      header: `bytes=${start}-${end}`
    };
  }

  return {
    passthrough: true,
    original: rangeHeader
  };
}

function make416(fileSize) {
  return new Response(null, {
    status: 416,
    headers: {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${fileSize}`,
      "Cache-Control": "no-store"
    }
  });
}

function cleanMediaHeaders(
  headers,
  fallbackType = "video/mp4",
  downloadName = ""
) {
  const out = new Headers(headers);

  out.delete("Content-Disposition");
  out.set("Accept-Ranges", "bytes");
  out.set("Cache-Control", "no-store");

  if (!out.get("Content-Type")) {
    out.set("Content-Type", fallbackType);
  }

  if (downloadName) {
    const safeName =
      String(downloadName)
        .replace(/[\\/\r\n\"']/g, "_")
        .trim()
        .slice(0, 180) || "video.mp4";

    out.set(
      "Content-Disposition",
      "attachment; filename*=UTF-8''" + encodeURIComponent(safeName)
    );
  }

  return out;
}

async function streamDriveFile(request, url) {
  const fileId = decodeURIComponent(
    url.pathname.substring(MEDIA_PREFIX.length)
  );

  const state = await getFileState(fileId);

  if (!state || !state.accessToken) {
    return new Response(
      "Google Drive authorization required",
      { status: 401 }
    );
  }

  const fileSize = Number(state.fileSize);

  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return new Response(
      "Invalid Google Drive file size",
      { status: 500 }
    );
  }

  const driveURL =
    "https://www.googleapis.com/drive/v3/files/" +
    encodeURIComponent(fileId) +
    "?alt=media";

  const downloadName =
    url.searchParams.get("download") === "1"
      ? url.searchParams.get("filename") || "video.mp4"
      : "";

  const headers = new Headers();
  headers.set(
    "Authorization",
    "Bearer " + state.accessToken
  );

  const resourceKey =
    url.searchParams.get("resourceKey");

  if (resourceKey) {
    headers.set(
      "X-Goog-Drive-Resource-Keys",
      fileId + "/" + resourceKey
    );
  }

  /*
   * HEAD：
   * 用 0-0 GET 取得 Content-Type 等元信息，
   * 但返回给浏览器时 Content-Length 必须是完整文件大小。
   *
   * 旧版把 0-0 响应的 Content-Length=1 原样带回，
   * 对某些浏览器/文件的 seek 会造成错误判断。
   */
  if (request.method === "HEAD") {
    const headHeaders = new Headers(headers);
    headHeaders.set("Range", "bytes=0-0");

    try {
      const upstream = await fetch(
        driveURL,
        {
          method: "GET",
          headers: headHeaders,
          signal: request.signal
        }
      );

      const responseHeaders =
        cleanMediaHeaders(upstream.headers, "video/mp4", downloadName);

      responseHeaders.delete("Content-Range");
      responseHeaders.set(
        "Content-Length",
        String(fileSize)
      );

      return new Response(null, {
        status: upstream.ok ? 200 : upstream.status,
        headers: responseHeaders
      });
    } catch (error) {
      if (
        error &&
        (error.name === "AbortError" ||
         request.signal?.aborted)
      ) {
        return new Response(null, { status: 499 });
      }

      console.error("Drive HEAD failed:", error);

      return new Response(
        "Drive stream failed",
        { status: 502 }
      );
    }
  }

  const originalRange =
    request.headers.get("Range");

  let parsedRange = null;

  if (originalRange) {
    parsedRange =
      parseSingleRange(
        originalRange,
        fileSize
      );

    if (parsedRange?.unsatisfiable) {
      return make416(fileSize);
    }

    if (parsedRange?.header) {
      headers.set(
        "Range",
        parsedRange.header
      );
    } else if (parsedRange?.passthrough) {
      headers.set(
        "Range",
        parsedRange.original
      );
    }
  }

  try {
    const upstream =
      await fetch(
        driveURL,
        {
          method: "GET",
          headers,
          // 关键：用户拖动进度条后，浏览器取消旧媒体请求时，
          // 尽量同步取消旧的 Drive fetch，避免旧流继续占带宽。
          signal: request.signal
        }
      );

    const responseHeaders =
      cleanMediaHeaders(
        upstream.headers,
        "video/mp4",
        downloadName
      );

    /*
     * 对我们自己裁剪过的 Range，明确告诉浏览器实际返回的是哪一段。
     * 不再依据“原始 Range”猜测。
     */
    if (
      upstream.status === 206 &&
      parsedRange &&
      Number.isFinite(parsedRange.start) &&
      Number.isFinite(parsedRange.end)
    ) {
      let actualEnd = parsedRange.end;

      const returnedLength =
        Number(
          responseHeaders.get(
            "Content-Length"
          )
        );

      if (
        Number.isFinite(returnedLength) &&
        returnedLength > 0
      ) {
        actualEnd =
          Math.min(
            fileSize - 1,
            parsedRange.start +
              returnedLength -
              1
          );
      } else {
        // 如果 Google 返回了合法 Content-Range，
        // 优先尊重上游实际 end。
        const upstreamCR =
          responseHeaders.get(
            "Content-Range"
          );

        const crMatch =
          upstreamCR &&
          /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i
            .exec(upstreamCR);

        if (crMatch) {
          actualEnd = Number(crMatch[2]);
        }
      }

      responseHeaders.set(
        "Content-Range",
        `bytes ${parsedRange.start}-${actualEnd}/${fileSize}`
      );

      responseHeaders.set(
        "Content-Length",
        String(
          actualEnd -
          parsedRange.start +
          1
        )
      );
    }

    return new Response(
      upstream.body,
      {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders
      }
    );
  } catch (error) {
    if (
      error &&
      (error.name === "AbortError" ||
       request.signal?.aborted)
    ) {
      /*
       * 这个响应通常不会真正显示给用户，
       * 因为对应的媒体请求已经被浏览器取消。
       */
      return new Response(null, {
        status: 499
      });
    }

    console.error(
      "Drive stream error:",
      error
    );

    return new Response(
      "Drive stream failed",
      { status: 502 }
    );
  }
}
