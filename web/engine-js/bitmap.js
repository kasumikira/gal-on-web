// Image buffers are Uint8ClampedArray (RGBA order for canvas putImageData);
// colors arriving from TJS are 0xAARRGGBB "actual color" values and are
// converted at the buffer boundary. Province/mask images are 8-bit planes.
import { getGPU } from './gpu.js';
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

export class Image {
  constructor(width, height, { gray = false, pixels, defer = false } = {}) {
    this.width = Math.max(0, width | 0);
    this.height = Math.max(0, height | 0);
    this.gray = gray;
    // A supplied buffer is adopted; Image.from remains the copying operation.
    // GPU render targets defer CPU allocation until an explicit pixel access.
    this._pixels = pixels ?? (defer ? null : (gray
      ? new Uint8ClampedArray(this.width * this.height)
      : new Uint8ClampedArray(this.width * this.height * 4)));
    this.gpu = null;
    // Authority is independent of allocation/residency. A read adds a valid
    // copy; a write invalidates only the other source. Deferred CPU storage
    // represents the initial transparent-black image until first use.
    this.cpuValid = true;
    this.gpuValid = false;
  }
  get pixels() {
    if (!this.cpuValid) {
      if (!this.gpuValid) throw new Error('Image has no authoritative source');
      const data = this.gpu.device.read(this.gpu);
      if (this._pixels) this._pixels.set(data); else this._pixels = data;
      this.cpuValid = true;
    }
    return this._pixels ??= new Uint8ClampedArray(this.width * this.height * (this.gray ? 1 : 4));
  }
  get writablePixels() {
    const pixels = this.pixels;
    this.markCPUWritten();
    return pixels;
  }
  markCPUWritten() {
    this._pointSample = null;
    this.cpuValid = true;
    this.gpuValid = false;
  }
  markGPUWritten() {
    this._pointSample = null;
    this.gpuValid = true;
    this.cpuValid = false;
    // External writable views must keep their backing array for synchronization.
    if (!this.externallyWritable) this._pixels = null;
  }
  set pixels(value) {
    this._pixels = value;
    this.markCPUWritten();
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
    if (this.gpuValid) {
      const copy = new Image(this.width, this.height, { defer: true });
      this.gpu.device.copy(copy, this);
      return copy;
    }
    return Image.from(this.pixels, this.width, this.height, { gray: this.gray });
  }
  resized(width, height, color = 0) {
    if (width === this.width && height === this.height) return this;
    if (this.gpuValid) {
      const gpu = this.gpu.device;
      const next = new Image(width, height, { defer: true });
      gpu.fill(next, { left: 0, top: 0, right: width, bottom: height }, colorBytes(color));
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
    const { cpuValid, gpuValid } = next;
    getGPU()?.moveImageStorage(this, next);
    this.width = next.width;
    this.height = next.height;
    this._pixels = next._pixels;
    this._pointSample = null;
    this.cpuValid = cpuValid;
    this.gpuValid = gpuValid;
    this.externallyWritable = next.externallyWritable;
    return this;
  }
  // Preserve identity and independently copy all RGBA channels, including
  // colour underneath a zero mask. GPU copies never pass through Canvas 2D.
  assign(src) {
    if (src === this) return this;
    if (this.width !== src.width || this.height !== src.height) {
      this.width = src.width;
      this.height = src.height;
      this._pixels = null;
      this.markCPUWritten();
    }
    // Resident sources stay on the GPU, including transition snapshots. A CPU
    // copy would need another full upload as soon as the copy is rendered.
    if (src.gpuValid) {
      src.gpu.device.copy(this, src);
    } else {
      const source = src.pixels;
      const target = this._pixels ??= new Uint8ClampedArray(source.length);
      target.set(source);
      this.markCPUWritten();
    }
    return this;
  }
  index(x, y) { return y * this.width + x; }
  point(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) throw new Error('TJS range error');
    if (!this.cpuValid && this.gpuValid) {
      // Mouse move/down/up/click can test the same unchanged pixel. Retain
      // just the latest sample instead of synchronizing the GPU each time.
      const sample = this._pointSample;
      if (sample && sample.x === x && sample.y === y) return sample.color;
      const p = this.gpu.device.read(this.gpu, { left: x, top: y, right: x + 1, bottom: y + 1 });
      const color = (p[3] << 24) + (p[0] << 16) + (p[1] << 8) + p[2];
      this._pointSample = { x, y, color };
      return color;
    }
    if (this.gray) return this.pixels[this.index(x, y)];
    const base = this.index(x, y) * 4, p = this.pixels;
    return (p[base + 3] << 24) + (p[base] << 16) + (p[base + 1] << 8) + p[base + 2];
  }
  setPoint(x, y, color) {
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
    if (!this.gray && this.gpuValid) {
      gpu.fill(this, { left: l, top: t, right: r, bottom: b }, [cr, cg, cb, ca], maskOnly);
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
    getGPU().colour(this, rect, value, a, a === 255 ? 0 : 1);
    return true;
  }
  // iTVPBaseBitmap::FillColorOnAlpha / FillColorOnAddAlpha (BlendColor).
  blendColor(rect, color, opa, additive = false) {
    const value = toActualColor(color), a = clamp255(opa);
    if (!this.width || !this.height) return false;
    getGPU().colour(this, rect, a === 255 ? value | 0xff000000 : value, a, a === 255 ? 4 : additive ? 3 : 2);
    return true;
  }
  // iTVPBaseBitmap::RemoveConstOpacity.
  removeConstOpacity(rect, level) {
    if (!this.width || !this.height) return false;
    getGPU().colour(this, rect, 0, clamp255(Math.abs(level)), 5);
    return true;
  }
  // TVPDoGrayScale / TVPConvert(Additive)Alpha.
  transform(rect, kind) {
    getGPU().transform(this, rect, { grayscale: 0, alphaToAdditive: 1, additiveToAlpha: 2 }[kind]);
    return true;
  }
  // Layer.AdjustGamma / Layer.light: per channel 256 entry tables.
  applyLookup(rect, tables, additive = false) {
    getGPU().applyLookup(this, rect, tables, additive);
    return true;
  }
  // iTVPBaseBitmap::DoBoxBlur / DoBoxBlurForAlpha.
  boxBlur(rect, area, alphaMode = false) {
    getGPU().boxBlur(this, rect, area, alphaMode);
    return true;
  }
  // tTJSNI_BaseLayer::ApplyGaussianBlur: separable kernel, two passes.
  gaussianBlur(radius, sigma) {
    getGPU().gaussianBlur(this, Math.trunc(radius), sigma);
    return true;
  }
  // Copy both main and mask planes (TVP_BB_COPY_MAIN | TVP_BB_COPY_MASK).
  copyRect(x, y, src, rect, { main = true, mask = true } = {}) {
    const gpu = getGPU();
    // Keep copies on the GPU whenever either bitmap has newer GPU contents.
    // A materialized CPU buffer can still be stale after a GPU draw; testing
    // only for a missing buffer would read the full image back just to copy a
    // small rectangle.
    if (!this.gray && !src.gray && (this.gpuValid || src.gpuValid)) {
      if (!main && !mask) return true;
      const source = src === this ? src.clone() : src;
      const sourceRect = { left: Math.max(0, rect.left), top: Math.max(0, rect.top),
        right: Math.min(src.width, rect.right), bottom: Math.min(src.height, rect.bottom) };
      gpu.draw(this, source, {
        matrix: [1, 0, 0, 1, x - rect.left, y - rect.top], sourceRect,
        mode: 1, copySourceAlpha: true, holdAlpha: !mask, maskOnly: !main,
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
    if (src === this) src = src.clone();
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
