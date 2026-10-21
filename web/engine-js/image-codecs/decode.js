// PNG/JPEG/WEBP/BMP and TLG5/TLG6 decoding; format routing by magic bytes.
import { Image } from '../bitmap.js';
import { imageCodec, initializeImageCodec } from './wasm.js';

function grayscaleImage(image) {
  if (image.gray) return image;
  return toImage({ pixels: image.pixels, width: image.width, height: image.height }, { gray: true });
}

function applyColorKey(image, key) {
  const p = image.writablePixels;
  if (key === 0x01ffffff) {
    // GraphicsLoaderIntf.cpp TVPMakeAlphaFromAdaptiveColor.
    const colors = [];
    for (let x = 0; x < image.width; x++) colors.push(image.point(x, 0) & 0xffffff);
    colors.sort((a, b) => a - b); colors.push(0xffffffff);
    let maxLength = 0, maxColor = 0, previous = 0xffffffff, length = 0;
    for (const color of colors) {
      if (color !== previous) {
        if (maxLength < length) { maxLength = length; maxColor = previous; length = 0; }
      } else length++;
      previous = color;
    }
    key = maxColor === 0xffffffff ? 0 : maxColor;
  }
  if ((key >>> 24) === 0) for (let i = 0; i < p.length; i += 4) {
    p[i + 3] = ((p[i] << 16) | (p[i + 1] << 8) | p[i + 2]) === key ? 0 : 255;
  }
}

const utf8 = new TextDecoder('utf-8');

