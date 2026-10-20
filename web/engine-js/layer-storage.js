// Layer operations whose native implementation crosses the image/storage
// boundary (LayerIntf.cpp and BitmapIntf.cpp).  Kept separate from layer.js
// so the layer state machine can install these operations after its Node type
// and bitmap class are available.
import { Image, colorBytes } from './bitmap.js';
import { getFontAscentOffsets, clipBlit, blurGlyphImage } from './font.js';
import { encodeTLG, makeBMP, canvasBytes } from './image-codecs/encode.js';
import { number, truth } from '#krkr/values';
import { nativeOwner } from '#krkr/native';

const unwrap = nativeOwner;

function glyphValue(glyph, index) {
  glyph = unwrap(glyph);
  if (glyph?.members instanceof Map && glyph.members.has(String(index))) return unwrap(glyph.members.get(String(index)));
  return glyph?.[index];
}

function glyphBytes(value) {
  value = unwrap(value);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  throw new Error('TJS failed glyph for drawGlyph: bitmap must be an octet');
}

function makeGlyphImage(glyph, color, aa) {
  const width = Math.trunc(number(glyphValue(glyph, 0)));
  const height = Math.trunc(number(glyphValue(glyph, 1)));
  if (width < 0 || height < 0) throw new Error('TJS failed glyph for drawGlyph: invalid size');
  const bytes = glyphBytes(glyphValue(glyph, 7));
  const colors = Math.trunc(number(glyphValue(glyph, 8) ?? 256));
  const stride = colors > 256 ? 4 : 1;
  if (bytes.length < width * height * stride) throw new Error('TJS failed glyph for drawGlyph: truncated bitmap');
  const [r, g, b] = colorBytes(color);
  const image = new Image(width, height);
  const pixels = image.writablePixels;
  for (let i = 0; i < width * height; i++) {
    let alpha = bytes[i * stride];
    if (!aa) alpha = alpha >= 128 ? 255 : 0;
    const p = i * 4;
    pixels[p] = r; pixels[p + 1] = g; pixels[p + 2] = b; pixels[p + 3] = alpha;
  }
  return image;
}

function normalizeGlyphOpacity(node, opa) {
  opa = Math.trunc(number(opa));
  const face = node.drawFace ?? 0;
  if (face !== 0 && face !== 1 && face !== 4) throw new Error(`TJS glyph drawing is unsupported on draw face ${face}`);
  if (face === 4 && opa < 0) throw new Error('TJS negative opacity not supported on additive alpha face');
  if (face !== 0 && opa < 0) return 0;
  return Math.max(-255, Math.min(255, opa));
}

const layerModeNames = new Map([
  [1, 'opaque'], [2, 'alpha'], [3, 'add'], [4, 'sub'], [5, 'mul'],
  [8, 'dodge'], [9, 'darken'], [10, 'lighten'], [11, 'screen'], [12, 'addalpha'],
  [13, 'psnormal'], [14, 'psadd'], [15, 'pssub'], [16, 'psmul'], [17, 'psscreen'],
  [18, 'psoverlay'], [19, 'pshlight'], [20, 'psslight'], [21, 'psdodge'],
  [22, 'psdodge5'], [23, 'psburn'], [24, 'pslighten'], [25, 'psdarken'],
  [26, 'psdiff'], [27, 'psdiff5'], [28, 'psexcl'],
]);

function dumpLayer(node, level = 0) {
  const indent = ' '.repeat(level * 2), name = node.name || '<noname>';
  const right = node.left + node.width, bottom = node.top + node.height;
  const typeName = layerModeNames.get(node.type) ?? 'unknown';
  console.log(`${indent}${name} (${node.left},${node.top})-(${right},${bottom}) (${node.width}x${node.height}) ${node.visible ? 'visible' : 'invisible'} index=${node.absoluteOrderIndex ?? 0}${node.province ? ' p' : ''} ${typeName}`);
  for (const child of node.children) dumpLayer(child, level + 1);
}

function resolveBitmap(value, bitmapClass) {
  value = unwrap(value);
  const state = bitmapClass?.instances?.get?.(value);
  const image = state?.image;
  if (image instanceof Image) return { image, value, state };
  return null;
}

function assignBitmap(bitmap, image) {
  if (bitmap.state) {
    bitmap.state.image = image.clone();
    return;
  }
  throw new Error('TJS Bitmap instance has no writable image');
}

