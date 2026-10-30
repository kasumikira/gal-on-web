# Kirikiri WASM 运行时

这是正式的 C++ 引擎运行时项目。CMake 生成 tjs-runtime，包含原版 TJS2、KAGParser、Scripts、System、视觉类、GLES 后端及按需加载的原生插件；源码编译、字节码加载和执行使用同一个 tTJS 实例。

## 源码布局

- core/tjs2/：TJS2 编译、执行、对象系统、内建类及语法生成输入。
- core/base/：KAGParser、Scripts、Rect/Pad/MenuItem、平台接口和内存流。
- core/plugin/：同模块插件注册器、ncbind 及运行时类元数据。
- core/utils/：原版 MD5 实现。
- core/common/：公共头文件。
- visual/：原版 Layer/LayerManager、Font/FreeType、Bitmap、图形缓存、转场、事件及浏览器窗口适配。
- render/：Emscripten GLES、纹理、分块位图、混合方法与呈递。
- image/：PNG/JPEG/TLG/WebP 和图像加载入口。
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

脚本编译、执行、内建容器、KAGParser、System、图层、字体、位图、Motion 和脚本对象生命周期由 C++ 实现。图像解码、FreeType 栅格化和 GLES 绘制也在 native；JS 提供浏览器窗口、输入采集、音视频、归档和实际资源 IO。绑定层通过不透明句柄调用 API，C++ 管理调用期间的 Variant 和宿主根。存储公共能力仍唯一保留在 JS，native 不维护第二份路径/归档状态。

scriptsEx、saveStruct 和其他 native 插件复用参考 ncbind 声明及调用模板，解析、脚本对象操作与序列化体沿用原版：csvParser 的 `parse()` 是当前调用帧内的嵌套回调，saveStruct 沿用历史 Wamsoft 的 UTF-8／当前代码页写流、精确 real 表达式和整形选项，默认换行保留 CRLF。实际字节 IO 通过平台接口接入 JS 资源层；文本流的编码、加密和压缩在 native。

`BinaryWriteStream` 将二进制存档缓冲在内存中，并在析构时经宿主存储接口提交，提交调用会等待完成。`tTJSBinaryStream` 的析构不可抛异常，因此析构阶段的存储失败不能从原版 `Array.saveStruct`／`Dictionary.saveStruct` 返回给脚本；该行为保留核心的原有流删除路径，不通过修改核心接口弥补。

JS WeakMap 保存宿主身份、类声明元数据和影子的 API 端点/不透明句柄，不记录脚本对象的调用关系、有效性或所有权。C++ 维护身份到导出项、dispatch 到导出项和 owner 到持有值的索引；删除索引和提取 Variant 均发生在可能重入的释放之前。同一身份的导出选择以及持有值的释放按句柄升序处理，保持原先有序表的行为。

TextRenderBase 的排版状态和方法体使用参考 `textrender/TextRender.cpp`；类注册和容器访问复用参考 ncbind 模板，保留原来的引用、属性标志和接收者。字宽、字体变化与表达式回调仍经现有 TJS dispatch，在当前调用内嵌套等待，不新增宿主操作或 WASM 导出。

坐标、尺寸、延迟等结果恢复参考的 TJS real 类型；旧 JS 绑定会把其中数值为整数的结果编码为 int。现有数组长度查询保留普通 Array 的 native 实例路径，并支持 PSB 只读数组的 dispatch GetCount，避免把只读 PSB 节点当作普通 Array 实例。

脚本 PSBFile 的 `load(string/octet)`、`root` 和只读 PSBValueDispatch 在 C++ 中实现，文件读取复用现有二进制流回调，MDF 解压静态链接 zlib。原始缓冲区和节点引用由参考 PSBFile/PSBRawOwner 管理。`psb://` 媒体、Motion 的 JS PSB 节点解析与 codecs 图像路径保持原实现，不引入 native 媒体接口。

`kirikiroid2.dll` 的 `_str_ord` 在 native 注册，字符串返回第一个 UTF-16 码元，其他 Variant 原样返回。使用字符串访问器替代参考对 ShortString 字段的直接读取，以保持原 JS 实现对长字符串的行为；`Storages.setTextEncoding` 与 `Scripts.textEncoding` 共同调用 native TextStream 的编码配置，不经过 JS。

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

## Timer 与 AsyncTrigger

两个类在 Runtime 启动时由 C++ 创建，沿用参考 TimerIntf/AsyncTrigger 的 TJS 绑定与 action 事件对象。TimerScheduler 的列表、待派发事件、ActionOwner 引用和取消规则均属于各自 Runtime。interval 保留参考的 16 位小数定点换算，不再截断为整数毫秒；内部初值也沿用 TimerImpl。interval=0 不触发；迟到按 NextTick 计算补发次数，超过 40 次时只触发一次并重新定位。capacity 默认 6，0 按 65535 处理；-laxtimer=yes 限制为 1。

