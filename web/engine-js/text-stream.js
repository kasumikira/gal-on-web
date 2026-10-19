import { detect } from 'chardet';

// TextStream.cpp's BOM, cipher and narrow-text converter paths.
const decode = (bytes, encoding) => new TextDecoder(encoding, { fatal: true }).decode(bytes);
export const normalizeTextEncoding = encoding => new TextDecoder(encoding).encoding;

export function streamOffset(mode = '') {
  if (!mode) return 0;
  if (!/^o\d+$/.test(mode)) throw new Error(`Unsupported TJS stream mode: ${mode}`);
  return Number(mode.slice(1));
}

export function encodeTextStream(text) {
  const bytes = new Uint8Array(2 + text.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xfeff, true);
  for (let i = 0; i < text.length; i++) view.setUint16(2 + i * 2, text.charCodeAt(i), true);
  return bytes;
}

export class TextStreamDecoder {
  constructor(encoding) { this.encoding = encoding ? normalizeTextEncoding(encoding) : null; }
  async read(bytes) {
    if (bytes[0] === 254 && bytes[1] === 254) {
      const mode = bytes[2];
      if (mode === 0 || mode === 1) {
        const result = new Uint8Array(Math.floor((bytes.length - 5) / 2) * 2);
        const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const target = new DataView(result.buffer);
        for (let i = 0; i < result.length; i += 2) {
          let ch = source.getUint16(i + 5,true);
          if (mode === 0) { if (ch >= 32) ch ^= ((ch & 254) << 8) ^ 1; }
          else ch = ((ch & 0xaaaa) >>> 1) | ((ch & 0x5555) << 1);
          target.setUint16(i,ch,true);
        }
        return decode(result,'utf-16le');
      }
      if (mode === 2) {
        const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const compressed = Number(header.getBigUint64(5,true));
        const original = Number(header.getBigUint64(13,true));
        const stream = new Blob([bytes.subarray(21,21+compressed)]).stream().pipeThrough(new DecompressionStream('deflate'));
        const result = new Uint8Array(await new Response(stream).arrayBuffer());
        if (result.length !== original) throw new Error('TJS compressed text size mismatch');
        return decode(result,'utf-16le');
      }
      throw new Error(`Unsupported TJS text cipher mode ${mode}`);
    }
    if (bytes[0] === 255 && bytes[1] === 254) return decode(bytes.subarray(2), 'utf-16le');
    if (bytes[0] === 254 && bytes[1] === 255) return decode(bytes.subarray(2), 'utf-16be');
    if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) return decode(bytes.subarray(3), 'utf-8');
    const end = bytes.indexOf(0);
    const narrow = end < 0 ? bytes : bytes.subarray(0, end);
    const detected = this.encoding ?? detect(narrow);
    let encoding;
    try { encoding = detected && normalizeTextEncoding(detected); }
    catch (error) {
      if (!(error instanceof RangeError)) throw error;
    }
    return decode(narrow, encoding || 'shift_jis');
  }
}
