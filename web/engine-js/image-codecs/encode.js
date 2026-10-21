// TLG5/TLG6 encoders. The byte layout follows SaveTLG5.cpp and
// SaveTLG6.cpp; the encoder intentionally uses the valid raw TLG5 planes and
// fixed MED/filter-zero TLG6 path, leaving the native compressor's optional
// ratio search out of this browser implementation.
const GOLOMB_N = 4;
const GOLOMB_COMPRESSED = [
  [3, 7, 15, 27, 63, 108, 223, 448, 130],
  [3, 5, 13, 24, 51, 95, 192, 384, 257],
  [2, 5, 12, 21, 39, 86, 155, 320, 384],
  [2, 3, 9, 18, 33, 61, 129, 258, 511],
];
const TLG6GolombBitLengthTable = [];
for (let n = 0; n < GOLOMB_N; n++) {
  const table = new Uint8Array(GOLOMB_N * 2 * 128);
  let a = 0;
  for (let i = 0; i < 9; i++) {
    for (let j = 0; j < GOLOMB_COMPRESSED[n][i]; j++) table[a++] = i;
  }
  TLG6GolombBitLengthTable[n] = table;
}

const TLG5_HEADER = Uint8Array.from([0x54, 0x4c, 0x47, 0x35, 0x2e, 0x30, 0x00, 0x72, 0x61, 0x77, 0x1a]);
const TLG6_HEADER = Uint8Array.from([0x54, 0x4c, 0x47, 0x36, 0x2e, 0x30, 0x00, 0x72, 0x61, 0x77, 0x1a]);
const TLG0_HEADER = Uint8Array.from([0x54, 0x4c, 0x47, 0x30, 0x2e, 0x30, 0x00, 0x73, 0x64, 0x73, 0x1a]);
const BLOCK5_HEIGHT = 4;
const BLOCK6_WIDTH = 8;
const BLOCK6_HEIGHT = 8;

function appendBytes(out, bytes) {
  for (const value of bytes) out.push(value & 0xff);
}

function appendLE32(out, value) {
  value >>>= 0;
  out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
}

function putLE32(out, offset, value) {
  value >>>= 0;
  out[offset] = value & 0xff;
  out[offset + 1] = (value >>> 8) & 0xff;
  out[offset + 2] = (value >>> 16) & 0xff;
  out[offset + 3] = value >>> 24;
}

function validateImage(image) {
  if (!image || !Number.isInteger(image.width) || !Number.isInteger(image.height)
      || image.width <= 0 || image.height <= 0) {
    throw new Error('TJS TLG save requires a non-empty image');
  }
  const pixels = image.pixels;
  const expected = image.gray ? image.width * image.height : image.width * image.height * 4;
  if (!pixels || pixels.length < expected) throw new Error('TJS TLG save image pixels are truncated');
  return pixels;
}

function sourceComponent(image, pixels, x, y, component) {
  const index = y * image.width + x;
  if (image.gray) return pixels[index] & 0xff;
  const p = index * 4;
  // Native bitmap scanlines are BGRA, while Image pixels are RGBA.
  return pixels[p + (component === 0 ? 2 : component === 1 ? 1 : component === 2 ? 0 : 3)] & 0xff;
}

function channelCount(image, is24) {
  if (image.gray) return 1;
  return is24 ? 3 : 4;
}

// SaveTLG5's raw plane path. Each plane stores the vertical and horizontal
// second difference as a byte, so mark=1 lets the reader copy it verbatim.
function encodeTLG5(image, is24) {
  const pixels = validateImage(image), width = image.width, height = image.height;
  const colors = channelCount(image, is24);
  const out = [], blocks = Math.ceil(height / BLOCK5_HEIGHT);
  appendBytes(out, TLG5_HEADER);
  out.push(colors);
  appendLE32(out, width); appendLE32(out, height); appendLE32(out, BLOCK5_HEIGHT);
  const sizeOffset = out.length;
  for (let i = 0; i < blocks; i++) appendLE32(out, 0);

  for (let block = 0; block < blocks; block++) {
    const y0 = block * BLOCK5_HEIGHT, rows = Math.min(BLOCK5_HEIGHT, height - y0);
    const planes = Array.from({ length: colors }, () => new Uint8Array(rows * width));
    const previous = new Int32Array(colors);
    let pos = 0;
    for (let y = y0; y < y0 + rows; y++) {
      previous.fill(0);
      for (let x = 0; x < width; x++, pos++) {
        const values = new Int32Array(colors);
        for (let c = 0; c < colors; c++) {
          const above = y ? sourceComponent(image, pixels, x, y - 1, c) : 0;
          const current = sourceComponent(image, pixels, x, y, c);
          const difference = current - above;
          values[c] = difference - previous[c];
          previous[c] = difference;
        }
        if (colors === 1) planes[0][pos] = values[0];
        else {
          planes[0][pos] = values[0] - values[1];
          planes[1][pos] = values[1];
          planes[2][pos] = values[2] - values[1];
          if (colors === 4) planes[3][pos] = values[3];
        }
      }
    }
    const blockStart = out.length;
    for (const plane of planes) {
      out.push(1); // raw plane, as permitted by the TLG5 format
      appendLE32(out, plane.length);
      appendBytes(out, plane);
    }
    putLE32(out, sizeOffset + block * 4, out.length - blockStart);
  }
  return Uint8Array.from(out);
}

