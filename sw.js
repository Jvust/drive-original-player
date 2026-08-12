let accessToken = null;
let currentFileId = null;
let currentFileSize = null;


/*
 * ==========================================
 * 持久保存 Service Worker 播放状态
 * ==========================================
 *
 * 浏览器可能在暂停视频几分钟后回收 Service Worker。
 * 如果只使用上面的内存变量，
 * Service Worker 再次启动时会全部变成 null。
 *
 * 因此把：
 * accessToken
 * currentFileId
 * currentFileSize
 *
 * 临时持久保存到 Cache Storage。
 */

const AUTH_STATE_CACHE =
  "drive-original-player-auth-v1";


function authStateUrl(fileId) {

  return new URL(
    "__auth_state__/" +
      encodeURIComponent(fileId),
    self.registration.scope
  ).href;

}


async function saveAuthState() {

  if (
    !accessToken ||
    !currentFileId
  ) {
    return;
  }

  try {

    const cache =
      await caches.open(
        AUTH_STATE_CACHE
      );

    await cache.put(

      authStateUrl(
        currentFileId
      ),

      new Response(
        JSON.stringify({
          accessToken:
            accessToken,

          currentFileId:
            currentFileId,

          currentFileSize:
            currentFileSize
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


async function restoreAuthState(
  fileId
) {

  try {

    const cache =
      await caches.open(
        AUTH_STATE_CACHE
      );

    const response =
      await cache.match(
        authStateUrl(fileId)
      );

    if (!response) {
      return false;
    }


    const data =
      await response.json();


    if (
      !data.accessToken ||
      data.currentFileId !== fileId
    ) {
      return false;
    }


    accessToken =
      data.accessToken;

    currentFileId =
      data.currentFileId;

    currentFileSize =
      Number(
        data.currentFileSize
      );


    console.log(
      "Drive 播放状态已恢复"
    );

    return true;

  } catch (error) {

    console.error(
      "恢复 Drive 播放状态失败:",
      error
    );

    return false;

  }

}



/*
 * ==========================================
 * Service Worker 生命周期
 * ==========================================
 */

self.addEventListener(
  "install",
  () => {

    self.skipWaiting();

  }
);


self.addEventListener(
  "activate",
  event => {

    event.waitUntil(
      self.clients.claim()
    );

  }
);



/*
 * ==========================================
 * 接收 index.html 发送的 Token
 * ==========================================
 */

self.addEventListener(
  "message",
  event => {

    if (
      event.data &&
      event.data.type ===
        "SET_TOKEN"
    ) {

      accessToken =
        event.data.token;

      currentFileId =
        event.data.fileId;

      currentFileSize =
        Number(
          event.data.fileSize
        );


      /*
       * 不仅存在内存，
       * 同时持久保存。
       */
      event.waitUntil(
        saveAuthState()
      );

    }

  }
);



/*
 * ==========================================
 * 拦截虚拟媒体地址
 * ==========================================
 */

self.addEventListener(
  "fetch",
  event => {

    const url =
      new URL(
        event.request.url
      );


    const prefix =
      "/drive-original-player/media/";


    if (
      url.origin ===
        self.location.origin &&
      url.pathname.startsWith(
        prefix
      )
    ) {

      event.respondWith(
        streamDriveFile(
          event.request,
          url,
          prefix
        )
      );

    }

  }
);



/*
 * ==========================================
 * 从 Google Drive 原文件读取视频
 * ==========================================
 */

async function streamDriveFile(
  request,
  url,
  prefix
) {


  /*
   * 先取得当前请求对应的 Drive File ID。
   */
  const fileId =
    decodeURIComponent(
      url.pathname.substring(
        prefix.length
      )
    );


  /*
   * ==========================================
   * Service Worker 状态恢复
   * ==========================================
   *
   * 如果浏览器刚刚把 Service Worker 回收，
   * accessToken / fileId / fileSize
   * 会重新变成 null。
   *
   * 此时从 Cache Storage 自动恢复。
   */

  if (
    !accessToken ||
    currentFileId !== fileId ||
    !Number.isFinite(
      currentFileSize
    )
  ) {

    await restoreAuthState(
      fileId
    );

  }


  /*
   * 状态恢复以后依然没有 Token，
   * 才真正返回 401。
   */

  if (!accessToken) {

    return new Response(
      "Google Drive authorization required",
      {
        status: 401
      }
    );

  }



  /*
   * Google Drive 原文件地址
   */

  const driveURL =
    "https://www.googleapis.com/drive/v3/files/" +
    encodeURIComponent(
      fileId
    ) +
    "?alt=media";


  const headers =
    new Headers();


  headers.set(
    "Authorization",
    "Bearer " +
      accessToken
  );



  /*
   * ==========================================
   * Range 分块
   * ==========================================
   */

  const range =
    request.headers.get(
      "Range"
    );


  /*
   * 每次最多读取 16 MB。
   */

  const CHUNK_SIZE =
    16 * 1024 * 1024;


  if (range) {

    const match =
      /^bytes=(\d+)-(\d*)$/.exec(
        range
      );


    if (
      match &&
      Number.isFinite(
        currentFileSize
      ) &&
      currentFileSize > 0
    ) {

      const start =
        Number(
          match[1]
        );

      let end;


      if (
        match[2] !== ""
      ) {

        /*
         * 浏览器已经明确指定结束位置。
         */
        end =
          Number(
            match[2]
          );

      } else {

        /*
         * 浏览器发送：
         *
         * bytes=0-
         *
         * 不允许 Google Drive
         * 一次把整个大文件传下来。
         *
         * 强制限制最多 16 MB。
         */

        end =
          Math.min(
            start +
              CHUNK_SIZE -
              1,

            currentFileSize -
              1
          );

      }


      headers.set(
        "Range",
        `bytes=${start}-${end}`
      );


    } else {

      /*
       * 例如：
       *
       * bytes=-8388608
       *
       * 这种尾部请求保持原样。
       */

      headers.set(
        "Range",
        range
      );

    }

  }



  /*
   * ==========================================
   * Google Drive resourceKey
   * ==========================================
   */

  const resourceKey =
    url.searchParams.get(
      "resourceKey"
    );


  if (resourceKey) {

    headers.set(
      "X-Goog-Drive-Resource-Keys",
      fileId +
        "/" +
        resourceKey
    );

  }



  try {


    /*
     * ==========================================
     * HEAD 请求
     * ==========================================
     *
     * 某些浏览器或播放器会先发送 HEAD。
     *
     * Google Drive 的媒体接口主要按 GET 工作，
     * 所以这里使用 bytes=0-0 的小 Range GET
     * 模拟 HEAD。
     */

    if (
      request.method ===
      "HEAD"
    ) {

      headers.set(
        "Range",
        "bytes=0-0"
      );


      const response =
        await fetch(
          driveURL,
          {
            method:
              "GET",

            headers:
              headers
          }
        );


      const responseHeaders =
        new Headers(
          response.headers
        );


      /*
       * 防止浏览器把视频当附件下载。
       */

      responseHeaders.delete(
        "Content-Disposition"
      );


      responseHeaders.set(
        "Accept-Ranges",
        "bytes"
      );


      if (
        !responseHeaders.get(
          "Content-Type"
        )
      ) {

        responseHeaders.set(
          "Content-Type",
          "video/mp4"
        );

      }


      return new Response(
        null,
        {
          status:
            response.ok
              ? 200
              : response.status,

          headers:
            responseHeaders
        }
      );

    }



    /*
     * ==========================================
     * 正常 GET / Range 请求
     * ==========================================
     */

    const response =
      await fetch(
        driveURL,
        {
          method:
            "GET",

          headers:
            headers
        }
      );


    const cleanHeaders =
      new Headers(
        response.headers
      );


    cleanHeaders.delete(
      "Content-Disposition"
    );


    cleanHeaders.set(
      "Accept-Ranges",
      "bytes"
    );


    if (
      !cleanHeaders.get(
        "Content-Type"
      )
    ) {

      cleanHeaders.set(
        "Content-Type",
        "video/mp4"
      );

    }



    /*
     * ==========================================
     * 修复 Content-Range
     * ==========================================
     *
     * 浏览器原始请求可能是：
     *
     * Range: bytes=0-
     *
     * 但是我们实际发给 Drive 的是：
     *
     * bytes=0-16777215
     *
     * 因此需要根据返回长度，
     * 重新构造正确的 Content-Range。
     */


    const requestedRange =
      request.headers.get(
        "Range"
      );


    const returnedLength =
      Number(
        cleanHeaders.get(
          "Content-Length"
        )
      );


    if (
      response.status ===
        206 &&

      requestedRange &&

      fileId ===
        currentFileId &&

      Number.isFinite(
        currentFileSize
      ) &&

      currentFileSize > 0 &&

      Number.isFinite(
        returnedLength
      ) &&

      returnedLength > 0
    ) {


      const match =
        /^bytes=(\d*)-(\d*)$/.exec(
          requestedRange
        );


      if (match) {

        let start =
          null;


        if (
          match[1] !== ""
        ) {

          start =
            Number(
              match[1]
            );

        }

        else if (
          match[2] !== ""
        ) {

          start =
            currentFileSize -
            returnedLength;

        }


        if (
          Number.isFinite(
            start
          ) &&
          start >= 0
        ) {

          const end =
            start +
            returnedLength -
            1;


          cleanHeaders.set(
            "Content-Range",
            `bytes ${start}-${end}/${currentFileSize}`
          );

        }

      }

    }



    /*
     * 把 Google Drive 返回的视频流
     * 原样交给浏览器。
     */

    return new Response(
      response.body,
      {
        status:
          response.status,

        statusText:
          response.statusText,

        headers:
          cleanHeaders
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
