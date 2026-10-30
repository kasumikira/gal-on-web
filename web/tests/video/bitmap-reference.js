// Image buffers are Uint8ClampedArray (RGBA order for canvas putImageData);
// colors arriving from TJS are 0xAARRGGBB "actual color" values and are
// converted at the buffer boundary. Province/mask images are 8-bit planes.
import { getGPU } from './gpu-reference.js';

// One texture plus its CPU shadow. LayerBitmapImpl.cpp Assign shares the
// iTVPTexture2D instead of copying pixels, and Independ separates the bitmap
// only when one side is about to be written. Several Images can therefore
// reference the same storage; refs counts the attached Images.
class ImageStorage {
  constructor(width, height, gray, pixels = null) {
    this.width = width;
    this.height = height;
    this.gray = gray;
    this.pixels = pixels;
    this.gpu = null;
    // Authority is independent of allocation/residency. A read adds a valid
    // copy; a write invalidates only the other source. Deferred CPU storage
    // represents the initial transparent-black image until first use.
    this.cpuValid = true;
    this.gpuValid = false;
    this.externallyWritable = false;
    this.refs = 1;
  }
}

// Each owning Image registers its current storage. Reassignment unregisters
// the old holding so GC and explicit release cannot decrement it twice.
const imageFinalizer = new FinalizationRegistry(dropStorage);
function bindStorage(image, storage) {
  imageFinalizer.unregister(image);
  image._storage = storage;
  imageFinalizer.register(image, storage, image);
}

// Releases a detached storage that no Image references any more. Storages kept
// alive by a GC-pending Image are reclaimed by the device's finalizer.
function dropStorage(storage) {
  if (--storage.refs > 0) return;
  const entry = storage.gpu;
  if (!entry) return;
  entry.device.releaseTexture(entry);
}

