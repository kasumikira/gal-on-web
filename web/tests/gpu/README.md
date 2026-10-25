# GPU 与原版 Kirikiri 对比

本目录以原版 C++ 结果为基准，浏览器执行实际 WebGL 2 路径；不调用旧 JS 混合算法计算期望值。当前生成 1,481 个像素用例，结果允许失败，不修改基准来迎合当前 GPU。

## 运行

在仓库根目录运行：

```powershell
node web/tests/gpu/prepare.mjs
pnpm dev:vite
```

打开准备脚本打印的测试页 URL，例如：

```text
http://127.0.0.1:5173/tests/gpu/index.html
```

已有 Vite 服务时无需再启动。页面不加载游戏、音频或 VM，在独立页面创建 GPU，并在结束时释放。准备脚本默认寻找已有的 `C:/msys64/ucrt64/bin/g++.exe`，否则使用 PATH 中的 `g++`；也可设置 `CXX` 为编译器可执行文件路径。不新增 npm 依赖。

原生程序及期望数据位于已忽略的 `out/gpu-tests/`。每次修改参考源码或用例后重新运行准备脚本，刷新测试页。它们不进入游戏构建，不增加应用的 WASM 数量。

## 基准来源

- `oracle.cpp` 直接包含 `third_party/kirikiroid2/cpp/core/visual/tvpgl.cpp`，同时编译 `gl/blend_function.cpp`。
- 调用真实的 `TVPInitTVPGL()`，包括查找表初始化、C 函数槽安装及该参考版本的 native blend-slot overrides；不模拟初始化函数。
- 混合调用适配器依据 `LayerIntf.cpp::GetBltMethodFromOperationModeAndDrawFace` 与 `LayerBitmapIntf.cpp::PartialBlt` 分派到原版函数。opacity=0 使用原版 Blt 的提前返回语义。
- crossfade 调用 `TVPConstAlphaBlend_SD[_a/_d]`；universal 调用原版表生成及普通/switch 版本，覆盖 vague=0 和 512 两侧。
- 几何测试由测试端 C++ 做逆映射。最近邻的期望来自原版 `TVPLinTransCopy`（整数截断）；平滑的期望是**理想双线性**（`oracle.cpp` 的 op 8，double 计算后取整），因为原版的 GL 渲染后端（`iTVPBaseBitmap::StretchBlt`/`AffineBlt` → `iTVPRenderManager::OperateRect`，`RenderManager_ogl.cpp` 不读 `StretchType`、纹理一律 `GL_LINEAR`）用的就是硬件双线性。软件渲染器的 `TVPInterpLinTransCopy`（8 位定点权重 + 逐级 `>>8`）作为档案期望存在 `case.softwareKernel`，单独在报告“档案”列显示。**不等于运行完整原版边缘扫描器**。
- 最终显示与原版 `TVPAlphaColorMat` 的黑底输出对比，检查方向、颜色和 alpha。
- 填充、复制、像素读取以原版 Fill/Copy 函数产生的字节为基准；裁剪用例只将矩形外原始目标像素原样保留。

原版使用 `0xAARRGGBB`，浏览器使用 RGBA 字节；打包与解包在准备脚本中明确转换。基准指仓库当前 Kirikiroid2 参考实现的便携 C 路径，不代表所有原版引擎版本、平台 SIMD 或 OpenGL 后端均完全相同。

## 已覆盖

