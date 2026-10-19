// PNG/JPEG/WEBP/BMP and TLG5/TLG6 decoding; format routing by magic bytes.
import { Image } from '../bitmap.js';

function grayscaleImage(image) {
  if (image.gray) return image;
  return toImage({ pixels: image.pixels, width: image.width, height: image.height }, { gray: true });
}

function applyColorKey(image, key) {
  const p = image.pixels;
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
  const image = new Image(decoded.width, decoded.height, { gray });
  if (gray) {
    // TVPBLConvert24BitTo8Bit: luma = (54*r + 183*g + 19*b) >> 8.
    for (let i = 0, j = 0; j < image.pixels.length; i += 4, j++) {
      image.pixels[j] = (decoded.pixels[i] * 54 + decoded.pixels[i + 1] * 183 + decoded.pixels[i + 2] * 19) >> 8;
    }
  } else {
    image.pixels.set(decoded.pixels);
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
        if (province) { image.setPoint(px, py, type === 3 ? index : Math.trunc(index * 255 / mask)); continue; }
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
        image.setPoint(px, py, (a << 24 | r << 16 | g << 8 | b) >>> 0);
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
        if (province) { image.setPoint(x, destY, idx); continue; }
        color = palette[idx];
      }
      image.setPoint(x, destY, province ? ((color >> 16 & 255) * 54 + (color >> 8 & 255) * 183 + (color & 255) * 19) >> 8 : color);
    }
  }
  return image;
}

// ---- TLG5 (LoadTLG.cpp TVPLoadTLG5 + tvpgl.cpp TLG5 functions) ----
function tlg5DecompressSlide(out, inBytes, insize, text, initialr) {
  let r = initialr, flags = 0, ip = 0, op = 0;
  const inlim = insize;
  while (ip < inlim) {
    if (((flags >>= 1) & 0x100) === 0) {
      flags = inBytes[ip++] | 0xff00;
      if (flags === 0xff00 && r < 4096 - 8 && ip < inlim - 8) {
        for (let i = 0; i < 8; i++) { out[op] = text[r] = inBytes[ip]; op++; r++; ip++; }
        flags = 0;
        continue;
      }
    }
    if (flags & 1) {
      const in16 = inBytes[ip] | (inBytes[ip + 1] << 8); ip += 2;
      let mpos = in16 & 0xfff;
      let mlen = (in16 >> 12) + 3;
      if (mlen === 18) mlen += inBytes[ip++];
      while (mlen--) {
        out[op] = text[r] = text[mpos];
        op++; mpos = (mpos + 1) & 0xfff; r = (r + 1) & 0xfff;
      }
    } else {
      out[op] = text[r] = inBytes[ip++];
      op++; r = (r + 1) & 0xfff;
    }
  }
  return r;
}

function tlg5ComposeColors3To4(out, upper, bufs, width) {
  // tvpgl.cpp TVPTLG5ComposeColors3To4_c: out is BGRA bytes; buf planes are
  // B,G,R with the C-order accumulation from the native code.
  const pc = [0, 0, 0];
  for (let x = 0; x < width; x++) {
    const c0 = bufs[0][x], c1 = bufs[1][x], c2 = bufs[2][x];
    // Native: c[2]=buf[0][x]; c[1]=buf[1][x]; c[0]=buf[2][x]; c[0]+=c[1]; c[2]+=c[1];
    const cc0 = (c2 + c1) & 0xff; // c[0] = buf[2] + buf[1]
    const cc1 = c1 & 0xff;
    const cc2 = (c0 + c1) & 0xff; // c[2] = buf[0] + buf[1]
    const b = ((pc[0] = (pc[0] + cc0) & 0xff) + upper[x * 4]) & 0xff;
    const g = ((pc[1] = (pc[1] + cc1) & 0xff) + upper[x * 4 + 1]) & 0xff;
    const r = ((pc[2] = (pc[2] + cc2) & 0xff) + upper[x * 4 + 2]) & 0xff;
    out[x * 4] = b; out[x * 4 + 1] = g; out[x * 4 + 2] = r; out[x * 4 + 3] = 0xff;
  }
}

