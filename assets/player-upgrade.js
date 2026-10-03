/* Drive Original Player upgrade: floating mini-player, loop, PiP and Unity/APK hints. */
(function () {
  "use strict";
  const video = document.getElementById("player");
  if (!video) return;

  const style = document.createElement("style");
  style.textContent = `
    .drive-upgrade-tools { display:flex; gap:.5rem; flex-wrap:wrap; margin-top:.6rem; }
    .drive-upgrade-tools button { border:1px solid rgba(255,255,255,.22); background:rgba(255,255,255,.08); color:inherit; border-radius:999px; padding:.45rem .8rem; cursor:pointer; }
    .drive-upgrade-tools button[aria-pressed="true"] { background:#d7b77a; color:#16120d; }
    body.drive-floating-player #playerWrap { position:fixed; z-index:9999; right:20px; bottom:20px; width:min(460px,calc(100vw - 28px)); margin:0; border:1px solid rgba(215,183,122,.5); border-radius:16px; box-shadow:0 18px 60px rgba(0,0,0,.55); overflow:hidden; background:#090b13; }
    body.drive-floating-player #playerWrap .player-tools, body.drive-floating-player #playerWrap #info { padding-left:12px; padding-right:12px; }
    .drive-format-hint { display:none; margin:.65rem 0; padding:.65rem .8rem; border-left:3px solid #d7b77a; background:rgba(215,183,122,.1); color:#ddd; font-size:.88rem; }
    .drive-format-hint.show { display:block; }
  `;
  document.head.appendChild(style);

  const tools = document.querySelector(".player-tools");
  if (!tools) return;
  const row = document.createElement("div");
  row.className = "drive-upgrade-tools";
  row.setAttribute("aria-label", "增强播放控制");

  function button(label, title, handler) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; b.title = title;
    b.addEventListener("click", handler); row.appendChild(b); return b;
  }

  const floatBtn = button("悬浮", "将播放器缩为桌面悬浮窗口", () => {
    document.body.classList.toggle("drive-floating-player");
    floatBtn.setAttribute("aria-pressed", String(document.body.classList.contains("drive-floating-player")));
  });
  floatBtn.setAttribute("aria-pressed", "false");

  const loopBtn = button("循环", "循环播放当前视频", () => {
    video.loop = !video.loop;
    loopBtn.setAttribute("aria-pressed", String(video.loop));
    loopBtn.textContent = video.loop ? "循环中" : "循环";
  });
  loopBtn.setAttribute("aria-pressed", "false");

  const pipBtn = button("画中画", "在浏览器画中画窗口中播放", async () => {
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else if (document.pictureInPictureEnabled && video.requestPictureInPicture) await video.requestPictureInPicture();
      else throw new Error("当前浏览器不支持画中画");
    } catch (e) {
      const status = document.getElementById("status");
      if (status) status.textContent = e.message;
    }
  });

  const hint = document.createElement("div");
  hint.className = "drive-format-hint";
  hint.setAttribute("role", "status");
  const info = document.getElementById("info");
  if (info && info.parentNode) info.parentNode.insertBefore(hint, info);
  tools.appendChild(row);

  function updateFormatHint() {
    const text = ((document.getElementById("filename") || {}).textContent || "").trim();
    if (!text) return;
    if (/\.(apk|aab|zip)$/i.test(text)) {
      hint.classList.add("show");
      hint.textContent = /\.apk$/i.test(text)
        ? "这是 Android APK 文件，浏览器不能直接当视频播放；请下载后用 Android 模拟器或手机运行。"
        : "这是 ZIP/Unity 导出包；只有其中包含 MP4/WebM 等视频文件时，播放器才会直接播放。";
    } else {
      hint.classList.remove("show");
      hint.textContent = "";
    }
  }

  const observer = new MutationObserver(updateFormatHint);
  const filename = document.getElementById("filename");
  if (filename) observer.observe(filename, {childList:true, subtree:true, characterData:true});
  updateFormatHint();

  document.addEventListener("keydown", (e) => {
    if (e.target && /input|textarea|select/i.test(e.target.tagName)) return;
    if (e.key.toLowerCase() === "l") { video.loop = !video.loop; loopBtn.click(); }
    if (e.key.toLowerCase() === "f") floatBtn.click();
    if (e.key.toLowerCase() === "p") pipBtn.click();
    if (e.key === "Escape" && document.body.classList.contains("drive-floating-player")) {
      document.body.classList.remove("drive-floating-player"); floatBtn.setAttribute("aria-pressed","false");
    }
  });
})();
