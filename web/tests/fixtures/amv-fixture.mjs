// 合成 AMV 素材：中性块 alpha 位流（Cb/Cr/Y 与 alpha 全为中性）。
// 解码结果恒为 RGBA (128,128,128,128)，因此可以直接把“Worker 解出的字节”
// 与“写进图层的字节”逐字节对照；separate alpha 布局用 zlib 压缩的 alpha 扫描。
// 只用标准 Web API（Blob/CompressionStream），Node 与浏览器共用。
// 只用于定向检查与浏览器验证页，不进入生产代码。
export const FILE_MAGIC = 1297107521;
export const FRAME_MAGIC = 1296126534;
const NEUTRAL_BITS = '0000'.repeat(2) + '001010'.repeat(8);

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function buildAmv({ frames = 1, separate = false, width = 16, height = 16, fpsScale = 30, fpsRate = 1 } = {}) {
  const bits = separate ? '0000'.repeat(2) + '001010'.repeat(4) : NEUTRAL_BITS;
  const scan = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) scan[i >> 3] |= Number(bits[i]) << (7 - (i & 7));
  const alpha = separate ? await deflate(Uint8Array.from({ length: 256 }, (_, i) => i)) : new Uint8Array(0);
  const headerSize = separate ? 168 : 232;
  const frameSize = (separate ? 24 : 20) + alpha.length + scan.length;
  const bytes = new Uint8Array(headerSize + frames * frameSize);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, FILE_MAGIC, true);
  view.setUint32(12, headerSize, true);
  view.setUint32(20, frames, true);
  view.setUint32(24, fpsScale, true);
  view.setUint32(28, fpsRate, true);
  view.setUint16(32, width, true);
  view.setUint16(34, height, true);
  bytes[36] = separate ? 2 : 1;
  bytes.fill(1, 40, headerSize);
  let offset = headerSize;
  for (let index = 0; index < frames; index++) {
    view.setUint32(offset, FRAME_MAGIC, true);
    view.setUint32(offset + 4, frameSize - 8, true);
    view.setUint32(offset + 8, index, true);
    view.setUint16(offset + 12, 2 * index, true);
    view.setUint16(offset + 14, index, true);
    view.setUint16(offset + 16, width, true);
    view.setUint16(offset + 18, height, true);
    if (separate) view.setUint32(offset + 20, alpha.length, true);
    bytes.set(alpha, offset + (separate ? 24 : 20));
    bytes.set(scan, offset + (separate ? 24 : 20) + alpha.length);
    offset += frameSize;
  }
  return bytes;
}