function tlg5ComposeColors4To4(out, upper, bufs, width) {
  const [red, green, blue, alpha] = bufs;
  let b = 0, g = 0, r = 0, a = 0;
  for (let x = 0, p = 0; x < width; x++, p += 4) {
    const c = green[x];
    b = (b + blue[x] + c) & 255;
    g = (g + c) & 255;
    r = (r + red[x] + c) & 255;
    a = (a + alpha[x]) & 255;
    out[p] = (b + upper[p]) & 255;
    out[p + 1] = (g + upper[p + 1]) & 255;
    out[p + 2] = (r + upper[p + 2]) & 255;
    out[p + 3] = (a + upper[p + 3]) & 255;
  }
}

function decodeTLG5(bytes) {
  let p = 11; // after "TLG5.0\x00raw\x1a\x00"
  const colors = bytes[p]; p += 1;
  if (colors !== 3 && colors !== 4) throw new Error('TJS unsupported color type in TLG');
  const width = le32(bytes, p); p += 4;
  const height = le32(bytes, p); p += 4;
  const blockheight = le32(bytes, p); p += 4;
  const blockcount = Math.floor((height - 1) / blockheight) + 1;
  p += blockcount * 4; // skip block size section
  const image = new Image(width, height);
  const text = new Uint8Array(4096);
  let r = 0;
  const bufs = [new Uint8Array(blockheight * width + 16), new Uint8Array(blockheight * width + 16), new Uint8Array(blockheight * width + 16), new Uint8Array(blockheight * width + 16)];
  let prevRow = null;
  const upper = new Uint8Array(width * 4);
  for (let yblk = 0; yblk < height; yblk += blockheight) {
    for (let c = 0; c < colors; c++) {
      const mark = bytes[p++];
      const size = le32(bytes, p); p += 4;
      if (mark === 0) {
        r = tlg5DecompressSlide(bufs[c], bytes.subarray(p, p + size), size, text, r);
        p += size;
      } else {
        bufs[c].set(bytes.subarray(p, p + size));
        p += size;
      }
    }
    const ylim = Math.min(yblk + blockheight, height);
    for (let y = yblk; y < ylim; y++) {
      const row = image.pixels.subarray(y * width * 4, (y + 1) * width * 4);
      const rowBufs = bufs.map(buf => buf.subarray((y - yblk) * width));
      if (prevRow) {
        if (colors === 3) tlg5ComposeColors3To4(row, prevRow, rowBufs, width);
        else tlg5ComposeColors4To4(row, prevRow, rowBufs, width);
      } else {
        // First block line: upper = zero line (alpha 0xff for colors=3).
        const zero = new Uint8Array(width * 4);
        if (colors === 3) for (let x = 0; x < width; x++) zero[x * 4 + 3] = 0xff;
        if (colors === 3) tlg5ComposeColors3To4(row, zero, rowBufs, width);
        else tlg5ComposeColors4To4(row, zero, rowBufs, width);
      }
      prevRow = row;
    }
  }
  return image;
}

// ---- TLG6 (LoadTLG.cpp TVPLoadTLG6 + tvpgl.cpp TLG6 decoder) ----
const GOLOMB_N = 4;
const GOLOMB_COMPRESSED = [
  [3, 7, 15, 27, 63, 108, 223, 448, 130],
  [3, 5, 13, 24, 51, 95, 192, 384, 257],
  [2, 5, 12, 21, 39, 86, 155, 320, 384],
  [2, 3, 9, 18, 33, 61, 129, 258, 511],
];
const LEADING_ZERO_BITS = 12;
const LEADING_ZERO_SIZE = 1 << LEADING_ZERO_BITS;
const LeadingZeroTable = new Uint8Array(LEADING_ZERO_SIZE);
for (let i = 0; i < LEADING_ZERO_SIZE; i++) {
  let cnt = 0, j;
  for (j = 1; j !== LEADING_ZERO_SIZE && !(i & j); j <<= 1, cnt++) ;
  cnt++;
  if (j === LEADING_ZERO_SIZE) cnt = 0;
  LeadingZeroTable[i] = cnt;
}
const GolombBitLengthTable = [];
for (let n = 0; n < GOLOMB_N; n++) {
  const table = new Uint8Array(GOLOMB_N * 2 * 128);
  let a = 0;
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < GOLOMB_COMPRESSED[n][i]; j++) table[a++] = i;
  }
  GolombBitLengthTable[n] = table;
}

