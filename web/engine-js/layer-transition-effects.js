// TransIntf.cpp's three default providers and tvpgl.cpp's software blends.
import { Image, tileImage } from './bitmap.js';
import { getGPU, QUAD_VERTEX } from './gpu.js';
import { number } from '#krkr/values';

// TVPConstAlphaBlend_SD / TVPUnivTransBlend. Only the crossfade and universal
// providers draw through this program, so it lives with them instead of in the
// shared device.
const TRANSITION_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D sourceTexture;
uniform sampler2D secondTexture;
uniform sampler2D ruleTexture;
uniform sampler2D tableTexture;
uniform int operation;
uniform int phase;
uniform int vague;
uniform int layerType;
in vec2 sourcePoint;
out vec4 colour;

uint packARGB(vec4 c) {
  uvec4 b = uvec4(round(clamp(c, 0.0, 1.0) * 255.0));
  return (b.a << 24u) | (b.r << 16u) | (b.g << 8u) | b.b;
}
vec4 unpackARGB(uint c) {
  return vec4(float((c >> 16u) & 255u), float((c >> 8u) & 255u), float(c & 255u), float(c >> 24u)) / 255.0;
}
uint opacityOnOpacity(uint srcAlpha, uint destAlpha) {
  return uint(round(texelFetch(tableTexture, ivec2(int(destAlpha), int(srcAlpha)), 0).r * 255.0));
}
uint negativeMul(uint srcAlpha, uint destAlpha) { return 255u - ((255u - destAlpha) * (255u - srcAlpha)) / 255u; }
uint blendARGB(uint b, uint a, uint ratio) {
  uint b2 = b & 0x00ff00ffu;
  uint t = (b2 + (((a & 0x00ff00ffu) - b2) * ratio >> 8u)) & 0x00ff00ffu;
  b2 = (b & 0xff00ff00u) >> 8u;
  return t + (((b2 + ((((a & 0xff00ff00u) >> 8u) - b2) * ratio >> 8u)) << 8u) & 0xff00ff00u);
}

// TVPConstAlphaBlend_SD* used by layer cross fading.
uint crossfadePlain(uint a, uint b, uint p) {
  return ((((a & 0x00ff00ffu) + (((b & 0x00ff00ffu) - (a & 0x00ff00ffu)) * p >> 8u)) & 0x00ff00ffu))
    | ((((a & 0x0000ff00u) + (((b & 0x0000ff00u) - (a & 0x0000ff00u)) * p >> 8u)) & 0x0000ff00u));
}
uint crossfadeAdditive(uint a, uint b, uint p) { return blendARGB(a, b, p); }
uint crossfadeDestAlpha(uint a, uint b, uint p) {
  uint o = p > 127u ? p + 1u : p;
  uint iopa = 256u - o;
  uint a1 = a >> 24u;
  uint a2 = b >> 24u;
  uint alpha = opacityOnOpacity((a2 * o & 0xff00u) >> 8u, (a1 * iopa >> 8u) & 255u);
  uint r = ((((a & 0x00ff00ffu) + (((b & 0x00ff00ffu) - (a & 0x00ff00ffu)) * alpha >> 8u)) & 0x00ff00ffu))
    | ((((a & 0x0000ff00u) + (((b & 0x0000ff00u) - (a & 0x0000ff00u)) * alpha >> 8u)) & 0x0000ff00u));
  r |= (a1 + ((a2 - a1) * o >> 8u)) << 24u;
  return r;
}
// TVPUnivTransBlend_d / TVPUnivTransBlend_switch_d: the universal transition
// keeps destination alpha through TVPNegativeMulTable and does not adjust the
// transition table value before deriving the inverse weight.
uint universalDestAlpha(uint a, uint b, uint p, bool switching) {
  uint a1 = a >> 24u;
  uint a2 = b >> 24u;
  uint srcAlpha = (a2 * p & 0xff00u) >> 8u;
  uint destAlpha = (a1 * (256u - p) >> 8u) & 255u;
  uint alpha = opacityOnOpacity(srcAlpha, destAlpha);
  uint r = (((a & 0x00ff00ffu) + (((b & 0x00ff00ffu) - (a & 0x00ff00ffu)) * alpha >> 8u)) & 0x00ff00ffu)
    | (((a & 0x0000ff00u) + (((b & 0x0000ff00u) - (a & 0x0000ff00u)) * alpha >> 8u)) & 0x0000ff00u);
  // The switched and unswitched reference entry points compose alpha differently.
  return switching ? r + (negativeMul(srcAlpha, destAlpha) << 24u) : r | ((a1 + ((a2 - a1) * p >> 8u)) << 24u);
}

