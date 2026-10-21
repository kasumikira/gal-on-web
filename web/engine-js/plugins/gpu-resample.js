import { getGPU } from '../gpu.js';

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const AREA = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D sourceTexture;
uniform ivec2 sourceSize;
uniform ivec2 destinationOrigin;
uniform ivec2 outputOrigin;
uniform ivec2 outputSize;
uniform ivec2 sourceOrigin;
uniform ivec2 sourceExtent;
uniform vec2 ratio;
uniform vec2 destinationOffset;
uniform int fastMode;
out vec4 colour;
void main() {
  ivec2 outp = ivec2(gl_FragCoord.xy) - outputOrigin;
  if (any(lessThan(outp, ivec2(0))) || any(greaterThanEqual(outp, outputSize))) discard;
  ivec2 dp = ivec2(gl_FragCoord.xy) - destinationOrigin;
  if (fastMode != 0) {
    ivec2 start = dp * ivec2(int(ratio.x), int(ratio.y));
    ivec2 extent = min(ivec2(int(ratio.x), int(ratio.y)), sourceSize - start);
    vec3 sum = vec3(0.0);
    for (int y = 0; y < extent.y; ++y)
      for (int x = 0; x < extent.x; ++x)
        sum += round(texelFetch(sourceTexture, start + ivec2(x, y), 0).rgb * 255.0);
    colour = vec4(floor(sum / float(extent.x * extent.y)) / 255.0, 1.0);
    return;
  }
  vec2 a = (vec2(dp) - destinationOffset) * ratio;
  vec2 b = a + ratio;
  ivec2 first = max(ivec2(0), ivec2(floor(a)));
  ivec2 last = min(sourceExtent - 1, ivec2(ceil(b)) - 1);
  vec4 sum = vec4(0.0);
  for (int y = first.y; y <= last.y; ++y) {
    float wy = min(b.y, float(y + 1)) - max(a.y, float(y));
    for (int x = first.x; x <= last.x; ++x) {
      float wx = min(b.x, float(x + 1)) - max(a.x, float(x));
      sum += round(texelFetch(sourceTexture, sourceOrigin + ivec2(x, y), 0) * 255.0) * (wx * wy);
    }
  }
  colour = floor(sum / (ratio.x * ratio.y)) / 255.0;
}`;

const RASTER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D sourceTexture;
uniform sampler2D shiftsTexture;
uniform int clipLeft;
uniform int clipTop;
uniform int clipWidth;
uniform int clipHeight;
out vec4 colour;
int shiftAt(int row) {
  uvec4 b = uvec4(round(texelFetch(shiftsTexture, ivec2(0, row), 0) * 255.0));
  uint v = b.r | (b.g << 8u) | (b.b << 16u) | (b.a << 24u);
  return int(v);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int row = p.y - clipTop;
  if (row < 0 || row >= clipHeight) discard;
  int shift = shiftAt(row);
  int sx = p.x - shift;
  if (p.x < clipLeft || p.x >= clipLeft + clipWidth || sx < clipLeft || sx >= clipLeft + clipWidth) discard;
  colour = texelFetch(sourceTexture, ivec2(sx, p.y), 0);
}`;

const programs = new WeakMap();
const locations = new WeakMap();
function getPrograms(gpu) {
  let result = programs.get(gpu);
  if (!result) {
    result = { area: gpu.compile(VERTEX, AREA), raster: gpu.compile(VERTEX, RASTER) };
    programs.set(gpu, result);
  }
  return result;
}

function uniforms(gl, program, values) {
  let cache = locations.get(program);
  if (!cache) { cache = new Map(); locations.set(program, cache); }
  for (const [name, setter, ...args] of values) {
    if (!cache.has(name)) cache.set(name, gl.getUniformLocation(program, name));
    gl[setter](cache.get(name), ...args);
  }
}

