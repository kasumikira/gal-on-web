# libav.js 视频后端

`bash native/libav/build.sh` 使用已安装并加载环境的 Emscripten SDK，构建 `krkr-wmv` 变体。只限定 libav.js **6.x** 和 SDK **6.x**，不为复现产物固定次版本或补丁版本。SDK 大版本与 Kirikiri 共用 `native/emscripten-major.txt`；脚本不安装或升级 SDK，应自行保持已有 SDK 更新。

每次构建查询 libav.js 6.x 最新正式发布 tag，并更新 `out/libavjs-src` 到该版本。FFmpeg 和 emfiberthreads 使用该上游版本 Makefile 指定的组合；FFmpeg 版本需与上游附带的补丁集匹配，不在本项目另行固定。确实依赖特定版本的补丁可以例外，但必须注明补丁及原因。

`config-fragments.json` 是变体的配置输入：avcodec/avformat/avfilter 的 JS 接口，ASF、MOV/MP4、Matroska/WebM demuxer，H.264/AAC parser，H.264、WMV3/WMA2 decoder，以及 format/scale filter 和 swscale。ASF/H.264 缺失 PTS 时，只在探测阶段用软件解码器测出初始重排延迟，随即释放；正式播放的 H.264、AAC、VP8 等编码仍通过 `libavjs-webcodecs-bridge` 交给浏览器解码。没有构建 AAC 软件解码器、编码器、asm.js 或线程版本。

## 构建

需要 Git、Node.js/npm、Bash、GNU Make、tar、xz、curl、patch、sed 和常规 Unix 构建工具。每次构建需要网络查询最新发布版；首次构建还会克隆上游源码、安装上游 npm 依赖，并由上游 Makefile 下载 FFmpeg 和 emfiberthreads 源码。

Windows 用户在 MSYS2 UCRT64 终端中直接运行脚本，使用已有的 Windows SDK。FFmpeg 构建还需要宿主 GCC 生成构建工具。按实际项目和 SDK 安装位置调整路径：

```sh
cd /d/dev/gal-on-web
source /d/emsdk/emsdk_env.sh
bash native/libav/build.sh
```

MSYS2 中缺少构建工具时，执行 `pacman -S --needed make diffutils patch tar xz curl mingw-w64-ucrt-x86_64-gcc`。确保 Git、Node.js/npm、GCC 和 SDK 工具在该终端的 PATH 中可用。Kirikiri 的 CMake 构建仍在 PowerShell 中使用 Windows 原生 CMake。

Linux/macOS 在加载 SDK 官方环境脚本后执行：

```sh
source /path/to/emsdk/emsdk_env.sh
bash native/libav/build.sh
```

构建目录为 `out/libavjs-src`。脚本不覆盖上游源码的本地修改；有修改时直接报错，先将修改整理为明确的补丁。构建脚本在 `configs` 目录调用上游 `mkconfig.js`，再通过上游 Makefile 构建 ES module 入口及 WASM 后端。上游版本或配置输入更新时重新生成变体；后续构建复用上游 Make 的增量缓存。

## 产物与版本

编译按当前进程可用的逻辑 CPU 数设置 Make 并行任务数；上游递归 Make 会继承这一设置。

脚本输出实际参与编译的 libav.js、FFmpeg、emfiberthreads 和 Emscripten 版本，并生成 `out/libav/build-info.json` 供检查。

运行时资源自动复制到 `web/engine-js/codecs/libav/`，使用稳定的源码文件名：

- `libav-krkr-wmv.mjs`：前端使用的稳定入口。
- `libav-krkr-wmv.wasm.mjs`：后端加载器。
- `libav-krkr-wmv.wasm.wasm`：对应的 WASM。

FFmpeg、emfiberthreads、libav.js 的对应源码归档，以及本项目的配置、构建脚本和说明放在 `out/libav/sources/`，供分发时提供对应源码。保留生成文件中的许可证头。前端目录只保留上述三个运行文件：JS 接入层导入入口，通过 `?url` 导入后端和 WASM，将地址传给上游的 `toImport`、`wasmurl` 参数。Vite 管理资源输出及哈希文件名，Go 随前端一起内嵌。

执行 `bash native/libav/build.sh` 后再运行 `pnpm build:js` 或 `pnpm build:go`。源码及构建缓存留在 `out`，项目维护的构建配置统一位于 `native/libav`。
