// AMV container and playback position; frame decoding lives in native/codecs/src/amv.rs.
import { codecs, initializeCodecs } from '../codecs/wasm.js';
export const FILE_MAGIC = 1297107521;
export const FRAME_MAGIC = 1296126534;

const NATURAL_ORDER = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

export async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class AMVDecoder {
  constructor() {
    this.bytes = null;
    this.quantization = [new Int16Array(64), new Int16Array(64), new Int16Array(64)];
    this.frame = 0;
    this.numOfFrame = 0;
    this.fpsScale = 0;
    this.fpsRate = 0;
    this.screenWidth = 0;
    this.screenHeight = 0;
    this.firstPosition = 0;
    this.position = 0;
    this.separateAlpha = false;
    this.loop = true;
    this.nextLoop = true;
    this.nextMovieFile = '';
    this.core = null;
    this.rgba = new Uint8ClampedArray(0);
  }

  // Returns an error message, or null when the file was accepted.
  open(bytes) {
    if (bytes.length < 40) return 'File read error';
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = offset => view.getUint32(offset, true);
    const u16 = offset => view.getUint16(offset, true);
    if (u32(0) !== FILE_MAGIC) return 'This file is not Alpha Movie File.';
    if (u32(8) !== 0) return 'Invalid File revision number.';
    const headerSize = u32(12);
    if (headerSize !== 168 && headerSize !== 232) return 'Invalid Quantaization table size.';
    if (bytes.length < headerSize) return 'File read error';
    const numOfFrame = u32(20);
    if (numOfFrame === 0) return 'Not found frame in this file.';
    const fpsScale = u32(24);
    if (fpsScale === 0) return 'Invalid frame rate.';
    const fpsRate = u32(28);
    if (fpsRate === 0) return 'Invalid frame rate.';
    const screenWidth = u16(32);
    if (screenWidth === 0) return 'Screen size is zero ?';
    const screenHeight = u16(34);
    if (screenHeight === 0) return 'Screen size is zero ?';
    const attribute = bytes[36];
    const tableSize = headerSize - 40;
    let separateAlpha;
    if (attribute & 1) {
      separateAlpha = false;
      if (headerSize !== 232) return 'Invalid Quantaization table size.';
    } else {
      if (!(attribute & 2)) return 'Invalid Attribute.';
      separateAlpha = true;
      if (headerSize !== 168) return 'Invalid Quantaization table size.';
    }
    // JPEG stores quantization tables in zigzag order; coefficients are raster.
    for (let i = 0; i < 64; i++) this.quantization[0][NATURAL_ORDER[i]] = bytes[40 + i];
    for (let i = 0; i < 64; i++) this.quantization[1][NATURAL_ORDER[i]] = bytes[104 + i];
    if (tableSize === 128) this.quantization[2].fill(0);
    else for (let i = 0; i < 64; i++) this.quantization[2][NATURAL_ORDER[i]] = bytes[168 + i];
    this.core?.dispose();
    this.core = null;
    this.bytes = bytes;
    this.numOfFrame = numOfFrame;
    this.fpsScale = fpsScale;
    this.fpsRate = fpsRate;
    this.screenWidth = screenWidth;
    this.screenHeight = screenHeight;
    this.separateAlpha = separateAlpha;
    this.firstPosition = headerSize;
    this.position = headerSize;
    this.frame = 0;
    return null;
  }

  frameHeader(position) {
    const bytes = this.bytes;
    if (!bytes || position + 20 > bytes.length) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const header = {
      magic: view.getUint32(position, true),
      size: view.getUint32(position + 4, true),
      frame: view.getUint32(position + 8, true),
      left: view.getUint16(position + 12, true),
      top: view.getUint16(position + 14, true),
      width: view.getUint16(position + 16, true),
      height: view.getUint16(position + 18, true),
      alphaSize: 0,
    };
    if (this.separateAlpha && position + 24 <= bytes.length) {
      header.alphaSize = view.getUint32(position + 20, true);
    }
    return header;
  }

  // AlphaMovieDecoder_guess::SeekFrame_guess.
  seekFrame(frame) {
    if (frame >= this.numOfFrame) return false;
    let position = this.firstPosition;
    for (;;) {
      const header = this.frameHeader(position);
      if (!header || header.magic !== FRAME_MAGIC) return false;
      if (header.frame === frame) {
        this.frame = frame;
        this.position = position;
        return true;
      }
      if (header.frame > frame) return false;
      position += header.size + 8;
    }
  }

  // Returns 'next' when the movie ended and a follow-up file should be opened.
  advance() {
    if (this.frame < this.numOfFrame - 1) return null;
    if (this.loop) {
      this.position = this.firstPosition;
      this.frame = 0;
      return null;
    }
    return 'next';
  }

  dispose() {
    this.core?.dispose();
    this.core = null;
    this.bytes = null;
    this.rgba = new Uint8ClampedArray(0);
  }

  async decodeNext({ transferable = false } = {}) {
    if (!this.bytes) return null;
    const header = this.frameHeader(this.position);
    if (!header || header.magic !== FRAME_MAGIC) return null;
    const separate = this.separateAlpha;
    const offset = this.position + (separate ? 24 + header.alphaSize : 20);
    const length = header.size - (separate ? header.alphaSize + 16 : 12);
    if (length < 0 || offset + length > this.bytes.length) return null;
    let alpha = null;
    if (separate && header.alphaSize) {
      alpha = await inflate(this.bytes.subarray(this.position + 24, offset));
    }
    await initializeCodecs();
    this.core ??= codecs.createAmvDecoder(this.quantization);
    const { width, height } = header;
    let rgba = null;
    if (width && height) {
      const size = width * height * 4;
      if (transferable) rgba = new Uint8ClampedArray(size);
      else {
        if (this.rgba.length < size) this.rgba = new Uint8ClampedArray(size);
        rgba = this.rgba.subarray(0, size);
      }
      this.core.decodeInto(this.bytes.subarray(offset, offset + length), alpha, width, height, separate, rgba);
    }
    this.position += header.size + 8;
    this.frame = header.frame;
    return { header, width, height, rgba };
  }
}