export function shrinkArea(sourceImage, targetImage, options) {
  // The destination may share storage after Assign; the copy reads its old
  // pixels in the self-copy case, so preserve them.
  targetImage.detach(true);
  const gpu = getGPU(), gl = gpu.gl, target = gpu.texture(targetImage);
  const source = options.sourceEntry ?? gpu.texture(sourceImage);
  const { area } = getPrograms(gpu);
  const readSource = !options.sourceEntry && sourceImage === targetImage
    ? gpu.snapshot(target, { left: 0, top: 0, right: target.width, bottom: target.height }) : source;
  const { clip, sourceOrigin = [0, 0], sourceExtent = [source.width, source.height],
    destinationOrigin = [0, 0], outputOrigin = destinationOrigin, outputSize = [target.width, target.height],
    ratio, destinationOffset = [0, 0], fast = false } = options;
  try {
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(area);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, readSource.texture);
    uniforms(gl, area, [
      ['sourceTexture', 'uniform1i', 0], ['sourceSize', 'uniform2i', source.width, source.height],
      ['destinationOrigin', 'uniform2i', ...destinationOrigin], ['outputOrigin', 'uniform2i', ...outputOrigin],
      ['outputSize', 'uniform2i', ...outputSize], ['sourceOrigin', 'uniform2i', ...sourceOrigin],
      ['sourceExtent', 'uniform2i', ...sourceExtent], ['ratio', 'uniform2f', ...ratio],
      ['destinationOffset', 'uniform2f', ...destinationOffset], ['fastMode', 'uniform1i', Number(fast)],
    ]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gpu.stats.draws++;
    gpu.commit(targetImage, target);
  } finally {
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(gpu.program);
  }
}

export function rasterCopy(sourceImage, targetImage, shifts, clip) {
  targetImage.detach(true);
  const gpu = getGPU(), gl = gpu.gl, source = gpu.texture(sourceImage), target = gpu.texture(targetImage);
  const state = getPrograms(gpu), { raster } = state;
  const readSource = sourceImage === targetImage
    ? gpu.snapshot(target, { left: 0, top: 0, right: target.width, bottom: target.height }) : source;
  if (state.shiftsImage && state.shiftsImage.height !== shifts.length) {
    gl.deleteFramebuffer(state.shiftsImage.framebuffer); gl.deleteTexture(state.shiftsImage.texture);
    state.shiftsImage = null;
  }
  const shiftsImage = state.shiftsImage ??= gpu.create(1, shifts.length);
  const bytes = new Uint8Array(shifts.length * 4);
  shifts.forEach((shift, i) => {
    const value = shift >>> 0, offset = i * 4;
    bytes[offset] = value & 255; bytes[offset + 1] = value >>> 8 & 255;
    bytes[offset + 2] = value >>> 16 & 255; bytes[offset + 3] = value >>> 24;
  });
  try {
    gl.bindTexture(gl.TEXTURE_2D, shiftsImage.texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1, shifts.length, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    gpu.stats.uploads++; gpu.stats.uploadedBytes += bytes.byteLength;
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(raster);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, readSource.texture);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, shiftsImage.texture);
    uniforms(gl, raster, [['sourceTexture', 'uniform1i', 0], ['shiftsTexture', 'uniform1i', 1],
      ['clipLeft', 'uniform1i', clip.left], ['clipTop', 'uniform1i', clip.top],
      ['clipWidth', 'uniform1i', clip.right - clip.left], ['clipHeight', 'uniform1i', shifts.length]]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gpu.stats.draws++;
    gpu.commit(targetImage, target);
  } finally {
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(gpu.program);
  }
}

export function captureImageTexture(image) {
  const gpu = getGPU(), gl = gpu.gl, source = gpu.texture(image);
  const copy = gpu.create(source.width, source.height);
  gl.disable(gl.SCISSOR_TEST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, copy.framebuffer);
  gl.blitFramebuffer(0, 0, source.width, source.height, 0, 0, source.width, source.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  return copy;
}

export function releaseImageTexture(entry) {
  const gl = getGPU().gl;
  gl.deleteFramebuffer(entry.framebuffer);
  gl.deleteTexture(entry.texture);
}
