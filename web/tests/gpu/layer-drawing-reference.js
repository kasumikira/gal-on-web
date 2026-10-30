// Layer drawing operations corresponding to LayerIntf.cpp and
// LayerBitmapIntf.cpp. The layer class owns state and dispatch; this module
// owns the pixel algorithms so the operation and legacy convenience methods
// share exactly the same clipping and blend behaviour.
import { Image, blendModes, clamp255 } from './bitmap-reference.js';
import { mat2d } from 'gl-matrix';
import { getGPU } from './gpu-reference.js';
import { number, truth } from '#krkr/values';
import { nativeOwner } from '#krkr/native';

const DEFAULTS = Object.freeze({
  ltOpaque: blendModes.opaque, ltAlpha: blendModes.alpha,
  dfAlpha: 0, dfMain: 1, dfAddAlpha: 4, omAuto: blendModes.auto,
});
const SUPPORTED_MODES = new Set(Object.values(blendModes));

const int = value => Math.trunc(number(value));
const real = value => number(value);
const byte = value => clamp255(Math.trunc(value));
const asOwner = nativeOwner;
const rectOf = (left, top, right, bottom) => ({ left, top, right, bottom });
const intersect = (a, b) => ({
  left: Math.max(a.left, b.left), top: Math.max(a.top, b.top),
  right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom),
});

function imageFor(value, Layer, Bitmap) {
  const owner = asOwner(value);
  const layerState = Layer?.instances?.get(owner);
  if (layerState?.node?.image instanceof Image) return { image: layerState.node.image, node: layerState.node };
  const bitmapState = Bitmap?.instances?.get(owner);
  if (bitmapState?.loading) throw new Error('TJS bitmap is currently loading');
  if (bitmapState?.image instanceof Image) return { image: bitmapState.image, node: null };
  throw new Error('TJS specify layer or bitmap');
}