// Shared by the TLG6 writer; this is the decompressed native table rather
// than another copy of the compressed constants.
export const TLG6GolombBitLengthTable = GolombBitLengthTable;

function makeBitReader(bytes, start, length) {
  // TVP_TLG6_FETCH_32BITS semantics on a byte pool.
  let bitPos = 1, bytePos = start;
  const zero = (bytes[start] & 1) ? 0 : 1;
  const fetch32 = () => {
    let v = 0;
    for (let i = 0; i < 4; i++) v += (bytes[bytePos + i] ?? 0) * 2 ** (8 * i);
    return v >>> 0;
  };
  return {
    zero,
    readCount() {
      let t = fetch32() >>> bitPos;
      let b = LeadingZeroTable[t & (LEADING_ZERO_SIZE - 1)];
      let bitCount = b;
      while (!b) {
        bitCount += LEADING_ZERO_BITS; bitPos += LEADING_ZERO_BITS;
        bytePos += bitPos >> 3; bitPos &= 7;
        t = fetch32() >>> bitPos;
        b = LeadingZeroTable[t & (LEADING_ZERO_SIZE - 1)];
        bitCount += b;
      }
      bitPos += b; bytePos += bitPos >> 3; bitPos &= 7;
      bitCount--;
      let count = 1 << bitCount;
      count += (fetch32() >>> bitPos) & (count - 1);
      bitPos += bitCount; bytePos += bitPos >> 3; bitPos &= 7;
      return count;
    },
    readValue(a, n) {
      const k = GolombBitLengthTable[n][a];
      let t = fetch32() >>> bitPos, bitCount, b;
      if (t) {
        b = LeadingZeroTable[t & (LEADING_ZERO_SIZE - 1)];
        bitCount = b;
        while (!b) {
          bitCount += LEADING_ZERO_BITS; bitPos += LEADING_ZERO_BITS;
          bytePos += bitPos >> 3; bitPos &= 7;
          t = fetch32() >>> bitPos;
          b = LeadingZeroTable[t & (LEADING_ZERO_SIZE - 1)];
          bitCount += b;
        }
        bitCount--;
      } else {
        bytePos += 5; bitCount = bytes[bytePos - 1]; bitPos = 0;
        t = fetch32(); b = 0;
      }
      let v = (bitCount << k) + ((t >>> b) & ((1 << k) - 1));
      const sign = (v & 1) - 1;
      v >>= 1;
      const outByte = (v ^ sign) + sign + 1;
      bitPos += b; bitPos += k;
      bytePos += bitPos >> 3; bitPos &= 7;
      return { outByte, a: a + v };
    },
  };
}

