// ObjSource equivalent: decode one PSB icon entry into an engine Image, lazily.
// SourceCache.cpp ensureTexture_guess (RL / palette / raw 32bpp paths).
import { Image } from '../bitmap.js';
import { imageCodec } from './wasm.js';
const decodedSources = new WeakMap();
export function decodeSource(iconNode) {
  if (!iconNode) return null;
  // PSBNode.get creates a new wrapper each time. File + offset identifies
  // the immutable source across lookups and lets the cache die with the file.
  let sources = decodedSources.get(iconNode.file);
  if (!sources) decodedSources.set(iconNode.file, sources = new Map());
  const cached = sources.get(iconNode.offset);
  if (cached) return cached;
  const width = iconNode.get('width')?.toInt() ?? 0;
  const height = iconNode.get('height')?.toInt() ?? 0;
  const originX = iconNode.get('originX')?.toInt() ?? 0;
  const originY = iconNode.get('originY')?.toInt() ?? 0;
  const clipNode = iconNode.get('clip');
  const clip = clipNode ? {
    left: clipNode.get('left')?.toNumber() ?? 0, top: clipNode.get('top')?.toNumber() ?? 0,
    right: clipNode.get('right')?.toNumber() ?? width, bottom: clipNode.get('bottom')?.toNumber() ?? height,
  } : { left: 0, top: 0, right: width, bottom: height };
  const pixelCount = width * height;
  const compressed = iconNode.has('compress') && iconNode.get('compress')?.toText() === 'RL';
  const hasPalette = iconNode.has('pal');
  const pixelData = iconNode.get('pixel')?.toResource() ?? new Uint8Array();
  // 1 byte/pixel when RL-compressed with a palette, else 4 bytes/pixel.
  let source8 = null, source32 = null;
  if (compressed) {
    if (hasPalette) source8 = imageCodec.decodeRl8(pixelData, pixelCount);
  } else if (hasPalette) source8 = pixelData;
  else source32 = pixelData;
  const rgba = new Uint8ClampedArray(pixelCount * 4);
  if (hasPalette) {
    const paletteBytes = iconNode.get('pal')?.toResource() ?? new Uint8Array();
    const paletteCount = Math.trunc(paletteBytes.length / 4);
    const palette = new Uint32Array(paletteCount);
    for (let i = 0; i < paletteCount; i++) palette[i] = readWord(paletteBytes, i * 4);
    expandPalette(rgba, source8, pixelCount, palette);
  } else if (compressed) {
    // Decode directly into RGBA: no intermediate full-size BGRA allocation
    // or second pass over the decompressed image. The only output copy is
    // from temporary WASM memory into the JS-owned image buffer.
    imageCodec.decodeRl32Into(pixelData, rgba);
  } else {
    imageCodec.bgraToRgbaInto(source32.subarray(0, pixelCount * 4), rgba);
  }
  // Cache the renderable image itself: timeline seeks must not wrap the same
  // decoded pixels in a new GPU texture owner on every source resolution.
  const result = Object.assign(new Image(width, height, { pixels: rgba }), {
    blank: false, originX, originY, clip, path: iconNode.path,
  });
  sources.set(iconNode.offset, result);
  return result;
}
// PSB 32-bit words are little-endian BGRA; return the native ARGB value.
function readWord(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0;
}
// TVPBLExpand8BitTo32BitPal: palette entries are native ARGB values.
function expandPalette(rgba, indexes, pixelCount, palette) {
  for (let i = 0; i < pixelCount; i++) {
    const word = palette[indexes[i]] ?? 0;
    rgba[i * 4] = (word >>> 16) & 0xff;
    rgba[i * 4 + 1] = (word >>> 8) & 0xff;
    rgba[i * 4 + 2] = word & 0xff;
    rgba[i * 4 + 3] = (word >>> 24) & 0xff;
  }
}
