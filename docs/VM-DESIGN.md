# 脚本运行时设计

## 执行与职责

脚本引擎使用一个 WASM 模块，包含原版 TJS2 编译器、解释执行器和内建类型。可选归档库 libarchive.js 的解压 WASM 是独立依赖，不承载脚本或 Native 业务。源码与已有字节码由同一个 tTJS 实例处理。KAGParser、Scripts 和 scriptsEx 在该实例内直接使用原版 Variant 与 dispatch。

JS 实现图像、渲染、音频、资源 IO 和其余业务 Native 接口。业务类使用普通 JS 类和装饰器；绑定层负责注册、参数/结果转换及 API 封装。开发方法见 [Native 绑定开发规范](NATIVE-BINDINGS.md)。

## 初始化配置

页面调用 `createRuntime(options)`，显式传入只读游戏存储 `gameStorage`、可写存档存储 `saveStorage`、XP3 入口 `entry`、`document`、`container`、`wasmURL`、通知回调 `inform`/`message`、脚本参数 `arguments`、未实现策略 `unimplementedMode`、帧调度模式 `continuousFrameRate` 和标题回调 `onTitleChange`。宿主配置默认值由 `web/main.js` 给出，引擎内部不重复补齐。`saveStorage: null` 是显式只读模式。页面入口自行设置临时标签页标题，不将其传入引擎；`System.title` 初始为 `kirikiriz`，读取和初始化不触发回调，仅脚本赋值时调用 `onTitleChange`。

`global.js` 的 `initializeGlobals()` 在创建 VM 前校验配置，运行时入口检查 entry 是否存在于文件清单中；子系统信任初始化后的配置。脚本 Native 方法自身的参数个数、类型转换与语义校验仍按原版执行，不能与宿主初始化参数校验混为一谈。

当前每个页面使用一份运行配置、运行一个游戏。`config` 供 System、窗口、音视频、输入与插件共享通知、文档、帧调度等宿主配置；事件队列、VM、脚本对象和活跃音频上下文仍留在运行时内部，不放入全局配置。对象操作需要的具体依赖继续显式传递。

两个存储均提供异步 `list()` 和 `read(path, offset, length)`：前者返回 `{ path, size }` 文件列表，后者返回指定字节范围的独立 `Uint8Array`，路径使用列表中的拼写。`saveStorage` 额外提供 `write(path, bytes)` 和 `delete(path)`，写入路径是引擎规范化后的虚拟绝对路径。同路径文件由存档存储覆盖游戏存储；XP3 成员和插件媒体保持只读。

HTTP Range 游戏存储由 `web/main.js` 创建；存档默认写入 Go 服务的 SQLite 后端（每个存档文件一行为 BLOB），`?save=memory` 切回刷新即丢失的内存存储。引擎保留 XP3 格式解析、7z 归档适配、虚拟路径、自动路径、插件媒体和写入后的缓存失效语义，不依赖清单格式或网络协议，不提供默认存储后端，也不负责猜测 XP3 入口。

## 对象与生命周期

影子元数据只有 API 端点与不透明句柄，C++ 保存完整 `tTJSVariant`，复用原版引用计数、闭包上下文、native instance、失效与终结机制。JS 不记录引擎内部调用关系或引用关系，也不缓存对象有效性。

JS 普通对象由 V8 管理。C++ 保存宿主 handle，绑定层宿主表持有实际 JS 值；原版 C++ 所有者结束时解除对应宿主根。JS 不再实现一套对象引用计数或 GC。

借用期限、retain/dispose 和常驻根由 C++ 管理。参数自动借用与显式借用块均止于 JS 同步返回；跨异步边界使用 retain 返回的新影子，并在 finally 中 await dispose。少量贯穿 runtime 的值使用 pin。JS 代理本身的存活不延长借用。

函数与对象使用同一种影子；完整 Variant 已保存原版上下文，不另建闭包持有机制。原版成员赋值负责脚本对象之间的持有关系。资源清理仍在 JS，由原版失效/终结路径触发。

## 引用环与运行时回收

