// AlphaMovie AMV backend: dedicated Worker decoding + bounded predecode (architecture diagram: AMV dedicated Worker backend).
//
// The main thread does only three things: send file bytes read by storage to the Worker,
// maintain container policy (Loop / NextMovieFile, which needs storage), and pass decoded
// frames to the shared pipeline. Pixel decoding, Huffman/IDCT, and the WASM context stay in
// the Worker, so full-frame decoding no longer blocks the main thread.
//
// The reference AlphaMovieNative_guess uses one thread per instance and a bounded Free/Ready
// frame pool. Here, VideoPipeline's bounded queue provides the same role (capacity =
// preloadSamples), and the Worker naturally pauses predecode when the queue is full. Multiple
// AlphaMovie instances share one Worker, with sessions isolated per instance to avoid creating
// a new WASM instance for each one.
let nextSessionId = 1;

function createAmvTransport() {
  let worker = null;
  const handlers = new Set();
  const emit = data => { for (const handler of [...handlers]) handler(data); };
  const ensure = () => {
    if (worker) return worker;
    worker = new Worker(new URL('./amv-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => emit(data);
    worker.onerror = event => {
      emit({ workerError: event.message || 'AMV decoder worker failed' });
      try { worker.terminate(); } catch {}
      worker = null;
    };
    return worker;
  };
  return {
    postMessage(message, transfer) { ensure().postMessage(message, transfer); },
    subscribe(handler) { handlers.add(handler); return () => handlers.delete(handler); },
  };
}

let sharedTransport = null;
export function amvTransport() { return sharedTransport ??= createAmvTransport(); }

export class AmvWorkerSource {
  constructor({ storage, createTransport = amvTransport } = {}) {
    this.storage = storage;
    this.info = null;
    this.loop = true;
    this.nextLoop = true;
    this.nextMovieFile = '';
    this.lastError = null;
    // Decoder.Frame: the index of the last decoded frame (predecode may be ahead of presentation).
    this.decoderFrame = 0;
    this.session = nextSessionId++;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.failed = null;
    this.transport = createTransport();
    this.unsubscribe = this.transport.subscribe(data => this.onMessage(data));
  }

  onMessage(data) {
    if (data.workerError) { this.fail(new Error(data.workerError)); return; }
    if (data.session !== this.session) return;
    const pending = this.pending.get(data.id);
    if (!pending) return;
    this.pending.delete(data.id);
    if (data.ok) pending.resolve(data);
    else pending.reject(new Error(data.error ?? 'AMV worker request failed'));
  }

  fail(error) {
    this.failed = error;
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  request(message, transfer) {
    if (!this.session || this.disposal) return Promise.reject(new Error('AMV worker session disposed'));
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.transport.postMessage({ session: this.session, request: { ...message, id } }, transfer ?? []); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  // Return an error message or null, matching the AMVDecoder.open contract in amv.js.
  async open(name) {
    try { return await this.openBytes(await this.storage.read(String(name))); }
    catch (error) { return error.message; }
  }

  async openBytes(bytes) {
    // A borrowed archive view cannot transfer ownership; transfer only a complete buffer that is explicitly owned.
    const input = this.storage.transferOwnership && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes : bytes.slice();
    try {
      const reply = await this.request({ type: 'open', bytes: input }, [input.buffer]);
      this.info = reply.info;
      this.decoderFrame = 0;
      this.lastError = null;
      return null;
    } catch (error) {
      return error?.message ?? String(error);
    }
  }

  // Decode the next frame; return null at end of media. Decide here whether to loop or
  // switch to the next file (matching the Loop / NextMovieFile branches in DecodeNext_guess).
  async next() {
    for (;;) {
      const reply = await this.request({ type: 'decode' });
      if (reply.frame) {
        const { frame, left, top, width, height } = reply.frame;
        this.decoderFrame = frame;
        return { frame, timestamp: null, width, height, left, top, rgba: reply.pixels ?? null, ownedPixels: true };
      }
      if (!this.nextMovieFile) return null;
      // Match DecodeNext_guess: if NextMovieFile cannot be opened, return 2 and end the worker thread.
      let bytes;
      try { bytes = await this.storage.read(this.nextMovieFile); }
      catch (error) { this.lastError = error?.message ?? String(error); return null; }
      const error = await this.openBytes(bytes);
      if (error) { this.lastError = error; return null; }
      await this.setLoop(this.nextLoop);
    }
  }

  async rewind() {
    await this.request({ type: 'rewind' });
    this.decoderFrame = 0;
  }

  async seek(frame) {
    const reply = await this.request({ type: 'seek', frame: Math.trunc(frame) });
    if (reply.found) this.decoderFrame = Math.trunc(frame);
    return !!reply.found;
  }

  async setLoop(loop) {
    this.loop = !!loop;
    await this.request({ type: 'loop', loop: this.loop });
  }

  dispose() {
    if (this.disposal) return this.disposal;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const { reject } of pending) reject(new Error('AMV worker session disposed'));
    const closing = this.failed ? Promise.resolve() : this.request({ type: 'dispose' });
    return this.disposal = closing.finally(() => {
      this.session = 0;
      this.unsubscribe();
      this.unsubscribe = null;
    });
  }
}
