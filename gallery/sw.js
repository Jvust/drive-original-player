let accessToken = null;

const AUTH_STATE_CACHE =
  "drive-original-gallery-auth-v1";

function authStateUrl() {
  return new URL(
    "__gallery_auth_state__",
    self.registration.scope
  ).href;
}

async function saveAuthState() {
  if (!accessToken) return;

  try {
    const cache = await caches.open(AUTH_STATE_CACHE);

    await cache.put(
      authStateUrl(),
      new Response(
        JSON.stringify({ accessToken }),
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
          }
        }
      )
    );
  } catch (error) {
    console.error("保存 Gallery Token 失败:", error);
  }
}

async function restoreAuthState() {
  try {
    const cache = await caches.open(AUTH_STATE_CACHE);
    const response = await cache.match(authStateUrl());

    if (!response) return false;

    const data = await response.json();
    if (!data.accessToken) return false;

    accessToken = data.accessToken;
    return true;
  } catch (error) {
    console.error("恢复 Gallery Token 失败:", error);
    return false;
  }
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", event => {
  if (
    event.data &&
    event.data.type === "SET_TOKEN"
  ) {
    accessToken = event.data.token;
    event.waitUntil(saveAuthState());
  }
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  const prefix =
    "/drive-original-player/gallery/media/";

  if (
    url.origin === self.location.origin &&
    url.pathname.startsWith(prefix)
  ) {
    event.respondWith(
      streamDriveImage(event.request, url, prefix)
    );
  }
});

async function streamDriveImage(request, url, prefix) {
  if (!accessToken) {
    await restoreAuthState();
  }

  if (!accessToken) {
    return new Response(
      "Google Drive authorization required",
      { status: 401 }
    );
  }

  const fileId = decodeURIComponent(
    url.pathname.substring(prefix.length)
  );

  const driveURL =
    "https://www.googleapis.com/drive/v3/files/" +
    encodeURIComponent(fileId) +
    "?alt=media&supportsAllDrives=true";

  const headers = new Headers();
  headers.set(
    "Authorization",
    "Bearer " + accessToken
  );

  const resourceKey =
    url.searchParams.get("resourceKey");

  if (resourceKey) {
    headers.set(
      "X-Goog-Drive-Resource-Keys",
      fileId + "/" + resourceKey
    );
  }

  try {
    const response = await fetch(
      driveURL,
      {
        method: "GET",
        headers
      }
    );

    const cleanHeaders =
      new Headers(response.headers);

    cleanHeaders.delete("Content-Disposition");
    cleanHeaders.set(
      "Cache-Control",
      "private, max-age=300"
    );

    return new Response(
      response.body,
      {
        status: response.status,
        statusText: response.statusText,
        headers: cleanHeaders
      }
    );
  } catch (error) {
    console.error("Drive image stream error:", error);

    return new Response(
      "Drive image stream failed",
      { status: 502 }
    );
  }
}