当前 C++ 对象位于 WASM 线性内存中，并非 WasmGC 对象堆。运行期间，单个 TJS 对象依赖原版引用计数与显式 invalidate；V8 不负责回收线性内存里的单个对象。原版 `tTJS::DoGarbageCollection()` 只整理 Variant 栈和字符串堆，不追踪跨对象的强引用环。环内对象及其 native 宿主状态因此可能持续占用内存。

已确认的实例是标题 `title.ks:36 [s]` 关闭时的 `EnvGraphicLayer.owner → EnvLayerObject.targetLayer → 同一个 EnvGraphicLayer`。窗口终结后 World 已失效，但 EnvLayerObject 仍有效；随后失效残留图层，触发 `EnvLayerObject.finalize → clear → world.stopAction`，因 World 已失效而报错。独立纯 TJS 示例也能复现：World 持有 Item，Item 与 Layer Dictionary 相互持有，World 失效后 Item 仍有效，晚于 World 执行 finalize 会产生相同错误。这确认了引用环与晚终结机制，但尚未证明原版完整游戏退出路径也会报同样错误。

整台实例的回收与上述逐对象回收分开处理。WASM 实例、导出函数和内存缓冲不再被外部强引用持有时，V8 可以回收整个不可达对象图；实例内部未解开的 TJS 引用环本身不阻止这一过程。因此保留原版脚本引用行为，不为该环增加 JS 引用图、追踪 GC 或推测性的终结排序。

曾确认的宿主泄漏发生在关闭失败出口：`TJSInterop.dispose()` 抛错后未解除模块级 `primitiveRuntime`，该全局入口继续持有 VM、WASM module 和宿主回调表。现由 finally 统一解除该入口、清空回调表，并清除 WASM module 与 runtime 地址。正常关闭仍调用原版 shutdown/destroy；原版终结失败时保留原始错误，随后断开宿主引用，让整个不可达实例交给 V8 回收，不再批量强制失效残留脚本对象。

关闭先停止宿主调度并等待已进入的调用排空，再执行组件和 VM 终结；音频上下文在 finally 中关闭。成功或失败后均不再使用旧 VM 及其影子。运行时整体回收不改变正常运行中的借用、retain/dispose 或 invalidate 合同，也不代表每个脚本 finalize 都成功完成。

2026-10-17 的最小真实 WASM 验证：修复前，丢弃应用引用并强制 GC 后，module 和线性内存缓冲的 WeakRef 仍存活；修复后，即使保留旧 VM 包装对象，两者也能被回收，宿主回调表为空，随后新建 VM 计算和关闭通过。该验证证明可回收性，不保证浏览器的 GC 时机或进程工作集立即下降。调用方保留的 WASM 内存视图、导出函数及调试对象仍可能延长实例或内存的寿命，需要由持有方释放。

## 挂起与事件

WASM 通过 JSPI 等待 JS 宿主操作，宿主也能调用脚本。正常调用按严格嵌套顺序完成；独立浏览器事件通过现有串行事件队列交付。当前没有统一执行锁或执行凭据，正确性依赖调用者传递完整 Promise，并避免挂起时另一条独立调用直接进入同一个 VM。

对象保活与执行顺序是两个问题：retain 不赋予并行调用 VM 的能力。当前 `host_call` 的借用清理与异步结果处理仍有待专项核对，不能将既有单项验证视为整体重入安全证明。

## 源码与构建

正式项目为 `native/kirikiri`。`core/tjs2` 保存语言核心，`core/base` 保存 KAGParser、ScriptMgnIntf 与平台声明，`core/utils` 保存原版工具，`plugins` 保存脚本工具扩展；`runtime.cpp` 保存运行时状态，`runtime-api.cpp`、`runtime-host.cpp`、`runtime-platform.cpp` 分别提供导出 API、宿主绑定和平台接入。

`pnpm build:vm` 生成一个 WASM 运行时及其 JS 加载器；`pnpm build:js` 从 `web/index.html` 打包游戏页面到 `web/build`，同目录的 `main.js` 通过 ES import 加载引擎代码。Go 构建通过 `//go:embed` 把 `web/build` 编入二进制，运行时不再读取该目录。构建缓存位于 `out/kirikiri`，依赖位于 `out/vcpkg_installed`。工具链见 [原生项目说明](../native/kirikiri/README.md)。
