# Kirikiri WASM 运行时

这是正式的 C++ 脚本运行时项目。CMake 生成 tjs-runtime，包含原版 TJS2、KAGParser、Scripts、scriptsEx、csvParser 和 saveStruct；源码编译、字节码加载和执行使用同一个 tTJS 实例。

## 源码布局

- core/tjs2/：TJS2 编译、执行、对象系统、内建类及语法生成输入。
- core/base/：KAGParser、ScriptMgnIntf、平台接口和内存流。
- core/utils/：原版 MD5 实现。
- core/common/：公共头文件。
- plugins/：scriptsEx、csvParser 和 saveStruct 的参考实现及同模块注册。
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

scriptsEx 使用直接注册替代跨 DLL 的 ncbind 注册，属性调用直接使用同模块 dispatch；脚本对象操作方法体沿用原版。csvParser 与 saveStruct 同样以直接注册替代 ncbind，解析与序列化体沿用原版：csvParser 的 `parse()` 是当前调用帧内的嵌套回调，saveStruct 直接写 UTF-16 码元而不再套文本流 BOM。浏览器存储和文本编码通过平台接口接入 JS 资源层。

`BinaryWriteStream` 将二进制存档缓冲在内存中，并在析构时经宿主存储接口提交，提交调用会等待完成。`tTJSBinaryStream` 的析构不可抛异常，因此析构阶段的存储失败不能从原版 `Array.saveStruct`／`Dictionary.saveStruct` 返回给脚本；该行为保留核心的原有流删除路径，不通过修改核心接口弥补。

JS WeakMap 保存宿主身份、类声明元数据和影子的 API 端点/不透明句柄，不记录脚本对象的调用关系、有效性或所有权。C++ 维护身份到导出项、dispatch 到导出项和 owner 到持有值的索引；删除索引和提取 Variant 均发生在可能重入的释放之前。同一身份的导出选择以及持有值的释放按句柄升序处理，保持原先有序表的行为。
