import { getGPU } from '../gpu.js';

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D imageTexture;
uniform sampler2D sourceTexture;
uniform sampler2D provinceTexture;
uniform ivec2 imageSize;
uniform ivec4 clipRect;
uniform ivec4 areaRect;
uniform ivec2 sourceOrigin;
uniform int operation;
uniform int additive;
uniform int clearOutside;
uniform int clearValue;
uniform int wantedProvince;
uniform int sourceIsDestination;
uniform int wantedColor;
uniform int alphaLimit;
uniform int matchAll;
uniform int provinceValue;
uniform ivec4 colorValue;
out vec4 outputColor;
ivec2 sourcePoint(ivec2 p) { return p - areaRect.xy + sourceOrigin; }
uint mulByte(uint a, uint b) { uint n = a * b; return (n + (n >> 7u)) >> 8u; }
int arithmeticShift8(int value) { return value >= 0 ? value / 256 : -((-value + 255) / 256); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 dst = texelFetch(imageTexture, p, 0);
  ivec2 q = sourcePoint(p);
  if (operation == 0) { // right half blue to left alpha
    if (p.x < imageSize.x / 2) dst.a = texelFetch(imageTexture, p + ivec2(imageSize.x / 2, 0), 0).b;
  } else if (operation == 1) { // bottom half blue to top alpha
    if (p.y < imageSize.y / 2) dst.a = texelFetch(imageTexture, p + ivec2(0, imageSize.y / 2), 0).b;
  } else if (operation == 2) {
    if (p.x >= clipRect.x && p.y >= clipRect.y && p.x < clipRect.z && p.y < clipRect.w) dst.a = 1.0;
  } else if (operation == 3) { // clip alpha by mask; clear outside when requested
    bool inside = p.x >= areaRect.x && p.y >= areaRect.y && p.x < areaRect.z && p.y < areaRect.w;
    if (inside) {
      uint m = uint(round(texelFetch(sourceTexture, q, 0).a * 255.0));
      uvec4 d = uvec4(round(dst * 255.0));
      if (additive != 0) d = uvec4(mulByte(d.r,m),mulByte(d.g,m),mulByte(d.b,m),mulByte(d.a,m));
      else d.a = mulByte(d.a,m);
      dst = vec4(d) / 255.0;
    } else if (clearOutside != 0) {
      uint c = uint(clearValue);
      uvec4 d = uvec4(round(dst * 255.0));
      if (additive != 0) d = uvec4(mulByte(d.r,c),mulByte(d.g,c),mulByte(d.b,c),mulByte(d.a,c));
      else d.a = c;
      dst = vec4(d) / 255.0;
    }
  } else if (operation == 4) { // thresholded pixel copy
    if (sourceIsDestination != 0) {
      ivec2 delta = sourceOrigin - areaRect.xy;
      if (delta.y < 0 || (delta.y == 0 && delta.x < 0)) {
        ivec2 originalQ = q;
        ivec2 cursor = q;
        int steps = 0;
        for (int i = 0; i < imageSize.x + imageSize.y; i++) {
          if (cursor.x < areaRect.x || cursor.y < areaRect.y || cursor.x >= areaRect.z || cursor.y >= areaRect.w) break;
          cursor += delta;
          steps++;
        }
        // The reference walks destination pixels forward. For an overlapping
        // self-copy, each source can therefore contain an earlier copy. Since
        // copies preserve alpha, unwind the dependency chain by selecting the
        // first original pixel that passes the threshold.
        bool found = texelFetch(sourceTexture, cursor, 0).a >= float(clearValue) / 255.0;
        if (found) q = cursor;
        for (int i = 0; i < imageSize.x + imageSize.y && !found; i++) {
          if (i >= steps) break;
          ivec2 candidate = cursor - delta * (i + 1);
          vec4 prior = texelFetch(sourceTexture, candidate, 0);
          if (prior.a >= float(clearValue) / 255.0) { q = candidate; found = true; }
        }
        if (!found) q = originalQ;
      }
    }
    vec4 src = texelFetch(sourceTexture, q, 0);
    if (src.a >= float(clearValue) / 255.0) dst = src;
  } else if (operation == 5) { // fill by province
    uint idx = uint(round(texelFetch(provinceTexture, p, 0).r * 255.0));
    if (idx == uint(wantedProvince)) dst = vec4(colorValue) / 255.0;
  } else if (operation == 6) { // copy alpha into an R8 province target
    uint value = uint(round(texelFetch(sourceTexture, p, 0).a * 255.0));
    uint old = uint(round(texelFetch(imageTexture, p, 0).r * 255.0));
    if (clearValue == 0) outputColor = vec4(float(value) / 255.0, 0.0, 0.0, 1.0);
    else if (clearValue == 1) outputColor = vec4(float(value >= uint(areaRect.x) ? uint(areaRect.y) : uint(areaRect.z)) / 255.0, 0.0, 0.0, 1.0);
    else if (clearValue == 2) outputColor = vec4(float(uint(areaRect.z)) / 255.0, 0.0, 0.0, 1.0);
    else if (clearValue == 3) outputColor = vec4(float(value >= uint(areaRect.x) ? uint(areaRect.y) : old) / 255.0, 0.0, 0.0, 1.0);
    else outputColor = vec4(float(value < uint(areaRect.x) ? uint(areaRect.z) : old) / 255.0, 0.0, 0.0, 1.0);
    return;
  } else if (operation == 7) { // fill province where color and alpha match
    vec4 src = texelFetch(sourceTexture, p, 0);
    uvec4 b = uvec4(round(src * 255.0));
    uint rgb = (b.r << 16u) | (b.g << 8u) | b.b;
    if ((matchAll != 0 || rgb == uint(wantedColor)) && int(b.a) >= alphaLimit)
      dst = vec4(float(provinceValue) / 255.0, 0.0, 0.0, 1.0);
  } else if (operation == 8) { // per-row min/max summary, each value is 16-bit little-endian
    int y = clipRect.y + p.y;
    int minX = 65535, maxX = 65535;
    for (int x = clipRect.x; x < clipRect.z; x++) {
      vec4 src = texelFetch(sourceTexture, ivec2(x, y), 0);
      uvec4 b = uvec4(round(src * 255.0));
      uint rgb = (b.r << 16u) | (b.g << 8u) | b.b;
      if ((matchAll != 0 || rgb == uint(wantedColor)) && int(b.a) >= alphaLimit) {
        int localX = x - clipRect.x;
        minX = min(minX, localX);
        maxX = maxX == 65535 ? localX : max(maxX, localX);
      }
    }
    if (maxX == 65535) outputColor = vec4(255.0);
    else outputColor = vec4(float(minX & 255), float((minX >> 8) & 255),
      float(maxX & 255), float((maxX >> 8) & 255)) / 255.0;
    return;
  } else if (operation == 9) { // assign alpha from a gray mask
    dst.a = texelFetch(sourceTexture, p, 0).r;
  } else if (operation == 10) { // alphaColorMat, preserving signed arithmetic shift
    uvec4 b = uvec4(round(dst * 255.0));
    int a = int(b.a);
    int r = (wantedColor >> 16) & 255;
    int g = (wantedColor >> 8) & 255;
    int bl = wantedColor & 255;
    int rr = r + arithmeticShift8((int(b.r) - r) * a);
    int gg = g + arithmeticShift8((int(b.g) - g) * a);
    int bb = bl + arithmeticShift8((int(b.b) - bl) * a);
    dst = vec4(vec3(clamp(rr, 0, 255), clamp(gg, 0, 255), clamp(bb, 0, 255)), 255.0) / 255.0;
  }
  outputColor = dst;
}`;

const programs = new WeakMap();
const programFor = gpu => {
  let state = programs.get(gpu);
  if (!state) {
    state = { program: gpu.compile(VERTEX, FRAGMENT), locations: new Map() };
    programs.set(gpu, state);
  }
  return state;
};
const uniform = (gpu, state, name, method, ...values) => {
  const gl = gpu.gl;
  let location = state.locations.get(name);
  if (location === undefined) {
    location = gl.getUniformLocation(state.program, name);
    state.locations.set(name, location);
  }
  gl[method](location, ...values);
};

function run(image, operation, { clip = [0, 0, image.width, image.height], area = clip,
  source = image, province = image, sourceOrigin = [0, 0], additive = false,
  clearOutside = false, clearValue = 0, wantedProvince = 0, color = [0, 0, 0, 0],
  wantedColor = 0, alphaLimit = 0, matchAll = false, provinceValue = 0 } = {}) {
  if (!image.width || !image.height) return;
  const gpu = getGPU();
  const gl = gpu.gl;
  const state = programFor(gpu);
  // Writes are clipped, so a shared destination keeps and copies its pixels.
  image.detach(true);
  const target = gpu.texture(image);
  const previous = gpu.snapshot(target, { left: 0, top: 0, right: image.width, bottom: image.height });
  const sourceEntry = source === image ? previous : gpu.texture(source);
  const provinceEntry = province === image ? previous : gpu.texture(province);
  gl.useProgram(state.program);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.viewport(0, 0, image.width, image.height);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(clip[0], clip[1], clip[2] - clip[0], clip[3] - clip[1]);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, previous.texture);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, sourceEntry.texture);
  gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, provinceEntry.texture);
  uniform(gpu, state, 'imageTexture', 'uniform1i', 0);
  uniform(gpu, state, 'sourceTexture', 'uniform1i', 1);
  uniform(gpu, state, 'provinceTexture', 'uniform1i', 2);
  uniform(gpu, state, 'imageSize', 'uniform2i', image.width, image.height);
  uniform(gpu, state, 'clipRect', 'uniform4i', ...clip);
  uniform(gpu, state, 'areaRect', 'uniform4i', ...area);
  uniform(gpu, state, 'sourceOrigin', 'uniform2i', ...sourceOrigin);
  uniform(gpu, state, 'operation', 'uniform1i', operation);
  uniform(gpu, state, 'additive', 'uniform1i', Number(additive));
  uniform(gpu, state, 'clearOutside', 'uniform1i', Number(clearOutside));
  uniform(gpu, state, 'clearValue', 'uniform1i', clearValue);
  uniform(gpu, state, 'wantedProvince', 'uniform1i', wantedProvince);
  uniform(gpu, state, 'sourceIsDestination', 'uniform1i', Number(source === image));
  uniform(gpu, state, 'wantedColor', 'uniform1i', wantedColor);
  uniform(gpu, state, 'alphaLimit', 'uniform1i', alphaLimit);
  uniform(gpu, state, 'matchAll', 'uniform1i', Number(matchAll));
  uniform(gpu, state, 'provinceValue', 'uniform1i', provinceValue);
  uniform(gpu, state, 'colorValue', 'uniform4i', ...color);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gpu.stats.draws++;
  gpu.commit(image, target);
  gl.useProgram(gpu.program);
}

function fillToProvince(image, province, clip, wantedColor, provinceValue, alphaLimit, matchAll) {
  const width = clip[2] - clip[0], height = clip[3] - clip[1];
  if (!width || !height) return undefined;
  run(province, 7, { clip, source: image, wantedColor, provinceValue, alphaLimit, matchAll });

  const gpu = getGPU(), gl = gpu.gl, state = programFor(gpu);
  const source = gpu.texture(image);
  const summary = gpu.create(1, height);
  try {
    gl.useProgram(state.program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, summary.framebuffer);
    gl.viewport(0, 0, 1, height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(0, 0, 1, height);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, source.texture);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, source.texture);
    uniform(gpu, state, 'imageTexture', 'uniform1i', 0);
    uniform(gpu, state, 'sourceTexture', 'uniform1i', 1);
    uniform(gpu, state, 'provinceTexture', 'uniform1i', 2);
    uniform(gpu, state, 'imageSize', 'uniform2i', image.width, image.height);
    uniform(gpu, state, 'clipRect', 'uniform4i', ...clip);
    uniform(gpu, state, 'areaRect', 'uniform4i', 0, 0, 0, 0);
    uniform(gpu, state, 'sourceOrigin', 'uniform2i', 0, 0);
    uniform(gpu, state, 'operation', 'uniform1i', 8);
    uniform(gpu, state, 'additive', 'uniform1i', 0);
    uniform(gpu, state, 'clearOutside', 'uniform1i', 0);
    uniform(gpu, state, 'clearValue', 'uniform1i', 0);
    uniform(gpu, state, 'wantedProvince', 'uniform1i', 0);
    uniform(gpu, state, 'sourceIsDestination', 'uniform1i', 0);
    uniform(gpu, state, 'wantedColor', 'uniform1i', wantedColor);
    uniform(gpu, state, 'alphaLimit', 'uniform1i', alphaLimit);
    uniform(gpu, state, 'matchAll', 'uniform1i', Number(matchAll));
    uniform(gpu, state, 'provinceValue', 'uniform1i', provinceValue);
    uniform(gpu, state, 'colorValue', 'uniform4i', 0, 0, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gpu.stats.draws++;

    const rows = gpu.read(summary);
    let minX = 65535, minY = -1, maxX = -1, maxY = -1;
    for (let y = 0; y < height; y++) {
      const offset = y * 4;
      const rowMin = rows[offset] | (rows[offset + 1] << 8);
      const rowMax = rows[offset + 2] | (rows[offset + 3] << 8);
      if (rowMin === 65535) continue;
      minX = Math.min(minX, rowMin);
      maxX = Math.max(maxX, rowMax);
      if (minY < 0) minY = y;
      maxY = y;
    }
    if (minY < 0) return undefined;
    return [clip[0] + minX, clip[1] + minY, maxX - minX + 1, maxY - minY + 1];
  } finally {
    gl.deleteFramebuffer(summary.framebuffer);
    gl.deleteTexture(summary.texture);
    gl.useProgram(gpu.program);
  }
}

export const gpuBtoa = Object.freeze({
  copyRightBlueToLeftAlpha: image => run(image, 0, { clip: [0, 0, image.width >> 1, image.height] }),
  copyBottomBlueToTopAlpha: image => run(image, 1, { clip: [0, 0, image.width, image.height >> 1] }),
  fillAlpha: (image, clip) => run(image, 2, { clip }),
  clipAlphaRect: (image, source, clip, area, sourceOrigin, options) => run(image, 3, { source, clip, area, sourceOrigin, ...options }),
  overwrapRect: (image, source, clip, area, sourceOrigin, threshold) => run(image, 4, { source, clip, area, sourceOrigin, clearValue: threshold }),
  fillByProvince: (image, province, clip, wantedProvince, color) => run(image, 5, { province, clip, wantedProvince, color }),
  copyAlphaToProvince: (image, province, clip, threshold, matched, otherwise, mode) => run(province, 6, {
    source: image, clip, area: [threshold, matched, otherwise, 0], clearValue: mode,
  }),
  fillToProvince,
  assignAlpha: (image, grayMask) => run(image, 9, { source: grayMask }),
  alphaColorMat: (image, rgb) => run(image, 10, { wantedColor: rgb }),
});
