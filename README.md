# AI Tarot · 塔罗抽牌

用 Three.js 展示塔罗牌，支持鼠标、键盘和可选的摄像头手势。初始抽三张牌，也可以追问一次，再抽三张补牌。项目仅供娱乐和自我反思。

## 在本机运行

需要 Node.js 20.19+ 或 22.12+。下载或克隆仓库后，在项目目录运行：

```bash
npm ci
npm run dev
```

打开终端显示的 localhost 地址。生产构建可用 `npm run build`，本机预览用 `npm run preview`。AI 解读经由本机 Vite 服务转发，使用 GitHub Pages 等纯静态托管时，仅能体验本地解读。

## 如何抽牌

1. 写下问题，点击「开始占卜」。
2. 点「张手」让牌流动，点「握拳」锁定当前牌。也可以按空格和回车。
3. 抽完三张牌后查看解读。需要时提交一次追问，再按相同方式抽三张补牌。
4. 想用手势时，点「开启摄像头」。张开手掌和握拳分别对应两种操作。

## 使用自己的 DeepSeek API

展开页面上的「AI 解读设置」，输入自己在 DeepSeek 官方平台创建的密钥，再点「启用 AI」。本机服务会通过 `https://api.deepseek.com/chat/completions` 调用 `deepseek-flash`。没有配置、接口失败或断网时，可以继续抽牌并使用本地牌义，不需要密钥。 [DeepSeek API 文档](https://api-docs.deepseek.com/)

- 密钥只保留在当前页面的运行内存里。点「清除密钥」或刷新、关闭页面即清除。仓库、构建产物和浏览器持久化存储不保存密钥。
- 只有开启 AI 后抽完牌，问题、当前牌和对应牌义才会通过本机桥接发送给 DeepSeek。追问时还会发送上一轮解读。用量由自己的 DeepSeek 账户承担。
- 摄像头是可选的。手势开启时会从 Google 下载 Hand Landmarker 模型，识别在浏览器内执行，应用不会上传摄像头画面。若模型不可达，可以继续用按钮和键盘。 [MediaPipe 文档](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker?tab=Web)

## 素材

公开版包含 78 张程序生成的几何牌面和简版中文正逆位提示。WebAssembly 文件在开发和构建前从 npm 安装的 MediaPipe 依赖生成到本地资源目录。