- 当前 `gpu.js` 全部实例方法：通过真实绘制及功能检查统计调用。新增方法未被执行时，覆盖检查失败。**被调用不等于其全部参数组合已验证。**
- `draw` 的 27 个模式、opacity `[0,1,127,128,254,255]`、目标 face/HDA、源 alpha 策略、自拷贝。
- 8×8 样本覆盖源/目标 alpha `[0,1,2,127,128,253,254,255]` 的笛卡尔积；包含 alpha=0 但 RGB 非零的颜色。其它颜色使用固定种子的序列。
- `fill` 的完整/局部/越界/空区域、仅 mask 修改；copy、clone、assign、read、point、present。
- crossfade / universal 的不同目标类型、phase 临界值、vague `[0,1,64,255,511,512,513]`。
- 平移、半像素、放大、缩小、镜像、90 度旋转、剪切、退化矩阵、源裁剪、目标裁剪、重叠自拷贝；最近邻（`TVPLinTransCopy`）与平滑（理想双线性，对应 GL 后端 `GL_LINEAR`）两类采样，平滑用例另有软件内核算术档案对照。
- 1×1、3×5、17×3 尺寸，覆盖单像素和原版循环的非整批尾部。
- Layer 的十一个 GPU 绘制入口：operateRect、operateStretch、operateAffine、stretchCopy/Pile/Blend、affineCopy/Pile/Blend、pileRect、blendRect（后两者分别验证 `bmAlphaOnAlpha` 与 `bmCopyOnAlpha`）。当前使用轻量状态对象测试绘制绑定，不启动脚本 VM。
- 整图算子：`TVPFillColor`、`TVPConstColorAlphaBlend`(±`_d`/`_a`)、`TVPFillARGB`、`TVPRemoveConstOpacity`（`colour/*`）；`TVPDoGrayScale`、`TVPConvertAlphaToAdditiveAlpha`、`TVPConvertAdditiveAlphaToAlpha`（`transform/*`）；`TVPInitGammaAdjustTempData` + `TVPAdjustGamma`/`TVPAdjustGamma_a`（`lookup/*`）；`DoBoxBlur`/`DoBoxBlurForAlpha` 的窗口平均（`boxBlur/*`，参考端用 `tTVPARGB_AA` 累加 + `TVPDoBoxBlurAvg32[_d]` 收尾）；`ApplyGaussianBlur` 的可分离核两趟卷积（`blur/gaussian/*`，参考端 kernel 生成与两趟循环逐行照抄）。
- texture 上传/CPU 修改后重新上传、snapshot、externallyWritable 同步、诊断、重复初始化拒绝与 finalize 资源释放。
- Image 写时复制：Assign 后共享同一纹理、局部写入分离并保留像素、整图覆盖无复制分离、no-copy independ 重建透明内容；原图像素在任一写路径后保持不变。
- 字形通过当前精确 shader 路径检查；`cow.html` 单独验证四项图像写时复制行为。

## 误差报告

默认每通道绝对误差容差为 **1**，URL 加 `?tolerance=0` 可要求逐字节一致，也可自行选择其它 0..255 的阈值。改变阈值不改变参考结果。

每个用例都展示最大 RGB 差、最大 alpha 差、发生差异的像素数、超过容差的像素数。JSON 报告另含 0..255 误差直方图、前八个差异坐标及双方 RGBA、实际输出字节、GPU 方法调用统计和功能检查。容差内的小差异也会显示，不会被隐藏。

点选结果行可查看原版 RGB、GPU RGB 和放大 16 倍的差异图。显示图强制 alpha=255，确保隐藏 RGB 可见；alpha 差异在数值报告中检查。使用“下载 JSON 报告”保存完整结果。自动调试工具可等待 `window.gpuTestResult` Promise 获取同一份报告。

## 尚未形成原版对比的范围

报告固定包含缺口列表及 `coverageComplete: false`，不能把功能调用覆盖率误称为原版一致性覆盖率：

- Motion 专用混合分支尚未接入原版 Motion 渲染基准；Layer 的混合不能替代该基准。
- `bmAddAlphaOnAlpha` 在参考 PartialBlt 中明确未实现，不为该组合伪造期望值。
- 完整 LayerBitmap 边缘扫描、各高阶插值核、图层树/窗口整体语义、上下文丢失及实际浏览器显示管线仍需要进一步对比。
- 字形栅格化、音视频解码以及完整 extrans 行为不属于本套 GPU 数值基准；像素扩展回归另见 `pixels.html`。

扩展方式：新增原版函数分派与用例，在 `run.js::execute` 调用对应真实接口；不要将当前 JS/GPU 输出存成期望值，也不要在缺少原版依据时默认为通过。

## 本轮验证

2026-10-24 迁移目录后重新生成原版 fixture，内置浏览器执行：1,481 项全部在默认容差 1 内，0 项超差、0 项功能检查失败；CoW 页 4/4 通过；pixels.html 显示 PASS、WebGL error=0。这些结果不代表完整游戏或全部 Motion 专用行为已验收。
