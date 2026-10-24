// AlphaMovie 的 AMV 后端：专用 Worker 解码 + 有界预解码（架构图：AMV: 专用 Worker 后端）。
//
// 主线程只做三件事：把 storage 读出的文件字节交给 Worker、维护容器策略
// （Loop / NextMovieFile，需要 storage）、把解出的帧交给统一管线。像素解码、
// Huffman/IDCT 与 WASM 上下文都留在 Worker，主线程不再被整帧解码阻塞。
//
// 参考实现的 AlphaMovieNative_guess 是“实例一个线程 + Free/Ready 有界帧池”：
// 这里由 VideoPipeline 的有界队列承担同一职责（容量 = preloadSamples），
// Worker 在队列满时自然停止预解码。多个 AlphaMovie 实例共用一个 Worker，
// 会话按实例隔离，避免每个实例都重新实例化 WASM。
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
    // Decoder.Frame：最后解出的帧号（预解码可能领先已呈现的帧）。
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

  // 返回错误消息或 null，与 amv.js 的 AMVDecoder.open 契约一致。
  async open(name) {
    try { return await this.openBytes(await this.storage.read(String(name))); }
    catch (error) { return error.message; }
  }

  async openBytes(bytes) {
    // 借用归档视图不能转移所有权；显式拥有的完整缓冲才直接转移。
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

  // 解下一帧；返回 null 表示影片数据结束。片尾的循环与下一个文件切换
  // （参考 DecodeNext_guess 的 Loop / NextMovieFile 分支）在这里决策。
  async next() {
    for (;;) {
      const reply = await this.request({ type: 'decode' });
      if (reply.frame) {
        const { frame, left, top, width, height } = reply.frame;
        this.decoderFrame = frame;
        return { frame, timestamp: null, width, height, left, top, rgba: reply.pixels ?? null, ownedPixels: true };
      }
      if (!this.nextMovieFile) return null;
      // 参考 DecodeNext_guess：NextMovieFile 打不开时返回 2，工作线程结束。
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
