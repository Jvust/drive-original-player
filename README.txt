Drive Original Gallery - 单选图片自动读取当前文件夹

GitHub 目录：
index.html
gallery/index.html
gallery/sw.js

Yande.re 原图画廊：
yande/index.html
scripts/archive-yande.py（归档 2026-01-01 至 2026-09-30 的日榜元数据；图片仍从 Yande.re 原图地址加载）

重要：自动读取同一文件夹里的所有图片，需要 OAuth scope：
https://www.googleapis.com/auth/drive.readonly
https://www.googleapis.com/auth/drive.install

Cloudflare Worker 的 /auth 授权请求中，把原来的 drive.file 改为 drive.readonly，然后重新授权一次，以生成包含新 scope 的 refresh token。

Google 官方把 drive.readonly 标记为 restricted scope。公开应用可能需要额外 OAuth 验证；个人自用/测试时也可能看到未验证应用提示。


## 播放器增强（2026-10）

主播放器已增加：
- 悬浮播放：把当前播放器缩成右下角浮窗，适合边看边处理其他页面；
- 循环播放：当前视频循环播放，可用快捷键 `L` 切换；
- 浏览器画中画：可用快捷键 `P` 或按钮弹出独立画中画窗口；
- 快捷键 `F`：切换悬浮模式，`Esc`：退出悬浮模式；
- APK/ZIP/Unity 导出文件提示：这类文件不会被错误当作视频，APK 需要 Android 模拟器/设备运行，ZIP 只有包含 MP4/WebM 等视频时才会直接播放。

这些增强只改变网页播放器交互，不修改 Google Drive 原文件，也不执行 APK/Unity 包内脚本。