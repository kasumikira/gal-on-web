# Gal on Web

浏览器中的 Kirikiri 运行时。原版 TJS2、KAGParser 和 Scripts 在同一个 WASM 模块中执行，渲染、音频及其余业务 Native 接口由 JavaScript 实现。Go 提供游戏清单和文件区间读取。

## 启动

安装 pnpm、Go 1.24 或以上，执行：

~~~powershell
pnpm install
pnpm dev
~~~

打开 http://127.0.0.1:5173。默认寻找唯一的 tests/*/data.xp3。也可以单独启动资源服务器并指定游戏：

~~~powershell
go run ./cmd/galweb -game "D:/games/游戏目录" -addr 127.0.0.1:8080
~~~

浏览器需支持 WebAssembly JSPI。开发服务器通过 /api 代理访问 Go 服务。运行时资源按 HTTP Range 读取，不预先解包整个 XP3。

存档默认写入 `tests/savedata.sqlite`（可用 `-save` 指定）：每个存档文件一行，内容存为 BLOB，便于把整个存档目录当单个文件复制复现问题。`?save=memory` 可切回刷新即丢弃的内存存档。

## 构建

native/kirikiri 是唯一 C++ 项目，按原版 core 与 plugins 布局组织。首次配置、工具链及依赖说明见 [native/kirikiri/README.md](native/kirikiri/README.md)。

~~~powershell
pnpm build:vm
pnpm build:js
~~~

WASM 运行时生成到 `web/engine-js/tjs-runtime`，前端统一构建到 `web/build`。Go 服务默认托管该目录，打开 8080 根页面即可进入游戏。可通过 `-web` 指定其它前端构建目录。

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
- tools：接口索引、开发诊断和现有验证工具。
- out：构建缓存及已安装依赖。

## 状态与来源

最近已在浏览器验证开场至标题菜单，尚未完成设置、新游戏及整款游戏验收。具体范围和后续工作见 [验证状态](docs/STATUS.md)。

原生源码基于 third_party/kirikiroid2 中的 Kirikiroid2/TJS2 参考实现，来源及许可证保存在 native/kirikiri。游戏资源不随源码发布。

## 开发文档

- [运行时架构](docs/VM-DESIGN.md)：JS/WASM 职责、对象生命周期与执行边界。
- [Native 绑定开发规范](docs/NATIVE-BINDINGS.md)：装饰器、脚本调用、借用、retain/dispose 和异步事件规则。
- [原生构建](native/kirikiri/README.md)：正式 C++ 项目和工具链。
- [接口索引](ENGINE-MIGRATION.md)：自动生成的原版接口声明清单。
