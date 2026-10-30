# Codecs

Rust AMV 帧解码器在本目录构建；通用 PNG/JPEG/TLG/WebP 图像解码已迁入 `native/kirikiri/image`，不再由此模块提供。libav.js WMV 后端的配置和构建脚本位于 [native/libav](../libav/README.md)，Windows 用户在 MSYS2 终端执行 `bash native/libav/build.sh`。

构建：`pnpm build:codecs`。需安装 Rust 的 `wasm32-unknown-unknown` target；构建启用 `simd128`，产物为 `web/engine-js/codecs/codecs.wasm`。

- `src/amv.rs`：AMV 帧解码、可复用上下文及 SIMD 转色。
- `src/ffi.rs`：WASM 内存分配接口。
- `src/lib.rs`：公共错误类型。

容器、存储、播放时钟与 TJS 业务逻辑留在 JS。JS 通过 `codecs/wasm.js` 访问 WASM，AMV 每帧输入复制一次、RGBA 输出复制一次；不会按宏块跨边界调用。

AMV 差分与性能测试：`node tools/dev/amv-benchmark.mjs [archive.xp3] [rounds=5]`，默认读取 `tests/9nine/data.xp3`，结果写入 `out/amv-benchmark.json`。测试包含初始化后的整帧解码和边界复制，不包含文件 I/O、纹理上传或游戏合成；标量/显式 SIMD 转色均使用相同的 SIMD-enabled 构建。