web/engine-js/timer.js 只提供一个可取消的 setTimeout 唤醒源，所有 VM 回调经现有 enqueueEvent 串行投递。平台服务通过隐藏的 Timer._scheduler 和既有对象调用 API 配置；没有新增 WASM 导出。native 内按 exclusive、normal、idle 排序，回调中新发事件留待后续轮次；idle 在浏览器事件队列没有其他待处理工作时派发。此排序作用于迁入的 Timer/AsyncTrigger 队列，未将全部输入、音频、连续事件重写成参考的全局 EventIntf 队列。

禁用、修改启用中的 interval、失效会取消待派发事件；AsyncTrigger 的 cached 合并、cancel 及切换 cached/mode 后清队列在 native 完成。浏览器适配不创建参考计时线程或其 Emscripten 帧首扫描，实际唤醒精度仍受浏览器调度影响。宿主 stop 先取消唤醒，finalize 解除平台服务，再关闭 VM。

## Storages 与 TJS2Storage

架构约束：存储的公共能力放在 JS 侧，供 JS 与 native 共同使用。公共 JS 存储服务具有独立语义，不允许模仿 TJS2 同名类的行为，也不承担其参数转换、返回值、异常或类行为的兼容责任。TJS2 Storages 及相关插件语义由 native 实现，TJS2Storage 仅适配基础能力。

storage.js 是普通 JS 文件/归档服务；路径查找、autoPath 根列表和索引缓存是 JS 与 native 共用的能力，统一留在这里。没有 VM resolver，也不持有 TJS 对象或引擎引用。文件读写、XP3/7z 解包、插件 media 与字节缓冲区也在 JS。

storage.js 将基础服务注册为薄 TJS 类 TJS2Storage，提供 read/write，以及 dirlist/fstat 实际使用的本地 listDirectory/stat/deleteFile 与确定地址的 exists。readPlaced 是已确定地址的 JS fast path，read 则先使用同一 JS autoPath 查找，二者都不进入 VM。图片加载已确定地址后直接调用 readPlaced，避免图片字节送入 WASM。

native Storages 保留 TJS 静态接口、参数转换和路径/本地名语义，autoPath 添加、移除及资源查找调用共享 JS 服务；没有第二份 native autoPath 状态或缓存。native 文件流及插件使用同一个查找结果和基础后端。复用既有宿主回调，没有新增 WASM 导出。

fstat 扩展安装到 native Storages 类，XP3 过滤器 VM 复用同一基础服务。文本编码配置和自动探测选中的转换器由各自 Runtime 的 native TextStream 管理，独立于公共存储服务的状态。clearArchiveCache 等待归档释放并清除 JS 查找索引。文件选择/CD 搜索等未支持能力未在本次补入。

存储服务不再提供 TJS 风格的 getLocalName、extractStorageName/Path/Ext、chopStorageExt 或数值返回的 isExistentStorage；这些脚本接口留在 native Storages。JS 调用方使用布尔 has 查询，图片加载所需的扩展名拆分在调用处完成。当前目录、规范化和 autoPath 因为也是 JS 读取需要的共享能力，继续保留。

## dirlist 与 fstat

两个模块通过 ncbind 按需注册，JS 插件包装已删除。Storages 核心类沿用参考的 native 成员声明与路径拆分函数，保留 currentDirectory、getLocalName 和 setTextEncoding 扩展。native 归一化拒绝越过根目录或归档边界的上级路径；autoPath 与 currentDirectory 在 native 检查末尾分隔符。公共 JS 服务保留自己的接口与语义。

目录枚举仍以文件清单为来源，包含隐含子目录，不展开归档或插件 media。getDirList 返回规范化名称，不存在目录返回空数组；Storages.dirlist 保留显示大小写，不存在目录报错。两者均沿用参考实现，不向目录名追加斜杠。dirtree 递归返回相对名称，目录追加 `/`，第二参数可限定仅返回目录。显示名同时支持后端清单中的绝对路径与相对路径。

fstat 提供参考的七个 FILE_ATTRIBUTE 常量、TemporaryFiles，以及 Storages.fstat/getTime/getLastModifiedFileTime、dirlist/dirtree、getDisplayName、isExistentDirectory、isExistentStorageNoSearchNoNormalize、copyFile/copyFileNoNormalize、exportFile、moveFile、deleteFile 和 clearStorageCaches。copyFile 与 deleteFile 的来源经过 autoPath 查找；exportFile 可从归档读取。moveFile 只允许可删除的存档来源。copyFileNoNormalize 沿用参考实现，接受但不使用 failIfExist。TemporaryFiles 与参考一样仅检查可访问性，不登记清理任务。