// Literal-only LZSS is sufficient for the TLG6 filter-type side stream. It is
// still the native slide format (flags followed by up to eight literals), so
// this is not a raw or fabricated filter section.
function encodeSlideLiterals(values) {
  const out = [];
  for (let i = 0; i < values.length;) {
    const count = Math.min(8, values.length - i);
    out.push(0);
    for (let j = 0; j < count; j++) out.push(values[i++]);
  }
  return Uint8Array.from(out);
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.bit = 0;
  }
  putBit(value) {
    if (this.bit === 0) this.bytes.push(0);
    if (value) this.bytes[this.bytes.length - 1] |= 1 << this.bit;
    this.bit = (this.bit + 1) & 7;
  }
  putValue(value, length) {
    value >>>= 0;
    for (let i = 0; i < length; i++) this.putBit(value & (1 << i));
  }
  putGamma(value) {
    if (value <= 0) throw new Error('TJS invalid TLG6 gamma value');
    let bits = 0, t = value >>> 1;
    while (t) { bits++; t >>>= 1; }
    for (let i = 0; i < bits; i++) this.putBit(0);
    this.putBit(1);
    this.putValue(value, bits);
  }
  finish() {
    return { bytes: Uint8Array.from(this.bytes), bitLength: this.bytes.length * 8 - ((8 - this.bit) & 7) };
  }
}

function signedByte(value) {
  value &= 0xff;
  return value < 128 ? value : value - 256;
}

function golombEncode(values) {
  const writer = new BitWriter();
  writer.putValue(values[0] ? 1 : 0, 1);
  let zero = !values[0], index = 0, n = 3, a = 0;
  while (index < values.length) {
    let end = index;
    while (end < values.length && ((values[end] === 0) === zero)) end++;
    writer.putGamma(end - index);
    if (!zero) {
      for (; index < end; index++) {
        const e = signedByte(values[index]);
        const m = (e >= 0 ? 2 * e : -2 * e - 1) - 1;
        const k = TLG6GolombBitLengthTable[n][a];
        const quotient = m >> k;
        // SaveTLG6 emits a four-byte escape when the unary quotient would
        // make the decoder's 32-bit lookahead all zero. The escaped quotient
        // is written as one raw byte at the resulting byte boundary.
        const limit = (writer.bit === 0 ? writer.bytes.length : writer.bytes.length - 1) + 4;
        let escaped = false;
        for (let q = quotient; q > 0; q--) {
          const bytePos = writer.bit === 0 ? writer.bytes.length : writer.bytes.length - 1;
          if (bytePos === limit) {
            writer.putValue(quotient, 8);
            escaped = true;
            break;
          }
          writer.putBit(0);
        }
        if (!escaped) {
          const bytePos = writer.bit === 0 ? writer.bytes.length : writer.bytes.length - 1;
          if (bytePos === limit) {
            writer.putValue(quotient, 8);
            escaped = true;
          }
        }
        if (!escaped) writer.putBit(1);
        writer.putValue(m, k);
        a += m >> 1;
        if (--n < 0) { a >>= 1; n = 3; }
      }
    } else index = end;
    zero = !zero;
  }
  return writer.finish();
}

function medPrediction(left, above, upperLeft) {
  const min = Math.min(left, above), max = Math.max(left, above);
  if (upperLeft >= max) return min;
  if (upperLeft < min) return max;
  return left + above - upperLeft;
}

