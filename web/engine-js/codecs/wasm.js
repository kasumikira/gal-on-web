import wasmUrl from './codecs.wasm?url';

let wasm, memory;
let initialization;
export function initializeCodecs() {
  initialization ??= fetch(wasmUrl)
    .then(response => WebAssembly.instantiateStreaming(response, {}))
    .then(({ instance }) => { wasm = instance.exports; memory = wasm.memory; });
  return initialization;
}
function api() {
  if (!wasm) throw new Error('Rust codecs used before codecsReady');
  return wasm;
}

function alloc(length) { return api().codecs_alloc(length) >>> 0; }
function free(pointer, length) { api().codecs_free(pointer, length); }
function view(pointer, length) { return new Uint8Array(memory.buffer, pointer, length); }
function put(pointer, bytes) { view(pointer, bytes.length).set(bytes); }

function decodeRl32Into(sourceBytes, outputBytes, simd) {
  const wasm = api();
  const outputLength = outputBytes.length;
  const source = alloc(sourceBytes.length), output = alloc(outputLength);
  try {
    put(source, sourceBytes);
    const written = wasm.codecs_decode_rl32(source, sourceBytes.length, output, outputLength, Number(simd));
    outputBytes.set(view(output, written * 4));
    return written;
  } finally { free(output, outputLength); free(source, sourceBytes.length); }
}

function bgraToRgbaInto(sourceBytes, outputBytes, simd) {
  const wasm = api();
  const length = sourceBytes.length;
  const source = alloc(length);
  try {
    put(source, sourceBytes);
    wasm.codecs_bgra_to_rgba_in_place(source, length, Number(simd));
    outputBytes.set(view(source, length));
    return length / 4;
  } finally { free(source, length); }
}

// Each movie owns reusable input, plane and RGBA buffers in WASM.
export const codecs = Object.freeze({
  createAmvDecoder(quantization) {
    const wasm = api();
    const quant = alloc(192);
    let context;
    try {
      for (let p = 0; p < 3; p++) put(quant + p * 64, quantization[p]);
      context = wasm.codecs_amv_create(quant);
    } finally { free(quant, 192); }
    return {
      decodeInto(scan, alpha, width, height, separate, output, simd = true) {
        const alphaLength = alpha?.length ?? 0;
        const input = wasm.codecs_amv_input(context, scan.length + alphaLength);
        put(input, scan);
        if (alphaLength) put(input + scan.length, alpha);
        const pixels = wasm.codecs_amv_decode(context, scan.length, alphaLength, width, height, Number(separate), Number(simd));
        if (!pixels) throw new Error('Rust AMV decoder: invalid frame');
        output.set(view(pixels, width * height * 4));
      },
      dispose() { wasm.codecs_amv_free(context); },
    };
  },
  decodeIndexedPng(bytes, width, height, province, key) {
    const wasm = api();
    const channels = province ? 1 : 4;
    const outputLength = width * height * channels;
    if (!Number.isSafeInteger(outputLength) || outputLength > 0xffff_ffff) {
      throw new RangeError('Rust PNG decoder: image is too large');
    }
    const source = alloc(bytes.length), output = alloc(outputLength);
    try {
      put(source, bytes);
      const status = wasm.codecs_decode_png_indexed(
        source, bytes.length, output, outputLength, Number(province), key >>> 0,
      );
      if (status === 2) return null;
      if (status) throw new Error(`Rust PNG decoder failed (${status})`);
      return new Uint8ClampedArray(memory.buffer, output, outputLength).slice();
    } finally {
      free(output, outputLength);
      free(source, bytes.length);
    }
  },
  decodeTlg(bytes) {
    const wasm = api();
    const source = alloc(bytes.length);
    let output = 0, outputLength = 0;
    try {
      put(source, bytes);
      const dims = wasm.codecs_dimensions(source, bytes.length);
      const width = Number(dims & 0xffff_ffffn), height = Number(dims >> 32n);
      if (!width || !height) throw new Error('Rust TLG decoder: invalid header');
      outputLength = width * height * 4;
      output = alloc(outputLength);
      const status = wasm.codecs_decode_tlg(source, bytes.length, output, outputLength);
      if (status) throw new Error(`Rust TLG decoder failed (${status})`);
      // Copy once into JS-owned pixels before freeing the temporary WASM allocation.
      const pixels = new Uint8ClampedArray(memory.buffer, output, outputLength).slice();
      return { width, height, pixels };
    } finally {
      if (output) free(output, outputLength);
      free(source, bytes.length);
    }
  },
  decodeRl8(sourceBytes, pixelCount, simd = false) {
    const wasm = api();
    const source = alloc(sourceBytes.length), output = alloc(pixelCount);
    try {
      put(source, sourceBytes);
      const written = wasm.codecs_decode_rl8(source, sourceBytes.length, output, pixelCount, Number(simd));
      return view(output, written).slice();
    } finally { free(output, pixelCount); free(source, sourceBytes.length); }
  },
  decodeRl32Into(sourceBytes, outputBytes, simd = false) {
    return decodeRl32Into(sourceBytes, outputBytes, simd);
  },
  bgraToRgbaInto(sourceBytes, outputBytes, simd = true) {
    return bgraToRgbaInto(sourceBytes, outputBytes, simd);
  },
});