/** Install the Layer methods that depend on storage or a Bitmap class. */
export function installLayerStorage(Layer, { instanceOf, updateTree = () => {}, storage, document, bitmapClass } = {}) {
  if (!Layer?.members || !instanceOf) throw new Error('TJS installLayerStorage requires a Layer class and instanceOf callback');
  Layer.members.set('drawGlyph', function(x, y, glyph, color, opa = 255, aa = true, shadowLevel = 0, shadowColor = 0, shadowWidth = 0, shadowOfsx = 0, shadowOfsy = 0) {
    if (arguments.length < 4) throw new Error('TJS Layer.drawGlyph requires 4 arguments');
    const node = instanceOf(this);
    if (!node.image) throw new Error('TJS layer has no image');
    opa = normalizeGlyphOpacity(node, opa);
    if (opa === 0) return;
    const source = makeGlyphImage(glyph, color, !!truth(aa));
    const originX = Math.trunc(number(glyphValue(glyph, 2)));
    const originY = Math.trunc(number(glyphValue(glyph, 3)));
    const ascent = getFontAscentOffsets(document, node.font);
    const left = Math.trunc(number(x)) + originX + ascent.x;
    const top = Math.trunc(number(y)) - originY + ascent.y;
    let changed = false;
    if (truth(shadowLevel)) {
      const blurWidth = Math.trunc(number(shadowWidth));
      // Native DrawGlyph uses shadowlevel as the blur level and the main
      // opacity for both shadow and glyph (LayerBitmapImpl.cpp:1048-1075).
      const shadow = makeGlyphImage(glyph, shadowColor, !!truth(aa));
      const blurred = blurGlyphImage(shadow, blurWidth, Math.abs(Math.trunc(number(shadowLevel))));
      changed = clipBlit(node, blurred.image, left + Math.trunc(number(shadowOfsx)) + blurred.offsetX, top + Math.trunc(number(shadowOfsy)) + blurred.offsetY, { opa, holdAlpha: !!node.holdAlpha }) || changed;
    }
    changed = clipBlit(node, source, left, top, { opa, holdAlpha: !!node.holdAlpha }) || changed;
    if (changed) updateTree(node);
  });
  Layer.members.set('saveLayerImage', async function(name, type = 'bmp') {
    if (!arguments.length) throw new Error('TJS Layer.saveLayerImage requires a name');
    const node = instanceOf(this);
    if (!node.image) throw new Error('TJS not drawable layer type');
    const format = String(type).toLowerCase().replace(/^\./, '');
    const meta = { mode: layerModeNames.get(node.type) ?? 'opaque' };
    if (node.imageLeft > 0) meta.offs_x = node.imageLeft;
    if (node.imageTop > 0) meta.offs_y = node.imageTop;
    if (node.imageLeft > 0 || node.imageTop > 0) meta.offs_unit = 'pixel';
    let bytes;
    if (format === 'bmp' || format === 'bmp32' || format === 'dib') bytes = makeBMP(node.image, 32);
    else if (format === 'bmp24') bytes = makeBMP(node.image, 24);
    else if (format === 'bmp8') bytes = makeBMP(node.image, 8);
    else if (format === 'png' || format === 'png24' || format === 'jpg' || format === 'jpeg' || format === 'jif' || /^jpg[0-9]+$/.test(format)) bytes = await canvasBytes(document, node.image, format);
    else if (format === 'tlg' || format === 'tlg5' || format === 'tlg6' || format === 'tlg524' || format === 'tlg624') {
      bytes = encodeTLG(node.image, format, meta);
    }
    else throw new Error(`TJS Layer.saveLayerImage does not support ${format} in the browser`);
    if (!storage?.write) throw new Error('TJS storage is read-only; Layer.saveLayerImage cannot persist browser data');
    await storage.write(name, bytes, meta);
  });
  Layer.members.set('dump', function() {
    dumpLayer(instanceOf(this));
    return undefined;
  });
  Layer.members.set('copyToBitmapFromMainImage', function(bitmap) {
    if (!arguments.length) throw new Error('TJS Layer.copyToBitmapFromMainImage requires a Bitmap');
    const node = instanceOf(this);
    if (!node.image) throw new Error('TJS not drawable layer type');
    const target = resolveBitmap(bitmap, bitmapClass);
    if (!target) throw new Error('TJS invalid Bitmap parameter');
    assignBitmap(target, node.image);
  });
  Layer.members.set('copyFromBitmapToMainImage', function(bitmap) {
    if (!arguments.length) throw new Error('TJS Layer.copyFromBitmapToMainImage requires a Bitmap');
    const node = instanceOf(this), source = resolveBitmap(bitmap, bitmapClass);
    if (!source) throw new Error('TJS invalid Bitmap parameter');
    node.image = source.image.clone();
    if (node.image.width < node.width) { node.imageLeft = 0; node.width = node.image.width; }
    if (node.image.height < node.height) { node.imageTop = 0; node.height = node.image.height; }
    if (node.image.width + node.imageLeft < node.width) node.imageLeft = node.width - node.image.width;
    if (node.image.height + node.imageTop < node.height) node.imageTop = node.height - node.image.height;
    if (node.province) node.province = node.province.resized(node.image.width, node.image.height, 0);
    node.clip = null; node.imageModified = true; updateTree(node);
  });
  Layer.installLayerStorage = installLayerStorage;
  return Layer;
}
