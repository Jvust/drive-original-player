/*
 * Drive Original Player · Seek Robust Service Worker
 *
 * 重点：
 * 1. 每个视频分别保存授权/大小，避免批量播放时多个文件请求互相覆盖状态。
 * 2. 所有单段 Range 都限制为较小块，提高拖动进度条后的响应速度。
 * 3. 正确处理 start-end / start- / -suffix 三种 Range。
 * 4. HEAD 返回完整文件长度，而不是错误地返回 1 byte。
 * 5. 把浏览器的 abort signal 传给 Google Drive，拖动后旧请求能尽快停止。
 * 6. SET_TOKEN 回执只等内存状态写完就返回，不等 Cache Storage 落盘，
 *    切视频 / 热备预加载不会被落盘 I/O 拖慢（落盘转后台完成）。
 * 7. 新增 Seek Scrub Prime：播放器拖动进度条、还没松手时就会按估算的
 *    字节位置提前预热一小块数据；松手真正 seek 命中同一网格时可以
 *    直接从内存返回，不用再等一次到 Google 的完整网络往返。
 */

const MEDIA_PREFIX = "/drive-original-player/media/";
const AUTH_STATE_CACHE = "drive-original-player-auth-v2";
const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MB：比旧版 16 MB 更适合 seek

/*
 * 快速切换：只在内存中预热相邻视频前 2 MB。
 * 不缓存整个视频，也不会降低原始画质。
 */
const PRIME_BYTES = 2 * 1024 * 1024;
const PRIME_MAX_ENTRIES = 4;
const primeMediaCache = new Map();

/*
 * 拖动进度条预热（Seek Scrub Prime）：
 * 和上面的“相邻视频预热”是两套独立缓存——这里预热的是
 * 当前视频里任意字节位置，而不是某个文件开头的固定 2 MB。
 *
 * 播放器在用户还在拖动、尚未松手前，会按估算字节位置提前抓一小块
 * （约 1.5 MB），按 1 MB 网格对齐存起来。松手真正 seek 时如果命中
 * 同一网格，直接从内存切片返回，不用再等一次到 Google 的完整往返。
 * 没命中也没有副作用，会自动退回正常的网络请求，不影响正确性。
 */
const SEEK_PRIME_ALIGN = 1 * 1024 * 1024;
const SEEK_PRIME_BYTES = 1.5 * 1024 * 1024;
const SEEK_PRIME_MAX_ENTRIES = 6;
const seekPrimeCache = new Map();

// 不再只保存一个 currentFileId。
// 批量播放/切换视频时，不同文件可以同时存在短暂的请求。
const fileStates = new Map();

function authStateUrl(fileId) {
  return new URL(
    "__auth_state_v2__/" + encodeURIComponent(fileId),
    self.registration.scope
  ).href;
}

/*
 * getFileState() 优先读内存 Map（见下方），所以真正卡在“切换/预热
 * 前必须等待”这条关键路径上的，只有内存写入这一步。
 * 这里拆成两步：
 *   1) saveFileStateMemory：同步写内存，函数一返回就立刻可用；
 *   2) persistFileState：写 Cache Storage，只用于刷新页面后恢复，
 *      放到后台完成，不阻塞任何播放 / 切换 / 预热判断。
 */
function saveFileStateMemory(fileId, state) {
  if (!fileId || !state || !state.accessToken) return false;

  fileStates.set(fileId, {
    accessToken: state.accessToken,
    fileSize: Number(state.fileSize)
  });

  return true;
}

async function persistFileState(fileId, state) {
  try {
    const cache = await caches.open(AUTH_STATE_CACHE);

    await cache.put(
      authStateUrl(fileId),
      new Response(
        JSON.stringify({
          accessToken: state.accessToken,
          fileId,
          fileSize: Number(state.fileSize)
        }),
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
          }
        }
      )
    );
  } catch (error) {
    console.error("保存 Drive 播放状态失败:", error);
  }
}

