# Kirikiri WASM 运行时

这是正式的原生引擎项目。CMake 只生成一个运行时目标 tjs-runtime，包含原版 TJS2、KAGParser、Scripts 和 scriptsEx；文本编译、字节码加载和执行使用同一个 tTJS 实例。语言实现所需的编译过程属于运行时内部功能。

## 源码布局

- core/tjs2/：TJS2 编译、执行、对象系统、内建类及语法生成输入。
- core/base/：KAGParser、ScriptMgnIntf、平台接口和内存流。
- core/utils/：原版 MD5 实现。
- core/common/：公共头文件。
- plugins/：scriptsEx 的原版方法实现及同模块注册。
- runtime.h / runtime.cpp：运行时状态、借用与 owner 持有值、导出索引和生命周期。
- runtime-api.cpp：值、对象、脚本执行等 WASM 导出 API。
- runtime-host.cpp：JS Native 类、方法、属性、只读对象及异步调用桥接。
- runtime-platform.cpp：文本/二进制流、存储和平台接入。

源码以 third_party/kirikiroid2/cpp 的对应实现为基础，参考提交为 2028cbccaa91498bd36f270d349ae711d0e8fed3。此目录的代码直接维护和编译；参考目录用于语义核对。许可证见 LICENSE 和各文件头。

## 构建

首次使用 CMake Tools 按 .vscode/settings.json 配置本目录，生成 out/kirikiri/CMakeCache.txt。之后执行 pnpm build:vm。依赖安装位置为 out/vcpkg_installed；配置和编译缓存位于 out/kirikiri。

构建脚本生成并发布 web/engine-js/tjs-runtime/tjs-runtime.js 与 tjs-runtime.wasm。前者是同一模块的加载器。pnpm build:js 将该唯一 WASM 模块打包到前端产物中。

Bison 语法和日期词表按输入依赖在构建目录生成。源码修正直接保存在代码中，不在 CMake 配置期间字符串替换或生成修补副本。内嵌 JS 使用 clang-format off/on，避免 C++ 格式化破坏 JS 运算符。

## 平台边界

脚本编译、执行、容器、解析器及原生对象生命周期由 C++ 和原版 TJS2 实现。图像、渲染、音频、资源 IO 等业务接口在 JS；JS 通过不透明句柄调用 API，C++ 管理调用期间的 Variant 和宿主根。

scriptsEx 使用直接注册替代跨 DLL 的 ncbind 注册，属性调用直接使用同模块 dispatch；脚本对象操作方法体沿用原版。浏览器存储和文本编码通过平台接口接入 JS 资源层。

JS WeakMap 仅分配宿主对象的身份编号，不缓存脚本句柄、有效性或所有权。C++ 维护身份到导出项、dispatch 到导出项和 owner 到持有值的索引；删除索引和提取 Variant 均发生在可能重入的释放之前。同一身份的导出选择以及持有值的释放按句柄升序处理，保持原先有序表的行为。