function decodeGolombValues(pixelbuf, pixelCount, bytes, start, forFirst) {
  // tvpgl.cpp TVPTLG6DecodeGolombValues[_ForFirst]_c.
  let n = GOLOMB_N - 1, a = 0;
  const reader = makeBitReader(bytes, start, pixelCount);
  let bitPos = 1;
  let zero = (bytes[start] & 1) ? 0 : 1;
  let idx = 0;
  const total = pixelCount * 4;
  while (idx < total) {
    // running count (shared bit position logic)
    let t = fetch32(bytes, start) >>> bitPos;
    let b = LeadingZeroTable[t & (LEADING_ZERO_SIZE - 1)];
    let bitCount = b;
    while (!b) {
      bitCount += LEADING_ZERO_BITS; bitPos += LEADING_ZERO_BITS;
      start += bitPos >> 3; bitPos &= 7;
      t = fetch32(bytes, start) >>> bitPos;
      b = LeadingZeroTable[t & (LEADING_ZERO_SIZE - 1)];
      bitCount += b;
    }
    bitPos += b; start += bitPos >> 3; bitPos &= 7;
    bitCount--;
    let count = 1 << bitCount;
    count += (fetch32(bytes, start) >>> bitPos) & (count - 1);
    bitPos += bitCount; start += bitPos >> 3; bitPos &= 7;
    if (zero) {
      for (let i = 0; i < count; i++) {
        if (forFirst) { pixelbuf[idx] = pixelbuf[idx + 1] = pixelbuf[idx + 2] = pixelbuf[idx + 3] = 0; }
        else pixelbuf[idx] = 0;
        idx += 4;
      }
      zero ^= 1;
    } else {
      for (let i = 0; i < count; i++) {
        const k = GolombBitLengthTable[n][a];
        let t2 = fetch32(bytes, start) >>> bitPos, bitCount2, b2;
        if (t2) {
          b2 = LeadingZeroTable[t2 & (LEADING_ZERO_SIZE - 1)];
          bitCount2 = b2;
          while (!b2) {
            bitCount2 += LEADING_ZERO_BITS; bitPos += LEADING_ZERO_BITS;
            start += bitPos >> 3; bitPos &= 7;
            t2 = fetch32(bytes, start) >>> bitPos;
            b2 = LeadingZeroTable[t2 & (LEADING_ZERO_SIZE - 1)];
            bitCount2 += b2;
          }
          bitCount2--;
        } else {
          start += 5; bitCount2 = bytes[start - 1]; bitPos = 0;
          t2 = fetch32(bytes, start); b2 = 0;
        }
        let v = (bitCount2 << k) + ((t2 >>> b2) & ((1 << k) - 1));
        const sign = (v & 1) - 1;
        v >>= 1;
        a += v;
        pixelbuf[idx] = ((v ^ sign) + sign + 1) & 0xff;
        if (forFirst) { pixelbuf[idx + 1] = pixelbuf[idx + 2] = pixelbuf[idx + 3] = 0; }
        idx += 4;
        bitPos += b2; bitPos += k;
        start += bitPos >> 3; bitPos &= 7;
        if (--n < 0) { a >>= 1; n = GOLOMB_N - 1; }
      }
      zero ^= 1;
    }
  }
}

function fetch32(bytes, pos) {
  let v = 0;
  for (let i = 0; i < 4; i++) v += (bytes[pos + i] ?? 0) * 2 ** (8 * i);
  return v >>> 0;
}

const W_BLOCK = 8, H_BLOCK = 8;

