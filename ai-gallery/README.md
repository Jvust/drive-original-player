# AI Gallery

一个可以直接部署到 GitHub Pages 的纯静态全屏图片 / 视频画廊。

## 已有功能

- 图片和视频都使用全屏舞台展示，支持移动端和桌面端
- 左右箭头、缩略图、上一项 / 下一项切换
- 视频播放、进度、音量、静音、循环和全屏
- `F` 全屏、`Space` 播放/暂停、`M` 静音
- 点击“添加媒体”或直接拖入本地图片 / 视频，适合临时预览
- `contain / cover` 两种显示方式，默认完整显示媒体
- 只使用 HTML、CSS、JavaScript，不需要构建工具或服务器

## 添加自己的媒体

### 方式一：编辑 `media.json`

把图片和视频上传到仓库，例如：

```text
media/
  mountain.jpg
  concert.mp4
```

再编辑 `media.json`：

```json
{
  "items": [
    {
      "type": "image",
      "src": "media/mountain.jpg",
      "title": "山色",
      "description": "周末拍摄"
    },
    {
      "type": "video",
      "src": "media/concert.mp4",
      "poster": "media/concert-poster.jpg",
      "title": "现场",
      "description": "演出片段"
    }
  ]
}
```

图片和视频文件会公开出现在 GitHub Pages；不要把私密文件上传到公开仓库。

### 方式二：网页临时加入

点击右上角 `＋`，或者把文件拖到网页中。临时加入的媒体只保存在当前浏览器标签页，刷新页面后需要重新选择。

## GitHub Pages

仓库上传后，在 **Settings → Pages** 中选择 **Deploy from a branch**，分支选择 `main`、目录选择 `/ (root)`，保存后等待 GitHub Pages 发布。

本项目包含 `.nojekyll`，可以直接使用根目录中的 `index.html`。
