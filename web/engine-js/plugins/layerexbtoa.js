import { callScript, nativeOwner } from '#krkr/native';
import { number, integer } from '#krkr/values';
import { Image } from '../bitmap.js';

// layerExBTOA.cpp: Layer alpha/province helpers. The image plane uses RGBA byte
// order; AddAlpha layers keep premultiplied colors, while ordinary alpha layers
// only change their alpha byte.
const LT_ADD_ALPHA = 12;
const trunc = Math.trunc;
const invalid = message => { throw new Error(`TJS ${message}`); };

const layerState = (Layer, value) => {
  try { return Layer.state(value); } catch { return null; }
};
const clipOf = (node, image) => node.clip
  ? { left: node.clip.left, top: node.clip.top, width: node.clip.right - node.clip.left, height: node.clip.bottom - node.clip.top }
  : { left: 0, top: 0, width: image.width, height: image.height };
const provinceOf = (node, image) => node.province ??= new Image(image.width, image.height, { gray: true });
// CalcClipArea (layerExBTOA.cpp 298): null when the source and destination
// rectangles no longer overlap.
const calcClipArea = (dx, dy, diw, dih, sx, sy, siw, sih, w, h) => {
  if (sx + w <= 0 || sy + h <= 0 || sx >= siw || sy >= sih) return null;
  if (sx < 0) { w += sx; dx -= sx; sx = 0; }
  if (sy < 0) { h += sy; dy -= sy; sy = 0; }
  let cut;
  if ((cut = sx + w - siw) > 0) w -= cut;
  if ((cut = sy + h - sih) > 0) h -= cut;
  if (dx + w <= 0 || dy + h <= 0 || dx >= diw || dy >= dih) return null;
  if (dx < 0) { w += dx; sx -= dx; dx = 0; }
  if (dy < 0) { h += dy; sy -= dy; dy = 0; }
  if ((cut = dx + w - diw) > 0) w -= cut;
  if ((cut = dy + h - dih) > 0) h -= cut;
  return w <= 0 || h <= 0 ? null : { dx, dy, sx, sy, w, h };
};
// ClipAddAlpha / the alpha-only multiply at layerExBTOA.cpp 283/403: (a*b + (a*b>>7)) >> 8.
const mulByte = (a, b) => { const n = a * b; return (n + (n >> 7)) >> 8; };
const argbBytes = color => {
  const value = color >>> 0;
  return [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff, (value >>> 24) & 0xff];
};

