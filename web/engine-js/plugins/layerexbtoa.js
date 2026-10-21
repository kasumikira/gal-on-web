import { callScript, nativeOwner } from '#krkr/native';
import { number, integer } from '#krkr/values';
import { Image } from '../bitmap.js';
import { gpuBtoa } from './gpu-btoa.js';

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
    gpuBtoa.copyRightBlueToLeftAlpha(image);
    node.imageModified = true;
    await update(this, 0, 0, width, height);
  });

  // copyBottomBlueToTopAlpha: the bottom half's blue byte becomes the top
  // half's alpha byte.
  Layer.defineMember('copyBottomBlueToTopAlpha', async function() {
    const node = this.node, image = node?.image;
    if (!image) invalid('dest must be Layer.');
    const width = image.width, height = image.height >> 1;
    gpuBtoa.copyBottomBlueToTopAlpha(image);
    node.imageModified = true;
    await update(this, 0, 0, width, height);
  });

  // fillAlpha: make the clipped area opaque.
  Layer.defineMember('fillAlpha', async function() {
    const node = this.node, image = node?.image;
    if (!image) invalid('dest must be Layer.');
    const clip = clipOf(node, image);
    gpuBtoa.fillAlpha(image, [clip.left, clip.top, clip.left + clip.width, clip.top + clip.height]);
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
    gpuBtoa.copyAlphaToProvince(image, province, [clip.left, clip.top, clip.left + clip.width, clip.top + clip.height], thresholdByte, onByte, offByte, mode);
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
    const area = calcClipArea(ddx, ddy, clip.width, clip.height, ssx, ssy, srcImage.width, srcImage.height, width, height);
    if (!area) {
      if (clear) {
        gpuBtoa.clipAlphaRect(image, srcImage, [clip.left, clip.top, clip.left + clip.width, clip.top + clip.height], [0, 0, 0, 0], [0, 0], { clearOutside: true, clearValue });
        node.imageModified = true;
        await update(this, clip.left, clip.top, clip.width, clip.height);
      }
      return;
    }
    const { dx: ax, dy: ay, sx: asx, sy: asy, w: aw, h: ah } = area;
    const clearOutside = clear && (!addAlpha || clearValue < 255);
    gpuBtoa.clipAlphaRect(image, srcImage,
      [clip.left, clip.top, clip.left + clip.width, clip.top + clip.height],
      [clip.left + ax, clip.top + ay, clip.left + ax + aw, clip.top + ay + ah],
      [asx, asy], { additive: addAlpha, clearOutside, clearValue });
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
    gpuBtoa.overwrapRect(image, srcImage, [clip.left + area.dx, clip.top + area.dy, clip.left + area.dx + area.w, clip.top + area.dy + area.h],
      [clip.left + area.dx, clip.top + area.dy, clip.left + area.dx + area.w, clip.top + area.dy + area.h], [area.sx, area.sy], thresholdByte);
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
    gpuBtoa.fillByProvince(image, province, [clip.left, clip.top, clip.left + clip.width, clip.top + clip.height], wanted, [r, g, b, a]);
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
    const box = gpuBtoa.fillToProvince(image, province,
      [clip.left, clip.top, clip.left + clip.width, clip.top + clip.height], wanted, value, limit, matchAll);
    node.imageModified = true;
    await update(this, clip.left, clip.top, clip.width, clip.height);
    return box;
  });
}