本地 fstat 返回文件大小和三个时间字段；现有字节后端没有时间戳，与参考 VLFS 一样时间字段为 void，getLastModifiedFileTime 返回 0。归档或插件 media 中的 fstat 仅返回大小。本地缺失文件明确报错。currentPath 读取应用虚拟根目录 `/`，与 Storages.currentDirectory 分开。

完整参考注册表保留，后端不支持的接口明确抛出错误：setTime、setLastModifiedFileTime、truncateFile、dirlistEx（缺少原生权限与时间信息）、removeDirectory、createDirectory/createDirectoryNoNormalize、changeDirectory/currentPath 写入、setFileAttributes/resetFileAttributes/getFileAttributes、selectDirectory、searchPath（宿主 PATH）和 getTemporaryName。不复制参考中“未实现但返回成功”的占位行为，也不在 native 另建空目录、时间或权限状态。

所有读写与目录信息均来自共享 JS 服务，TJS2Storage 只适配基础能力。复制、移动及删除成功后等待共享归档清理并清除 autoPath 索引；错误继续传给脚本。没有新增 WASM 导出。

## TextStream

core/base/TextStream.cpp/.h 直接迁自参考实现，保留 BOM、SJIS/UTF-8/GBK 转换器、简单加密、zlib 压缩、模式解析和偏移读写。SJIS/GBK 使用参考的 core/utils/encoding 编码表；BOM UTF 转换使用已链接的 Boost，压缩使用已链接的 zlib，不增加依赖。默认编码和自动探测状态按 Runtime 隔离，不保留进程级编码状态。

TVPCreateStream 连接既有 JS 原始字节 IO，提供读、写及更新模式。文本流在 Destruct 中执行原版压缩收尾、回填长度，再显式等待二进制提交；析构只清理资源，不重试提交，关闭失败能返回脚本。原有 saveStruct 等二进制流析构提交契约不变。

相对参考修正了 z 模式未切入压缩路径的问题，c2 默认使用 zlib 默认级别，z0/z9 使用指定级别。Read(size) 限制为剩余字符数，截断加密头和越界压缩长度明确报错，窄文本转换保留最大码元长度所需的终止填充；其余格式和转换流程沿用参考。

System 的 RegisterData.tjs 通过 Scripts.evalStorage 读取，XP3 filter 的独立 VM 通过 Scripts.execStorage 启动，均复用 native TextStream。原 web/engine-js/text-stream.js 及其编码状态、浏览器压缩、文本宿主操作已删除；TJS2Storage 仅适配原始字节与目录能力。没有新增 WASM 导出。

## XP3 filter

plugins/xp3filter.cpp、BinaryAccessor.cpp 与 xp3filter.h 以参考插件为基础，过滤器闭包由各 Runtime 的 native 插件根持有。独立过滤器 VM 使用同一个 TJS2 运行时，注册现有 System 和 Debug 平台接口，通过 native TextStream 执行根目录 xp3filter.tjs；不在 native 创建第二套文件、归档或 autoPath 服务。

xp3filter.dll 按需安装隐藏的 Storages._xp3Filter 宿主入口；只有独立过滤器 VM 初始化该入口时，才注册 setXP3ArchiveExtractionFilter 与 setXP3ArchiveContentFilter。游戏 VM 加载插件不安装无效的回调注册器。JS 保留独立 VM 的启动、串行调用和字节传递，不保存解密闭包或文件级脚本上下文，也不生成 XP3Buffer 脚本类。

每次 XP3 文件读取创建一个 native 文件上下文。content filter 接收文件名、归档路径和原始大小，其返回数组的第二项由 native 持有并作为 extraction filter 的第六个参数跨分段传递；并发读取各自持有上下文。参考的模式 1 要求完整读取，而当前 JS 读取接口本就读取整个文件，因此无须新增模式或缓存。

extraction filter 仍在每个 segment 解压后调用，接收 hash、文件内偏移、CBinaryAccessor、块长度、文件名和上下文。字节索引、ptr 的 TJS 整数转换、复合运算及 xor 沿用参考 dispatch；不再逐字节调用 JS。字节块经原有 Octet API 进入 native 并返回处理结果，没有新增 WASM 导出。

CBinaryAccessor 借用当前块的字节，回调成功或失败后由 C++ 失效，保留的旧对象不能继续访问已释放内存。相对参考，补入失效检查，并修正自增/自减时对空 param 的解引用。JS 在正常读取和异常路径均释放 native 文件上下文；关闭独立 VM 时由 native 释放过滤器闭包。

XP3 的索引解析、解压和整文件读取仍在 JS，7z 不调用 XP3 filter。保持当前按 segment 调用的读取契约，没有扩展成任意大小的流式 IO。