function be32(b, o) { return (b[o] << 24 | b[o + 1] << 16 | b[o + 2] << 8 | b[o + 3]) >>> 0; }
function le32(b, o) { return (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0; }
function le16(b, o) { return b[o] | b[o + 1] << 8; }

async function decodeWithBrowser(bytes) {
  // Color management off: the engine expects raw sRGB values.
  const bitmap = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  const data = context.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return { pixels: data.data, width: data.width, height: data.height };
}

function toImage(decoded, { gray = false } = {}) {
  // Browser ImageData owns this fresh buffer; adopt it instead of allocating
  // and copying the entire decoded RGBA image before the layer's own clone.
  if (!gray) return new Image(decoded.width, decoded.height, { pixels: decoded.pixels });
  const image = new Image(decoded.width, decoded.height, { gray });
  const pixels = image.writablePixels;
  if (gray) {
    // TVPBLConvert24BitTo8Bit: luma = (54*r + 183*g + 19*b) >> 8.
    for (let i = 0, j = 0; j < pixels.length; i += 4, j++) {
      pixels[j] = (decoded.pixels[i] * 54 + decoded.pixels[i + 1] * 183 + decoded.pixels[i + 2] * 19) >> 8;
    }
  }
  return image;
}

// LoadPNG.cpp glmPalettized needs palette indices, which browser decoders
// discard. PNG's packed scanlines use the same unfiltering for both palette
// indices and grayscale samples; DecompressionStream handles the zlib data.
async function decodeIndexedPNG(bytes, key, province) {
  const width = be32(bytes, 16) >>> 0, height = be32(bytes, 20) >>> 0;
  const depth = bytes[24], type = bytes[25], interlaced = bytes[28];
  if ((type !== 3 && type !== 0) || depth > 8) return null;
  let palette, transparency;
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const size = be32(bytes, offset) >>> 0, name = utf8.decode(bytes.subarray(offset + 4, offset + 8));
    const data = bytes.subarray(offset + 8, offset + 8 + size);
    if (name === 'PLTE') palette = data;
    else if (name === 'tRNS') transparency = data;
    else if (name === 'IDAT') chunks.push(data);
    offset += size + 12;
  }
  const raw = new Uint8Array(await new Response(new Blob(chunks).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const image = new Image(width, height, { gray: province });
  const pixels = image.writablePixels;
  const passes = interlaced ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  let input = 0;
  const mask = (1 << depth) - 1;
  for (const [x0, y0, xStep, yStep] of passes) {
    const w = Math.max(0, Math.ceil((width - x0) / xStep)), h = Math.max(0, Math.ceil((height - y0) / yStep));
    if (!w || !h) continue;
    const length = Math.ceil(w * depth / 8);
    let previous = new Uint8Array(length);
    for (let y = 0; y < h; y++) {
      if (input + length + 1 > raw.length) throw new Error('TJS truncated PNG scanline');
      const filter = raw[input++], row = raw.slice(input, input + length); input += length;
      for (let i = 0; i < length; i++) {
        const left = i ? row[i - 1] : 0, up = previous[i], upperLeft = i ? previous[i - 1] : 0;
        switch (filter) {
          case 0: break;
          case 1: row[i] += left; break;
          case 2: row[i] += up; break;
          case 3: row[i] += (left + up) >> 1; break;
          case 4: {
            const p = left + up - upperLeft, a = Math.abs(p - left), b = Math.abs(p - up), c = Math.abs(p - upperLeft);
            row[i] += a <= b && a <= c ? left : b <= c ? up : upperLeft;
            break;
          }
          default: throw new Error('TJS invalid PNG row filter');
        }
      }
      for (let x = 0; x < w; x++) {
        const index = row[x * depth >> 3] >> (8 - depth - (x * depth & 7)) & mask;
        const px = x0 + x * xStep, py = y0 + y * yStep;
        if (province) { pixels[py * width + px] = type === 3 ? index : Math.trunc(index * 255 / mask); continue; }
        const base = index * 3;
        let r, g, b, a;
        if (type === 3) {
          if (!palette || base + 2 >= palette.length) throw new Error('TJS invalid PNG palette index');
          r = palette[base]; g = palette[base + 1]; b = palette[base + 2];
          a = (key >>> 24) === 3 && index === (key & 255) ? 0 : transparency?.[index] ?? 255;
        } else {
          r = g = b = Math.trunc(index * 255 / mask);
          a = transparency && index === (transparency[0] << 8 | transparency[1]) ? 0 : 255;
        }
        const dest = (py * width + px) * 4;
        pixels[dest] = r; pixels[dest + 1] = g; pixels[dest + 2] = b; pixels[dest + 3] = a;
      }
      previous = row;
    }
  }
  return image;
}

// ---- BMP (GraphicsLoaderIntf.cpp TVPLoadBMP/TVPInternalLoadBMP) ----
function decodeBMP(bytes, key = 0x1fffffff, province = false) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) throw new Error('TJS not a Windows bitmap');
  const bfOffBits = dv.getUint32(10, true);
  const biSize = dv.getUint32(14, true);
  let width, heightRaw, bitCount, clrUsed, compression = 0;
  if (biSize === 12) {
    width = dv.getUint16(18, true); heightRaw = dv.getUint16(20, true);
    bitCount = dv.getUint16(24, true); clrUsed = 1 << bitCount;
  } else {
    width = dv.getInt32(18, true); heightRaw = dv.getInt32(22, true);
    bitCount = dv.getUint16(28, true); compression = dv.getUint32(30, true);
    clrUsed = dv.getUint32(46, true);
  }
  if (compression !== 0) throw new Error('TJS compressed bmp is not supported');
  const orgbit = bitCount;
  if (bitCount === 1 || bitCount === 4) bitCount = 8;
  const height = Math.abs(heightRaw);
  const palette = new Uint32Array(256).fill(0xff000000);
  if (orgbit <= 8) {
    const count = clrUsed || (1 << orgbit);
    const entrySize = biSize === 12 ? 3 : 4;
    let p = 14 + biSize;
    for (let i = 0; i < count; i++) {
      // palette[i] = (b<<16)+(g<<8)+r + 0xff000000 in file's BGR order.
      palette[i] = 0xff000000 + (bytes[p + 2] << 16) + (bytes[p + 1] << 8) + bytes[p];
      p += entrySize;
    }
  }
  if ((key >>> 24) === 3 && orgbit <= 8) palette[key & 0xff] &= 0xffffff;
  const image = new Image(width, height, { gray: province });
  const pixels = image.writablePixels;
  const pitch = ((width * orgbit + 31) & ~31) / 8;
  for (let row = 0; row < height; row++) {
    const destY = heightRaw > 0 ? height - 1 - row : row;
    const line = bfOffBits + row * pitch;
    for (let x = 0; x < width; x++) {
      let color;
      if (orgbit === 32) {
        const v = le32(bytes, line + x * 4);
        // batMulAlpha: the TVP native representation; B,G,R,A bytes as-is
        // but dest is RGBA bytes: file gives BGRA little-endian -> value
        // 0xAARRGGBB after LE read of BBGGRR AA... copy directly.
        const b = bytes[line + x * 4], g = bytes[line + x * 4 + 1], r = bytes[line + x * 4 + 2], a = bytes[line + x * 4 + 3];
        color = (a << 24) + (r << 16) + (g << 8) + b;
      } else if (orgbit === 24) {
        const b = bytes[line + x * 3], g = bytes[line + x * 3 + 1], r = bytes[line + x * 3 + 2];
        color = 0xff000000 + (r << 16) + (g << 8) + b;
      } else if (orgbit === 16 || orgbit === 15) {
        const v = le16(bytes, line + x * 2);
        const r5 = (v >> 10) & 0x1f, g5 = (v >> 5) & 0x1f, b5 = v & 0x1f;
        color = 0xff000000 + ((r5 * 255 / 31) << 16 | 0) + ((g5 * 255 / 31) << 8 | 0) + (b5 * 255 / 31 | 0);
      } else {
        const idx = orgbit === 1 ? (bytes[line + (x >> 3)] >> (7 - (x & 7))) & 1
          : orgbit === 4 ? (bytes[line + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15 : bytes[line + x];
        if (province) { pixels[destY * width + x] = idx; continue; }
        color = palette[idx];
      }
      if (province) pixels[destY * width + x] = ((color >> 16 & 255) * 54 + (color >> 8 & 255) * 183 + (color & 255) * 19) >> 8;
      else {
        const dest = (destY * width + x) * 4;
        pixels[dest] = color >>> 16 & 255; pixels[dest + 1] = color >>> 8 & 255;
        pixels[dest + 2] = color & 255; pixels[dest + 3] = color >>> 24;
      }
    }
  }
  return image;
}

export async function loadGraphic(storage, key = 0x1fffffff, { gray = false, province = false } = {}) {
  // TVPFindGraphicLoadHandler: extension routing, then _m/_p siblings.
  const bytes = await storage.read();
  const head = bytes.subarray(0, 16);
  let image, metainfo = null;
  if (head[0] === 0x89 && head[1] === 0x50) image = await decodeIndexedPNG(bytes, key, province)
    ?? toImage(await decodeWithBrowser(bytes), { gray: gray || province });
  else if (head[0] === 0xff && head[1] === 0xd8) image = toImage(await decodeWithBrowser(bytes), { gray });
  else if (head[0] === 0x42 && head[1] === 0x4d) image = decodeBMP(bytes, key, province);
  else if (head[0] === 0x52 && head[1] === 0x49 && utf8.decode(head.subarray(8, 12)) === 'WEBP') image = toImage(await decodeWithBrowser(bytes), { gray });
  else if (utf8.decode(head.subarray(0, 6)) === 'TLG5.0' || utf8.decode(head.subarray(0, 6)) === 'TLG6.0') {
    await initializeImageCodec();
    const decoded = imageCodec.decodeTlg(bytes);
    image = new Image(decoded.width, decoded.height, { pixels: decoded.pixels });
  }
  else if (utf8.decode(head.subarray(0, 6)) === 'TLG0.0') {
    // TLG0.0 sds: embedded TLG + tags chunk.
    const rawlen = le32(bytes, 11);
    image = (await loadGraphic({ read: async () => bytes.subarray(15, 15 + rawlen), name: storage.name }, key, { gray, province })).image;
    for (let offset = 15 + rawlen; offset + 8 <= bytes.length;) {
      const name = utf8.decode(bytes.subarray(offset, offset + 4)), size = le32(bytes, offset + 4);
      const end = offset + 8 + size;
      if (end > bytes.length) throw new Error('TJS truncated TLG metadata chunk');
      if (name === 'tags') {
        metainfo ??= new Map();
        let position = offset + 8;
        const text = () => {
          let length = 0;
          while (position < end && bytes[position] >= 48 && bytes[position] <= 57) length = length * 10 + bytes[position++] - 48;
          if (bytes[position++] !== 58 || position + length > end) throw new Error('TJS malformed TLG tag length');
          const value = utf8.decode(bytes.subarray(position, position + length)); position += length;
          return value;
        };
        while (position < end) {
          const key = text();
          if (bytes[position++] !== 61) throw new Error('TJS malformed TLG tag equals');
          const value = text();
          if (bytes[position++] !== 44) throw new Error('TJS malformed TLG tag comma');
          metainfo.set(key, value);
        }
      }
      offset = end;
    }
  }
  else throw new Error(`TJS unknown graphic format: ${storage.name ?? 'storage'}`);
  if (gray || province) image = grayscaleImage(image);
  else applyColorKey(image, key >>> 0);
  void be32;
  return { image, province: null, metainfo };
}
