import { nativeClass, nativeMethod, nativeProperty, createNativeInstance, nativeOwner } from '#krkr/native';
import { number, truth, Closure } from '#krkr/values';
import { Image, colorBytes } from './bitmap.js';
import { getGPU, QUAD_VERTEX } from './gpu.js';
import { blurGlyphGPU } from './gpu-glyph-blur.js';
import { LRUCache } from 'lru-cache';

export const TEXT_BLEND = `// Layer.drawText blends each glyph's coverage with the destination through the
// draw face's function. The three faces are the reference's text blit selection
// (bmAlphaOnAlpha / bmAlpha / bmAlphaOnAddAlpha) and are ported verbatim; the
// draw mode encodes them as 100 + face.
uint packText(int r, int g, int b, int a) {
  return (uint(clamp(a, 0, 255)) << 24u) | (uint(clamp(r, 0, 255)) << 16u)
    | (uint(clamp(g, 0, 255)) << 8u) | uint(clamp(b, 0, 255));
}
uint textBlend(uint d, uint s, int opacity, uint face) {
  uint coverage = s >> 24u;
  if (opacity < 0) {
    uint strength = min(uint(-opacity), 255u);
    uint remain = 65025u - coverage * strength;
    uint alpha = (d >> 24u) * remain / 65025u;
    return (d & 0x00ffffffu) | (alpha << 24u);
  }
  if (opacity == 0 || coverage == 0u) return d;
  int alpha = (int(coverage) * opacity) >> 8;
  int dr = int((d >> 16u) & 255u), dg = int((d >> 8u) & 255u), db = int(d & 255u);
  int sr = int((s >> 16u) & 255u), sg = int((s >> 8u) & 255u), sb = int(s & 255u);
  int destAlpha = int(d >> 24u);
  if (face == 4u) {
    // bmAlphaOnAddAlpha: additive alpha on both planes.
    int inverse = 255 - alpha;
    int unionAlpha = alpha + destAlpha - ((destAlpha * alpha) >> 8);
    return packText(
      min(255, ((dr * inverse) >> 8) + ((sr * alpha) >> 8)),
      min(255, ((dg * inverse) >> 8) + ((sg * alpha) >> 8)),
      min(255, ((db * inverse) >> 8) + ((sb * alpha) >> 8)),
      unionAlpha - (unionAlpha >> 8));
  }
  if (face == 1u) {
    // bmAlpha: colour is interpolated, the destination alpha is retained.
    return packText((dr * 256 + (sr - dr) * int(alpha)) / 256,
      (dg * 256 + (sg - dg) * int(alpha)) / 256,
      (db * 256 + (sb - db) * int(alpha)) / 256, destAlpha);
  }
  // bmAlphaOnAlpha: source-over in straight RGB with the destination alpha in
  // the colour ratio.
  int alphaInt = int(alpha);
  int outAlpha = 255 - ((255 - alphaInt) * (255 - destAlpha)) / 255;
  int ratio = 255;
  if (destAlpha != 0) {
    uint denominator = uint((255 - alphaInt) * destAlpha + 255 * alphaInt);
    ratio = int((65025u * uint(alphaInt)) / denominator);
  }
  return packText((dr * 256 + (sr - dr) * ratio) / 256,
    (dg * 256 + (sg - dg) * ratio) / 256,
    (db * 256 + (sb - db) * ratio) / 256, outAlpha);
}

`;