function packedBytesAdd(a, b) {
  const tmp = ((((a & b) << 1) + ((a ^ b) & 0xfefefefe)) & 0x01010100) >>> 0;
  return (a + b - tmp) >>> 0;
}
function makeGtMask(a, b) {
  const tmp2 = ~b >>> 0;
  let tmp = (((a & tmp2) + (((a ^ tmp2) >>> 1) & 0x7f7f7f7f)) & 0x80808080) >>> 0;
  tmp = (((tmp >>> 7) + 0x7f7f7f7f) ^ 0x7f7f7f7f) >>> 0;
  return tmp;
}
function med2(a, b, c) {
  const aaGtBb = makeGtMask(a, b);
  const axb = ((a ^ b) & aaGtBb) >>> 0;
  const aa = (axb ^ a) >>> 0, bb = (axb ^ b) >>> 0;
  const n = makeGtMask(c, bb), nn = makeGtMask(aa, c);
  const m = (~(n | nn)) >>> 0;
  return ((n & aa) | (nn & bb) | (((((bb & m) >>> 0) - (c & m) + (aa & m)) >>> 0) & 0)) >>> 0 ||
    packedBytesAdd(((n & aa) | (nn & bb) | (((bb & m) - (c & m) + (aa & m)) & m)) >>> 0, 0);
}
function med(a, b, c, v) { return packedBytesAdd(med2Simple(a, b, c), v); }
function med2Simple(a, b, c) {
  const aaGtBb = makeGtMask(a, b);
  const axb = ((a ^ b) & aaGtBb) >>> 0;
  const aa = (axb ^ a) >>> 0, bb = (axb ^ b) >>> 0;
  const n = makeGtMask(c, bb), nn = makeGtMask(aa, c);
  const m = (~(n | nn)) >>> 0;
  const select = ((n & aa) | (nn & bb)) >>> 0;
  const tail = (((((bb & m) >>> 0) - (c & m) + (aa & m)) >>> 0) & m) >>> 0;
  return (select | tail) >>> 0;
}
const avgPacked = (x, y) => (((((x & y) + (((x ^ y) & 0xfefefefe) >>> 1)) + ((x ^ y) & 0x01010101)) >>> 0));
function avg(a, b, c, v) { return packedBytesAdd(avgPacked(a, b), v); }

function decodeTLG6(bytes, palettized = false) {
  let p = 11;
  const colors = bytes[p];
  if (colors !== 1 && colors !== 4 && colors !== 3) throw new Error('TJS unsupported color count in TLG6');
  if (bytes[p + 1] !== 0) throw new Error('TJS data flag must be zero');
  if (bytes[p + 2] !== 0) throw new Error('TJS unsupported color type');
  if (bytes[p + 3] !== 0) throw new Error('TJS unsupported external golomb table');
  p += 4;
  const width = le32(bytes, p); p += 4;
  const height = le32(bytes, p); p += 4;
  const maxBitLength = le32(bytes, p); p += 4;
  const image = new Image(width, height);
  const xBlockCount = Math.floor((width - 1) / W_BLOCK) + 1;
  const yBlockCount = Math.floor((height - 1) / H_BLOCK) + 1;
  // chroma filter types: LZSS-compressed
  const filterTypes = new Uint8Array(xBlockCount * yBlockCount + 16);
  {
    const inbufSize = le32(bytes, p); p += 4;
    const text = new Uint8Array(4096);
    let offset = 0;
    for (let i = 0; i < 32; i++) for (let j = 0; j < 16; j++) {
      text.fill(i, offset, offset + 4);
      text.fill(j, offset + 4, offset + 8);
      offset += 8;
    }
    tlg5DecompressSlide(filterTypes, bytes.subarray(p, p + inbufSize), inbufSize, text, 0);
    p += inbufSize;
  }
  const pixelbuf = new Uint8Array(width * H_BLOCK * 4 + 4);
  const zeroline = new Uint8Array(width * 4);
  if (colors === 3) for (let x = 0; x < width; x++) zeroline[x * 4 + 3] = 0xff;
  for (let y = 0; y < height; y += H_BLOCK) {
    const ylim = Math.min(y + H_BLOCK, height);
    const pixelCount = (ylim - y) * width;
    for (let c = 0; c < colors; c++) {
      const bitLengthRaw = le32(bytes, p); p += 4;
      const method = (bitLengthRaw >>> 30) & 3;
      const bitLength = bitLengthRaw & 0x3fffffff;
      const byteLength = Math.ceil(bitLength / 8);
      if (method !== 0) throw new Error('TJS unsupported entropy coding method');
      decodeGolombValues(pixelbuf.subarray(c), pixelCount, bytes, p, c === 0 && colors !== 1);
      p += byteLength;
    }
    const ftBase = (y / H_BLOCK) * xBlockCount;
    const skipbytes = (ylim - y) * W_BLOCK;
    for (let yy = y; yy < ylim; yy++) {
      const curline = image.pixels.subarray(yy * width * 4, (yy + 1) * width * 4);
      const dir = (yy & 1) ^ 1;
      const oddskip = ((ylim - yy - 1) - (yy - y));
      const up = yy === 0 ? null : image.pixels.subarray((yy - 1) * width * 4, yy * width * 4);
      decodeLine(curline, up ?? zeroline, width, xBlockCount, filterTypes, ftBase, skipbytes, pixelbuf, colors === 3 ? 0xff000000 : 0, oddskip, dir, yy - y);
    }
  }
  return image;
}

