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
