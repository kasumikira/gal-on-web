import { Image } from '../bitmap.js';
import { loadGraphic } from './decode.js';

let worker;
let workerError;
let nextId = 0;
const pending = new Map();

function decoderWorker() {
  if (workerError) throw workerError;
  if (!worker) {
    worker = new Worker(new URL('./decode-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error !== undefined) reject(new Error(data.error));
      else resolve({
        image: new Image(data.width, data.height, { gray: data.gray, pixels: data.pixels }),
        province: null, metainfo: data.metainfo,
      });
    };
    worker.onerror = event => {
      workerError = new Error(`Image decoder worker failed: ${event.message}`);
      for (const { reject } of pending.values()) reject(workerError);
      pending.clear();
      worker.terminate();
    };
  }
  return worker;
}

// TLG's JS decoder must not block rendering while a script awaits loadImages.
// Browser-native formats keep their existing asynchronous decoder path.
export async function loadGraphicAsync(storage, key = 0x1fffffff, options = {}) {
  const bytes = await storage.read();
  if (bytes[0] !== 0x54 || bytes[1] !== 0x4c || bytes[2] !== 0x47) {
    return loadGraphic({ read: async () => bytes, name: storage.name }, key, options);
  }
  const decoder = decoderWorker(), id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Only an explicitly owned, complete buffer can be detached. Borrowed
    // data and archive views keep their backing storage intact.
    try {
      const input = storage.transferOwnership && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes : bytes.slice();
      decoder.postMessage({ id, bytes: input, name: storage.name, key, options }, [input.buffer]);
    }
    catch (error) { pending.delete(id); reject(error); }
  });
}
