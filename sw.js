let accessToken = null;

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", event => {
  if (event.data && event.data.type === "SET_TOKEN") {
    accessToken = event.data.token;
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

  if (range) {
    headers.set("Range", range);
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

    return new Response(
      response.body,
      {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
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
