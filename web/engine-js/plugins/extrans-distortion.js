// GPU distortion passes for the extrans wave, mosaic and ripple providers.
// Mapping follows the existing software formulas; the shader only replaces
// their per-pixel CPU loops.
import { getGPU, QUAD_VERTEX } from '../gpu.js';

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D sourceTexture;
uniform sampler2D secondTexture;
uniform int kind;
uniform int phase;
uniform int layerType;
uniform ivec2 imageSize;
uniform float curH;
uniform float omega;
uniform float radStart;
uniform vec4 background;
uniform int blockSize;
uniform ivec2 blockOffset;
uniform ivec2 center;
uniform float roundness;
uniform int rippleWidth;
uniform int wavePhase;
uniform int fdrift;
uniform int rippleForm[128];
uniform int cosTable[32];
uniform int sinTable[32];
out vec4 colour;

int reflectCoord(int v, int size) {
  if (size <= 1) return 0;
  while (v < 0 || v >= size) v = v < 0 ? -v : size - 1 - (v - size);
  return v;
}
int signedByte(int v) {
  int b = v & 255;
  return b < 128 ? b : b - 256;
}
ivec2 ripplePoint(ivec2 p) {
  bool right = p.x >= center.x;
  bool top = p.y < center.y;
  int dx = right ? p.x - center.x : center.x - p.x - 1;
  int dy = top ? center.y - p.y - 1 : p.y - center.y;
  float yy = (float(dy) + 0.5) * roundness;
  float xx = float(dx) + 0.5;
  int dir = clamp(int(atan(xx / yy) * (32.0 / 1.5707963267948966)), 0, 31);
  int dist = int(sqrt(xx * xx + yy * yy)) & (rippleWidth - 1);
  int w = (dist + wavePhase) & (rippleWidth - 1);
  int fd = (rippleForm[w] * fdrift) >> 10;
  int xd = (cosTable[dir] * fd) >> 11;
  int yd = (sinTable[dir] * fd) >> 11;
  int sx = signedByte(xd >> 11);
  int sy = signedByte(yd >> 11);
  ivec2 q = ivec2(right ? p.x - sx : p.x + sx, top ? p.y + sy : p.y - sy);
  return ivec2(reflectCoord(q.x, imageSize.x), reflectCoord(q.y, imageSize.y));
}
uint packRGBA(vec4 c) {
  uvec4 b = uvec4(round(clamp(c, 0.0, 1.0) * 255.0));
  return (b.a << 24u) | (b.r << 16u) | (b.g << 8u) | b.b;
}
vec4 unpackRGBA(uint c) {
  return vec4(float((c >> 16u) & 255u), float((c >> 8u) & 255u), float(c & 255u), float(c >> 24u)) / 255.0;
}
uint mixPixel(uint a, uint b, uint p) {
  uvec4 av = uvec4((a >> 16u) & 255u, (a >> 8u) & 255u, a & 255u, a >> 24u);
  uvec4 bv = uvec4((b >> 16u) & 255u, (b >> 8u) & 255u, b & 255u, b >> 24u);
  uint rgbWeight = p;
  if (layerType == 2 || (layerType >= 13 && layerType <= 28)) {
    p = p > 127u ? p + 1u : p;
    uint adjusted = p;
    float srcAlpha = float((bv.a * adjusted) >> 8u) / 255.0;
    float dstAlpha = float((av.a * (256u - adjusted)) >> 8u) / 255.0;
    float ratio = dstAlpha == 0.0 ? 1e20 : srcAlpha / dstAlpha;
    rgbWeight = uint(clamp(ratio / (1.0 - srcAlpha + ratio) * 255.0, 0.0, 255.0));
  }
  ivec3 rgb = ivec3(av.rgb) + ((ivec3(bv.rgb) - ivec3(av.rgb)) * int(rgbWeight) >> 8);
  int alpha = int(av.a) + ((int(bv.a) - int(av.a)) * int(p) >> 8);
  if (layerType != 2 && layerType != 12 && !(layerType >= 13 && layerType <= 28)) alpha = 0;
  return (uint(alpha) << 24u) | (uint(rgb.r) << 16u) | (uint(rgb.g) << 8u) | uint(rgb.b);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int blend = min(255, phase);
  ivec2 s = p;
  if (kind == 0) {
    int shift = int(sin(float(p.y) * omega + radStart) * curH);
    s.x -= shift;
    if (s.x < 0 || s.x >= imageSize.x) {
      colour = background;
      return;
    }
  } else if (kind == 1) {
    int left = (int(floor(float(p.x - blockOffset.x) / float(blockSize))) * blockSize) + blockOffset.x;
    int top = (int(floor(float(p.y - blockOffset.y) / float(blockSize))) * blockSize) + blockOffset.y;
    s = clamp(ivec2(left + (blockSize >> 1), top + (blockSize >> 1)), ivec2(0), imageSize - 1);
  } else {
    s = ripplePoint(p);
  }
  uint a = packRGBA(texelFetch(sourceTexture, s, 0));
  uint b = packRGBA(texelFetch(secondTexture, s, 0));
  colour = unpackRGBA(mixPixel(a, b, uint(blend)));
}`;

const programs = new WeakMap();
function getProgram(gpu) {
  let program = programs.get(gpu);
  if (!program) {
    program = gpu.compile(QUAD_VERTEX, FRAGMENT);
    programs.set(gpu, program);
    gpu.onDispose(() => { gpu.gl.deleteProgram(program); programs.delete(gpu); });
  }
  return program;
}

/** Render a software-compatible distortion mapping on the GPU. */
export function renderDistortion(frame, src1, src2, options) {
  const { kind, width, height, type, blend } = options;
  if (src1.width !== width || src1.height !== height || src2.width !== width || src2.height !== height ||
      frame.width !== width || frame.height !== height)
    throw new Error('extrans source images must have equal dimensions');
  const kinds = { wave: 0, mosaic: 1, ripple: 2 };
  const shaderKind = kinds[kind];
  if (shaderKind === undefined) throw new Error(`unsupported extrans distortion: ${kind}`);
  const gpu = getGPU(), gl = gpu.gl;
  frame.detach(false);
  const first = gpu.texture(src1), second = gpu.texture(src2), target = gpu.texture(frame, true);
  const full = { left: 0, top: 0, right: width, bottom: height };
  try {
    gpu.setup(target, first, full, [1, 0, 0, 1, 0, 0], gpu.clip(frame), second, getProgram(gpu));
    gpu.bind(second, 1, 'secondTexture');
    gpu.uniform('kind', 'uniform1i', shaderKind);
    gpu.uniform('phase', 'uniform1i', blend);
    gpu.uniform('layerType', 'uniform1i', type);
    gpu.uniform('imageSize', 'uniform2i', width, height);
    if (kind === 'wave') {
      gpu.uniform('curH', 'uniform1f', options.curH);
      gpu.uniform('omega', 'uniform1f', options.omega);
      gpu.uniform('radStart', 'uniform1f', options.radStart);
      gpu.uniform('background', 'uniform4f', ...options.background.map(value => value / 255));
    } else if (kind === 'mosaic') {
      gpu.uniform('blockSize', 'uniform1i', options.block);
      gpu.uniform('blockOffset', 'uniform2i', options.ox, options.oy);
    } else {
      gpu.uniform('center', 'uniform2i', options.centerX, options.centerY);
      gpu.uniform('roundness', 'uniform1f', options.roundness);
      gpu.uniform('rippleWidth', 'uniform1i', options.rippleWidth);
      gpu.uniform('wavePhase', 'uniform1i', options.wavePhase);
      gpu.uniform('fdrift', 'uniform1i', options.fdrift);
      gpu.uniform('rippleForm[0]', 'uniform1iv', new Int32Array(options.rippleForm));
      gpu.uniform('cosTable[0]', 'uniform1iv', new Int32Array(options.cosTable));
      gpu.uniform('sinTable[0]', 'uniform1iv', new Int32Array(options.sinTable));
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gpu.stats.draws++;
    gpu.commit(frame, target);
  } finally {
    gl.useProgram(gpu.program);
  }
}