export function registerLayerExBTOA({ get }) {
  const Layer = get('Layer');
  const update = async (state, l, t, w, h) => {
    await callScript(nativeOwner(state), 'update', [l, t, w, h]);
  };

  // copyRightBlueToLeftAlpha: the right half's blue byte becomes the left
  // half's alpha byte.
  Layer.defineMember('copyRightBlueToLeftAlpha', async function() {
    const node = this.node, image = node?.image;
    if (!image) invalid('dest must be Layer.');
    const width = image.width >> 1, height = image.height;
    const pixels = image.writablePixels, pitch = image.width * 4;
    for (let y = 0; y < height; y++) {
      const row = y * pitch;
      for (let x = 0; x < width; x++) pixels[row + x * 4 + 3] = pixels[row + (width + x) * 4 + 2];
    }
    node.imageModified = true;
    await update(this, 0, 0, width, height);
  });

  // copyBottomBlueToTopAlpha: the bottom half's blue byte becomes the top
  // half's alpha byte.
  Layer.defineMember('copyBottomBlueToTopAlpha', async function() {
    const node = this.node, image = node?.image;
    if (!image) invalid('dest must be Layer.');
    const width = image.width, height = image.height >> 1;
    const pixels = image.writablePixels, pitch = image.width * 4;
    for (let y = 0; y < height; y++) {
      const source = (height + y) * pitch, target = y * pitch;
      for (let x = 0; x < width; x++) pixels[target + x * 4 + 3] = pixels[source + x * 4 + 2];
    }
    node.imageModified = true;
    await update(this, 0, 0, width, height);
  });

  // fillAlpha: make the clipped area opaque.
  Layer.defineMember('fillAlpha', async function() {
    const node = this.node, image = node?.image;
    if (!image) invalid('dest must be Layer.');
    const clip = clipOf(node, image), pixels = image.writablePixels, pitch = image.width * 4;
    for (let y = 0; y < clip.height; y++) {
      const row = (clip.top + y) * pitch;
      for (let x = 0; x < clip.width; x++) pixels[row + (clip.left + x) * 4 + 3] = 0xff;
    }
    node.imageModified = true;
    await update(this, clip.left, clip.top, clip.width, clip.height);
  });

  // copyAlphaToProvince(threshold = -1, matched = 1, otherwise = 0): the main
  // image's alpha becomes the province index, optionally thresholded.
  Layer.defineMember('copyAlphaToProvince', async function(threshold = -1, matched = 1, otherwise = 0) {
    const node = this.node, image = node?.image;
    if (!image) invalid('src must be Layer.');
    const clip = clipOf(node, image), province = provinceOf(node, image);
    const limit = trunc(number(threshold)), on = trunc(number(matched)), off = trunc(number(otherwise));
    const src = image.pixels, dst = province.writablePixels, pitch = image.width * 4;
    let mode = 0;
    if (limit >= 0 && limit < 256) {
      const match = on >= 0 && on < 256, other = off >= 0 && off < 256;
      if (!match && !other) return;
      mode = match && other ? 1 : match ? 3 : 4;
    } else if (limit >= 256) {
      if (!(off >= 0 && off < 256)) return;
      mode = 2;
    }
    const thresholdByte = limit & 0xff, onByte = on & 0xff, offByte = off & 0xff;
    for (let y = 0; y < clip.height; y++) {
      const target = (clip.top + y) * province.width + clip.left;
      const source = (clip.top + y) * pitch + clip.left * 4;
      for (let x = 0; x < clip.width; x++) {
        const value = src[source + x * 4 + 3], index = target + x;
        switch (mode) {
          case 0: dst[index] = value; break;
          case 1: dst[index] = value >= thresholdByte ? onByte : offByte; break;
          case 2: dst[index] = offByte; break;
          case 3: if (value >= thresholdByte) dst[index] = onByte; break;
          case 4: if (value < thresholdByte) dst[index] = offByte; break;
          default: break;
        }
      }
    }
    node.imageModified = true;
    await update(this, clip.left, clip.top, clip.width, clip.height);
  });

  // clipAlphaRect(dx, dy, src, sx, sy, w, h, clr = void): multiply the clipped
  // area's alpha by the mask layer's alpha, optionally clearing the rest of the
  // clip to `clr` (0..255).
  Layer.defineMember('clipAlphaRect', async function(dx, dy, src, sx, sy, w, h, clr = undefined) {
    if (arguments.length < 7) throw new Error('TJS Layer.clipAlphaRect requires 7 arguments');
    const node = this.node, image = node?.image;
    const source = layerState(Layer, src);
    const srcImage = source?.node?.image;
    if (!image) invalid('dest must be Layer.');
    if (!srcImage) invalid('src must be Layer.');
    let ddx = trunc(number(dx)), ddy = trunc(number(dy));
    let ssx = trunc(number(sx)), ssy = trunc(number(sy));
    let width = trunc(number(w)), height = trunc(number(h));
    if (width <= 0 || height <= 0) invalid('invalid parameter');
    let clear = false, clearValue = 0;
    if (arguments.length >= 8 && clr !== undefined && clr !== null) {
      const value = trunc(number(clr));
      clear = value >= 0 && value < 256;
      clearValue = value & 0xff;
    }
    const clip = clipOf(node, image);
    ddx -= clip.left;
    ddy -= clip.top;
    const addAlpha = node.type === LT_ADD_ALPHA;
    const pixels = image.writablePixels, srcPixels = srcImage.pixels;
    const pitch = image.width * 4, srcPitch = srcImage.width * 4;
    const area = calcClipArea(ddx, ddy, clip.width, clip.height, ssx, ssy, srcImage.width, srcImage.height, width, height);
    const paintAlpha = (left, top, right, bottom, value, multiply) => {
      for (let y = top; y < bottom; y++) {
        const row = (clip.top + y) * pitch;
        for (let x = left; x < right; x++) {
          const index = row + (clip.left + x) * 4 + 3;
          if (multiply) {
            pixels[index - 3] = mulByte(pixels[index - 3], value);
            pixels[index - 2] = mulByte(pixels[index - 2], value);
            pixels[index - 1] = mulByte(pixels[index - 1], value);
            pixels[index] = mulByte(pixels[index], value);
          } else pixels[index] = value;
        }
      }
    };
    if (!area) {
      if (clear) {
        // The reference's none: branch always assigns the clear value.
        paintAlpha(0, 0, clip.width, clip.height, clearValue, false);
        node.imageModified = true;
        await update(this, clip.left, clip.top, clip.width, clip.height);
      }
      return;
    }
    const { dx: ax, dy: ay, sx: asx, sy: asy, w: aw, h: ah } = area;
    // clearValue === 255 is a no-op for an AddAlpha layer; only the other values
    // touch pixels outside the copied rectangle.
    if (clear && (!addAlpha || clearValue < 255)) {
      if (addAlpha && clearValue === 0) {
        // ClipAddAlpha(0) zeroes the whole premultiplied pixel.
        const words = pixels.byteOffset % 4 === 0
          ? new Uint32Array(pixels.buffer, pixels.byteOffset, pixels.byteLength >> 2)
          : null;
        const clearPixels = (from, to) => {
          if (words) { words.fill(0, from >> 2, to >> 2); return; }
          for (let index = from; index < to; index += 4) pixels.fill(0, index, index + 4);
        };
        for (let y = 0; y < clip.height; y++) {
          const start = (clip.top + y) * pitch + clip.left * 4;
          if (y < ay || y >= ay + ah) {
            clearPixels(start, start + clip.width * 4);
            continue;
          }
          if (ax > 0) clearPixels(start, start + ax * 4);
          clearPixels(start + (ax + aw) * 4, start + clip.width * 4);
        }
      } else {
        const multiply = addAlpha;
        paintAlpha(0, 0, clip.width, ay, clearValue, multiply);
        paintAlpha(0, ay + ah, clip.width, clip.height, clearValue, multiply);
        paintAlpha(0, ay, ax, ay + ah, clearValue, multiply);
        paintAlpha(ax + aw, ay, clip.width, ay + ah, clearValue, multiply);
      }
    }
    for (let y = 0; y < ah; y++) {
      const target = (clip.top + ay + y) * pitch + (clip.left + ax) * 4 + 3;
      const sourceAlpha = (asy + y) * srcPitch + (asx * 4) + 3;
      for (let x = 0; x < aw; x++) {
        const index = target + x * 4, mask = srcPixels[sourceAlpha + x * 4];
        if (addAlpha) {
          pixels[index - 3] = mulByte(pixels[index - 3], mask);
          pixels[index - 2] = mulByte(pixels[index - 2], mask);
          pixels[index - 1] = mulByte(pixels[index - 1], mask);
          pixels[index] = mulByte(pixels[index], mask);
        } else pixels[index] = mulByte(pixels[index], mask);
      }
    }
    node.imageModified = true;
    if (clear) await update(this, clip.left, clip.top, clip.width, clip.height);
    else await update(this, clip.left + ax, clip.top + ay, aw, ah);
  });

  // overwrapRect(dx, dy, src, sx, sy, w, h, threshold = 1): copy whole pixels
  // whose source alpha reaches the threshold. No update, like the reference.
  Layer.defineMember('overwrapRect', function(dx, dy, src, sx, sy, w, h, threshold = 1) {
    if (arguments.length < 7) throw new Error('TJS Layer.overwrapRect requires 7 arguments');
    const node = this.node, image = node?.image;
    const source = layerState(Layer, src), srcImage = source?.node?.image;
    if (!image) invalid('dest must be Layer.');
    if (!srcImage) invalid('src must be Layer.');
    const clip = clipOf(node, image);
    let ddx = trunc(number(dx)) - clip.left, ddy = trunc(number(dy)) - clip.top;
    const ssx = trunc(number(sx)), ssy = trunc(number(sy));
    let width = trunc(number(w)), height = trunc(number(h));
    if (width <= 0 || height <= 0) invalid('invalid parameter');
    const limit = trunc(number(threshold));
    const thresholdByte = limit >= 0 && limit < 256 ? limit : 1;
    const area = calcClipArea(ddx, ddy, clip.width, clip.height, ssx, ssy, srcImage.width, srcImage.height, width, height);
    if (!area) return;
    const pixels = image.writablePixels, srcPixels = srcImage.pixels;
    const pitch = image.width * 4, srcPitch = srcImage.width * 4;
    for (let y = 0; y < area.h; y++) {
      const target = (clip.top + area.dy + y) * pitch + (clip.left + area.dx) * 4;
      const sourceRow = (area.sy + y) * srcPitch + area.sx * 4;
      for (let x = 0; x < area.w; x++) {
        if (srcPixels[sourceRow + x * 4 + 3] >= thresholdByte)
          pixels.set(srcPixels.subarray(sourceRow + x * 4, sourceRow + x * 4 + 4), target + x * 4);
      }
    }
    node.imageModified = true;
  });

  // fillByProvince(index, color): paint the clipped area where the province
  // index matches.
  Layer.defineMember('fillByProvince', async function(index, color) {
    if (arguments.length < 2) throw new Error('TJS Layer.fillByProvince requires 2 arguments');
    const node = this.node, image = node?.image;
    if (!image) invalid('must be Layer.');
    const clip = clipOf(node, image), province = provinceOf(node, image);
    const wanted = trunc(number(index)) & 0xff;
    const [r, g, b, a] = argbBytes(trunc(number(color)));
    const pixels = image.writablePixels, indexes = province.pixels, pitch = image.width * 4;
    for (let y = 0; y < clip.height; y++) {
      const row = (clip.top + y) * pitch + clip.left * 4;
      const source = (clip.top + y) * province.width + clip.left;
      for (let x = 0; x < clip.width; x++) {
        if (indexes[source + x] !== wanted) continue;
        const index = row + x * 4;
        pixels[index] = r; pixels[index + 1] = g; pixels[index + 2] = b; pixels[index + 3] = a;
      }
    }
    node.imageModified = true;
    await update(this, clip.left, clip.top, clip.width, clip.height);
  });

  // fillToProvince(color, index, threshold = 64): write the province index where
  // the main image matches the colour (negative = any colour) and the alpha
  // reaches the threshold; returns the changed bounding box as [x, y, w, h].
  Layer.defineMember('fillToProvince', async function(color, index, threshold = 64) {
    if (arguments.length < 2) throw new Error('TJS Layer.fillToProvince requires 2 arguments');
    const node = this.node, image = node?.image;
    if (!image) invalid('src must be Layer.');
    const raw = trunc(number(color)), matchAll = raw < 0;
    const wanted = raw & 0xffffff;
    const value = trunc(number(index)) & 0xff;
    const limit = trunc(number(threshold));
    const clip = clipOf(node, image), province = provinceOf(node, image);
    const pixels = image.pixels, indexes = province.writablePixels, pitch = image.width * 4;
    let minX = -1, minY = -1, maxX = -1, maxY = -1;
    for (let y = 0; y < clip.height; y++) {
      const row = (clip.top + y) * pitch + clip.left * 4;
      const target = (clip.top + y) * province.width + clip.left;
      for (let x = 0; x < clip.width; x++) {
        const index4 = row + x * 4;
        const rgb = (pixels[index4] << 16) | (pixels[index4 + 1] << 8) | pixels[index4 + 2];
        if (!(matchAll || rgb === wanted) || pixels[index4 + 3] < limit) continue;
        indexes[target + x] = value;
        if (minX < 0 || minX > x) minX = x;
        if (minY < 0 || minY > y) minY = y;
        if (maxX < 0 || maxX < x) maxX = x;
        if (maxY < 0 || maxY < y) maxY = y;
      }
    }
    node.imageModified = true;
    await update(this, clip.left, clip.top, clip.width, clip.height);
    if (minX < 0) return undefined;
    return [minX + clip.left, minY + clip.top, maxX - minX + 1, maxY - minY + 1];
  });
}