const fontPrograms = new WeakMap();
const FONT_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D sourceTexture;
uniform vec2 sourceSize;
uniform vec3 glyphColor;
uniform int coverageChannel;
uniform int thresholdCoverage;
in vec2 sourcePoint;
out vec4 colour;
void main() {
  vec2 uv = sourcePoint / sourceSize;
  vec4 value = texture(sourceTexture, uv);
  float coverage = coverageChannel == 0 ? value.r : value.a;
  if (thresholdCoverage != 0) coverage = coverage >= (128.0 / 255.0) ? 1.0 : 0.0;
  colour = vec4(coverageChannel == 3 && value.a == 0.0 ? vec3(0.0) : glyphColor, coverage);
}`;

function colorizeGlyph(source, color, channel, aa) {
  const image = new Image(source.width, source.height, { defer: true });
  if (!source.width || !source.height) return image;
  const gpu = getGPU();
  if (!gpu) throw new Error('GPU font rendering requires an initialized GPU renderer');
  let program = fontPrograms.get(gpu);
  if (!program) {
    program = gpu.compile(QUAD_VERTEX, FONT_FRAGMENT);
    fontPrograms.set(gpu, program);
    gpu.onDispose(() => { gpu.gl.deleteProgram(program); fontPrograms.delete(gpu); });
  }
  const input = gpu.texture(source), target = gpu.texture(image, true);
  const clip = { left: 0, top: 0, right: image.width, bottom: image.height };
  gpu.setup(target, input, clip, [1, 0, 0, 1, 0, 0], clip, input, program);
  gpu.uniform('sourceSize', 'uniform2f', source.width, source.height);
  gpu.uniform('glyphColor', 'uniform3f', ((color >>> 16) & 255) / 255, ((color >>> 8) & 255) / 255, (color & 255) / 255);
  gpu.uniform('coverageChannel', 'uniform1i', channel);
  gpu.uniform('thresholdCoverage', 'uniform1i', Number(!aa));
  gpu.gl.drawArrays(gpu.gl.TRIANGLES, 0, 6);
  gpu.stats.draws++;
  gpu.commit(image, target);
  gpu.releaseTexture(input);
  return image;
}

export function fontCoverageImage(coverage, width, height, color, { stride = 1, aa = true } = {}) {
  if (width <= 0 || height <= 0) return new Image(width, height, { defer: true });
  const source = new Image(width, height, { gray: stride === 1, pixels: coverage });
  return colorizeGlyph(source, color, 0, aa);
}

function fontCanvasImage(canvas, color, aa = true) {
  if (!canvas.width || !canvas.height) return new Image(canvas.width, canvas.height, { defer: true });
  const source = new Image(canvas.width, canvas.height, { defer: true });
  getGPU().uploadCanvas(source, canvas);
  return colorizeGlyph(source, color, 3, aa);
}

export class FontState {
  constructor() {
    this.height = 23;
    this.flags = 0;
    this.angle = 0;
    this.face = 'MS Shell Dlg 2';
    this.faceIsFileName = false;
    this.prerenderedFont = null;
  }
}

// Text measurement/drawing through the browser canvas 2D context. The native
// engine rasterizes via FreeType; the browser font stack replaces it (platform
// boundary), with the same API surface and extents in pixels.
let LayerFontClass = null;
let LayerNativeClass = null;

export function attachFontClass(fontClass, layerClass) {
  LayerFontClass = fontClass;
  LayerNativeClass = layerClass;
}

export function createFontInstance(layerNode) {
  // TVPCreateFontObject: a Font native instance bound to a layer node.
  if (!LayerFontClass) throw new Error('TJS Font class is not registered');
  return createNativeInstance(LayerFontClass, { layer: layerNode });
}

// TVPCreateRectObject returns a real Rect native instance, including its
// width/height properties and methods.  Constructing it here mirrors the VM's
// NativeClass path because getGlyphDrawRect is a synchronous native method.
function createRectObject(Rect, left, top, right, bottom) {
  if (!Rect) throw new Error('TJS Font.getGlyphDrawRect requires the Rect native class');
  const owner = createNativeInstance(Rect, Rect.initialize());
  const rect = Rect.state(owner).rect;
  rect.left = left; rect.top = top; rect.right = right; rect.bottom = bottom;
  return owner;
}

const PRERENDERED_HEADER = new TextEncoder().encode('TVP pre-rendered font\x1a');
const read16 = (bytes, offset) => bytes[offset] | bytes[offset + 1] << 8;
const read32 = (bytes, offset) => (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;

// Prerendered fonts are a small indexed bitmap format in Kirikiri.  The
// browser parses the same index and RLE data after Storages.read resolves;
// rasterization itself remains synchronous once the bytes are mapped.
function parsePrerenderedFont(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length < 36 || !PRERENDERED_HEADER.every((value, i) => bytes[i] === value)) throw new Error('TJS invalid prerendered font file');
  const version = bytes[22];
  if (bytes[23] !== 2) throw new Error('TJS prerendered font is not a 16-bit Unicode font');
  if (version !== 0 && version !== 1) throw new Error('TJS invalid prerendered font header version');
  const count = read32(bytes, 24), charsOffset = read32(bytes, 28), itemsOffset = read32(bytes, 32);
  if (charsOffset + count * 2 > bytes.length || itemsOffset + count * 20 > bytes.length) throw new Error('TJS truncated prerendered font index');
  const glyphs = new Map();
  for (let i = 0; i < count; i++) {
    const item = itemsOffset + i * 20;
    glyphs.set(read16(bytes, charsOffset + i * 2), {
      offset: read32(bytes, item), width: read16(bytes, item + 4), height: read16(bytes, item + 6),
      originX: (read16(bytes, item + 8) << 16) >> 16, originY: (read16(bytes, item + 10) << 16) >> 16,
      incX: (read16(bytes, item + 12) << 16) >> 16, incY: (read16(bytes, item + 14) << 16) >> 16,
      inc: (read16(bytes, item + 16) << 16) >> 16,
    });
  }
  return { bytes, version, glyphs };
}

function retrievePrerenderedGlyph(font, glyph) {
  const { bytes, version } = font;
  const output = new Uint8Array(glyph.width * glyph.height);
  let source = glyph.offset, dest = 0;
  while (dest < output.length && source < bytes.length) {
    const marker = bytes[source++];
    if (version === 0) {
      if (marker === 0x41) {
        if (source >= bytes.length) throw new Error('TJS truncated prerendered glyph');
        const value = dest ? output[dest - 1] : 0, count = bytes[source++];
        if (dest + count > output.length) throw new Error('TJS truncated prerendered glyph');
        output.fill(value, dest, dest + count); dest += count;
      } else output[dest++] = marker;
    } else if (marker >= 0x41) {
      const count = marker - 0x40, value = dest ? output[dest - 1] : 0;
      if (dest + count > output.length) throw new Error('TJS truncated prerendered glyph');
      output.fill(value, dest, dest + count); dest += count;
    } else output[dest++] = marker;
  }
  if (dest !== output.length) throw new Error('TJS truncated prerendered glyph');
  // TVPUpscale65_255: prerendered fonts store coverage in the 0..64 range;
  // each value is expanded to the normal 0..255 alpha range.
  for (let i = 0; i < output.length; i++) output[i] = Math.min(255, output[i] * 4);
  return output;
}

function textClipRect(node, source, left, top) {
  const clip = node.clip ?? { left: 0, top: 0, right: node.image.width, bottom: node.image.height };
  const rect = {
    left: Math.max(0, left, clip.left), top: Math.max(0, top, clip.top),
    right: Math.min(node.image.width, left + source.width, clip.right),
    bottom: Math.min(node.image.height, top + source.height, clip.bottom),
  };
  return rect.right <= rect.left || rect.bottom <= rect.top ? null : rect;
}

export function clipBlit(node, source, left, top, { opa = 255 } = {}) {
  const face = node.drawFace ?? 0;
  if (face !== 0 && face !== 1 && face !== 4) throw new Error(`TJS text drawing is unsupported on draw face ${face}`);
  if (opa === 0) return false;
  const rect = textClipRect(node, source, left, top);
  if (!rect) return false;
  const gpu = getGPU();
  if (!gpu) throw new Error('GPU text compositing requires an initialized GPU renderer');
  gpu.drawGlyph(node.image, source, left, top, {
    mode: 100 + face,
    opacity: opa,
    clip: node.clip,
  });
  node.markImageModified(rect);
  return true;
}

function prerenderedGlyphImage(font, glyph, color, aa) {
  const coverage = retrievePrerenderedGlyph(font, glyph);
  // TVPToActualColor strips system-color markers and leaves RGB.  Text
  // opacity comes from the `opa` argument, so an ordinary 0xRRGGBB color is
  // fully opaque even though its high byte is zero.
  return fontCoverageImage(coverage, glyph.width, glyph.height, color, { aa });
}

// The message layer repaints the whole visible line on every reveal step, so the
// same glyph is rasterised and blurred dozens of times per line. Cache the final
// glyph variant (coloured + shadow blur) per (font, glyph, colour, aa, blur) and
// turn the repeated work into cheap blits. Keep pixel storage bounded per
// runtime, with an entry cap for key and object overhead.
const GLYPH_CACHE_BYTES = 16 * 1024 * 1024;
const GLYPH_CACHE_ENTRIES = 4096;
let nextFontCacheId = 1;
const fontCacheIds = new WeakMap();
function fontCacheId(font) {
  let id = fontCacheIds.get(font);
  if (!id) fontCacheIds.set(font, id = nextFontCacheId++);
  return id;
}
function cachedGlyph(cache, key, create) {
  const entry = cache.get(key);
  if (entry !== undefined) return entry;
  const created = create();
  const bytes = created?.image ? created.image.width * created.image.height * 4 : 0;
  if (bytes > 0 && bytes <= GLYPH_CACHE_BYTES) cache.set(key, created);
  return created;
}
function prerenderedGlyphVariant(cache, font, glyph, color, aa, blurWidth, blurLevel) {
  const key = `${fontCacheId(font)}|${glyph.offset}|${glyph.width}x${glyph.height}|${color}|${aa ? 1 : 0}|${blurWidth}|${blurLevel}`;
  return cachedGlyph(cache, `prerendered|${key}`, () =>
    blurGlyphImage(prerenderedGlyphImage(font, glyph, color, aa), blurWidth, blurLevel));
}

// LayerBitmapImpl::ApplyFont derives these offsets from the rasterizer ascent.
// Canvas does not expose the native rasterizer's ascent, so use its measured
// glyph ascent when available and retain the same integer/trigonometric rules.
export function getFontAscentOffsets(document, font) {
  const size = Math.abs(font?.height ?? 0) | 0;
  let ascent = Math.trunc(size * 0.8);
  if (document?.createElement) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (context) {
      context.font = `${font?.flags & 0x0200 ? 'bold ' : ''}${font?.flags & 0x0100 ? 'italic ' : ''}${size}px "${String(font?.face ?? '').replace(/"/g, '')}", sans-serif`;
      const metrics = context.measureText('Mg');
      if (Number.isFinite(metrics.actualBoundingBoxAscent)) ascent = Math.trunc(metrics.actualBoundingBoxAscent);
    }
  }
  const angle = (font?.angle || 0) * Math.PI / 1800;
  return {
    x: Math.trunc(Math.sin(angle) * ascent),
    y: Math.trunc(Math.cos(angle) * ascent),
    angle,
  };
}

