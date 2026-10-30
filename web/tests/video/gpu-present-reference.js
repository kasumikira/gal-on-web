// Browser video and GPU comparison pages present an already composed image.
import { QUAD_VERTEX } from './gpu-reference.js';
const PRESENT_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D sourceTexture;
uniform vec2 sourceSize;
in vec2 sourcePoint;
out vec4 colour;
uint packARGB(vec4 c) {
  uvec4 b = uvec4(round(clamp(c, 0.0, 1.0) * 255.0));
  return (b.a << 24u) | (b.r << 16u) | (b.g << 8u) | b.b;
}
uint sampleTexel(int x, int y) {
  ivec2 size = ivec2(sourceSize);
  return packARGB(texelFetch(sourceTexture, clamp(ivec2(x, y), ivec2(0), size - 1), 0));
}
void main() {
  // Default framebuffer origin is bottom-left: TVPAlphaColorMat on black.
  uint flipped = sampleTexel(int(floor(sourcePoint.x)), int(sourceSize.y) - 1 - int(floor(sourcePoint.y)));
  float sa = float(flipped >> 24u);
  vec3 premultiplied = vec3(
    float((flipped >> 16u) & 255u) * sa / 256.0,
    float((flipped >> 8u) & 255u) * sa / 256.0,
    float(flipped & 255u) * sa / 256.0);
  colour = vec4(floor(premultiplied) / 255.0, 1.0);
}`;

const presentPrograms = new WeakMap();
const presenters = new WeakMap();
function presentProgram(gpu) {
  let program = presentPrograms.get(gpu);
  if (!program) {
    program = gpu.compile(QUAD_VERTEX, PRESENT_FRAGMENT);
    presentPrograms.set(gpu, program);
    gpu.onDispose(() => { gpu.gl.deleteProgram(program); presentPrograms.delete(gpu); });
  }
  return program;
}
export function present(gpu, image, canvas) {
  const source = gpu.texture(image);
  const gl = gpu.gl;
  if (gpu.canvas.width !== image.width) gpu.canvas.width = image.width;
  if (gpu.canvas.height !== image.height) gpu.canvas.height = image.height;
  const full = { left: 0, top: 0, right: image.width, bottom: image.height };
  gpu.setup({ framebuffer: null, width: image.width, height: image.height },
      source, full, [1, 0, 0, 1, 0, 0], gpu.clip(image), source, presentProgram(gpu));
  gl.drawArrays(gl.TRIANGLES, 0, 6);
  let context = presenters.get(canvas);
  if (!context) {
    context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('GPU presentation requires CanvasRenderingContext2D');
    presenters.set(canvas, context);
  }
  // Copy the rendered canvas directly. Safari's transferToImageBitmap path
  // can block for an entire frame while exporting the WebGL drawing buffer.
  context.drawImage(gpu.canvas, 0, 0);
}