async function saveFileState(fileId, state) {
  if (!saveFileStateMemory(fileId, state)) return;
  await persistFileState(fileId, state);
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


function touchPrimeCache(fileId, entry) {
  if (primeMediaCache.has(fileId)) {
    primeMediaCache.delete(fileId);
  }

  primeMediaCache.set(fileId, entry);

  while (
    primeMediaCache.size >
      PRIME_MAX_ENTRIES
  ) {
    const oldestKey =
      primeMediaCache
        .keys()
        .next()
        .value;

    primeMediaCache.delete(oldestKey);
  }
}

async function primeMediaFile({
  fileId,
  token,
  fileSize,
  resourceKey
}) {
  fileId = String(fileId || "");
  fileSize = Number(fileSize);

  if (
    !fileId ||
    !token ||
    !Number.isFinite(fileSize) ||
    fileSize <= 0
  ) {
    return false;
  }

  const existing =
    primeMediaCache.get(fileId);

  if (
    existing &&
    existing.token === token &&
    existing.buffer?.byteLength > 0
  ) {
    touchPrimeCache(
      fileId,
      existing
    );
    return true;
  }

  saveFileStateMemory(
    fileId,
    {
      accessToken: token,
      fileSize
    }
  );

  // 落盘持久化和随后的 Range 抓取并行进行，不再串行拖慢预热。
  const persistState =
    persistFileState(
      fileId,
      {
        accessToken: token,
        fileSize
      }
    );

  const end =
    Math.min(
      fileSize - 1,
      PRIME_BYTES - 1
    );

  const driveURL =
    "https://www.googleapis.com/drive/v3/files/" +
    encodeURIComponent(fileId) +
    "?alt=media";

  const headers =
    new Headers();

  headers.set(
    "Authorization",
    "Bearer " + token
  );

  headers.set(
    "Range",
    `bytes=0-${end}`
  );

  if (resourceKey) {
    headers.set(
      "X-Goog-Drive-Resource-Keys",
      fileId + "/" + resourceKey
    );
  }

  try {
    const response =
      await fetch(
        driveURL,
        {
          method: "GET",
          headers
        }
      );

    if (
      response.status !== 206 &&
      !response.ok
    ) {
      return false;
    }

    const buffer =
      await response.arrayBuffer();

    if (!buffer.byteLength) {
      return false;
    }

    touchPrimeCache(
      fileId,
      {
        token,
        resourceKey:
          resourceKey || null,
        buffer,
        contentType:
          response.headers.get(
            "Content-Type"
          ) || "video/mp4",
        createdAt:
          Date.now()
      }
    );

    await persistState.catch(
      () => {}
    );

    return true;
  } catch (error) {
    console.debug(
      "Prime media failed:",
      error
    );
    return false;
  }
}

function getPrimeResponse(
  fileId,
  parsedRange,
  fileSize
) {
  if (
    !parsedRange ||
    parsedRange.start !== 0 ||
    !Number.isFinite(
      parsedRange.end
    )
  ) {
    return null;
  }

  const entry =
    primeMediaCache.get(
      String(fileId)
    );

  if (
    !entry ||
    !entry.buffer ||
    entry.buffer.byteLength <= 0
  ) {
    return null;
  }

  const availableEnd =
    Math.min(
      parsedRange.end,
      entry.buffer.byteLength - 1,
      fileSize - 1
    );

  if (availableEnd < 0) {
    return null;
  }

  touchPrimeCache(
    String(fileId),
    entry
  );

  const slice =
    entry.buffer.slice(
      0,
      availableEnd + 1
    );

  return new Response(
    slice,
    {
      status: 206,
      headers: {
        "Content-Type":
          entry.contentType ||
          "video/mp4",
        "Content-Length":
          String(
            slice.byteLength
          ),
        "Content-Range":
          `bytes 0-${availableEnd}/${fileSize}`,
        "Accept-Ranges":
          "bytes",
        "Cache-Control":
          "no-store"
      }
    }
  );
}

function seekPrimeKey(fileId, alignedStart) {
  return fileId + ":" + alignedStart;
}

function touchSeekPrimeCache(key, entry) {
  if (seekPrimeCache.has(key)) {
    seekPrimeCache.delete(key);
  }

  seekPrimeCache.set(key, entry);

  while (
    seekPrimeCache.size >
      SEEK_PRIME_MAX_ENTRIES
  ) {
    const oldestKey =
      seekPrimeCache
        .keys()
        .next()
        .value;

    seekPrimeCache.delete(oldestKey);
  }
}

async function primeSeekPosition({
  fileId,
  token,
  fileSize,
  resourceKey,
  offset
}) {
  fileId = String(fileId || "");
  fileSize = Number(fileSize);
  offset = Number(offset);

  if (
    !fileId ||
    !token ||
    !Number.isFinite(fileSize) ||
    fileSize <= 0 ||
    !Number.isFinite(offset) ||
    offset < 0
  ) {
    return false;
  }

  const alignedStart =
    Math.min(
      Math.floor(
        offset / SEEK_PRIME_ALIGN
      ) * SEEK_PRIME_ALIGN,
      Math.max(0, fileSize - 1)
    );

  const key =
    seekPrimeKey(
      fileId,
      alignedStart
    );

  const existing =
    seekPrimeCache.get(key);

  if (
    existing &&
    existing.token === token &&
    existing.buffer?.byteLength > 0
  ) {
    touchSeekPrimeCache(
      key,
      existing
    );
    return true;
  }

  // 顺手把 token/大小写进内存状态，防止拖动预热先于 SET_TOKEN 到达。
  saveFileStateMemory(
    fileId,
    {
      accessToken: token,
      fileSize
    }
  );

  const end =
    Math.min(
      fileSize - 1,
      alignedStart +
        SEEK_PRIME_BYTES -
        1
    );

  const driveURL =
    "https://www.googleapis.com/drive/v3/files/" +
    encodeURIComponent(fileId) +
    "?alt=media";

  const headers =
    new Headers();

  headers.set(
    "Authorization",
    "Bearer " + token
  );

  headers.set(
    "Range",
    `bytes=${alignedStart}-${end}`
  );

  if (resourceKey) {
    headers.set(
      "X-Goog-Drive-Resource-Keys",
      fileId + "/" + resourceKey
    );
  }

  try {
    const response =
      await fetch(
        driveURL,
        {
          method: "GET",
          headers
        }
      );

    if (
      response.status !== 206 &&
      !response.ok
    ) {
      return false;
    }

    const buffer =
      await response.arrayBuffer();

    if (!buffer.byteLength) {
      return false;
    }

    touchSeekPrimeCache(
      key,
      {
        token,
        resourceKey:
          resourceKey || null,
        start: alignedStart,
        buffer,
        contentType:
          response.headers.get(
            "Content-Type"
          ) || "video/mp4",
        createdAt:
          Date.now()
      }
    );

    return true;
  } catch (error) {
    console.debug(
      "Prime seek position failed:",
      error
    );
    return false;
  }
}

function getSeekPrimeResponse(
  fileId,
  parsedRange,
  fileSize
) {
  if (
    !parsedRange ||
    !Number.isFinite(
      parsedRange.start
    )
  ) {
    return null;
  }

  const alignedStart =
    Math.floor(
      parsedRange.start /
        SEEK_PRIME_ALIGN
    ) * SEEK_PRIME_ALIGN;

  /*
   * SEEK_PRIME_BYTES（1.5MB）比 SEEK_PRIME_ALIGN（1MB）大一截，
   * 所以“上一个网格”的缓存条目末尾可能会溢出，覆盖到当前网格
   * 开头的一小段。这里把当前网格和上一个网格都当候选查一遍，
   * 哪个真正覆盖到 parsedRange.start 就用哪个，避免明明缓存里
   * 有数据，却因为只查了一个网格键而白白漏判成没命中。
   */
  const candidateStarts = [
    alignedStart,
    alignedStart - SEEK_PRIME_ALIGN
  ];

  for (
    const candidateStart of
      candidateStarts
  ) {
    if (candidateStart < 0) {
      continue;
    }

    const key =
      seekPrimeKey(
        String(fileId),
        candidateStart
      );

    const entry =
      seekPrimeCache.get(key);

    if (
      !entry ||
      !entry.buffer ||
      entry.buffer.byteLength <= 0
    ) {
      continue;
    }

    const bufferStart =
      entry.start;

    const bufferEnd =
      bufferStart +
      entry.buffer.byteLength -
      1;

    // 拖动位置估算不一定精确，落在这个候选缓存范围外就换下一个候选，
    // 都不命中就交给下面的正常网络请求处理，不强行拼凑。
    if (
      parsedRange.start <
        bufferStart ||
      parsedRange.start >
        bufferEnd
    ) {
      continue;
    }

    const availableEnd =
      Math.min(
        parsedRange.end,
        bufferEnd,
        fileSize - 1
      );

    if (
      availableEnd <
        parsedRange.start
    ) {
      continue;
    }

    touchSeekPrimeCache(
      key,
      entry
    );

    const sliceStart =
      parsedRange.start -
      bufferStart;

    const sliceEnd =
      availableEnd -
      bufferStart;

    const slice =
      entry.buffer.slice(
        sliceStart,
        sliceEnd + 1
      );

    if (!slice.byteLength) {
      continue;
    }

    return new Response(
      slice,
      {
        status: 206,
        headers: {
          "Content-Type":
            entry.contentType ||
            "video/mp4",
          "Content-Length":
            String(
              slice.byteLength
            ),
          "Content-Range":
            `bytes ${parsedRange.start}-${availableEnd}/${fileSize}`,
          "Accept-Ranges":
            "bytes",
          "Cache-Control":
            "no-store"
        }
      }
    );
  }

  return null;
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
      fileSize:
        Number(data.fileSize)
    };

    const ok =
      saveFileStateMemory(
        fileId,
        state
      );

    /*
     * 关键优化：回执只等内存写入，不等 Cache Storage 落盘。
     * getFileState() 优先读内存 Map，播放器这一帧就能开始
     * 请求媒体，切视频 / 热备预加载不会被落盘 I/O 拖慢。
     * 落盘只用于刷新页面后的状态恢复，放进 waitUntil 后台完成。
     */
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

  if (
    data.type === "PRIME_MEDIA" &&
    data.fileId &&
    data.token
  ) {
    const work =
      primeMediaFile({
        fileId:
          data.fileId,
        token:
          data.token,
        fileSize:
          Number(data.fileSize),
        resourceKey:
          data.resourceKey || null
      })
        .then(ok => {
          reply({ ok });
        });

    event.waitUntil(work);
    return;
  }

  if (
    data.type === "PRIME_SEEK" &&
    data.fileId &&
    data.token &&
    Number.isFinite(
      Number(data.offset)
    )
  ) {
    const work =
      primeSeekPosition({
        fileId:
          data.fileId,
        token:
          data.token,
        fileSize:
          Number(data.fileSize),
        resourceKey:
          data.resourceKey || null,
        offset:
          Number(data.offset)
      })
        .then(ok => {
          reply({ ok });
        });

    event.waitUntil(work);
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

function cleanMediaHeaders(headers, fallbackType = "video/mp4") {
  const out = new Headers(headers);

  out.delete("Content-Disposition");
  out.set("Accept-Ranges", "bytes");
  out.set("Cache-Control", "no-store");

  if (!out.get("Content-Type")) {
    out.set("Content-Type", fallbackType);
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
        cleanMediaHeaders(upstream.headers);

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

  if (
    request.method === "GET" &&
    parsedRange &&
    parsedRange.start === 0
  ) {
    const primeResponse =
      getPrimeResponse(
        fileId,
        parsedRange,
        fileSize
      );

    if (primeResponse) {
      return primeResponse;
    }
  }

  /*
   * 拖动进度条时提前预热过的任意字节位置，这里统一查一次。
   * 命中就直接返回内存切片；没命中/没预热过就自然往下走正常请求。
   */
  if (
    request.method === "GET" &&
    parsedRange &&
    Number.isFinite(
      parsedRange.start
    )
  ) {
    const seekPrimeResponse =
      getSeekPrimeResponse(
        fileId,
        parsedRange,
        fileSize
      );

    if (seekPrimeResponse) {
      return seekPrimeResponse;
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
        upstream.headers
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
