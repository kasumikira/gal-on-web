# Gal on Web

浏览器中的 Kirikiri 运行时。原版 TJS2、KAGParser 和 Scripts 在同一个 WASM 模块中执行，渲染、音频及其余业务 Native 接口由 JavaScript 实现。Go 提供游戏清单、文件区间读取和内嵌前端页面。

## 启动

安装 pnpm、Go 1.24 或以上，执行：

~~~powershell
pnpm install
pnpm build:js
pnpm dev
~~~

打开 http://127.0.0.1:5173。默认寻找唯一的 tests/*/data.xp3。也可以单独启动资源服务器并指定游戏：

~~~powershell
go run ./cmd/galweb -game "D:/games/游戏目录" -addr 127.0.0.1:8080
~~~

Go 构建通过 `//go:embed` 内嵌 `web/build`。运行 `pnpm dev`、`go run` 或 `go build` 前需先执行一次 `pnpm build:js`；`pnpm dev` 并行启动 Go API 与 Vite，开发时页面由 Vite 提供。浏览器需支持 WebAssembly JSPI。开发服务器通过 /api 代理访问 Go 服务。运行时资源按 HTTP Range 读取，不预先解包整个 XP3。

存档默认写入 `tests/savedata.sqlite`（可用 `-save` 指定）：每个存档文件一行，内容存为 BLOB，便于把整个存档目录当单个文件复制复现问题。`?save=memory` 可切回刷新即丢弃的内存存档。

## 构建

原生构建默认利用全部可用逻辑 CPU：VM 的 CMake/Ninja、vcpkg 和 libav Make 自动按可用 CPU 数并行；Rust Cargo 和 Go 使用各自默认的 CPU 并行调度。显式设置的 `CMAKE_BUILD_PARALLEL_LEVEL`、`VCPKG_MAX_CONCURRENCY` 等工具环境配置仍受尊重。Vite 保持自身的构建调度，串行阶段不会强制拆分。

native/kirikiri 是 TJS2 与原生插件的 C++ 项目，按原版 core 与 plugins 布局组织。先在当前终端加载已安装 SDK 的官方环境脚本，设置 `VCPKG_ROOT`，并确保 CMake、Ninja、Python、Bison 可用。具体步骤见 [native/kirikiri/README.md](native/kirikiri/README.md)。首次构建不依赖 VS Code 或已有 CMake 缓存。

完整构建还需要 Rust stable 和 `wasm32-unknown-unknown` target（`rustup target add wasm32-unknown-unknown`），以及 Go 1.24 或以上。先在 MSYS2 终端加载 SDK 环境并执行 `bash native/libav/build.sh` 构建 WMV 后端，详见 [native/libav/README.md](native/libav/README.md)。再在 PowerShell 中构建其余部分：

~~~powershell
pnpm build:vm
pnpm build:codecs
pnpm build:js
go build -o galweb.exe ./cmd/galweb
~~~

WASM 运行时生成到 `web/engine-js/tjs-runtime`，前端统一构建到 `web/build`。Go 通过 `web/embed.go` 将前端产物编入二进制；生成的 `galweb.exe` 不再依赖外部前端文件。打开 8080 根页面即可进入游戏。开发时可通过 `-web` 指定其它前端构建目录覆盖内嵌内容。

## 页面配置

`web/index.html` 以标准 `<script type="module" src="/main.js">` 加载同目录的 `main.js`。入口读取 URL 参数和游戏清单，通过普通 ES import 使用 `engine-js` 下的运行时、存储及 WASM 资源。当前只构建游戏页面。

通知、帧调度、标题更新回调和存储后端在 `web/main.js` 中传给运行时。页面入口以清单标题作为临时标签页标题；`System.title` 初始为原版引擎名 `kirikiriz`，仅脚本赋值时通知页面更新标题。

入口调用 `createRuntime(options)`，显式传入 `gameStorage`、`saveStorage`、`entry`（XP3 虚拟路径）和运行配置。页面采用清单中的入口，依次执行游戏根目录的 `patch.tjs`（若存在）、入口内的 `startup.tjs`、游戏根目录的 `AfterStartup.tjs`（若存在）。

默认值和具体存储实现只放在 `web/main.js`：`gameStorage` 提供只读游戏文件，`saveStorage` 提供可写存档，传 `saveStorage: null` 表示只读。两个后端均实现异步 `list()`（返回 `{ path, size }`）和 `read(path, offset, length)`（返回独立 `Uint8Array`），存档后端额外实现 `write(path, bytes)` 和 `delete(path)`（返回是否实际删除），写入路径是引擎规范化的虚拟绝对路径。同路径存档覆盖游戏文件。HTTP Range 访问由 `createHTTPGameStorage()` 实现，XP3 解析仍由引擎负责；`createHTTPSaveStorage()` 对应 Go 的 `/api/saves` 后端（SQLite），`createMemoryStorage()` 是刷新即丢弃的对照后端。

配置由初始化入口统一校验，并保存在 `web/engine-js/global.js`，各子系统读取共享配置，当前每个页面运行一个游戏。

## 项目结构

- native/kirikiri：正式 WASM 运行时源码、平台适配和构建入口。
- web/index.html、web/main.js：游戏页面和启动入口。
- web/engine-js：JS Native 接口、资源读取、解码、渲染和音频。
- internal/library：游戏资源枚举及引擎无关清单。
- internal/save：SQLite 存档后端（每个存档文件一行为 BLOB）。
- internal/server：HTTP 清单、Range 读取和静态文件服务。
- web/tests：引擎回归测试、GPU 原版对照与浏览器视频测试。
- tools：归档、脚本、音视频与设备调试工具。
- tests：本地游戏资源和复现存档，不是引擎测试目录。
- out：构建缓存及已安装依赖。

## 状态与来源

当前验证范围及尚未覆盖的边界见 [验证状态](docs/STATUS.md)。测试命令和浏览器入口见 [引擎测试](web/tests/README.md)，开发工具见 [工具说明](tools/README.md)。

原生源码基于 third_party/kirikiroid2 中的 Kirikiroid2/TJS2 参考实现，来源及许可证保存在 native/kirikiri。游戏资源不随源码发布。

## 开发文档

- [运行时架构](docs/VM-DESIGN.md)：JS/WASM 职责、对象生命周期与执行边界。
- [Native 绑定开发规范](docs/NATIVE-BINDINGS.md)：装饰器、脚本调用、借用、retain/dispose 和异步事件规则。
- [原生构建](native/kirikiri/README.md)：正式 C++ 项目和工具链。
- [文档索引](docs/README.md)：当前规范、调查记录与参考清单。
- [目录组织与后续拆包建议](docs/REPOSITORY-LAYOUT.md)。
- [接口索引](docs/reference/ENGINE-INTERFACES.md)：自动生成的原版声明清单，不作为实现覆盖率。