function decodeLine(curline, upline, width, xBlockCount, filterTypes, ftBase, skipbytes, pixelbuf, initialp, oddskip, dir, row) {
  // tvpgl.cpp TVPTLG6DecodeLineGeneric_c: chroma decode + MED/AVG.
  let p = initialp >>> 0, up = initialp >>> 0;
  for (let i = 0; i < xBlockCount; i++) {
    let w = width - i * W_BLOCK;
    if (w > W_BLOCK) w = W_BLOCK;
    if (w <= 0) break;
    const ft = filterTypes[ftBase + i];
    const method = ft >> 1, postOp = ft & 1;
    const step = (dir & 1) ? 1 : -1;
    let inOffset = (skipbytes * i + w * row + (step === -1 ? w - 1 : 0) + (i & 1 ? oddskip * w : 0)) * 4;
    for (let k = 0; k < w; k++) {
      const idx = i * W_BLOCK + k;
      const px = idx * 4;
      const B = (pixelbuf[inOffset] << 24 >>> 24), G = (pixelbuf[inOffset + 1] << 24 >>> 24), R = (pixelbuf[inOffset + 2] << 24 >>> 24);
      let bb, gg, rr, aa;
      switch (method) {
        case 0: bb = B; gg = G; rr = R; break;
        case 1: bb = B + G; gg = G; rr = R + G; break;
        case 2: bb = B; gg = G + B; rr = R + B + G; break;
        case 3: bb = B + R + G; gg = G + R; rr = R; break;
        case 4: bb = B + R; gg = G + B + R; rr = R + B + R + G; break;
        case 5: bb = B + R; gg = G + B + R; rr = R; break;
        case 6: bb = B + G; gg = G; rr = R; break;
        case 7: bb = B; gg = G + B; rr = R; break;
        case 8: bb = B; gg = G; rr = R + G; break;
        case 9: bb = B + G + R + B; gg = G + R + B; rr = R + B; break;
        case 10: bb = B + R; gg = G + R; rr = R; break;
        case 11: bb = B; gg = G + B; rr = R + B; break;
        case 12: bb = B; gg = G + R + B; rr = R + B; break;
        case 13: bb = B + G; gg = G + R + B + G; rr = R + B + G; break;
        case 14: bb = B + G + R; gg = G + R; rr = R + B + G + R; break;
        case 15: bb = B; gg = G + (B << 1); rr = R + (B << 1); break;
        default: return;
      }
      // IA is a residual; colors=3 keeps it zero and predicts opaque alpha
      // from initialp/zeroline.
      aa = pixelbuf[inOffset + 3];
      const v = ((aa & 0xff) << 24) + ((rr & 0xff) << 16) + ((gg & 0xff) << 8) + (bb & 0xff);
      const u = (upline[px + 3] << 24 | upline[px] << 16 | upline[px + 1] << 8 | upline[px + 2]) >>> 0;
      const prevP = p;
      p = (postOp ? avg : med)(prevP, u, up, v);
      up = u;
      curline[px] = (p >>> 16) & 0xff; curline[px + 1] = (p >>> 8) & 0xff;
      curline[px + 2] = p & 0xff; curline[px + 3] = (p >>> 24) & 0xff;
      inOffset += step * 4;
    }
  }
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
  else if (utf8.decode(head.subarray(0, 6)) === 'TLG5.0') image = decodeTLG5(bytes);
  else if (utf8.decode(head.subarray(0, 6)) === 'TLG6.0') image = decodeTLG6(bytes);
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