function encodeTLG6(image, is24) {
  const pixels = validateImage(image), width = image.width, height = image.height;
  const colors = channelCount(image, is24), xBlocks = Math.ceil(width / BLOCK6_WIDTH);
  const filterTypes = [], encodedBlocks = [], maxBitLength = { value: 0 };

  for (let y0 = 0; y0 < height; y0 += BLOCK6_HEIGHT) {
    const rows = Math.min(BLOCK6_HEIGHT, height - y0), blockBuffers = [];
    let groupSize = 0;
    for (let x0 = 0, xp = 0; x0 < width; x0 += BLOCK6_WIDTH, xp++) {
      const bw = Math.min(BLOCK6_WIDTH, width - x0), residual = Array.from({ length: colors }, () => new Uint8Array(rows * bw));
      for (let yy = 0; yy < rows; yy++) for (let xx = 0; xx < bw; xx++) {
        const x = x0 + xx, y = y0 + yy;
        for (let c = 0; c < colors; c++) {
          const left = x ? sourceComponent(image, pixels, x - 1, y, c) : 0;
          const above = y ? sourceComponent(image, pixels, x, y - 1, c) : 0;
          const upperLeft = x && y ? sourceComponent(image, pixels, x - 1, y - 1, c) : 0;
          const value = sourceComponent(image, pixels, x, y, c);
          residual[c][yy * bw + xx] = value - medPrediction(left, above, upperLeft);
        }
      }
      const ordered = Array.from({ length: colors }, () => new Uint8Array(rows * bw));
      let wp = 0;
      for (let yy = 0; yy < rows; yy++) {
        // SaveTLG6 indexes rows relative to this block.  `yy` is already
        // relative here; keep the expression in the same form as the native
        // (ylim - absoluteY - 1) / (absoluteY - y) calculation.
        const ofs = (xp & 1 ? rows - yy - 1 : yy) * bw;
        const dir = (rows & 1) === 0
          ? (((y0 + yy) & 1) ^ (xp & 1)) !== 0
          : (xp & 1 ? ((y0 + yy) & 1) !== 0 : ((((y0 + yy) & 1) ^ (xp & 1)) !== 0));
        if (dir) {
          for (let xx = bw - 1; xx >= 0; xx--, wp++) for (let c = 0; c < colors; c++) ordered[c][wp] = residual[c][ofs + xx];
        } else {
          for (let xx = 0; xx < bw; xx++, wp++) for (let c = 0; c < colors; c++) ordered[c][wp] = residual[c][ofs + xx];
        }
      }
      for (let c = 0; c < colors; c++) (blockBuffers[c] ??= []).push(ordered[c]);
      groupSize += rows * bw;
      filterTypes.push(0); // MED + chroma filter 0
    }
    for (let c = 0; c < colors; c++) {
      const values = new Uint8Array(groupSize);
      let offset = 0;
      for (const part of blockBuffers[c]) { values.set(part, offset); offset += part.length; }
      const encoded = golombEncode(values);
      maxBitLength.value = Math.max(maxBitLength.value, encoded.bitLength);
      encodedBlocks.push({ bitLength: encoded.bitLength, bytes: encoded.bytes });
    }
  }

  const filterBytes = encodeSlideLiterals(filterTypes), out = [];
  appendBytes(out, TLG6_HEADER); out.push(colors, 0, 0, 0);
  appendLE32(out, width); appendLE32(out, height); appendLE32(out, maxBitLength.value);
  appendLE32(out, filterBytes.length); appendBytes(out, filterBytes);
  for (const block of encodedBlocks) { appendLE32(out, block.bitLength); appendBytes(out, block.bytes); }
  return Uint8Array.from(out);
}

function metadataEntries(metadata) {
  if (!metadata) return [];
  const entries = metadata.members instanceof Map ? metadata.members.entries()
    : metadata instanceof Map ? metadata.entries() : Object.entries(metadata);
  const result = [];
  for (const [key, value] of entries) {
    const name = String(key);
    if (!name) continue;
    result.push([name, String(value)]);
  }
  return result;
}

function wrapTLG0(raw, metadata) {
  const entries = metadataEntries(metadata);
  if (!entries.length) return raw;
  const encoder = new TextEncoder(), tags = [];
  for (const [name, value] of entries) {
    const nameBytes = encoder.encode(name), valueBytes = encoder.encode(value);
    for (const byte of encoder.encode(`${nameBytes.length}:`)) tags.push(byte);
    appendBytes(tags, nameBytes);
    for (const byte of encoder.encode(`=${valueBytes.length}:`)) tags.push(byte);
    appendBytes(tags, valueBytes); tags.push(0x2c);
  }
  const out = [];
  appendBytes(out, TLG0_HEADER); appendLE32(out, raw.length); appendBytes(out, raw);
  out.push(0x74, 0x61, 0x67, 0x73); appendLE32(out, tags.length); appendBytes(out, tags);
  return Uint8Array.from(out);
}