function nativeCellIncY(value, angleTenths) {
  value = Math.trunc(value);
  if (value !== 0) {
    if (angleTenths < 1800) { if (value > 0) value = -value; }
    else if (value < 0) value = -value;
  }
  return value;
}

export function blurGlyphImage(source, blurWidth, blurLevel = 255) {
  const radius = Math.abs(Math.trunc(blurWidth));
  blurLevel = Math.max(0, Math.min(255, Math.trunc(blurLevel)));
  if (!radius) {
    if (blurLevel === 255) return { image: source, offsetX: 0, offsetY: 0 };
    return blurGlyphGPU(source, blurWidth, blurLevel, []);
  }
  const hypot = (x, y) => {
    x = Math.abs(x); y = Math.abs(y);
    const hi = Math.max(x, y), lo = Math.min(x, y), t = lo + (lo >> 1);
    return hi - (hi >> 5) - (hi >> 7) + (t >> 2) + (t >> 6);
  };
  const kernel = [];
  let total = 0;
  for (let y = -radius; y <= radius; y++) for (let x = -radius; x <= radius; x++) {
    const distance = hypot(x, y);
    if (distance <= radius) { const weight = radius - distance + 1; kernel.push([x, y, weight]); total += weight; }
  }
  const levelScale = Math.trunc((1 << 18) / total);
  const weightedKernel = kernel.map(([x, y, weight]) => [x, y, Math.trunc(weight * levelScale * blurLevel / 256)]);
  return blurGlyphGPU(source, blurWidth, blurLevel, weightedKernel);
}

