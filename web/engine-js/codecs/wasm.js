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
});
