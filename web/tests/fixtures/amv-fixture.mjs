// Synthetic AMV fixture: a neutral block alpha bitstream (Cb/Cr/Y and alpha are neutral).
// Decoding always produces RGBA (128,128,128,128), so bytes produced by the Worker can
// be compared directly with the bytes written to the layer. The separate-alpha layout
// uses a zlib-compressed alpha scan.
// Uses only standard Web APIs (Blob/CompressionStream), shared by Node and browsers.
// For focused checks and the browser verification page only; not used in production.
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
