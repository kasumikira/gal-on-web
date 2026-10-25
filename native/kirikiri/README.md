# Kirikiri WASM 运行时

这是正式的 C++ 脚本运行时项目。CMake 生成 tjs-runtime，包含原版 TJS2、KAGParser、Scripts、核心类及按需加载的原生插件；源码编译、字节码加载和执行使用同一个 tTJS 实例。

## 源码布局

- core/tjs2/：TJS2 编译、执行、对象系统、内建类及语法生成输入。
- core/base/：KAGParser、Scripts、Rect/Pad/MenuItem、平台接口和内存流。
- core/plugin/：同模块插件注册器、ncbind 及运行时类元数据。
- core/utils/：原版 MD5 实现。
- core/common/：公共头文件。
- plugins/：scriptsEx、csvParser、saveStruct、TextRenderBase、脚本 PSBFile、JSON、Expat 与 kirikiroid2 扩展的同模块注册。
- runtime.h / runtime.cpp：运行时状态、借用与 owner 持有值、导出索引和生命周期。
- runtime-api.cpp：值、对象、脚本执行等 WASM 导出 API。
- runtime-host.cpp：JS Native 类、方法、属性、只读对象及异步调用桥接。
- runtime-platform.cpp：文本/二进制流、存储和平台接入。

源码以 third_party/kirikiroid2/cpp 的对应实现为基础，参考提交为 2028cbccaa91498bd36f270d349ae711d0e8fed3。此目录的代码直接维护和编译；参考目录用于语义核对。许可证见 LICENSE 和各文件头。

## 构建

使用已安装的 Emscripten SDK；项目不会下载或安装 SDK。仅通过 `native/emscripten-major.txt` 限定大版本（6.x），不限制次版本或补丁版本；`pnpm build:vm` 检查大版本并输出实际 SDK 版本。工具链应及时更新；只有确实依赖特定版本的补丁才可例外固定，并注明补丁原因。

所需工具：Node.js 22.12 或以上、pnpm、CMake 3.28 或以上、Ninja、Python 3、Bison，以及已安装的 vcpkg。将工具加入 `PATH`；Windows 可使用 MSYS2 的 Bison，但应将 MSYS2 的 `usr/bin` 追加到 PATH，避免其 CMake 覆盖 Windows 原生 CMake。依赖编译所需的宿主工具也须可用（Windows 使用 Visual Studio C++ Build Tools）。

在构建终端加载 SDK 官方环境脚本，并设置已有 vcpkg 的位置。例如本机 PowerShell：

```powershell
& ./tools/emsdk/emsdk_env.ps1
$env:VCPKG_ROOT = 'D:/vcpkg'
$env:PATH += ';C:/msys64/usr/bin'
pnpm build:vm
```

SDK 位于其他目录时，执行该目录中的 `emsdk_env.ps1` 即可，无须修改源码。Linux/macOS 使用 `source <sdk>/emsdk_env.sh`、`export VCPKG_ROOT=<vcpkg目录>`，并安装宿主 Bison、Python、CMake 和 Ninja。

`CMakePresets.json` 是命令行与编辑器共用的配置入口。vcpkg 作为主工具链，chainload SDK 官方 `Emscripten.cmake`，使用 `wasm32-emscripten` triplet；配置阶段自动按 `vcpkg.json` 安装依赖，不需要预先创建 CMakeCache。依赖安装位置为 `out/vcpkg_installed`；配置和编译缓存位于 `out/kirikiri`。不提交这些缓存。

`pnpm build:vm` 在本目录依次执行：

```sh
cmake --preset wasm-release
cmake --build --preset wasm-release
```

随后复制运行时到前端源码目录。VS Code 从已经加载上述环境的终端启动，并选择 `wasm-release` preset。若迁移 SDK 或更换工具链，可在本目录运行 `cmake --fresh --preset wasm-release` 重新配置。