export function encodeTLG(image, mode = 'tlg5', metadata = null) {
  const selected = String(mode ?? 'tlg5').toLowerCase();
  const tlg6 = selected === 'tlg6' || selected === 'tlg624';
  const is24 = selected === 'tlg524' || selected === 'tlg624';
  if (!['tlg', 'tlg5', 'tlg6', 'tlg524', 'tlg624'].includes(selected)) {
    throw new Error(`TJS unsupported TLG save mode: ${selected}`);
  }
  const raw = tlg6 ? encodeTLG6(image, is24) : encodeTLG5(image, is24);
  return wrapTLG0(raw, metadata);
}

export function makeBMP(image, depth = 32) {
  if (depth !== 8 && depth !== 24 && depth !== 32) throw new Error(`TJS BMP encoder does not support ${depth}bpp browser images`);
  const bytesPerPixel = depth === 8 ? 1 : depth === 24 ? 3 : 4;
  const stride = (image.width * bytesPerPixel + 3) & ~3;
  const paletteBytes = depth === 8 ? 1024 : 0;
  const result = new Uint8Array(54 + paletteBytes + stride * image.height);
  const view = new DataView(result.buffer);
  result[0] = 0x42; result[1] = 0x4d;
  view.setUint32(2, result.length, true); view.setUint32(10, 54 + paletteBytes, true);
  view.setUint32(14, 40, true); view.setInt32(18, image.width, true); view.setInt32(22, image.height, true);
  view.setUint16(26, 1, true); view.setUint16(28, depth, true); view.setUint32(34, stride * image.height, true);
  if (depth === 8) {
    let index = 0;
    for (let r = 0; r < 6; r++) for (let g = 0; g < 7; g++) for (let b = 0; b < 6; b++, index++) {
      const p = 54 + index * 4;
      result[p] = Math.trunc(b * 255 / 5); result[p + 1] = Math.trunc(g * 255 / 6); result[p + 2] = Math.trunc(r * 255 / 5);
    }
  }
  const dither = [
    [0, 12, 2, 14], [8, 4, 10, 6], [3, 15, 1, 13], [11, 7, 9, 5],
  ];
  const paletteIndex = (r, g, b, x, y) => {
    const i = x & 3, j = y & 3;
    const v1 = dither[j][i] / 16, v2 = dither[(j + 1) % 2][(i + 1) % 2] / 16, v3 = dither[j][(i + 1) % 2] / 16;
    const quant = (value, levels, threshold) => {
      const scaled = value * levels / 255, main = Math.trunc(scaled);
      return Math.min(levels, main + (threshold < scaled - main ? 1 : 0));
    };
    const ri = quant(r, 5, v1), gi = quant(g, 6, v3), bi = quant(b, 5, v2);
    return ri * 42 + gi * 6 + bi;
  };
  for (let y = 0; y < image.height; y++) {
    const sourceY = image.height - 1 - y, row = 54 + y * stride;
    for (let x = 0; x < image.width; x++) {
      const source = (sourceY * image.width + x) * 4, dest = row + x * bytesPerPixel;
      if (depth === 8) result[dest] = paletteIndex(image.pixels[source], image.pixels[source + 1], image.pixels[source + 2], x, sourceY);
      else {
        result[dest] = image.pixels[source + 2]; result[dest + 1] = image.pixels[source + 1]; result[dest + 2] = image.pixels[source];
        if (depth === 32) result[dest + 3] = image.pixels[source + 3];
      }
    }
  }
  return result;
}

export async function canvasBytes(document, image, type) {
  if (!['png', 'png24', 'jpg', 'jpeg', 'jif'].includes(type) && !/^jpg(?:[0-9]+)$/.test(type)) throw new Error(`TJS image encoder does not support ${type}`);
  if (!document?.createElement) throw new Error('TJS image encoding requires a browser canvas');
  const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext('2d');
  const pixels = image.pixels.slice();
  const jpeg = type === 'jpg' || type === 'jpeg' || type === 'jif' || /^jpg[0-9]+$/.test(type);
  if (type === 'png24' || jpeg) for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
  context.putImageData(new ImageData(pixels, image.width, image.height), 0, 0);
  const mime = jpeg ? 'image/jpeg' : 'image/png';
  const quality = /^jpg[0-9]+$/.test(type)
    ? Math.max(0.1, Math.min(1, Number(type.slice(3)) / 100 || 0.1))
    : jpeg ? 0.9 : undefined;
  const options = quality === undefined ? { type: mime } : { type: mime, quality };
  let blob;
  if (canvas.convertToBlob) blob = await canvas.convertToBlob(options);
  else if (canvas.toBlob) blob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error(`TJS cannot encode ${type}`)), mime, quality));
  else throw new Error('TJS image encoding requires canvas.toBlob');
  return new Uint8Array(await blob.arrayBuffer());
}