function normalizeTextOpacity(node, opa) {
  opa = Math.trunc(number(opa));
  const face = node.drawFace ?? 0;
  if (face !== 0 && face !== 1 && face !== 4) throw new Error(`TJS text drawing is unsupported on draw face ${face}`);
  if (face === 4 && opa < 0) throw new Error('TJS negative opacity not supported on additive alpha face');
  if (face !== 0 && opa < 0) return 0;
  return Math.max(-255, Math.min(255, opa));
}

function measuredTextBounds(context, text, size, flags) {
  const metrics = context.measureText(text);
  const baseline = size * 0.8;
  const left = Number.isFinite(metrics.actualBoundingBoxLeft) ? -metrics.actualBoundingBoxLeft : -size * 0.25;
  const right = Number.isFinite(metrics.actualBoundingBoxRight) ? metrics.actualBoundingBoxRight : metrics.width + size * 0.25;
  const ascent = Number.isFinite(metrics.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : size * 0.8;
  const descent = Number.isFinite(metrics.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : size * 0.2;
  const boxes = [];
  if (right > left && ascent + descent > 0) boxes.push([left, baseline - ascent, right, baseline + descent]);
  const line = Math.max(1, Math.ceil(size / 14));
  if (flags & 0x0800) boxes.push([0, size * 0.52, metrics.width, size * 0.52 + line]);
  if (flags & 0x0400) boxes.push([0, size * 0.86, metrics.width, size * 0.86 + line]);
  return { metrics, boxes };
}

function addRotatedTextBounds(bounds, textBounds, x, y, angle) {
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  for (const [left, top, right, bottom] of textBounds.boxes) {
    for (const [localX, localY] of [[left, top], [right, top], [left, bottom], [right, bottom]]) {
      const worldX = x + cosine * localX + sine * localY;
      const worldY = y - sine * localX + cosine * localY;
      bounds.left = Math.min(bounds.left, worldX);
      bounds.top = Math.min(bounds.top, worldY);
      bounds.right = Math.max(bounds.right, worldX);
      bounds.bottom = Math.max(bounds.bottom, worldY);
    }
  }
}

function textCanvasRegion(node, bounds) {
  if (bounds.right <= bounds.left || bounds.bottom <= bounds.top) return null;
  const left = Math.max(0, Math.floor(bounds.left) - 1), top = Math.max(0, Math.floor(bounds.top) - 1);
  const right = Math.min(node.image.width, Math.ceil(bounds.right) + 1), bottom = Math.min(node.image.height, Math.ceil(bounds.bottom) + 1);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function drawFallback(cache, document, node, glyphs, color, opa, shadowWidth = 0, offsetX = 0, offsetY = 0, angle = 0, blurLevel = 255, aa = true) {
  if (!glyphs.length) return false;
  if (!document?.createElement) throw new Error('TJS prerendered font fallback requires a browser canvas');
  blurLevel = Math.max(0, Math.min(255, Math.abs(Math.trunc(blurLevel))));
  // Horizontal text takes the cached per-character path; rotated fallback
  // text remains a single run so its existing rasterization and blur semantics
  // are unchanged.
  if (!angle) {
    for (const item of glyphs) {
      const entry = fallbackGlyphVariant(cache, document, node, item.character, color, shadowWidth, blurLevel, aa);
      if (!entry) continue;
      clipBlit(node, entry.image, item.x + offsetX + entry.left, item.y + offsetY + entry.top, { opa, holdAlpha: !!node.holdAlpha });
    }
    return true;
  }
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const size = Math.abs(node.font.height) | 0;
  const [r, g, b] = colorBytes(color);
  const flags = node.font.flags;
  const font = `${flags & 0x0200 ? 'bold ' : ''}${flags & 0x0100 ? 'italic ' : ''}${size}px "${String(node.font.face).replace(/"/g, '')}", sans-serif`;
  context.font = font;
  const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const item of glyphs) {
    const measured = measuredTextBounds(context, item.character, size, flags);
    addRotatedTextBounds(bounds, measured, item.x + offsetX, item.y + offsetY, angle);
  }
  const region = textCanvasRegion(node, bounds);
  if (!region) return false;
  canvas.width = region.width; canvas.height = region.height;
  context.font = font;
  context.imageSmoothingEnabled = true;
  context.fillStyle = `rgba(${r},${g},${b},1)`;
  for (const item of glyphs) {
    context.save();
    context.translate(item.x + offsetX - region.left, item.y + offsetY - region.top);
    context.rotate(-angle);
    context.fillText(item.character, 0, size * 0.8);
    const metrics = context.measureText(item.character), line = Math.max(1, Math.ceil(size / 14));
    if (flags & 0x0800) context.fillRect(0, size * 0.52, metrics.width, line);
    if (flags & 0x0400) context.fillRect(0, size * 0.86, metrics.width, line);
    context.restore();
  }
  const source = fontCanvasImage(canvas, color, aa);
  const blurred = blurGlyphImage(source, shadowWidth, blurLevel);
  return clipBlit(node, blurred.image, region.left + blurred.offsetX, region.top + blurred.offsetY, { opa, holdAlpha: !!node.holdAlpha });
}

// One browser-rasterised character, positioned by its own bounding box. The
// caller blits it at `left`/`top` relative to the pen position.
function renderFallbackGlyph(document, node, character, color, shadowWidth, blurLevel, aa = true, angle = 0) {
  const size = Math.abs(node.font.height) | 0;
  const flags = node.font.flags;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  const font = `${flags & 0x0200 ? 'bold ' : ''}${flags & 0x0100 ? 'italic ' : ''}${size}px "${String(node.font.face).replace(/"/g, '')}", sans-serif`;
  context.font = font;
  const measured = measuredTextBounds(context, character, size, flags);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const [l, t, r, b] of measured.boxes) {
    for (const [px, py] of [[l, t], [r, t], [l, b], [r, b]]) {
      const rx = Math.cos(angle) * px + Math.sin(angle) * py;
      const ry = -Math.sin(angle) * px + Math.cos(angle) * py;
      left = Math.min(left, rx); top = Math.min(top, ry);
      right = Math.max(right, rx); bottom = Math.max(bottom, ry);
    }
  }
  if (!Number.isFinite(left) || right <= left || bottom <= top) return null;
  const pad = Math.abs(Math.trunc(shadowWidth)) + 2;
  const originX = Math.floor(left) - pad, originY = Math.floor(top) - pad;
  const width = Math.max(1, Math.ceil(right) + pad - originX);
  const height = Math.max(1, Math.ceil(bottom) + pad - originY);
  canvas.width = width; canvas.height = height;
  context.font = font;
  context.imageSmoothingEnabled = true;
  const [r, g, b] = colorBytes(color);
  context.fillStyle = `rgba(${r},${g},${b},1)`;
  context.translate(-originX, -originY);
  context.rotate(-angle);
  context.fillText(character, 0, size * 0.8);
  const metrics = context.measureText(character), line = Math.max(1, Math.ceil(size / 14));
  if (flags & 0x0800) context.fillRect(0, size * 0.52, metrics.width, line);
  if (flags & 0x0400) context.fillRect(0, size * 0.86, metrics.width, line);
  const source = fontCanvasImage(canvas, color, aa);
  const blurred = blurGlyphImage(source, shadowWidth, blurLevel);
  return { image: blurred.image, left: originX + blurred.offsetX, top: originY + blurred.offsetY };
}

function fallbackGlyphVariant(cache, document, node, character, color, shadowWidth, blurLevel, aa = true, angle = 0) {
  const key = `${String(node.font.face)}|${node.font.height}|${node.font.flags}|${character}|${color}|${aa ? 1 : 0}|${shadowWidth}|${blurLevel}|${angle}`;
  return cachedGlyph(cache, `fallback|${key}`,
    () => renderFallbackGlyph(document, node, character, color, shadowWidth, blurLevel, aa, angle));
}

function browserGlyphPositions(context, text, x, y, angle) {
  const glyphs = [];
  let prefix = '';
  for (const character of text) {
    const advance = prefix ? context.measureText(prefix).width : 0;
    glyphs.push({ character, x: x + Math.cos(angle) * advance, y: y - Math.sin(angle) * advance });
    prefix += character;
  }
  return glyphs;
}

// TVPGetCharacter uses the mapped glyph's bitmap and advances by IncX/IncY.
// Returning false when a character is absent lets the normal browser font
// renderer handle the mixed mapped/fallback case as the native rasterizer does.
function drawPrerenderedText(cache, document, node, x, y, text, color, opa, aa, shadowLevel, shadowColor, shadowWidth, shadowOfsx, shadowOfsy) {
  const font = node.font?.prerenderedFont;
  if (!font) return false;
  opa = normalizeTextOpacity(node, opa);
  if (opa === 0) return true;
  const ascent = getFontAscentOffsets(document, node.font);
  const glyphs = [], fallback = [];
  let cursorX = x, cursorY = y;
  for (const character of text) {
    const glyph = font.glyphs.get(character.charCodeAt(0));
    if (glyph) {
      glyphs.push({ glyph, x: cursorX + glyph.originX + ascent.x, y: cursorY - glyph.originY + ascent.y });
      cursorX += glyph.incX;
      cursorY += nativeCellIncY(glyph.incY, node.font.angle);
    } else {
      // FreeType's GetBitmap adds AscentOfsX to the fallback origin.  Its
      // OriginY already includes the rasterizer ascent, unlike packed glyphs.
      fallback.push({ character, x: cursorX + ascent.x, y: cursorY });
      // The browser fallback is measured one character at a time, matching
      // TVPGetCharacter's per-character fallback for an absent mapped glyph.
      const canvas = document?.createElement?.('canvas');
      if (!canvas) throw new Error('TJS prerendered font fallback requires a browser canvas');
      const context = canvas.getContext('2d');
      const size = Math.abs(node.font.height) | 0;
      context.font = `${node.font.flags & 0x0200 ? 'bold ' : ''}${node.font.flags & 0x0100 ? 'italic ' : ''}${size}px "${String(node.font.face).replace(/"/g, '')}", sans-serif`;
      const advance = Math.ceil(context.measureText(character).width);
      const radians = ascent.angle;
      if (node.font.angle === 2700) cursorY += advance;
      else {
        cursorX += Math.trunc(Math.cos(radians) * advance);
        cursorY += nativeCellIncY(Math.trunc(-Math.sin(radians) * advance), node.font.angle);
      }
    }
  }
  const drawSet = (set, drawColor, drawOpa, ox = 0, oy = 0, blurWidth = 0, blurLevel = 255) => {
    for (const item of set) {
      const blurred = prerenderedGlyphVariant(cache, font, item.glyph, drawColor, aa, blurWidth, blurLevel);
      clipBlit(node, blurred.image, item.x + ox + blurred.offsetX, item.y + oy + blurred.offsetY, { opa: drawOpa, holdAlpha: !!node.holdAlpha });
    }
  };
  if (shadowLevel) {
    drawSet(glyphs, shadowColor, opa, Math.trunc(shadowOfsx), Math.trunc(shadowOfsy), shadowWidth, Math.abs(Math.trunc(shadowLevel)));
    drawFallback(cache, document, node, fallback, shadowColor, opa, shadowWidth, Math.trunc(shadowOfsx), Math.trunc(shadowOfsy), ascent.angle, shadowLevel);
  }
  drawSet(glyphs, color, opa);
  drawFallback(cache, document, node, fallback, color, opa, 0, 0, 0, ascent.angle);
  return true;
}

async function storageBytes(storage, name) {
  if (name instanceof Uint8Array) return name.slice();
  if (name instanceof ArrayBuffer) return new Uint8Array(name);
  if (!storage?.read) return null;
  const bytes = await storage.read(String(name));
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return null;
}

export function createFontClass(document, { storage, Rect } = {}) {
  let rasterizer = 0;
  const browserDefaultFace = () => {
    const faces = document?.fonts ? Array.from(document.fonts).map(font => String(font.family || '')).filter(Boolean) : [];
    return faces[0] ?? 'sans-serif';
  };
  const defaultFaceName = browserDefaultFace();
  const measure = (font, text) => {
    if (font?.prerenderedFont) {
      let width = 0;
      let context;
      for (const character of text) {
        const glyph = font.prerenderedFont.glyphs.get(character.charCodeAt(0));
        if (glyph) width += glyph.inc;
        else {
          if (!context) {
            const canvas = document.createElement('canvas');
            context = canvas.getContext('2d');
            context.font = `${font.flags & 0x0200 ? 'bold ' : ''}${font.flags & 0x0100 ? 'italic ' : ''}${Math.abs(font.height) | 0}px "${String(font.face).replace(/"/g, '')}", sans-serif`;
          }
          width += Math.ceil(context.measureText(character).width);
        }
      }
      return { width, height: Math.abs(font.height) };
    }
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = `${font.flags & 0x0200 ? 'bold ' : ''}${font.flags & 0x0100 ? 'italic ' : ''}${Math.abs(font.height) | 0}px "${String(font.face).replace(/"/g, '')}", sans-serif`;
    const metrics = context.measureText(text);
    return { width: Math.ceil(metrics.width), height: Math.abs(font.height) };
  };
  // The Font instance follows its owning layer's font state when attached.
  const fontOf = state => {
    if (!state.layer) state.font ??= new FontState();
    return state.layer ? state.layer.font : state.font;
  };
  @nativeClass('Font')
  class Font {
    static initialize() { return { layer: null }; }

    @nativeMethod Font(layer) {
      const state = this;
      if (layer !== undefined && layer !== null) {
        if (!LayerNativeClass) throw new Error('TJS Layer class is not registered');
        state.layer = LayerNativeClass.state(nativeOwner(layer)).node;
      }
    }
    @nativeMethod getTextWidth(...args) {
      if (!arguments.length) throw new Error('TJS Font.getTextWidth requires text');
      const state = this;
      return measure(state.layer ? state.layer.font : state.font ?? new FontState(), String(args[0])).width;
    }
    @nativeMethod getTextHeight(...args) {
      if (!arguments.length) throw new Error('TJS Font.getTextHeight requires text');
      const state = this;
      return measure(state.layer ? state.layer.font : state.font ?? new FontState(), String(args[0])).height;
    }

    @nativeProperty get height() { return fontOf(this).height; }
    @nativeProperty set height(value) {
      let next = Math.trunc(number(value));
      if (next < 0) next = -next;
      fontOf(this).height = next;
    }
    @nativeProperty get angle() { return fontOf(this).angle; }
    @nativeProperty set angle(value) {
      let next = Math.trunc(number(value));
      next %= 3600; if (next < 0) next += 3600;
      fontOf(this).angle = next;
    }
    @nativeProperty get bold() { return Number(!!(fontOf(this).flags & 0x0200)); }
    @nativeProperty set bold(value) { if (truth(value)) fontOf(this).flags |= 0x0200; else fontOf(this).flags &= ~0x0200; }
    @nativeProperty get italic() { return Number(!!(fontOf(this).flags & 0x0100)); }
    @nativeProperty set italic(value) { if (truth(value)) fontOf(this).flags |= 0x0100; else fontOf(this).flags &= ~0x0100; }
    @nativeProperty get strikeout() { return Number(!!(fontOf(this).flags & 0x0800)); }
    @nativeProperty set strikeout(value) { if (truth(value)) fontOf(this).flags |= 0x0800; else fontOf(this).flags &= ~0x0800; }
    @nativeProperty get underline() { return Number(!!(fontOf(this).flags & 0x0400)); }
    @nativeProperty set underline(value) { if (truth(value)) fontOf(this).flags |= 0x0400; else fontOf(this).flags &= ~0x0400; }
    @nativeProperty get face() { return fontOf(this).face; }
    @nativeProperty set face(value) { fontOf(this).face = String(value); }
    @nativeProperty get faceIsFileName() { return Number(fontOf(this).faceIsFileName); }
    @nativeProperty set faceIsFileName(value) { fontOf(this).faceIsFileName = !!truth(value); }

    @nativeMethod getEscWidthX(...args) { if (!args.length) throw new Error('TJS Font.getEscWidthX requires text'); const f = fontOf(this); return measure(f, String(args[0])).width * Math.cos(f.angle * Math.PI / 1800); }
    @nativeMethod getEscWidthY(...args) { if (!args.length) throw new Error('TJS Font.getEscWidthY requires text'); const f = fontOf(this); return measure(f, String(args[0])).width * -Math.sin(f.angle * Math.PI / 1800); }
    @nativeMethod getEscHeightX(...args) { if (!args.length) throw new Error('TJS Font.getEscHeightX requires text'); const f = fontOf(this); return measure(f, String(args[0])).height * Math.sin(f.angle * Math.PI / 1800); }
    @nativeMethod getEscHeightY(...args) { if (!args.length) throw new Error('TJS Font.getEscHeightY requires text'); const f = fontOf(this); return measure(f, String(args[0])).height * Math.cos(f.angle * Math.PI / 1800); }
    @nativeMethod getGlyphDrawRect(...args) {
      if (arguments.length < 1) throw new Error('TJS Font.getGlyphDrawRect requires text');
      const font = fontOf(this), text = String(args[0]);
      if (!text.length) return createRectObject(Rect, 0, 0, 0, 0);
      const size = Math.abs(font.height) | 0;
      let left = 0, top = -Math.trunc(size * 0.8), right = measure(font, text).width, bottom = size - Math.trunc(size * 0.8);
      if (document?.createElement) {
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
        context.font = `${font.flags & 0x0200 ? 'bold ' : ''}${font.flags & 0x0100 ? 'italic ' : ''}${size}px "${String(font.face).replace(/"/g, '')}", sans-serif`;
        const metrics = context.measureText(text);
        if (Number.isFinite(metrics.actualBoundingBoxLeft)) left = -Math.ceil(metrics.actualBoundingBoxLeft);
        if (Number.isFinite(metrics.actualBoundingBoxAscent)) top = -Math.ceil(metrics.actualBoundingBoxAscent);
        if (Number.isFinite(metrics.actualBoundingBoxRight)) right = Math.ceil(metrics.actualBoundingBoxRight);
        if (Number.isFinite(metrics.actualBoundingBoxDescent)) bottom = Math.ceil(metrics.actualBoundingBoxDescent);
      }
      // Canvas exposes no portable underline/strikeout metrics; retain the
      // native text extent convention by extending to the advance width.
      if (font.flags & (0x0400 | 0x0800)) right = Math.max(right, measure(font, text).width);
      return createRectObject(Rect, left, top, right, bottom);
    }
    @nativeMethod async mapPrerenderedFont(...args) {
      if (!args.length) throw new Error('TJS Font.mapPrerenderedFont requires a storage');
      const bytes = await storageBytes(storage, args[0]);
      if (!bytes) throw new Error('TJS prerendered font mapping could not read storage bytes in the browser');
      const state = this;
      state.font ??= new FontState();
      state.layer ? state.layer.font.prerenderedFont = parsePrerenderedFont(bytes) : state.font.prerenderedFont = parsePrerenderedFont(bytes);
    }
    @nativeMethod unmapPrerenderedFont() {
      const state = this;
      if (state.layer) state.layer.font.prerenderedFont = null;
      else { state.font ??= new FontState(); state.font.prerenderedFont = null; }
    }
    @nativeMethod doUserSelect(...args) {
      if (args.length < 4) throw new Error('TJS Font.doUserSelect requires flags, caption, prompt and sample text');
      // The native implementation intentionally returns false unless a
      // platform font picker is supplied.  Browsers have no synchronous font
      // picker, so returning 0 preserves that contract without a fake change.
      return 0;
    }
    @nativeMethod getList() {
      if (!arguments.length) throw new Error('TJS Font.getList requires flags');
      const result = [];
      const names = new Set(document?.fonts ? Array.from(document.fonts).map(f => String(f.family || '')).filter(Boolean) : []);
      result.push(...names);
      return result;
    }

    // FontRasterizer.cpp exposes only the FreeType rasterizer in this build
    // (index 0); invalid values are ignored by the native setter.
    @nativeProperty get rasterizer() { return rasterizer; }
    @nativeProperty set rasterizer(value) {
      const next = Math.trunc(number(value));
      if (next === 0) rasterizer = 0;
    }
    // The native setter deliberately leaves the preference unchanged.  The
    // browser's default family is the closest platform equivalent.
    @nativeProperty get defaultFaceName() { return defaultFaceName; }
    @nativeProperty set defaultFaceName(value) {}
  }
  return Font;
}

export function createTextRenderer(document) {
  let textCanvas;
  const glyphCache = new LRUCache({
    max: GLYPH_CACHE_ENTRIES,
    maxSize: GLYPH_CACHE_BYTES,
    sizeCalculation: entry => entry.image.width * entry.image.height * 4,
  });
  const drawText = function drawText(node, x, y, text, color, opa, aa = true, shadowLevel = 0, shadowColor = 0, shadowWidth = 0, shadowOfsx = 0, shadowOfsy = 0) {
    opa = normalizeTextOpacity(node, opa);
    if (opa === 0) return;
    if (drawPrerenderedText(glyphCache, document, node, x, y, text, color, opa, aa, shadowLevel, shadowColor, shadowWidth, shadowOfsx, shadowOfsy)) return;
    const canvas = textCanvas ??= document.createElement('canvas');
    const context = canvas.getContext('2d');
    const font = node.font, size = Math.abs(font.height) | 0;
    const fontSpec = `${font.flags & 0x0200 ? 'bold ' : ''}${font.flags & 0x0100 ? 'italic ' : ''}${size}px "${String(font.face).replace(/"/g, '')}", sans-serif`;
    context.font = fontSpec;
    const angle = (font.angle || 0) * Math.PI / 1800;
    const glyphs = browserGlyphPositions(context, text, x, y, angle);
    const drawRun = (dx, dy, drawColor, blurWidth = 0, blurLevel = 255, threshold = false) => {
      const measured = measuredTextBounds(context, text, size, font.flags);
      const bounds = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      addRotatedTextBounds(bounds, measured, x + dx, y + dy, angle);
      const region = textCanvasRegion(node, bounds);
      if (!region) return false;
      const key = `run|${JSON.stringify([font.face, font.height, font.flags, text, drawColor, aa, angle,
        x + dx - region.left, y + dy - region.top, region.width, region.height, blurWidth, blurLevel, threshold])}`;
      const entry = cachedGlyph(glyphCache, key, () => {
        if (canvas.width !== region.width) canvas.width = region.width;
        if (canvas.height !== region.height) canvas.height = region.height;
        context.font = fontSpec;
        context.imageSmoothingEnabled = !!aa;
        context.clearRect(0, 0, region.width, region.height);
        context.save();
        context.translate(x + dx - region.left, y + dy - region.top);
        context.rotate(-angle);
        const [r, g, b] = colorBytes(drawColor);
        context.fillStyle = `rgba(${r},${g},${b},1)`;
        context.fillText(text, 0, size * 0.8);
        const metrics = measured.metrics, line = Math.max(1, Math.ceil(size / 14));
        if (font.flags & 0x0800) context.fillRect(0, size * 0.52, metrics.width, line);
        if (font.flags & 0x0400) context.fillRect(0, size * 0.86, metrics.width, line);
        context.restore();
        const image = fontCanvasImage(canvas, drawColor, threshold ? false : aa);
        const blurred = blurGlyphImage(image, blurWidth, blurLevel);
        return { image: blurred.image, left: region.left + blurred.offsetX - x - dx, top: region.top + blurred.offsetY - y - dy };
      });
      if (!entry) return false;
      clipBlit(node, entry.image, x + dx + entry.left, y + dy + entry.top, { opa, holdAlpha: !!node.holdAlpha });
      return true;
    };
    // The browser fallback historically rasterized and blurred the entire
    // string as one mask. Keep that shadow algorithm intact and cache the run
    // variant; only ordinary horizontal body glyphs use the per-glyph cache.
    if (shadowLevel) drawRun(Math.trunc(shadowOfsx), Math.trunc(shadowOfsy), shadowColor,
      shadowWidth, Math.abs(Math.trunc(shadowLevel)));
    if (angle === 0 && !(font.flags & (0x0400 | 0x0800))) {
      drawFallback(glyphCache, document, node, glyphs, color, opa, 0, 0, 0, angle, 255, !!aa);
    } else drawRun(0, 0, color, 0, 255, !aa);
  };
  drawText.finalize = () => glyphCache.clear();
  return drawText;
}