void main() {
  ivec2 point = ivec2(gl_FragCoord.xy);
  uint s = packARGB(texelFetch(sourceTexture, point, 0));
  uint bridge = packARGB(texelFetch(secondTexture, point, 0));
  uint p = uint(phase);
  if (operation == 8) {
    int value = int(round(texelFetch(ruleTexture, point, 0).r * 255.0));
    int low = phase - vague;
    if (vague < 512 && (value >= phase || value < low)) {
      colour = unpackARGB(value >= phase ? s : bridge);
      return;
    }
    p = uint(value < low ? 255 : (value >= phase ? 0 : 255 - (value - low) * 255 / vague));
  }
  if (layerType == 12) colour = unpackARGB(crossfadeAdditive(s, bridge, p));
  else if (layerType == 2 || layerType >= 13) colour = unpackARGB(operation == 8 ? universalDestAlpha(s, bridge, p, vague < 512) : crossfadeDestAlpha(s, bridge, p));
  else colour = unpackARGB(crossfadePlain(s, bridge, p));
}`;

const programs = new WeakMap();
function transitionProgram(gpu) {
  let program = programs.get(gpu);
  if (!program) {
    program = gpu.compile(QUAD_VERTEX, TRANSITION_FRAGMENT);
    programs.set(gpu, program);
    gpu.onDispose(() => { gpu.gl.deleteProgram(program); programs.delete(gpu); });
  }
  return program;
}

// TVPConstAlphaBlend_SD and TVPUnivTransBlend: dst = mix(src1, src2) with the
// layer type deciding alpha handling. The rule texture only participates in the
// universal transition.
export function renderTransition(gpu, frame, src1, src2, phase, type, rule = null, vague = 0) {
  const source = gpu.texture(src1);
  const second = gpu.texture(src2);
  const ruleSource = rule ? gpu.texture(rule) : null;
  // The effect overwrites the whole frame, which may share its pixels with a
  // transition source after Assign; no old frame content is needed.
  frame.detach(false);
  const target = gpu.texture(frame, true);
  const full = { left: 0, top: 0, right: frame.width, bottom: frame.height };
  try {
    gpu.setup(target, source, full, [1, 0, 0, 1, 0, 0], gpu.clip(frame), second, transitionProgram(gpu));
    if (ruleSource) gpu.bind(ruleSource, 3, 'ruleTexture');
    gpu.uniform('operation', 'uniform1i', rule ? 8 : 3);
    gpu.uniform('phase', 'uniform1i', phase);
    gpu.uniform('layerType', 'uniform1i', type);
    gpu.uniform('vague', 'uniform1i', vague);
    gpu.gl.drawArrays(gpu.gl.TRIANGLES, 0, 6);
    gpu.stats.draws++;
    gpu.commit(frame, target);
  } finally {
    gpu.gl.useProgram(gpu.program);
  }
}

const providers = new Map();

export function registerTransition(name, provider) {
  if (providers.has(name)) throw new Error(`TJS transition handler already registered: ${name}`);
  providers.set(name, provider);
}

export function unregisterTransition(name) {
  providers.delete(name);
}

export function findTransition(name) {
  return providers.get(name);
}

// TVPConstAlphaBlend_SD[_a/_d] and TVPUnivTransBlend[_a/_d].
export function blendTransitionPixel(dest, index, a, ai, b, bi, opacity, type, adjust = true) {
  let mix = opacity;
  if (type === 2 || type >= 13 && type <= 28) {
    if (adjust && opacity > 127) opacity++;
    const sourceAlpha = b[bi + 3] * opacity >> 8;
    const destinationAlpha = a[ai + 3] * (256 - opacity) >> 8;
    if (destinationAlpha) {
      const at = destinationAlpha / 255, bt = sourceAlpha / 255;
      const ratio = bt / at;
      mix = Math.min(255, Math.trunc(ratio / (1 - bt + ratio) * 255));
    } else mix = 255;
  }
  for (let c = 0; c < 3; c++) dest[index + c] = a[ai + c] + ((b[bi + c] - a[ai + c]) * mix >> 8);
  dest[index + 3] = type === 2 || type === 12 || type >= 13 && type <= 28
    ? a[ai + 3] + ((b[bi + 3] - a[ai + 3]) * opacity >> 8) : 0;
}

registerTransition('crossfade', async ({ type }) => ({
  maxPhase: 255,
  render(frame, src1, src2, phase) {
    renderTransition(getGPU(), frame, src1, src2, phase, type);
  },
}));

registerTransition('universal', async ({ option, required, loadGraphic, width, height, type }) => {
  const vague = Math.trunc(number(await option('vague', 64)));
  const ruleName = String(await required('rule'));
  const { image } = await loadGraphic(ruleName, 0x02ffffff, { gray: true });
  // GraphicsLoaderIntf.cpp expands undersized requested images by tiling.
  const rule = tileImage(image, width, height);
  return {
    maxPhase: 255 + vague,
    render(frame, src1, src2, phase) {
      renderTransition(getGPU(), frame, src1, src2, phase, type, rule, vague);
    },
  };
});

registerTransition('scroll', async ({ option, width, height }) => {
  const from = Math.trunc(number(await option('from', 0))), stay = Math.trunc(number(await option('stay', 0)));
  return {
    maxPhase: from === 0 || from === 2 ? width : height,
    render(frame, src1, src2, phase) {
      let x1 = 0, y1 = 0, x2 = 0, y2 = 0;
      switch (from) {
        case 0: if (stay === 0 || stay === 2) x1 = phase; if (stay === 0 || stay === 1) x2 = phase - width; break;
        case 1: if (stay === 0 || stay === 2) y1 = phase; if (stay === 0 || stay === 1) y2 = phase - height; break;
        case 2: if (stay === 0 || stay === 2) x1 = -phase; if (stay === 0 || stay === 1) x2 = width - phase; break;
        case 3: if (stay === 0 || stay === 2) y1 = -phase; if (stay === 0 || stay === 1) y2 = height - phase; break;
      }
      const copy = (image, x, y) => frame.copyRect(x, y, image, { left: 0, top: 0, right: width, bottom: height });
      if (stay === 2) { copy(src2, x2, y2); copy(src1, x1, y1); }
      else { copy(src1, x1, y1); copy(src2, x2, y2); }
    },
  };
});
