import createModule from "./tjs-runtime.js";

export class TJSRuntime {
  constructor(wasmURL = new URL(['.', 'tjs-runtime.wasm'].join('/'), import.meta.url).href) {
    this.wasmURL = wasmURL;
    this.module = null;
    this.runtime = 0;
    this.callbacks = new Map();
    this.nextCallback = 1;
    this.identities = new WeakMap();
    this.nextIdentity = 1;
    this.tail = Promise.resolve();
  }
  async init({ onError, onDispatch, onReadOnly, canvas, gl }) {
    this.module = await createModule({
      locateFile: () => this.wasmURL,
      ...(canvas ? { getRenderCanvas: () => canvas, preinitializedWebGLContext: gl } : {}),
    });
    this.runtime = this.module._tjs_runtime_create();
    this.module.hostError = (_, message) => onError(message);
    this.module.hostDispatch = (_module, callback, operation, receiver, args) =>
      onDispatch(callback, operation, receiver, args);
    this.module.hostReadOnly = onReadOnly;
    return this;
  }
  string(value) {
    const pointer = this.module._malloc((value.length + 1) * 2);
    this.module.stringToUTF16(value, pointer, (value.length + 1) * 2);
    return pointer;
  }
  // Pure JS identity only. C++ owns export handles and their lifetimes.
  identity(value) {
    let identity = this.identities.get(value);
    if (identity === undefined) {
      identity = this.nextIdentity++;
      this.identities.set(value, identity);
    }
    return identity;
  }
  enqueue(job) {
    const next = this.tail.then(job);
    this.tail = next.catch(() => {});
    return next;
  }
  async dispose() {
    await this.tail;
    if (!await this.module._tjs_runtime_shutdown(this.runtime)) return false;
    await this.module._tjs_runtime_destroy(this.runtime);
    return true;
  }
}
