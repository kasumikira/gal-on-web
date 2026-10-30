# 引擎测试

在仓库根目录执行。测试不进入游戏生产包；`tests/` 根目录继续保存本地游戏和问题存档。

## 无浏览器回归

```powershell
pnpm test:engine
# 或只运行一个文件
node web/tests/unit/vm-check.mjs
```

`unit/` 当前包含 20 个独立检查文件：TJS2/宿主错误、插件注册、CSV/saveStruct、KAGParserEx、输入、System/Window、PSB、音频以及视频队列/时间戳。部分文件通过 Vite SSR 编译装饰器，使用内存存储与音频桩；真实音频设备和 GPU 仍需浏览器检查。Node 需要支持 WebAssembly JSPI，建议使用当前已验证的 Node 24。

`fixtures/amv-fixture.mjs` 是 Node/浏览器共用的合成 AMV 素材，不是可单独执行的测试。

`gpu/gpu-reference.js`、`gpu/bitmap-reference.js`、`gpu/font-reference.js`、`gpu/glyph-blur-reference.js`、`gpu/layer-drawing-reference.js` 与 `unit/layer-tree-reference.js`
仅用于保留既有算法对照；生产入口已使用原版 native Layer/Font/Bitmap，不得引用这些文件。

`video/*-reference.js` 保留迁移前的 JS 图像、GPU 和视频图层呈递，仅供旧路径对比测试。
生产视频图层交给 native；悬浮视频直接绘制解码帧，不再初始化独立的 JS GPU 设备。

## 浏览器检查

启动 `pnpm dev:vite` 后打开：

| 地址 | 用途 | 依赖 |
| --- | --- | --- |
| `/tests/gpu/index.html` | 原版 C++ 与 GPU 像素对照、误差报告 | 先执行 `node web/tests/gpu/prepare.mjs`；原版参考源码与 C++ 编译器 |
| `/tests/gpu/cow.html` | 图像共享与写时复制 | WebGL2，不需要参考 fixture |
| `/tests/gpu/pixels.html` | 字形、缓存、编解码、扩展像素与合成回归 | WebGL2、浏览器图像/字体 API |
| `/tests/render/native.html` | native 渲染后端（纹理、绘制、全部 `bm` 混合、`_d` 目标采样、Ps 模式、CoW、上下文丢失） | WebGL2 |
| `/tests/image/native.html` | native 图像解码与预渲染字体（PNG/TLG/JPEG、色键、字体两种 RLE、字形度量/行距） | WASM 解码器 |
| `/tests/video/index.html` | 合成 AMV/WebM 的真实 Worker/WASM/GPU 与音频检查 | WebGL2、WebCodecs、音频用户手势 |

页面也可以直接在内置浏览器里打开（`pnpm dev:vite` 后访问上表地址）：结果表与汇总行
在页面上直接可见。图像页带看门狗——20 秒内没有结果或模块加载失败时，汇总行会显示
失败原因，不会静默停在「运行中…」。

页面内显示通过/失败及差异；GPU 基准的覆盖缺口见 [GPU 说明](gpu/README.md)。像素 fixture 与 oracle 可执行文件生成到 `out/gpu-tests`，不放到源码或游戏目录。

浏览器媒体诊断页依赖真实游戏清单，放在 `tools/browser`，运行方式见 [工具说明](../../tools/README.md)。Go 存档后端测试继续与源码同放，运行 `go test ./...`。