export class Image {
  constructor(width, height, { gray = false, pixels, defer = true } = {}) {
    const w = Math.max(0, width | 0), h = Math.max(0, height | 0);
    // A supplied buffer is adopted; Image.from remains the copying operation.
    // Empty images start as implicit transparent black. Allocate CPU storage
    // only for explicit pixel work; rendering can initialize them on the GPU.
    this._storage = new ImageStorage(w, h, gray, pixels ?? (defer ? null : (gray
      ? new Uint8ClampedArray(w * h)
      : new Uint8ClampedArray(w * h * 4))));
    imageFinalizer.register(this, this._storage, this);
    this.halfFloat = false;
  }
  // Geometry and pixel residency belong to the shared storage so an assigned
  // image reports the source bitmap's size and format, as the native Assign
  // replaces the Bitmap pointer.
  get width() { return this._storage.width; }
  get height() { return this._storage.height; }
  get gray() { return this._storage.gray; }
  get _pixels() { return this._storage.pixels; }
  set _pixels(value) { this._storage.pixels = value; }
  get gpu() { return this._storage.gpu; }
  set gpu(value) { this._storage.gpu = value; }
  get cpuValid() { return this._storage.cpuValid; }
  set cpuValid(value) { this._storage.cpuValid = value; }
  get gpuValid() { return this._storage.gpuValid; }
  set gpuValid(value) { this._storage.gpuValid = value; }
  get externallyWritable() { return this._storage.externallyWritable; }
  set externallyWritable(value) { this._storage.externallyWritable = value; }
  // A read-only view of an existing storage. Used to copy a detached texture
  // through the existing GPU copy path without transferring ownership.
  static fromStorage(storage) {
    const image = Object.create(Image.prototype);
    image._storage = storage;
    image.halfFloat = false;
    return image;
  }
  // tTVPNativeBaseBitmap copy construction: a new wrapper shares the source
  // Bitmap and calls AddRef. AssignImages uses this when the destination plane
  // does not exist yet (new tTVPBaseTexture(*src->MainImage)).
  copyReference() {
    if (this.externallyWritable) return this.clone();
    const image = Image.fromStorage(this._storage);
    this._storage.refs++;
    bindStorage(image, this._storage);
    image.halfFloat = this.halfFloat;
    return image;
  }
  // Drop this wrapper's ownership without evicting another Image's texture.
  release() {
    const storage = this._storage;
    imageFinalizer.unregister(this);
    this._storage = null;
    dropStorage(storage);
  }
  // tTVPNativeBaseBitmap::Independ / IndependNoCopy: separate shared storage
  // before a write. copy=false recreates empty content instead of preserving
  // the old pixels; preferCPU keeps writable pixel access on the CPU side.
  detach(copy = true, preferCPU = false) {
    const old = this._storage;
    if (old.refs <= 1) return this;
    const next = new ImageStorage(old.width, old.height, old.gray);
    bindStorage(this, next);
    if (copy) {
      const gpu = getGPU();
      if (!preferCPU && gpu && old.gpuValid && old.gpu) {
        gpu.copy(this, Image.fromStorage(old));
      } else if (old.cpuValid) {
        if (old.pixels) next.pixels = old.pixels.slice();
      } else if (old.gpuValid && old.gpu) {
        next.pixels = (old.gpu.device ?? gpu).read(old.gpu);
        next.cpuValid = true;
      }
    }
    dropStorage(old);
    return this;
  }
  get pixels() {
    const storage = this._storage;
    if (!storage.cpuValid) {
      if (!storage.gpuValid) throw new Error('Image has no authoritative source');
      const data = storage.gpu.device.read(storage.gpu);
      if (storage.pixels) storage.pixels.set(data); else storage.pixels = data;
      storage.cpuValid = true;
    }
    return storage.pixels ??= new Uint8ClampedArray(storage.width * storage.height * (storage.gray ? 1 : 4));
  }
  get writablePixels() {
    this.detach(true, true);
    const pixels = this.pixels;
    this.markCPUWritten(false);
    return pixels;
  }
  markCPUWritten(copy = true) {
    this.detach(copy, true);
    this._storage.cpuValid = true;
    this._storage.gpuValid = false;
  }
  markGPUWritten() {
    const storage = this._storage;
    storage.gpuValid = true;
    storage.cpuValid = false;
    // External writable views must keep their backing array for synchronization.
    if (!storage.externallyWritable) storage.pixels = null;
  }
  set pixels(value) {
    this.detach(false);
    this._storage.pixels = value;
    this._storage.cpuValid = true;
    this._storage.gpuValid = false;
  }
  materialize() {
    return this.pixels;
  }
  static from(pixels, width, height, { gray = false } = {}) {
    const img = new Image(width, height, { gray });
    img.writablePixels.set(pixels);
    return img;
  }
  clone() {
    const gpu = getGPU();
    if (gpu && this.width && this.height) {
      const copy = new Image(this.width, this.height, { gray: this.gray, defer: true });
      gpu.copy(copy, this);
      return copy;
    }
    return Image.from(this.pixels, this.width, this.height, { gray: this.gray });
  }
  resized(width, height) {
    if (width === this.width && height === this.height) return this;
    const gpu = getGPU();
    if (gpu && this.width && this.height && width && height) {
      const next = new Image(width, height, { gray: this.gray, defer: true });
      gpu.fill(next, { left: 0, top: 0, right: width, bottom: height }, [0, 0, 0, 0]);
      gpu.draw(next, this, {
        sourceRect: { left: 0, top: 0, right: Math.min(width, this.width), bottom: Math.min(height, this.height) },
        mode: 1, copySourceAlpha: true,
      });
      return next;
    }
    const next = new Image(width, height, { gray: this.gray });
    const copyWidth = Math.min(width, this.width), copyHeight = Math.min(height, this.height);
    const stride = this.gray ? 1 : 4, row = copyWidth * stride;
    const target = next.writablePixels, source = this.pixels;
    for (let y = 0; y < copyHeight; y++) {
      target.set(source.subarray(y * this.width * stride, y * this.width * stride + row), y * width * stride);
    }
    return next;
  }
  // Layer resizing mutates its bitmap, as SetSizeWithFill does in the native
  // backend. Transfer the replacement storage and release the old texture now,
  // rather than retaining every intermediate size until a GC finalizer runs.
  resize(width, height) {
    const next = this.resized(width, height);
    if (next === this) return this;
    const old = this._storage;
    imageFinalizer.unregister(next);
    bindStorage(this, next._storage);
    // `next` owns the fabricated storage and is discarded here; relinquish its
    // reference so it does not look like a second Image sharing the result.
    next._storage = null;
    dropStorage(old);
    return this;
  }
  // tTVPNativeBaseBitmap::Assign: release the old bitmap and reference the
  // source texture. Neither side is copied until one of them is written.
  // Assign does not inspect dimensions or format: the destination bitmap
  // becomes the source bitmap, and Layer::AssignImages then resizes the layer
  // through InternalSetImageSize.
  assign(src) {
    if (src === this || src._storage === this._storage) return this;
    const old = this._storage;
    // Writes through an exported array cannot trigger detach. Snapshot it
    // instead of sharing storage that can change outside the Image API.
    if (src.externallyWritable) {
      this._storage = new ImageStorage(src.width, src.height, src.gray, src.pixels.slice());
    } else {
      this._storage = src._storage;
      this._storage.refs++;
    }
    bindStorage(this, this._storage);
    this.halfFloat = src.halfFloat;
    dropStorage(old);
    return this;
  }
}