配置依据：[Emscripten 官方安装说明](https://emscripten.org/docs/getting_started/downloads.html)、[官方 CMake 构建流程](https://emscripten.org/docs/compiling/Building-Projects.html#cmake-based-projects)、[vcpkg 的 Presets 和工具链组合](https://learn.microsoft.com/en-us/vcpkg/users/buildsystems/cmake-integration)。

构建脚本生成 `web/engine-js/tjs-runtime/tjs-runtime.js` 与 `tjs-runtime.wasm`，由 `pnpm build:js` 打包到前端产物中。归档解析和平台 IO 仍在 JS，7z 使用 npm 的 libarchive.js。

Bison 语法和日期词表按输入依赖在构建目录生成。源码修正直接保存在代码中，不在 CMake 配置期间字符串替换或生成修补副本。内嵌 JS 使用 clang-format off/on，避免 C++ 格式化破坏 JS 运算符。

## 平台边界

脚本编译、执行、内建容器、KAGParser 和脚本对象生命周期由 C++ 及原版 TJS2 实现。图像、渲染、音频、归档和实际资源 IO 在 JS；绑定层通过不透明句柄调用 API，C++ 管理调用期间的 Variant 和宿主根。

scriptsEx、saveStruct 和其他 native 插件复用参考 ncbind 声明及调用模板，解析、脚本对象操作与序列化体沿用原版：csvParser 的 `parse()` 是当前调用帧内的嵌套回调，saveStruct 直接写 UTF-16 码元而不再套文本流 BOM。浏览器存储和文本编码通过平台接口接入 JS 资源层。

`BinaryWriteStream` 将二进制存档缓冲在内存中，并在析构时经宿主存储接口提交，提交调用会等待完成。`tTJSBinaryStream` 的析构不可抛异常，因此析构阶段的存储失败不能从原版 `Array.saveStruct`／`Dictionary.saveStruct` 返回给脚本；该行为保留核心的原有流删除路径，不通过修改核心接口弥补。

JS WeakMap 保存宿主身份、类声明元数据和影子的 API 端点/不透明句柄，不记录脚本对象的调用关系、有效性或所有权。C++ 维护身份到导出项、dispatch 到导出项和 owner 到持有值的索引；删除索引和提取 Variant 均发生在可能重入的释放之前。同一身份的导出选择以及持有值的释放按句柄升序处理，保持原先有序表的行为。

TextRenderBase 的排版状态和方法体使用参考 `textrender/TextRender.cpp`；类注册和容器访问复用参考 ncbind 模板，保留原来的引用、属性标志和接收者。字宽、字体变化与表达式回调仍经现有 TJS dispatch，在当前调用内嵌套等待，不新增宿主操作或 WASM 导出。

坐标、尺寸、延迟等结果恢复参考的 TJS real 类型；旧 JS 绑定会把其中数值为整数的结果编码为 int。现有数组长度查询保留普通 Array 的 native 实例路径，并支持 PSB 只读数组的 dispatch GetCount，避免把只读 PSB 节点当作普通 Array 实例。

脚本 PSBFile 的 `load(string/octet)`、`root` 和只读 PSBValueDispatch 在 C++ 中实现，文件读取复用现有二进制流回调，MDF 解压静态链接 zlib。原始缓冲区和节点引用由参考 PSBFile/PSBRawOwner 管理。`psb://` 媒体、Motion 的 JS PSB 节点解析与 codecs 图像路径保持原实现，不引入 native 媒体接口。

`kirikiroid2.dll` 的 `_str_ord` 在 native 注册，字符串返回第一个 UTF-16 码元，其他 Variant 原样返回。使用字符串访问器替代参考对 ShortString 字段的直接读取，以保持原 JS 实现对长字符串的行为；`Storages.setTextEncoding` 继续复用既有存储服务，不增加编码状态或桥接接口。

JSON 与 Expat 采用 [Wamsoft/json](https://github.com/wamsoft/json) 和 [Wamsoft/expat](https://github.com/wamsoft/expat) 的实现，改为同模块注册并复用现有存储读写与 TJS 回调，不新增 WASM 导出或宿主操作。原 DLL 的私有类放入各自匿名命名空间，避免与 saveStruct 等插件产生同名类链接冲突。

JSON 提供 Scripts.evalJSON、evalJSONStorage、saveJSON、toJSONString，保留参考的注释、单引号、分号等扩展及数值解析规则，而不是替换成浏览器 JSON.parse。相对来源修正了 utf8 参数误读为指针及未闭合字符串遇 EOF 无限循环的问题；普通数组长度通过内建 Array 实例取得，PSB 只读数组通过 dispatch GetCount 取得，不跨 Runtime 缓存 Array.count dispatch。文本写出仍受现有二进制写流析构提交的错误传播限制。

Expat 静态链接 vcpkg Expat，提供 XMLParser.parse/parseStorage 及六个错误/位置只读属性。回调目标优先级为构造参数、parse 的第二参数、实例本身；事件按现有 TJS dispatch 嵌套等待。临时方法引用以 Variant 管理，确保脚本回调抛错时也释放。

## Native 插件注册

`core/plugin/ncbind.hpp`、`ncb_invoke.hpp` 和 `ncb_foreach.inc` 来自 Kirikiroid2。插件使用 `NCB_MODULE_NAME`、`NCB_REGISTER_CLASS`、`NCB_ATTACH_CLASS`、`NCB_REGISTER_FUNCTION` 及注册回调声明接口，保留 Factory、属性、转换器及实例 hook。CSVParser 保留原有 TJS 类实现，通过模块注册回调安装；JSON 同样通过回调安装其手写 dispatch。

`PluginRegistry.cpp` 只构建一次模块索引；加载时依次执行 PreRegist、ClassRegist、PostRegist，完成后才记录已加载。模块名忽略大小写，重复加载不重复安装。模块描述可共享，类信息、持有的 TJS 引用及已加载集合均属于各自 Runtime，关闭时释放；不恢复进程级脚本引用或全局 AllUnregist。

JS 经唯一的 `tjs_plugins` JSPI 入口加载模块和查询已加载列表。`Plugins.link` 先加载 native 部分，再运行同名 JS 适配器（如 PSB 媒体支持）；`Plugins.getList` 合并两侧结果。Native 接口只在 link 后出现，`Plugins.unlink` 沿用参考实现的 native 空操作。浏览器插件仍按原有 JS 路径注册。新增纯 native 插件只需加入 CMake 和自身注册声明，无须再维护 JS 插件名表或逐插件桥接接口。

## Rect、Pad 与 MenuItem

这三个核心类由 Runtime 启动时创建，无须 Plugins.link。Rect 沿用 RectItf 和 ComplexRect 的简单矩形运算，未引入区域分配器；included(rect) 与 includedPos(x,y) 完全沿用参考接口。Font.getGlyphDrawRect 经现有 VM 构造调用返回 Rect，不再读取 JS Rect 状态。

Pad 使用参考 PadIntf 的常量属性与空 setter；平台编辑器仍未实现。MenuItem 的树、子项数组、ActionOwner/Window 引用、单选组及脚本事件由 C++ 管理；Window.menu 属性在 C++ 创建并按 Window 缓存，随窗口现有失效路径销毁菜单。窗口 visible/enabled 状态经 TJS 属性查询，菜单及祖先的 enabled 在 native 检查，支持已有异步宿主调用；浏览器窗口和绘制仍在 JS。popup 继续明确报未实现，shortcut/index setter 及 HMENU 保留现有兼容行为。没有新增 WASM 导出。
