let accessToken = null;
let currentFileId = null;
let currentFileSize = null;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", event => {
  if (event.data && event.data.type === "SET_TOKEN") {
    accessToken = event.data.token;
    currentFileId = event.data.fileId;
    currentFileSize = Number(event.data.fileSize);
  }
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  const prefix = "/drive-original-player/media/";

  if (
    url.origin === self.location.origin &&
    url.pathname.startsWith(prefix)
  ) {
    event.respondWith(
      streamDriveFile(event.request, url, prefix)
    );
  }
});

async function streamDriveFile(request, url, prefix) {

  if (!accessToken) {
    return new Response("Google Drive authorization required", {
      status: 401
    });
  }

  const fileId = decodeURIComponent(
    url.pathname.substring(prefix.length)
  );

  const driveURL =
    "https://www.googleapis.com/drive/v3/files/" +
    encodeURIComponent(fileId) +
    "?alt=media";

  const headers = new Headers();

  headers.set(
    "Authorization",
    "Bearer " + accessToken
  );

const range = request.headers.get("Range");

const CHUNK_SIZE =
  16 * 1024 * 1024; // 每次 16 MB

if (range) {

  const match =
    /^bytes=(\d+)-(\d*)$/.exec(range);

  if (
    match &&
    Number.isFinite(currentFileSize) &&
    currentFileSize > 0
  ) {

    const start =
      Number(match[1]);

    let end;

    if (match[2] !== "") {

      // 浏览器明确指定了结束位置
      end = Number(match[2]);

    } else {

      // bytes=0- 这种请求改成最多读取 16 MB
      end = Math.min(
        start + CHUNK_SIZE - 1,
        currentFileSize - 1
      );
    }

    headers.set(
      "Range",
      `bytes=${start}-${end}`
    );

  } else {

    // 例如 bytes=-8388608 这种尾部请求保持原样
    headers.set(
      "Range",
      range
    );
  }
}

  const resourceKey =
    url.searchParams.get("resourceKey");

  if (resourceKey) {
    headers.set(
      "X-Goog-Drive-Resource-Keys",
      fileId + "/" + resourceKey
    );
  }

  try {

    /*
      某些播放器/浏览器扩展会先发送 HEAD。
      Drive 的媒体接口主要按 GET 读取，
      因此 HEAD 时用一个很小的 Range GET 获取信息。
    */

    if (request.method === "HEAD") {

      headers.set("Range", "bytes=0-0");

      const response = await fetch(
        driveURL,
        {
          method: "GET",
          headers: headers
        }
      );

const responseHeaders =
  new Headers(response.headers);

responseHeaders.delete("Content-Disposition");

responseHeaders.set(
  "Accept-Ranges",
  "bytes"
);

if (!responseHeaders.get("Content-Type")) {
  responseHeaders.set(
    "Content-Type",
    "video/mp4"
  );
}

return new Response(null, {
  status: response.ok ? 200 : response.status,
  headers: responseHeaders
});
    }

    const response = await fetch(
      driveURL,
      {
        method: "GET",
        headers: headers
      }
    );

const cleanHeaders =
  new Headers(response.headers);

cleanHeaders.delete("Content-Disposition");

cleanHeaders.set(
  "Accept-Ranges",
  "bytes"
);

if (!cleanHeaders.get("Content-Type")) {
  cleanHeaders.set(
    "Content-Type",
    "video/mp4"
  );
}
    const requestedRange =
  request.headers.get("Range");

const returnedLength =
  Number(cleanHeaders.get("Content-Length"));

if (
  response.status === 206 &&
  requestedRange &&
  fileId === currentFileId &&
  Number.isFinite(currentFileSize) &&
  currentFileSize > 0 &&
  Number.isFinite(returnedLength) &&
  returnedLength > 0
) {

  const match =
    /^bytes=(\d*)-(\d*)$/.exec(requestedRange);

  if (match) {

    let start = null;

    if (match[1] !== "") {
      start = Number(match[1]);
    }
    else if (match[2] !== "") {
      start = currentFileSize - returnedLength;
    }

    if (
      Number.isFinite(start) &&
      start >= 0
    ) {

      const end =
        start + returnedLength - 1;

      cleanHeaders.set(
        "Content-Range",
        `bytes ${start}-${end}/${currentFileSize}`
      );
    }
  }
}

return new Response(
  response.body,
  {
    status: response.status,
    statusText: response.statusText,
    headers: cleanHeaders
  }
);

  } catch (error) {

    console.error(
      "Drive stream error:",
      error
    );

    return new Response(
      "Drive stream failed",
      {
        status: 502
      }
    );
  }
}
