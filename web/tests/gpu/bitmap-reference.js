// Image buffers are Uint8ClampedArray (RGBA order for canvas putImageData);
// colors arriving from TJS are 0xAARRGGBB "actual color" values and are
// converted at the buffer boundary. Province/mask images are 8-bit planes.
import { getGPU, QUAD_VERTEX } from './gpu-reference.js';
import { number } from '#krkr/values';

// LayerImpl.cpp TVPToActualColor: system colors (high bit) go to RGB; the
// 0xBBGGRR Windows layout is byte-swapped into 0xRRGGBB. Plain 0xAARRGGBB
// values pass through unchanged.
export function toActualColor(color) {
  color = Math.trunc(number(color)) >>> 0;
  if (color & 0xff000000) {
    const r = color & 0xff, g = (color >> 8) & 0xff, b = (color >> 16) & 0xff;
    return (b << 16) + (g << 8) + r;
  }
  return color;
}
// Actual color (0xRRGGBB) to buffer RGBA bytes.
export const colorBytes = color => [(color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff, (color >>> 24) & 0xff];

export const clamp255 = v => v < 0 ? 0 : v > 255 ? 255 : v;

// The numeric values are the public tTVPBlendOperationMode/tTVPLayerType
// values from ScriptMgnIntf.cpp.  Keep these here rather than importing Layer
// so Bitmap remains usable by ImageFunction and the Layer drawing helpers.
export const blendModes = Object.freeze({
  binder: 0, opaque: 1, alpha: 2, additive: 3, subtractive: 4,
  multiplicative: 5, dodge: 8, darken: 9, lighten: 10, screen: 11,
  addAlpha: 12, psNormal: 13, psAdditive: 14, psSubtractive: 15,
  psMultiplicative: 16, psScreen: 17, psOverlay: 18, psHardLight: 19,
  psSoftLight: 20, psColorDodge: 21, psColorDodge5: 22, psColorBurn: 23,
  psLighten: 24, psDarken: 25, psDifference: 26, psDifference5: 27,
  psExclusion: 28, auto: 128,
});

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
  resized(width, height, color = 0) {
    if (width === this.width && height === this.height) return this;
    const gpu = getGPU();
    if (gpu && this.width && this.height && width && height) {
      const next = new Image(width, height, { gray: this.gray, defer: true });
      gpu.fill(next, { left: 0, top: 0, right: width, bottom: height }, this.gray ? [color & 255, 0, 0, 0] : colorBytes(color));
      gpu.draw(next, this, {
        sourceRect: { left: 0, top: 0, right: Math.min(width, this.width), bottom: Math.min(height, this.height) },
        mode: 1, copySourceAlpha: true,
      });
      return next;
    }
    const next = new Image(width, height, { gray: this.gray });
    const copyWidth = Math.min(width, this.width), copyHeight = Math.min(height, this.height);
    // SetSizeWithFill preserves the overlap and fills only the newly exposed
    // strips. Fresh typed arrays already contain transparent black.
    if (!this.gray && color !== 0) {
      next.fill({ left: copyWidth, top: 0, right: width, bottom: copyHeight }, color);
      next.fill({ left: 0, top: copyHeight, right: width, bottom: height }, color);
    }
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
  resize(width, height, color = 0) {
    const next = this.resized(width, height, color);
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
  index(x, y) { return y * this.width + x; }
  point(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) throw new Error('TJS range error');
    if (!this.cpuValid && this.gpuValid) {
      const p = this.gpu.device.read(this.gpu, { left: x, top: y, right: x + 1, bottom: y + 1 });
      if (this.gray) return p[0];
      return (p[3] << 24) + (p[0] << 16) + (p[1] << 8) + p[2];
    }
    if (this.gray) return this.pixels[this.index(x, y)];
    const base = this.index(x, y) * 4, p = this.pixels;
    return (p[base + 3] << 24) + (p[base] << 16) + (p[base + 1] << 8) + p[base + 2];
  }
  setPoint(x, y, color) {
    const gpu = getGPU();
    if (gpu) {
      gpu.fill(this, { left: x, top: y, right: x + 1, bottom: y + 1 },
        this.gray ? [color & 255, 0, 0, 0] : colorBytes(color));
      return;
    }
    if (this.gray) {
      this.writablePixels[this.index(x, y)] = color & 0xff;
      return;
    }
    const base = this.index(x, y) * 4, p = this.writablePixels;
    p[base] = (color >>> 16) & 0xff; p[base + 1] = (color >>> 8) & 0xff;
    p[base + 2] = color & 0xff; p[base + 3] = (color >>> 24) & 0xff;
  }
  fill(rect, color, maskOnly = false) {
    // iTVPBaseBitmap::Fill fills both main and alpha planes.
    const l = Math.max(0, rect.left), t = Math.max(0, rect.top);
    const r = Math.min(this.width, rect.right), b = Math.min(this.height, rect.bottom);
    if (r <= l || b <= t) return false;
    const [cr, cg, cb, ca] = colorBytes(color);
    const gpu = getGPU();
    if (gpu) {
      gpu.fill(this, { left: l, top: t, right: r, bottom: b }, this.gray ? [color & 255, 0, 0, 0] : [cr, cg, cb, ca], maskOnly && !this.gray);
      return true;
    }
    const bytes = this.writablePixels;
    // The supported Windows/browser runtime is little-endian: fill complete
    // RGBA pixels as words instead of assigning four channels per pixel.
    if (!maskOnly || this.gray) {
      const pixels = this.gray ? bytes : new Uint32Array(bytes.buffer, bytes.byteOffset, this.width * this.height);
      const value = this.gray ? color & 255 : (ca << 24 | cb << 16 | cg << 8 | cr) >>> 0;
      if (l === 0 && r === this.width) pixels.fill(value, t * this.width, b * this.width);
      else for (let y = t; y < b; y++) pixels.fill(value, this.index(l, y), this.index(r, y));
      return true;
    }
    for (let y = t; y < b; y++) {
      let base = this.index(l, y) * 4;
      for (let x = l; x < r; x++) {
        bytes[base + 3] = ca;
        base += 4;
      }
    }
    return r > l && b > t;
  }
  // iTVPBaseBitmap::FillColor: TVPFillColor when opaque, otherwise a constant
  // alpha blend that always holds the destination alpha.
  fillColor(rect, color, opa = 255) {
    const value = toActualColor(color), a = clamp255(opa);
    if (!this.width || !this.height) return false;
    colourPixels(this, rect, value, a, a === 255 ? 0 : 1);
    return true;
  }
  // iTVPBaseBitmap::FillColorOnAlpha / FillColorOnAddAlpha (BlendColor).
  blendColor(rect, color, opa, additive = false) {
    const value = toActualColor(color), a = clamp255(opa);
    if (!this.width || !this.height) return false;
    colourPixels(this, rect, a === 255 ? value | 0xff000000 : value, a, a === 255 ? 4 : additive ? 3 : 2);
    return true;
  }
  // iTVPBaseBitmap::RemoveConstOpacity.
  removeConstOpacity(rect, level) {
    if (!this.width || !this.height) return false;
    colourPixels(this, rect, 0, clamp255(Math.abs(level)), 5);
    return true;
  }
  // TVPDoGrayScale / TVPConvert(Additive)Alpha.
  transform(rect, kind) {
    const operation = typeof kind === 'number'
      ? kind
      : { grayscale: 0, alphaToAdditive: 1, additiveToAlpha: 2 }[kind];
    transformPixels(this, rect, operation);
    return true;
  }
  // Layer.AdjustGamma / Layer.light: per channel 256 entry tables.
  applyLookup(rect, tables, additive = false) {
    lookupPixels(this, rect, tables, additive);
    return true;
  }
  // iTVPBaseBitmap::DoBoxBlur / DoBoxBlurForAlpha.
  boxBlur(rect, area, alphaMode = false) {
    boxBlurPixels(this, rect, area, alphaMode);
    return true;
  }
  // tTJSNI_BaseLayer::ApplyGaussianBlur: separable kernel, two passes.
  gaussianBlur(radius, sigma) {
    gaussianBlurPixels(this, Math.trunc(radius), sigma);
    return true;
  }
  // Copy both main and mask planes (TVP_BB_COPY_MAIN | TVP_BB_COPY_MASK).
  copyRect(x, y, src, rect, { main = true, mask = true } = {}) {
    const gpu = getGPU();
    // Matching planes already have a GPU copy implementation. CPU residency
    // only determines the upload required by texture(), not this selection.
    if (gpu && this.gray === src.gray) {
      if (!this.gray && !main && !mask) return true;
      const source = src === this ? src.clone() : src;
      const sourceRect = { left: Math.max(0, rect.left), top: Math.max(0, rect.top),
        right: Math.min(src.width, rect.right), bottom: Math.min(src.height, rect.bottom) };
      gpu.draw(this, source, {
        matrix: [1, 0, 0, 1, x - rect.left, y - rect.top], sourceRect,
        mode: 1, copySourceAlpha: true, holdAlpha: !mask && !this.gray, maskOnly: !main && !this.gray,
      });
      return true;
    }
    if (this.gray === src.gray && (this.gray || main && mask)) {
      const left = Math.max(rect.left, 0, rect.left - x);
      const top = Math.max(rect.top, 0, rect.top - y);
      const right = Math.min(rect.right, src.width, rect.left + this.width - x);
      const bottom = Math.min(rect.bottom, src.height, rect.top + this.height - y);
      if (right <= left || bottom <= top) return true;
      const stride = this.gray ? 1 : 4, bytes = (right - left) * stride;
      const dx = x + left - rect.left, dy = y + top - rect.top;
      // TypedArray.set handles horizontal overlap. Copy bottom-up when a
      // self-copy moves rows down, so no full-image temporary is needed.
      const backwards = src === this && dy > top;
      const source = src.pixels, target = this.writablePixels;
      for (let row = backwards ? bottom - top - 1 : 0;
        backwards ? row >= 0 : row < bottom - top; row += backwards ? -1 : 1) {
        const offset = ((top + row) * src.width + left) * stride;
        target.set(source.subarray(offset, offset + bytes), ((dy + row) * this.width + dx) * stride);
      }
      return true;
    }
    if (src === this) src = Image.from(src.pixels, src.width, src.height, { gray: src.gray });
    const p = this.writablePixels, q = src.pixels;
    for (let sy = rect.top; sy < rect.bottom; sy++) {
      const dy = y + sy - rect.top;
      if (dy < 0 || dy >= this.height || sy < 0 || sy >= src.height) continue;
      for (let sx = rect.left; sx < rect.right; sx++) {
        const dx = x + sx - rect.left;
        if (dx < 0 || dx >= this.width || sx < 0 || sx >= src.width) continue;
        if (this.gray) { p[this.index(dx, dy)] = q[src.index(sx, sy)]; continue; }
        const d = this.index(dx, dy) * 4, s = src.index(sx, sy) * 4;
        if (main) { p[d] = q[s]; p[d + 1] = q[s + 1]; p[d + 2] = q[s + 2]; }
        if (mask) p[d + 3] = q[s + 3];
      }
    }
    return true;
  }
}

// LayerIntf.cpp / LayerBitmapIntf.cpp Copy9Patch via nine CopyRect draws
// instead of a per-pixel loop.
// tTVPBaseBitmap::LRFlip / UDFlip: a mirrored copy through one scaled draw.
export function flipImage(image, horizontal) {
  const flipped = new Image(image.width, image.height);
  getGPU().draw(flipped, image, {
    matrix: horizontal ? [-1, 0, 0, 1, image.width, 0] : [1, 0, 0, -1, 0, image.height],
    mode: 1, copySourceAlpha: true,
  });
  return flipped;
}

export function tileImage(image, width, height) {
  width = Math.max(width, image.width); height = Math.max(height, image.height);
  if (width === image.width && height === image.height) return image;
  const result = new Image(width, height, { gray: image.gray, defer: true }), gpu = getGPU();
  for (let y = 0; y < height; y += image.height) for (let x = 0; x < width; x += image.width) {
    gpu.draw(result, image, { matrix: [1, 0, 0, 1, x, y], mode: 1, copySourceAlpha: true });
  }
  return result;
}

export function copy9Patch(dest, source) {
  if (source.gray || dest.gray) return false;
  const w = source.width, h = source.height;
  if (w < 11 || h < 11) return false;
  const dw = dest.width, dh = dest.height;
  if (dw < w - 2 || dh < h - 2) return false;
  const alphaOf = (x, y) => (source.point(x, y) >>> 24) & 0xff;
  // scale: first opaque run in the top row (x) and left column (y).
  let scaleLeft = -1, scaleRight = -1, scaleTop = -1, scaleBottom = -1;
  let marginLeft = -1, marginRight = -1, marginTop = -1, marginBottom = -1;
  for (let x = 1; x < w - 1; x++) {
    const topAlpha = alphaOf(x, 0), bottomAlpha = alphaOf(x, h - 1);
    if (scaleLeft === -1 && topAlpha === 0xff) scaleLeft = x;
    else if (scaleLeft !== -1 && scaleRight === -1 && topAlpha === 0) scaleRight = x;
    if (marginLeft === -1 && bottomAlpha === 0xff) marginLeft = x - 1;
    else if (marginLeft !== -1 && marginRight === -1 && bottomAlpha === 0) marginRight = w - x - 1;
    if (scaleRight !== -1 && marginRight !== -1) break;
  }
  for (let y = 1; y < h - 1; y++) {
    const leftAlpha = alphaOf(0, y), rightAlpha = alphaOf(w - 1, y);
    if (scaleTop === -1 && leftAlpha === 0xff) scaleTop = y;
    else if (scaleTop !== -1 && scaleBottom === -1 && leftAlpha === 0) scaleBottom = y;
    if (marginTop === -1 && rightAlpha === 0xff) marginTop = y - 1;
    else if (marginTop !== -1 && marginBottom === -1 && rightAlpha === 0) marginBottom = h - y - 1;
    if (scaleBottom !== -1 && marginBottom !== -1) break;
  }
  if (scaleLeft === -1 || scaleRight === -1 || scaleTop === -1 || scaleBottom === -1) return false;
  // The scale area excludes its 1px frame: the corners come from the outer ring.
  const srcLeftWidth = scaleLeft - 1, srcRightWidth = w - 1 - scaleRight;
  const srcTopHeight = scaleTop - 1, srcBottomHeight = h - 1 - scaleBottom;
  const srcCenterWidth = scaleRight - scaleLeft, srcCenterHeight = scaleBottom - scaleTop;
  const dstCenterWidth = dw - srcLeftWidth - srcRightWidth;
  const dstCenterHeight = dh - srcTopHeight - srcBottomHeight;
  if (dstCenterWidth <= 0 || dstCenterHeight <= 0) return false;
  // Column and row bands: [source start, source extent, destination start, destination extent].
  const left = [1, srcLeftWidth, 0, srcLeftWidth];
  const centreX = [scaleLeft, srcCenterWidth, srcLeftWidth, dstCenterWidth];
  const right = [scaleRight, srcRightWidth, dw - srcRightWidth, srcRightWidth];
  const top = [1, srcTopHeight, 0, srcTopHeight];
  const centreY = [scaleTop, srcCenterHeight, srcTopHeight, dstCenterHeight];
  const bottom = [scaleBottom, srcBottomHeight, dh - srcBottomHeight, srcBottomHeight];
  const columns = [left, centreX, right], rows = [top, centreY, bottom];
  for (const row of rows) for (const column of columns) {
    const [sx, sw, dx, dwe] = column, [sy, sh, dy, dhe] = row;
    if (!sw || !sh || !dwe || !dhe) continue;
    const sourceRect = { left: sx, top: sy, right: sx + sw, bottom: sy + sh };
    if (sw === dwe && sh === dhe) {
      dest.copyRect(dx, dy, source, sourceRect);
    } else {
      // StretchBlt(bmCopy, stNearest): one scaled primitive per band.
      const scaleX = dwe / sw, scaleY = dhe / sh;
      getGPU().draw(dest, source, {
        matrix: [scaleX, 0, 0, scaleY, dx - sx * scaleX, dy - sy * scaleY],
        sourceRect, mode: 1, copySourceAlpha: true,
      });
    }
  }
  return true;
}

// Whole-buffer pixel operations behind Image.fillColor/blendColor/
// removeConstOpacity/transform/applyLookup/boxBlur/gaussianBlur. Every one of
// them reads and writes the same image, so the program and its scratch tables
// belong to Image rather than to the shared device.
const PIXEL_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D sourceTexture;
uniform sampler2D tableTexture;
uniform sampler2D lutTexture;
uniform sampler2D kernelTexture;
uniform vec2 sourceSize;
uniform int operation;
uniform int colourOp;
uniform int colourValue;
uniform int colourOpa;
uniform int lutOp;
uniform int transformOp;
uniform int blurRadius;
uniform ivec2 blurStep;
uniform int blurLeft;
uniform int blurTop;
uniform int blurRight;
uniform int blurBottom;
uniform bool blurAlpha;
in vec2 sourcePoint;
out vec4 colour;

uint packARGB(vec4 c) {
  uvec4 b = uvec4(round(clamp(c, 0.0, 1.0) * 255.0));
  return (b.a << 24u) | (b.r << 16u) | (b.g << 8u) | b.b;
}
vec4 unpackARGB(uint c) {
  return vec4(float((c >> 16u) & 255u), float((c >> 8u) & 255u), float(c & 255u), float(c >> 24u)) / 255.0;
}
uint satAdd(uint a, uint b) {
  uint tmp = ((a & b) + (((a ^ b) >> 1u) & 0x7f7f7f7fu)) & 0x80808080u;
  tmp = (tmp << 1u) - (tmp >> 7u);
  return (a + b - tmp) | tmp;
}
uint mulColor(uint color, uint fac) {
  return ((((color & 0x00ff00u) * fac) & 0x00ff0000u) + (((color & 0xff00ffu) * fac) & 0xff00ff00u)) >> 8u;
}
// TVPOpacityOnOpacityTable, shared with the layer blend program.
uint opacityOnOpacity(uint srcAlpha, uint destAlpha) {
  return uint(round(texelFetch(tableTexture, ivec2(int(destAlpha), int(srcAlpha)), 0).r * 255.0));
}

// premulalpha_blend_a_ca_func: additive-alpha fill with an explicit source alpha.
uint premulAC(uint d, uint sopa, uint sopaInv, uint src) {
  uint dopa = d >> 24u;
  dopa = dopa + sopa - (dopa * sopa >> 8u);
  dopa -= dopa >> 8u;
  return (dopa << 24u) + satAdd((((d & 0xff00ffu) * sopaInv >> 8u) & 0xff00ffu) + (((d & 0xff00u) * sopaInv >> 8u) & 0xff00u), src);
}

// LayerBitmapIntf FillColor / BlendColor family (tvpgl const_alpha_fill_blend).
uint constColourPixel(uint d) {
  uint c = uint(colourValue) & 0x00ffffffu;
  uint opa = uint(colourOpa);
  if (colourOp == 0) return (d & 0xff000000u) | c;                                   // TVPFillColor
  if (colourOp == 1) {                                                               // TVPConstColorAlphaBlend
    uint inv = 255u - opa;
    return (d & 0xff000000u)
      + ((((d & 0xff00ffu) * inv + (c & 0xff00ffu) * opa) >> 8u) & 0xff00ffu)
      + ((((d & 0xff00u) * inv + (c & 0xff00u) * opa) >> 8u) & 0xff00u);
  }
  if (colourOp == 2) {                                                               // TVPConstColorAlphaBlend_d
    uint dopa = d >> 24u;
    uint alpha = opacityOnOpacity(opa, dopa);
    uint d1 = d & 0xff00ffu;
    d1 = (d1 + (((c & 0xff00ffu) - d1) * alpha >> 8u)) & 0xff00ffu;
    d1 |= (255u - ((255u - dopa) * (255u - opa) >> 8u)) << 24u;
    uint dd = d & 0xff00u;
    return d1 | ((dd + (((c & 0xff00u) - dd) * alpha >> 8u)) & 0xff00u);
  }
  if (colourOp == 3) {                                                               // TVPConstColorAlphaBlend_a
    uint premul = (((((c & 0x00ff00u) * opa) & 0x00ff0000u) + (((c & 0xff00ffu) * opa) & 0xff00ff00u)) >> 8u);
    return premulAC(d, opa, opa ^ 0xffu, premul);
  }
  if (colourOp == 4) return uint(colourValue);                                       // TVPFillARGB
  return (d & 0x00ffffffu) + ((((d >> 24u) * (255u - opa)) << 16u) & 0xff000000u);   // TVPRemoveConstOpacity
}

// TVPAdjustGamma / Layer.light: per channel 256 entry lookup table.
// TVPAdjustGamma_c indexes the table with recip*t>>8, which reaches 256 when
// t equals alpha and alpha is a power of two; that index is one past the array,
// so the reference reads out of bounds. Return zero there instead of a rounded
// value, matching the fetch semantics and the reference's observed output.
uint lutEntry(uint channel, uint index) {
  if (index > 255u) return 0u;
  return uint(round(texelFetch(lutTexture, ivec2(int(index), int(channel)), 0).r * 255.0));
}
uint lutPixel(uint d) {
  uint alpha = d >> 24u;
  if (lutOp == 0) {
    if (alpha == 0u) return d;
    return (d & 0xff000000u) | (lutEntry(0u, d & 255u)) | (lutEntry(1u, (d >> 8u) & 255u) << 8u) | (lutEntry(2u, (d >> 16u) & 255u) << 16u);
  }
  if (lutOp == 2 || alpha == 255u) {
    return (d & 0xff000000u) | (lutEntry(0u, d & 255u)) | (lutEntry(1u, (d >> 8u) & 255u) << 8u) | (lutEntry(2u, (d >> 16u) & 255u) << 16u);
  }
  if (alpha == 0u) return d;
  // Additive-alpha face: weight by the adjusted alpha and the recip table.
  uint adjusted = alpha + (alpha >> 7u);
  uint recip = min(0x7fffu, 65536u / alpha);
  uint result = d & 0xff000000u;
  for (int c = 0; c < 3; c++) {
    uint t = (d >> uint(8 * c)) & 255u;
    uint value;
    // The reference ORs the unclamped value, so a value of 256 carries into the
    // neighbouring channel; reproduce that bit spill exactly.
    if (t > alpha) value = (lutEntry(uint(c), 255u) * adjusted >> 8u) + t - alpha;
    else value = lutEntry(uint(c), recip * t >> 8u) * adjusted >> 8u;
    result |= value << uint(8 * c);
  }
  return result;
}

// TVPDoGrayScale / TVPConvert(Additive)Alpha: whole image value transforms.
uint transformedPixel(uint s) {
  if (transformOp == 0) {
    uint v = ((s & 255u) * 19u + ((s >> 8u) & 255u) * 183u + ((s >> 16u) & 255u) * 54u) >> 8u;
    return (v * 0x010101u) | (s & 0xff000000u);
  }
  if (transformOp == 1) return mulColor(s, s >> 24u) | (s & 0xff000000u);
  uint alpha = s >> 24u;
  uint result = s & 0xff000000u;
  for (int c = 0; c < 3; c++) {
    uint v = (s >> uint(8 * c)) & 255u;
    result |= (alpha == 0u ? 0u : min(255u, v * 255u / alpha)) << uint(8 * c);
  }
  return result;
}

// iTVPBaseBitmap::DoBoxBlur / DoBoxBlurForAlpha over the clamped area.
uint boxBlurPixel() {
  ivec2 size = ivec2(sourceSize);
  ivec2 centre = ivec2(gl_FragCoord.xy);
  int x0 = max(0, centre.x + blurLeft), x1 = min(size.x - 1, centre.x + blurRight);
  int y0 = max(0, centre.y + blurTop), y1 = min(size.y - 1, centre.y + blurBottom);
  if (x1 < x0 || y1 < y0) return 0u;
  uint n = uint((x1 - x0 + 1) * (y1 - y0 + 1));
  uint rounding = n >> 1u;
  uint sumB = 0u, sumG = 0u, sumR = 0u, sumA = 0u;
  for (int y = y0; y <= y1; y++) for (int x = x0; x <= x1; x++) {
    uint v = packARGB(texelFetch(sourceTexture, ivec2(x, y), 0));
    if (blurAlpha) {
      uint a = v >> 24u;
      uint aadj = a + (a >> 7u);
      sumA += a;
      sumB += (v & 255u) * aadj >> 8u;
      sumG += ((v >> 8u) & 255u) * aadj >> 8u;
      sumR += ((v >> 16u) & 255u) * aadj >> 8u;
    } else {
      sumA += v >> 24u;
      sumB += v & 255u;
      sumG += (v >> 8u) & 255u;
      sumR += (v >> 16u) & 255u;
    }
  }
  if (!blurAlpha) {
    return (((sumR + rounding) / n) << 16u) | (((sumG + rounding) / n) << 8u) | ((sumB + rounding) / n) | (((sumA + rounding) / n) << 24u);
  }
  uint alpha = (sumA + rounding) / n;
  uint result = alpha << 24u;
  for (int c = 0; c < 3; c++) {
    uint value = (c == 0 ? sumB : c == 1 ? sumG : sumR);
    uint mean = (value + rounding) / n;
    result |= (alpha == 0u ? 0u : min(255u, mean * 255u / alpha)) << uint(8 * c);
  }
  return result;
}

// tTJSNI_BaseLayer::ApplyGaussianBlur: separable convolution with the
// generate_1d_gaussian_kernel weights, clamp-to-edge sampling, float
// accumulation and per pass truncation at the 8 bit target.
vec4 gaussianPixel() {
  ivec2 size = ivec2(sourceSize);
  ivec2 base = ivec2(gl_FragCoord.xy);
  vec4 sum = vec4(0.0);
  for (int k = -blurRadius; k <= blurRadius; k++) {
    ivec2 p = clamp(base + k * blurStep, ivec2(0), size - 1);
    float weight = texelFetch(kernelTexture, ivec2(k + blurRadius, 0), 0).r;
    sum += texelFetch(sourceTexture, p, 0) * 255.0 * weight;
  }
  return clamp(floor(sum), 0.0, 255.0) / 255.0;
}

void main() {
  ivec2 point = ivec2(gl_FragCoord.xy);
  uint d = packARGB(texelFetch(sourceTexture, point, 0));
  if (operation == 9) { colour = unpackARGB(constColourPixel(d)); return; }
  if (operation == 10) { colour = unpackARGB(lutPixel(d)); return; }
  if (operation == 11) { colour = unpackARGB(transformedPixel(d)); return; }
  if (operation == 12) { colour = unpackARGB(boxBlurPixel()); return; }
  colour = gaussianPixel();
}`;

const IDENTITY = [1, 0, 0, 1, 0, 0];
const pixelStates = new WeakMap();
function pixelState(gpu) {
  let state = pixelStates.get(gpu);
  if (state) return state;
  const gl = gpu.gl;
  const program = gpu.compile(QUAD_VERTEX, PIXEL_FRAGMENT);
  state = { program, lutTexture: null, kernelTexture: null, kernelSize: 0, blurTarget: null };
  pixelStates.set(gpu, state);
  gpu.onDispose(() => {
    gl.deleteProgram(program);
    if (state.lutTexture) gl.deleteTexture(state.lutTexture);
    if (state.kernelTexture) gl.deleteTexture(state.kernelTexture);
    if (state.blurTarget) {
      gl.deleteTexture(state.blurTarget.texture);
      gl.deleteFramebuffer(state.blurTarget.framebuffer);
    }
    pixelStates.delete(gpu);
  });
  return state;
}

// Every sampler in the whole-buffer program must resolve to a complete texture
// even when the current operation does not use that branch. The lookup/kernel
// units otherwise keep stale or empty bindings and the next unrelated pass
// fails with INVALID_OPERATION.
function bindPixelFallbacks(gpu) {
  const gl = gpu.gl;
  for (const unit of [5, 6]) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, gpu.tables);
  }
  gl.activeTexture(gl.TEXTURE0);
}

// Runs a whole-buffer pass reading the previous content and writing it back.
function pixelOperation(image, rect, operation, setUniforms) {
  const gpu = getGPU();
  if (gpu.lost) throw new Error('WebGL context was lost; reload the game');
  if (image.gray) throw new Error('GPU operations require an RGBA image');
  const clip = gpu.clip(image, rect);
  if (clip.right <= clip.left || clip.bottom <= clip.top) return;
  const state = pixelState(gpu), gl = gpu.gl;
  // The pass reads and rewrites the same texture; separate shared storage first.
  image.detach(true);
  const target = gpu.texture(image);
  const previous = gpu.snapshot(target, gpu.clip(image));
  const full = { left: 0, top: 0, right: image.width, bottom: image.height };
  try {
    gpu.setup(target, previous, full, IDENTITY, clip, previous, state.program);
    bindPixelFallbacks(gpu);
    // Scratch capacity may exceed this image; neighbourhood filters must clamp
    // to the logical image bounds, not to unused texels in the scratch buffer.
    gpu.uniform('sourceSize', 'uniform2f', image.width, image.height);
    gpu.uniform('operation', 'uniform1i', operation);
    setUniforms(gpu, state);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gpu.stats.draws++;
    gpu.commit(image, target);
  } finally {
    gl.useProgram(gpu.program);
  }
}

function colourPixels(image, rect, argb, opa, op) {
  pixelOperation(image, rect, 9, gpu => {
    gpu.uniform('colourOp', 'uniform1i', op);
    gpu.uniform('colourValue', 'uniform1i', argb | 0);
    gpu.uniform('colourOpa', 'uniform1i', opa);
  });
}

function transformPixels(image, rect, kind) {
  pixelOperation(image, rect, 11, gpu => gpu.uniform('transformOp', 'uniform1i', kind));
}

// TVPAdjustGamma / Layer.light: the tables are computed on the host with the
// reference arithmetic and applied as a lookup texture.
function lookupPixels(image, rect, tables, additive) {
  const data = new Uint8Array(256 * 3);
  for (let channel = 0; channel < 3; channel++) data.set(tables[channel], channel * 256);
  pixelOperation(image, rect, 10, (gpu, state) => {
    const gl = gpu.gl;
    gl.activeTexture(gl.TEXTURE5);
    if (!state.lutTexture) {
      state.lutTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, state.lutTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 3, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, state.lutTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 3, gl.RED, gl.UNSIGNED_BYTE, data);
    }
    gpu.uniform('lutTexture', 'uniform1i', 5);
    gpu.uniform('lutOp', 'uniform1i', additive ? 1 : 0);
  });
}

function boxBlurPixels(image, rect, area, alphaMode) {
  pixelOperation(image, rect, 12, gpu => {
    gpu.uniform('blurLeft', 'uniform1i', area.left);
    gpu.uniform('blurTop', 'uniform1i', area.top);
    gpu.uniform('blurRight', 'uniform1i', area.right);
    gpu.uniform('blurBottom', 'uniform1i', area.bottom);
    gpu.uniform('blurAlpha', 'uniform1i', alphaMode ? 1 : 0);
  });
}

function uploadKernel(gpu, state, radius, sigma) {
  const gl = gpu.gl;
  const size = radius * 2 + 1;
  const data = new Float32Array(size);
  // generate_1d_gaussian_kernel, including its float32 rounding at every step.
  const s32 = Math.fround(sigma);
  const rSquared = Math.fround(Math.fround(2 * s32) * s32);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    data[i] = Math.fround(Math.exp(Math.fround(-Math.fround(x * x) / rSquared)));
    sum = Math.fround(sum + data[i]);
  }
  for (let i = 0; i < size; i++) data[i] = Math.fround(data[i] / sum);
  gl.activeTexture(gl.TEXTURE6);
  if (!state.kernelTexture) {
    state.kernelTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, state.kernelTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  gl.bindTexture(gl.TEXTURE_2D, state.kernelTexture);
  if (state.kernelSize !== size) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, size, 1, 0, gl.RED, gl.FLOAT, data);
    state.kernelSize = size;
  } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, 1, gl.RED, gl.FLOAT, data);
}

// tTJSNI_BaseLayer::ApplyGaussianBlur: two separable convolution passes.
// Pass one writes the horizontally blurred copy into a scratch target, pass
// two writes the image texture in place, so no readback is needed.
function gaussianBlurPixels(image, radius, sigma) {
  const gpu = getGPU();
  if (gpu.lost) throw new Error('WebGL context was lost; reload the game');
  if (image.gray) throw new Error('GPU operations require an RGBA image');
  if (!image.width || !image.height || !(radius > 0) || !(sigma > 0)) return;
  const state = pixelState(gpu), gl = gpu.gl;
  uploadKernel(gpu, state, radius, sigma);
  // Two-pass blur rewrites the image; detach before using it as the source.
  image.detach(true);
  const source = gpu.texture(image);
  const clip = gpu.clip(image);
  const full = { left: 0, top: 0, right: image.width, bottom: image.height };
  // The scratch target must match the image exactly: the pass clamps sample
  // coordinates to the texture size, which has to be the image size.
  if (!state.blurTarget || state.blurTarget.width !== image.width || state.blurTarget.height !== image.height) {
    if (state.blurTarget) {
      gl.deleteTexture(state.blurTarget.texture);
      gl.deleteFramebuffer(state.blurTarget.framebuffer);
    }
    state.blurTarget = gpu.create(image.width, image.height);
  }
  bindPixelFallbacks(gpu);
  try {
    const pass = (target, input, stepX, stepY) => {
      gpu.setup(target, input, full, IDENTITY, clip, input, state.program);
      gpu.uniform('operation', 'uniform1i', 13);
      gpu.uniform('blurRadius', 'uniform1i', radius);
      gpu.uniform('blurStep', 'uniform2i', stepX, stepY);
      gl.activeTexture(gl.TEXTURE6);
      gl.bindTexture(gl.TEXTURE_2D, state.kernelTexture);
      gpu.uniform('kernelTexture', 'uniform1i', 6);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    pass(state.blurTarget, source, 1, 0);
    pass(source, state.blurTarget, 0, 1);
  } finally {
    gl.useProgram(gpu.program);
  }
  gpu.stats.draws += 2;
  gpu.commit(image, source);
}