export function createLayerDrawing({
  getLayer, Bitmap, instanceOf, updateTree,
  ltOpaque = DEFAULTS.ltOpaque, ltAlpha = DEFAULTS.ltAlpha,
  dfAlpha = DEFAULTS.dfAlpha, dfMain = DEFAULTS.dfMain,
  dfAddAlpha = DEFAULTS.dfAddAlpha, omAuto = DEFAULTS.omAuto,
} = {}) {
  const layerFor = owner => instanceOf(asOwner(owner));
  const sourceFor = value => imageFor(value, getLayer?.(), Bitmap);
  const layerSourceFor = value => {
    const source = sourceFor(value);
    if (!source.node) throw new Error('TJS specify layer');
    return source;
  };
  const clipFor = node => node.clip ?? rectOf(0, 0, node.image.width, node.image.height);
  const changed = node => { node.imageModified = true; if (updateTree) updateTree(node); };
  const faceOptions = (node, mode, ignoreSourceAlpha = false, copySourceAlpha = false) => {
    if (!SUPPORTED_MODES.has(mode) || mode === blendModes.auto || mode === blendModes.binder) throw new Error(`TJS unsupported blend operation mode: ${mode}`);
    if (node.drawFace !== dfAlpha && node.drawFace !== dfMain && node.drawFace !== dfAddAlpha) {
      throw new Error('TJS operation is not drawable on this face');
    }
    const destinationAlpha = node.drawFace !== dfMain;
    // LayerBitmapIntf passes HoldAlpha directly to Blt/StretchBlt/AffineBlt;
    // operation modes do not implicitly select an HDA variant.
    const holdAlpha = !!node.holdAlpha;
    return { destinationAlpha, additiveDestination: node.drawFace === dfAddAlpha, copySourceAlpha, holdAlpha, ignoreSourceAlpha };
  };
  const resolveMode = (mode, sourceNode) => {
    mode = mode === undefined ? omAuto : int(mode);
    if (mode !== omAuto) return mode;
    const type = sourceNode?.type ?? ltAlpha;
    return SUPPORTED_MODES.has(type) && type !== blendModes.binder ? type : blendModes.opaque;
  };
  const markRect = (node, rect) => { if (rect.right > rect.left && rect.bottom > rect.top) changed(node); };
  const drawGPU = (node, source, sourceRect, clip, matrix, mode, opa, options, interpolation = 0) => {
    const gpu = getGPU();
    gpu.draw(node.image, source, {
      matrix, sourceRect, clip, mode, opacity: clamp255(int(opa)), smooth: interpolation !== 0, ...options,
    });
  };

  function operateRect(dx, dy, src, sx, sy, sw, sh, mode = omAuto, opa = 255) {
    if (arguments.length < 7) throw new Error('TJS Layer.operateRect requires 7 arguments');
    const node = layerFor(this), source = sourceFor(src);
    if (!source.image) throw new Error('TJS specify layer or bitmap');
    const sourceImage = source.image === node.image ? source.image.clone() : source.image;
    dx = int(dx); dy = int(dy); sx = int(sx); sy = int(sy); sw = int(sw); sh = int(sh);
    if (sw <= 0 || sh <= 0) return;
    const modeValue = resolveMode(mode, source.node), options = faceOptions(node, modeValue);
    let dest = intersect(rectOf(dx, dy, dx + sw, dy + sh), clipFor(node));
    dest = intersect(dest, rectOf(0, 0, node.image.width, node.image.height));
    let sr = rectOf(sx + dest.left - dx, sy + dest.top - dy, sx + dest.right - dx, sy + dest.bottom - dy);
    const sourceClip = rectOf(0, 0, sourceImage.width, sourceImage.height);
    const clipped = intersect(sr, sourceClip);
    dest.left += clipped.left - sr.left; dest.top += clipped.top - sr.top;
    dest.right = dest.left + clipped.right - clipped.left; dest.bottom = dest.top + clipped.bottom - clipped.top;
    sr = clipped;
    if (dest.right <= dest.left || dest.bottom <= dest.top) return;
    drawGPU(node, sourceImage, sr, dest, [1, 0, 0, 1, dx - sx, dy - sy], modeValue, opa, options);
    markRect(node, dest);
  }

  function operateStretchImpl(dx, dy, dw, dh, src, sx, sy, sw, sh, mode = omAuto, opa = 255, type = 0, typeopt, { copySourceAlpha = false } = {}) {
    if (arguments.length < 9) throw new Error('TJS Layer.operateStretch requires 9 arguments');
    const node = layerFor(this), source = sourceFor(src);
    if (!source.image) throw new Error('TJS specify layer or bitmap');
    const sourceImage = source.image === node.image ? source.image.clone() : source.image;
    dx = int(dx); dy = int(dy); dw = int(dw); dh = int(dh); sx = int(sx); sy = int(sy); sw = int(sw); sh = int(sh);
    if (dw === 0 || dh === 0 || sw === 0 || sh === 0) return;
    const modeValue = resolveMode(mode, source.node), options = faceOptions(node, modeValue, false, copySourceAlpha);
    const typeValue = int(type), interpolation = typeValue & 0xffff;
    if (interpolation > 19 || interpolation < 0) throw new Error(`TJS stretch interpolation type is unsupported: ${interpolation}`);
    // ResampleAreaAvg is intentionally reduction-only in ResampleImage.cpp;
    // its native path returns without writing when either axis enlarges.
    if ((interpolation === 14 || interpolation === 15) && (Math.abs(dw) > Math.abs(sw) || Math.abs(dh) > Math.abs(sh))) return;
    // GPU linear sampling replaces the individual filter kernels and their
    // tuning parameter; keep the argument's TJS numeric conversion.
    if (typeopt !== undefined) real(typeopt);
    const clip = intersect(intersect(rectOf(Math.min(dx, dx + dw), Math.min(dy, dy + dh), Math.max(dx, dx + dw), Math.max(dy, dy + dh)), clipFor(node)), rectOf(0, 0, node.image.width, node.image.height));
    const noClip = !!(typeValue & 0x10000);
    const sourceRect = intersect(noClip ? rectOf(0, 0, sourceImage.width, sourceImage.height)
      : rectOf(Math.min(sx, sx + sw), Math.min(sy, sy + sh), Math.max(sx, sx + sw), Math.max(sy, sy + sh)),
      rectOf(0, 0, sourceImage.width, sourceImage.height));
    const matrix = [dw / sw, 0, 0, dh / sh, dx - sx * dw / sw, dy - sy * dh / sh];
    drawGPU(node, sourceImage, sourceRect, clip, matrix, modeValue, opa, options, interpolation);
    markRect(node, clip);
  }

  function operateStretch(...args) {
    return operateStretchImpl.apply(this, args.slice(0, 13));
  }

  function operateAffineImpl(src, sx, sy, sw, sh, affine, a, b, c, d, tx, ty, mode = omAuto, opa = 255, type = 0, { clear = false, copySourceAlpha = false } = {}) {
    if (arguments.length < 12) throw new Error('TJS Layer.operateAffine requires 12 arguments');
    const node = layerFor(this), source = sourceFor(src);
    if (!source.image) throw new Error('TJS specify layer or bitmap');
    const sourceImage = source.image === node.image ? source.image.clone() : source.image;
    sx = int(sx); sy = int(sy); sw = int(sw); sh = int(sh);
    if (sw <= 0 || sh <= 0) return;
    let matrix = new Float64Array([real(a), real(b), real(c), real(d), real(tx), real(ty)]);
    if (!truth(affine)) {
      const [x0, y0, x1, y1, x2, y2] = matrix;
      matrix = new Float64Array([(x1 - x0) / sw, (y1 - y0) / sw, (x2 - x0) / sh, (y2 - y0) / sh,
        x0 + ((x1 - x0) / sw + (x2 - x0) / sh) / 2,
        y0 + ((y1 - y0) / sw + (y2 - y0) / sh) / 2]);
    }
    const inverse = mat2d.invert(new Float64Array(6), matrix);
    if (!inverse) return;
    const corners = [[-0.5, -0.5], [sw - 0.5, -0.5], [-0.5, sh - 0.5], [sw - 0.5, sh - 0.5]];
    const xs = corners.map(([x, y]) => matrix[0] * x + matrix[2] * y + matrix[4]);
    const ys = corners.map(([x, y]) => matrix[1] * x + matrix[3] * y + matrix[5]);
    const bounds = rectOf(Math.ceil(Math.min(...xs)), Math.ceil(Math.min(...ys)), Math.ceil(Math.max(...xs)), Math.ceil(Math.max(...ys)));
    const clip = intersect(intersect(bounds, clipFor(node)), rectOf(0, 0, node.image.width, node.image.height));
    const modeValue = resolveMode(mode, source.node), options = faceOptions(node, modeValue, false, copySourceAlpha);
    const typeValue = int(type), interpolation = typeValue & 0xffff;
    if (interpolation > 19 || interpolation < 0) throw new Error(`TJS affine interpolation type is unsupported: ${interpolation}`);
    const noClip = !!(typeValue & 0x10000);
    if (truth(clear)) {
      const clearClip = intersect(clipFor(node), rectOf(0, 0, node.image.width, node.image.height));
      if (clearClip.right > clearClip.left && clearClip.bottom > clearClip.top) node.image.fill(clearClip, node.neutralColor);
    }
    const sourceRect = intersect(noClip ? rectOf(0, 0, sourceImage.width, sourceImage.height) : rectOf(sx, sy, sx + sw, sy + sh),
      rectOf(0, 0, sourceImage.width, sourceImage.height));
    const sourceMatrix = [matrix[0], matrix[1], matrix[2], matrix[3],
      matrix[4] - matrix[0] * (sx + 0.5) - matrix[2] * (sy + 0.5) + 0.5,
      matrix[5] - matrix[1] * (sx + 0.5) - matrix[3] * (sy + 0.5) + 0.5];
    drawGPU(node, sourceImage, sourceRect, clip, sourceMatrix, modeValue, opa, options, interpolation);
    markRect(node, clip);
  }

  function operateAffine(...args) {
    return operateAffineImpl.apply(this, args.slice(0, 15));
  }

  function stretchCopy(dx, dy, dw, dh, src, sx, sy, sw, sh, type = 0) {
    if (arguments.length < 9) throw new Error('TJS Layer.stretchCopy requires 9 arguments');
    operateStretchImpl.call(this, dx, dy, dw, dh, src, sx, sy, sw, sh, blendModes.opaque, 255, type, undefined, { copySourceAlpha: true });
  }
  function stretchPile(dx, dy, dw, dh, src, sx, sy, sw, sh, opa = 255, type = 0) {
    if (arguments.length < 9) throw new Error('TJS Layer.stretchPile requires 9 arguments');
    const source = layerSourceFor(src);
    operateStretch.call(this, dx, dy, dw, dh, source.node.owner, sx, sy, sw, sh, blendModes.alpha, opa, type);
  }
  function stretchBlend(dx, dy, dw, dh, src, sx, sy, sw, sh, opa = 255, type = 0) {
    if (arguments.length < 9) throw new Error('TJS Layer.stretchBlend requires 9 arguments');
    const source = layerSourceFor(src);
    operateStretch.call(this, dx, dy, dw, dh, source.node.owner, sx, sy, sw, sh, blendModes.opaque, opa, type);
  }
  // LayerIntf.cpp PileRect / BlendRect: the obsolete convenience wrappers over
  // Blt. PileRect uses bmAlphaOnAlpha on dfAlpha and bmAlpha on dfOpaque;
  // BlendRect treats the source as opaque, i.e. bmCopyOnAlpha / bmCopy.
  function pileRect(dx, dy, src, sx, sy, sw, sh, opa = 255) {
    if (arguments.length < 7) throw new Error('TJS Layer.pileRect requires 7 arguments');
    if (layerFor(this).drawFace !== dfAlpha && layerFor(this).drawFace !== dfMain) throw new Error('TJS Layer.pileRect not drawable on this face');
    layerSourceFor(src);
    operateRect.call(this, dx, dy, src, sx, sy, sw, sh, blendModes.alpha, opa);
  }
  function blendRect(dx, dy, src, sx, sy, sw, sh, opa = 255) {
    if (arguments.length < 7) throw new Error('TJS Layer.blendRect requires 7 arguments');
    if (layerFor(this).drawFace !== dfAlpha && layerFor(this).drawFace !== dfMain) throw new Error('TJS Layer.blendRect not drawable on this face');
    layerSourceFor(src);
    operateRect.call(this, dx, dy, src, sx, sy, sw, sh, blendModes.opaque, opa);
  }

  function affineCopy(src, sx, sy, sw, sh, affine, a, b, c, d, tx, ty, type = 0, clear = false) {
    if (arguments.length < 12) throw new Error('TJS Layer.affineCopy requires 12 arguments');
    operateAffineImpl.call(this, src, sx, sy, sw, sh, affine, a, b, c, d, tx, ty, blendModes.opaque, 255, type, { clear, copySourceAlpha: true });
  }
  function affinePile(src, sx, sy, sw, sh, affine, a, b, c, d, tx, ty, opa = 255, type = 0) {
    if (arguments.length < 12) throw new Error('TJS Layer.affinePile requires 12 arguments');
    const source = layerSourceFor(src);
    operateAffine.call(this, source.node.owner, sx, sy, sw, sh, affine, a, b, c, d, tx, ty, blendModes.alpha, opa, type);
  }
  function affineBlend(src, sx, sy, sw, sh, affine, a, b, c, d, tx, ty, opa = 255, type = 0) {
    if (arguments.length < 12) throw new Error('TJS Layer.affineBlend requires 12 arguments');
    const source = layerSourceFor(src);
    operateAffine.call(this, source.node.owner, sx, sy, sw, sh, affine, a, b, c, d, tx, ty, blendModes.opaque, opa, type);
  }

  function doBoxBlur(xblur = 1, yblur = 1) {
    const node = layerFor(this);
    if (!node.image) throw new Error('TJS Layer has no image');
    // LayerIntf.cpp accepts only xblur and yblur.  The algorithm is selected
    // from DrawFace; extra script arguments are ignored by the native call.
    // DoBoxBlur passes the area (-xblur,-yblur,xblur,yblur); the image edges
    // clamp the window and the divisor counts the clamped pixels.
    const alphaMode = node.drawFace === dfAlpha;
    const changedImage = node.image.boxBlur(clipFor(node),
      { left: -Math.abs(int(xblur)), top: -Math.abs(int(yblur)), right: Math.abs(int(xblur)), bottom: Math.abs(int(yblur)) },
      alphaMode);
    if (changedImage) changed(node);
  }

  function adjustGamma(...args) {
    const node = layerFor(this);
    if (!args.length) return;
    if (!node.image) throw new Error('TJS Layer has no image');
    const values = [1, 0, 255, 1, 0, 255, 1, 0, 255];
    for (let i = 0; i < Math.min(9, args.length); i++) if (args[i] !== undefined) values[i] = real(args[i]);
    const tables = [0, 1, 2].map(channel => {
      const gamma = values[channel * 3], floor = values[channel * 3 + 1], ceil = values[channel * 3 + 2];
      return Uint8Array.from({ length: 256 }, (_, i) => clamp255(Math.floor(Math.pow(i / 255, gamma === 0 ? Infinity : 1 / gamma) * (ceil - floor) + floor + 0.5)));
    });
    const clip = intersect(clipFor(node), rectOf(0, 0, node.image.width, node.image.height));
    node.image.applyLookup(clip, tables, node.drawFace === dfAddAlpha);
    changed(node);
  }

  function gaussianBlurMethod(radius = 1, sigma) {
    if (arguments.length < 1) throw new Error('TJS Layer.gaussianBlur requires radius');
    radius = int(radius);
    sigma = sigma === undefined ? (arguments.length < 2 ? Math.max(1, radius / 2.5) : 1) : real(sigma);
    const node = layerFor(this);
    if (!(radius > 0)) throw new Error('TJS Layer.gaussianBlur radius must be positive');
    if (!(sigma > 0)) throw new Error('TJS Layer.gaussianBlur sigma must be positive');
    if (!node.image) return;
    node.image.gaussianBlur(radius, sigma);
    changed(node);
  }

  function light(brightness = 0, contrast = 0) {
    if (arguments.length < 2) throw new Error('TJS Layer.light requires brightness and contrast');
    const node = layerFor(this);
    if (!node.image) return;
    brightness = int(brightness); contrast = int(contrast);
    contrast = Math.max(-255, Math.min(255, contrast));
    const factor = contrast === 0 ? 1 : contrast === 255 ? 259 * 510 / (255 * (259 - 254.9))
      : contrast === -255 ? 0 : 259 * (contrast + 255) / (255 * (259 - contrast));
    // The curve is evaluated on the host so the table matches the previous
    // double precision arithmetic byte for byte; the GPU applies it.
    const table = Uint8Array.from({ length: 256 }, (_, i) => byte(factor * (clamp255(i + brightness) - 128) + 128));
    node.image.applyLookup(rectOf(0, 0, node.image.width, node.image.height), [table, table, table]);
    changed(node);
  }

  return {
    operateRect, operateStretch, operateAffine, stretchCopy, stretchPile, stretchBlend, pileRect, blendRect,
    affineCopy, affinePile, affineBlend, doBoxBlur, adjustGamma,
    gaussianBlur: gaussianBlurMethod, light,
  };
}
