import { mat2d } from 'gl-matrix';
import { Image } from './bitmap.js';

// Public images use straight RGBA8, including RGB underneath zero alpha.
// Offscreen composition privately accumulates premultiplied RGBA16F.
let device = null;
export const getGPU = () => device;
const PREPARE_UPLOAD_BYTES = 4 * 1024 * 1024;
const PREPARE_UPLOAD_MS = 4;
export function initializeGPU(document, textBlendShader) {
  if (device) throw new Error('GPU renderer is already initialized');
  try {
    device = new GPUDevice(document, textBlendShader);
  } catch (error) {
    document.defaultView.alert(`WebGL 2 初始化失败，无法启动游戏。\n${error.message}`);
    throw error;
  }
  return device;
}

// The quad used by every program the device owns or that a feature module
// compiles through GPUDevice.compile. Modules draw six vertices with it.
export const QUAD_VERTEX = `#version 300 es
precision highp float;
uniform vec2 targetSize;
uniform vec4 sourceRect;
uniform mat3 transform;
out vec2 sourcePoint;
void main() {
  vec2 corners[6] = vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
  sourcePoint = mix(sourceRect.xy, sourceRect.zw, corners[gl_VertexID]);
  vec2 point = (transform * vec3(sourcePoint,1)).xy;
  gl_Position = vec4(point / targetSize * 2.0 - 1.0, 0, 1);
}`;

// Shared blend program for layer, motion, window composition and text draws.
// Feature-only programs (transitions, presentation, whole-image pixel passes)
// are compiled by the modules that own them.
// Blending is a word-for-word port of the reference C implementation
// (third_party/kirikiroid2 .../visual/gl/blend_functor_c.h and the native
// blend slots installed by TVPInitTVPGL). Packed pixels are 0xAARRGGBB in a
// uint so that every masking, borrow and 32 bit truncation reproduces the
// original byte results, including the engine's own oddities.
const fragmentSource = textBlendShader => `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D sourceTexture;
uniform sampler2D destinationTexture;
uniform sampler2D tableTexture;
uniform vec2 sourceSize;
uniform mat3 inverseTransform;
uniform vec4 sampleRect;
uniform vec4 sampleBounds;
#ifdef LAYER_COMPOSITE
const int operation = 1;
const int mode = 0;
#else
uniform int operation;
uniform int mode;
#endif
uniform int policy;
uniform int opacity;
uniform int smoothSampling;
uniform bool opaque;
uniform bool explicitCoverage;
in vec2 sourcePoint;
out vec4 colour;

const uint POLICY_HOLD = 1u;
const uint POLICY_DEST_ALPHA = 2u;
const uint POLICY_ADDITIVE = 4u;
const uint POLICY_COPY_ALPHA = 8u;
const uint POLICY_IGNORE_ALPHA = 16u;

uint packARGB(vec4 c) {
  uvec4 b = uvec4(round(clamp(c, 0.0, 1.0) * 255.0));
  return (b.a << 24u) | (b.r << 16u) | (b.g << 8u) | b.b;
}
vec4 unpackARGB(uint c) {
  return vec4(float((c >> 16u) & 255u), float((c >> 8u) & 255u), float(c & 255u), float(c >> 24u)) / 255.0;
}
// Arithmetic shift of a signed 32 bit value by 31, as 0 or all ones.
uint signMask(uint v) { return 0u - ((v >> 31u) & 1u); }

uint satAdd(uint a, uint b) {
  uint tmp = ((a & b) + (((a ^ b) >> 1u) & 0x7f7f7f7fu)) & 0x80808080u;
  tmp = (tmp << 1u) - (tmp >> 7u);
  return (a + b - tmp) | tmp;
}
uint mulColor(uint color, uint fac) {
  return ((((color & 0x00ff00u) * fac) & 0x00ff0000u) + (((color & 0xff00ffu) * fac) & 0xff00ff00u)) >> 8u;
}
// translucent_nsa_op style source fade (premultiplied alpha path): all channels.
uint fadeAll(uint s, uint a) {
  return (((s & 0xff00ffu) * a >> 8u) & 0xff00ffu) + (((s >> 8u) & 0xff00ffu) * a & 0xff00ff00u);
}
// Colour fade toward zero; alpha is left untouched (add/sub/mul/dodge paths).
uint fadeColour(uint s, uint a) {
  return (((s & 0x00ff00u) * a >> 8u) & 0x00ff00u) + (((s & 0xff00ffu) * a >> 8u) & 0xff00ffu);
}
uint alphaToPremul(uint x) { return mulColor(x, x >> 24u) + (x & 0xff000000u); }

uint premulAA(uint d, uint s) {
  uint da = d >> 24u;
  uint sa = s >> 24u;
  da = da + sa - (da * sa >> 8u);
  da -= da >> 8u;
  sa ^= 0xffu;
  s &= 0x00ffffffu;
  return (da << 24u) + satAdd((((d & 0xff00ffu) * sa >> 8u) & 0xff00ffu) + (((d & 0xff00u) * sa >> 8u) & 0xff00u), s);
}
uint premulNA(uint d, uint s) {
  uint sopa = (~s) >> 24u;
  return satAdd((((d & 0xff00ffu) * sopa >> 8u) & 0xff00ffu) + (((d & 0xff00u) * sopa >> 8u) & 0xff00u), s);
}
uint premulHDA(uint d, uint s) { return (d & 0xff000000u) + (premulNA(d, s) & 0x00ffffffu); }
uint premulNAO(uint d, uint s, uint opa) { return premulNA(d, fadeAll(s, opa)); }
uint premulHDAO(uint d, uint s, uint opa) { return (d & 0xff000000u) + (premulNA(d, fadeAll(s, opa)) & 0x00ffffffu); }
uint premulAAO(uint d, uint s, uint opa) { return premulAA(d, fadeAll(s, opa)); }

// TVPOpacityOnOpacityTable / ps_soft_light_table share one lookup texture.
uint opacityOnOpacity(uint srcAlpha, uint destAlpha) {
  return uint(round(texelFetch(tableTexture, ivec2(int(destAlpha), int(srcAlpha)), 0).r * 255.0));
}
uint softLightTable(uint src, uint dest) {
  return uint(round(texelFetch(tableTexture, ivec2(int(dest), int(src) + 256), 0).r * 255.0));
}
uint negativeMul(uint srcAlpha, uint destAlpha) { return 255u - ((255u - destAlpha) * (255u - srcAlpha)) / 255u; }
uint recip256(uint x) { return x == 0u ? 65536u : 65536u / x; }

// alpha_blend_func: TVPAlphaBlend_o / TVPAlphaBlend_HDA_o style lane blend.
uint alphaBlendLanes(uint d, uint s, uint sopa) {
  uint d1 = d & 0xff00ffu;
  d1 = (d1 + (((s & 0xff00ffu) - d1) * sopa >> 8u)) & 0xff00ffu;
  uint dd = d & 0xff00u;
  uint ss = s & 0xff00u;
  return d1 + ((dd + ((ss - dd) * sopa >> 8u)) & 0xff00u);
}
uint alphaBlendO(uint d, uint s, uint opa) { return alphaBlendLanes(d, s, ((s >> 24u) * opa) >> 8u); }
uint alphaBlendHO(uint d, uint s, uint opa) { return (alphaBlendO(d, s, opa) & 0x00ffffffu) | (d & 0xff000000u); }
// The libkrkr2.so alpha blend slots (TVPAlphaBlend = TVPAlphaBlend_HDA).
uint blendByte55(uint dest, uint src, uint sopa) {
  uint diff = ((src * sopa) - (dest * sopa)) & 0xffffu;
  return (dest + (diff >> 8u)) & 0xffu;
}
uint alphaBlend55(uint d, uint s) {
  uint sopa = s >> 24u;
  uint b = blendByte55(d & 255u, s & 255u, sopa);
  uint g = blendByte55((d >> 8u) & 255u, (s >> 8u) & 255u, sopa);
  uint r = blendByte55((d >> 16u) & 255u, (s >> 16u) & 255u, sopa);
  return (d & 0xff000000u) | (r << 16u) | (g << 8u) | b;
}
uint alphaBlendD55(uint d, uint s) {
  uint alpha = opacityOnOpacity((s >> 24u), d >> 24u);
  return alphaBlendLanes(d, s, alpha) + (negativeMul((s >> 24u), d >> 24u) << 24u);
}
uint alphaBlendDO(uint d, uint s, uint opa) {
  uint srcAlpha = ((s >> 24u) * opa) >> 8u;
  uint alpha = opacityOnOpacity(srcAlpha, d >> 24u);
  return alphaBlendLanes(d, s, alpha) + (negativeMul(srcAlpha, d >> 24u) << 24u);
}
uint alphaBlendAO(uint d, uint s, uint opa) {
  uint t = (s & 0x00ffffffu) + ((((s >> 24u) * opa) >> 8u) << 24u);
  return premulAA(d, alphaToPremul(t));
}

uint constAlpha(uint d, uint s, uint opa) {
  uint d1 = d & 0xff00ffu;
  d1 = (d1 + (((s & 0xff00ffu) - d1) * opa >> 8u)) & 0xff00ffu;
  uint dd = d & 0xff00u;
  uint ss = s & 0xff00u;
  return d1 | ((dd + ((ss - dd) * opa >> 8u)) & 0xff00u);
}
uint constAlphaHDA(uint d, uint s, uint opa) { return (constAlpha(d, s, opa) & 0x00ffffffu) + (d & 0xff000000u); }
uint constAlphaD(uint d, uint s, uint opa) {
  uint destAlpha = d >> 24u;
  uint alpha = opacityOnOpacity(opa, destAlpha);
  uint d1 = d & 0xff00ffu;
  d1 = (d1 + (((s & 0xff00ffu) - d1) * alpha >> 8u)) & 0xff00ffu;
  d1 += negativeMul(opa, destAlpha) << 24u;
  uint dd = d & 0xff00u;
  uint ss = s & 0xff00u;
  return d1 | ((dd + ((ss - dd) * alpha >> 8u)) & 0xff00u);
}
uint constAlphaA(uint d, uint s, uint opa) { return premulAA(d, (s & 0x00ffffffu) | ((opa << 24u) & 0xff000000u)); }

uint addVariant(uint d, uint s, uint opa, bool hold) {
  uint r = satAdd(d, opa == 255u ? s : fadeColour(s, opa));
  return hold ? ((r & 0x00ffffffu) | (d & 0xff000000u)) : r;
}
uint subFunctor(uint d, uint s) {
  uint tmp = ((s & d) + (((s ^ d) >> 1u) & 0x7f7f7f7fu)) & 0x80808080u;
  tmp = (tmp << 1u) - (tmp >> 7u);
  return (s + d - tmp) & tmp;
}
uint subVariant(uint d, uint s, uint opa, bool hold) {
  uint r = subFunctor(d, opa == 255u ? s : ~fadeColour(~s, opa));
  return hold ? ((r & 0x00ffffffu) | (d & 0xff000000u)) : r;
}
uint mulFunctor(uint d, uint s) {
  uint tmp = ((d & 255u) * (s & 255u) & 0xff00u);
  tmp |= (((d & 0xff00u) >> 8u) * (s & 0xff00u) & 0xff0000u);
  tmp |= (((d & 0xff0000u) >> 16u) * (s & 0xff0000u) & 0xff000000u);
  return tmp >> 8u;
}
uint mulVariant(uint d, uint s, uint opa, bool hold) {
  uint r = mulFunctor(d, opa == 255u ? s : ~fadeColour(~s, opa));
  return hold ? ((r & 0x00ffffffu) | (d & 0xff000000u)) : r;
}
uint dodgeFunctor(uint d, uint s) {
  uint tmp2 = ~s;
  uint t0 = (d & 255u) * recip256(tmp2 & 255u) >> 8u;
  uint r0 = (t0 | signMask(~(t0 - 0x100u))) & 255u;
  uint t1 = ((d & 0xff00u) >> 8u) * recip256((tmp2 & 0xff00u) >> 8u);
  uint r1 = (t1 | signMask(~(t1 - 0x10000u))) & 0xff00u;
  uint t2 = ((d & 0xff0000u) >> 16u) * recip256((tmp2 & 0xff0000u) >> 16u);
  uint r2 = ((t2 | signMask(~(t2 - 0x10000u))) & 0xff00u) << 8u;
  return r0 | r1 | r2;
}
uint dodgeVariant(uint d, uint s, uint opa, bool hold) {
  uint r = dodgeFunctor(d, opa == 255u ? s : fadeColour(s, opa));
  return hold ? ((r & 0x00ffffffu) | (d & 0xff000000u)) : r;
}
uint darkenPlain(uint d, uint s) {
  uint m = ~s;
  uint tmp = ((m & d) + (((m ^ d) >> 1u) & 0x7f7f7f7fu)) & 0x80808080u;
  tmp = (tmp << 1u) - (tmp >> 7u);
  return d ^ ((d ^ s) & tmp);
}
uint lightenPlain(uint d, uint s) {
  uint m = ~d;
  uint tmp = ((s & m) + (((s ^ m) >> 1u) & 0x7f7f7f7fu)) & 0x80808080u;
  tmp = (tmp << 1u) - (tmp >> 7u);
  return d ^ ((d ^ s) & tmp);
}
uint darkenFaded(uint d, uint s, uint a) {
  uint m = ~s;
  uint tmp = ((m & d) + (((m ^ d) >> 1u) & 0x7f7f7f7fu)) & 0x80808080u;
  tmp = (tmp << 1u) - (tmp >> 7u);
  tmp = d ^ ((d ^ s) & tmp);
  uint d1 = d & 0xff00ffu;
  d1 = (d1 + (((tmp & 0xff00ffu) - d1) * a >> 8u)) & 0xff00ffu;
  uint dd = d & 0xff00u;
  return d1 + ((dd + (((tmp & 0xff00u) - dd) * a >> 8u)) & 0xff00u);
}
uint lightenFaded(uint d, uint s, uint a) {
  uint m = ~d;
  uint tmp = ((s & m) + (((s ^ m) >> 1u) & 0x7f7f7f7fu)) & 0x80808080u;
  tmp = (tmp << 1u) - (tmp >> 7u);
  tmp = d ^ ((d ^ s) & tmp);
  uint d1 = d & 0xff00ffu;
  d1 = (d1 + (((tmp & 0xff00ffu) - d1) * a >> 8u)) & 0xff00ffu;
  uint dd = d & 0xff00u;
  return d1 + ((dd + (((tmp & 0xff00u) - dd) * a >> 8u)) & 0xff00u);
}
uint darkenVariant(uint d, uint s, uint opa, bool hold) {
  uint r = opa == 255u ? darkenPlain(d, s) : darkenFaded(d, s, opa);
  return hold ? ((r & 0x00ffffffu) | (d & 0xff000000u)) : r;
}
uint lightenVariant(uint d, uint s, uint opa, bool hold) {
  uint r = opa == 255u ? lightenPlain(d, s) : lightenFaded(d, s, opa);
  return hold ? ((r & 0x00ffffffu) | (d & 0xff000000u)) : r;
}
uint screenPlain(uint d, uint s) { return ~mulFunctor(~d, ~s); }
uint screenVariant(uint d, uint s, uint opa, bool hold) {
  if (opa == 255u) {
    uint r = screenPlain(d, s);
    return hold ? ((r & 0x00ffffffu) | (d & 0xff000000u)) : r;
  }
  uint product = mulFunctor(~d, ~fadeColour(s, opa));
  return hold ? (~product ^ ((~d) & 0xff000000u)) : product;
}

// Photoshop compatible modes: ps_alpha_blend_func and friends.
uint psAlphaBlend(uint d, uint s, uint a) {
  return ((((((s & 0x00ff00ffu) - (d & 0x00ff00ffu)) * a) >> 8u) + (d & 0x00ff00ffu)) & 0x00ff00ffu)
    | ((((((s & 0x0000ff00u) - (d & 0x0000ff00u)) * a) >> 8u) + (d & 0x0000ff00u)) & 0x0000ff00u);
}
uint psAddFunctor(uint d, uint s, uint a) {
  uint n = (((d & s) << 1u) + ((d ^ s) & 0x00fefefeu)) & 0x01010100u;
  n = ((n >> 8u) + 0x007f7f7fu) ^ 0x007f7f7fu;
  return psAlphaBlend(d, (d + s - n) | n, a);
}
uint psSubFunctor(uint d, uint s, uint a) {
  s = ~s;
  uint n = ((((~d) & s) << 1u) + (((~d) ^ s) & 0x00fefefeu)) & 0x01010100u;
  n = ((n >> 8u) + 0x007f7f7fu) ^ 0x007f7f7fu;
  return psAlphaBlend(d, (d | n) - (s | n), a);
}
uint psMulFunctor(uint d, uint s, uint a) {
  s = (((((d >> 16u) & 255u) * (s & 0x00ff0000u)) & 0xff000000u)
    | ((((d >> 8u) & 255u) * (s & 0x0000ff00u)) & 0x00ff0000u)
    | ((d & 255u) * (s & 0x000000ffu))) >> 8u;
  return psAlphaBlend(d, s, a);
}
uint psScreenFunctor(uint d, uint s, uint a) {
  uint sd1 = (((((d >> 16u) & 255u) * (s & 0x00ff0000u)) & 0xff000000u) | ((d & 255u) * (s & 0x000000ffu))) >> 8u;
  uint sd2 = ((((d >> 8u) & 255u) * (s & 0x0000ff00u)) & 0x00ff0000u) >> 8u;
  return ((((((s & 0x00ff00ffu) - sd1) * a) >> 8u) + (d & 0x00ff00ffu)) & 0x00ff00ffu)
    | ((((((s & 0x0000ff00u) - sd2) * a) >> 8u) + (d & 0x0000ff00u)) & 0x0000ff00u);
}
uint psOverlayValue(uint s, uint d) {
  uint t = (s * d * 2u) / 255u;
  return d < 128u ? t : (s + d) * 2u - t - 255u;
}
uint psDodgeValue(uint s, uint d) {
  return (255u - s) <= d ? 255u : (d * 255u) / (255u - s);
}
uint psBurnValue(uint s, uint d) {
  return s <= (255u - d) ? 0u : 255u - ((255u - d) * 255u) / s;
}
uint psTableChannels(uint d, uint s, int which) {
  uint r;
  uint g;
  uint b;
  if (which == 0) {
    r = psOverlayValue((s >> 16u) & 255u, (d >> 16u) & 255u);
    g = psOverlayValue((s >> 8u) & 255u, (d >> 8u) & 255u);
    b = psOverlayValue(s & 255u, d & 255u);
  } else if (which == 1) {
    r = psOverlayValue((d >> 16u) & 255u, (s >> 16u) & 255u);
    g = psOverlayValue((d >> 8u) & 255u, (s >> 8u) & 255u);
    b = psOverlayValue(d & 255u, s & 255u);
  } else if (which == 2) {
    r = softLightTable((s >> 16u) & 255u, (d >> 16u) & 255u);
    g = softLightTable((s >> 8u) & 255u, (d >> 8u) & 255u);
    b = softLightTable(s & 255u, d & 255u);
  } else if (which == 3) {
    r = psDodgeValue((s >> 16u) & 255u, (d >> 16u) & 255u);
    g = psDodgeValue((s >> 8u) & 255u, (d >> 8u) & 255u);
    b = psDodgeValue(s & 255u, d & 255u);
  } else {
    r = psBurnValue((s >> 16u) & 255u, (d >> 16u) & 255u);
    g = psBurnValue((s >> 8u) & 255u, (d >> 8u) & 255u);
    b = psBurnValue(s & 255u, d & 255u);
  }
  return (r << 16u) | (g << 8u) | b;
}
uint psCompareMask(uint d, uint s) {
  uint n = ((((~d) & s) << 1u) + (((~d) ^ s) & 0x00fefefeu)) & 0x01010100u;
  return ((n >> 8u) + 0x007f7f7fu) ^ 0x007f7f7fu;
}
uint psDiffChannels(uint d, uint s) {
  uint n = psCompareMask(d, s);
  return ((s & n) - (d & n)) | ((d & ~n) - (s & ~n));
}
uint psExclusionFunctor(uint d, uint s, uint a) {
  uint sd1 = (((((d >> 16u) & 255u) * ((s & 0x00ff0000u) >> 7u)) & 0x01ff0000u)
    | (((d >> 0u) & 255u) * (s & 0x000000ffu)) >> 7u);
  uint sd2 = ((((d >> 8u) & 255u) * (s & 0x0000ff00u)) & 0x00ff8000u) >> 7u;
  return ((((((s & 0x00ff00ffu) - sd1) * a) >> 8u) + (d & 0x00ff00ffu)) & 0x00ff00ffu)
    | ((((((s & 0x0000ff00u) - sd2) * a) >> 8u) + (d & 0x0000ff00u)) & 0x0000ff00u);
}
uint psVariant(uint d, uint s, uint opa, bool hold) {
  uint a = opa == 255u ? (s >> 24u) : ((s >> 24u) * opa) >> 8u;
  int m = mode;
  uint r;
  if (m == 22) {
    uint t = fadeColour(s, a);
    r = psTableChannels(d, t, 3);
  } else if (m == 27) {
    r = psDiffChannels(d, fadeColour(s, a));
  } else if (m == 13) {
    r = psAlphaBlend(d, s, a);
  } else if (m == 14) {
    r = psAddFunctor(d, s, a);
  } else if (m == 15) {
    r = psSubFunctor(d, s, a);
  } else if (m == 16) {
    r = psMulFunctor(d, s, a);
  } else if (m == 17) {
    r = psScreenFunctor(d, s, a);
  } else if (m == 18) {
    r = psAlphaBlend(d, psTableChannels(d, s, 0), a);
  } else if (m == 19) {
    r = psAlphaBlend(d, psTableChannels(d, s, 1), a);
  } else if (m == 20) {
    r = psAlphaBlend(d, psTableChannels(d, s, 2), a);
  } else if (m == 21) {
    r = psAlphaBlend(d, psTableChannels(d, s, 3), a);
  } else if (m == 23) {
    r = psAlphaBlend(d, psTableChannels(d, s, 4), a);
  } else if (m == 24) {
    uint n = psCompareMask(d, s);
    r = psAlphaBlend(d, (s & n) | (d & ~n), a);
  } else if (m == 25) {
    uint n = psCompareMask(d, s);
    r = psAlphaBlend(d, (d & n) | (s & ~n), a);
  } else if (m == 26) {
    r = psAlphaBlend(d, psDiffChannels(d, s), a);
  } else if (m == 28) {
    r = psExclusionFunctor(d, s, a);
  } else {
    r = s;
  }
  return hold ? ((r & 0x00ffffffu) | (d & 0xff000000u)) : r;
}

${textBlendShader}

// LayerBitmapIntf::PartialBlt dispatch for the source layer's operation mode.
uint blendPixel(uint d, uint s) {
  uint bits = uint(policy);
  bool hold = (bits & POLICY_HOLD) != 0u;
  bool destAlpha = (bits & POLICY_DEST_ALPHA) != 0u;
  bool additive = (bits & POLICY_ADDITIVE) != 0u;
  bool copyAlpha = (bits & POLICY_COPY_ALPHA) != 0u;
  if ((bits & POLICY_IGNORE_ALPHA) != 0u || opaque) s |= 0xff000000u;
  int m = mode;
  // Text draw faces are dispatched before the layer operation modes.
  if (m >= 100 && m <= 104) return textBlend(d, s, opacity, uint(m - 100));
  uint opa = uint(opacity);
  if (opa == 0u) return d;
  if (m == 1) {
    if (destAlpha && !copyAlpha) {
      if (opa == 255u) return s | 0xff000000u;
      return additive ? constAlphaA(d, s, opa) : constAlphaD(d, s, opa);
    }
    if (opa == 255u) {
      if (hold) return (d & 0xff000000u) | (s & 0x00ffffffu);
      if (copyAlpha || !destAlpha) return s;
      return s | 0xff000000u;
    }
    if (hold) return constAlphaHDA(d, s, opa);
    if (additive) return constAlphaA(d, s, opa);
    if (destAlpha) return constAlphaD(d, s, opa);
    return constAlpha(d, s, opa);
  }
  if (m == 2) {
    if (!destAlpha) {
      if (opa == 255u) return alphaBlend55(d, s);
      return hold ? alphaBlendHO(d, s, opa) : alphaBlendO(d, s, opa);
    }
    if (additive) return opa == 255u ? premulAA(d, alphaToPremul(s)) : alphaBlendAO(d, s, opa);
    return opa == 255u ? alphaBlendD55(d, s) : alphaBlendDO(d, s, opa);
  }
  if (m == 12) {
    if (additive && !hold) return opa == 255u ? premulAA(d, s) : premulAAO(d, s, opa);
    if (opa == 255u) return hold ? premulHDA(d, s) : premulNA(d, s);
    return hold ? premulHDAO(d, s, opa) : premulNAO(d, s, opa);
  }
  if (m == 3) return addVariant(d, s, opa, hold);
  if (m == 4) return subVariant(d, s, opa, hold);
  if (m == 5) return mulVariant(d, s, opa, hold);
  if (m == 8) return dodgeVariant(d, s, opa, hold);
  if (m == 9) return darkenVariant(d, s, opa, hold);
  if (m == 10) return lightenVariant(d, s, opa, hold);
  if (m == 11) return screenVariant(d, s, opa, hold);
  if (m >= 13) return psVariant(d, s, opa, hold);
  return d;
}

uint sampleTexel(int x, int y) {
  ivec2 size = ivec2(sourceSize);
  return packARGB(texelFetch(sourceTexture, clamp(ivec2(x, y), ivec2(0), size - 1), 0));
}
// TVPLinTransCopy: nearest sample at the truncated 16.16 coordinate.
uint sampleNearest(vec2 point) {
  return sampleTexel(int(floor(point.x)), int(floor(point.y)));
}
// Smooth sampling uses the hardware's own GL_LINEAR filtering: the engine's
// GL render backend never reads StretchType and creates every texture with
// GL_LINEAR, so this is the sampling path the original actually shows.
uint sampleLinear(vec2 point) {
  vec2 inset = clamp(point, sampleBounds.xy + 0.5, sampleBounds.zw - 0.5);
  return packARGB(texture(sourceTexture, inset / sourceSize));
}

void main() {
  vec2 point = explicitCoverage ? (inverseTransform * vec3(gl_FragCoord.xy, 1)).xy : sourcePoint;
  uint s;
  if (explicitCoverage) {
    // Native affine coverage includes the source's top/left pixel boundaries.
    if (any(lessThan(point, sampleRect.xy)) || any(greaterThanEqual(point, sampleRect.zw))) discard;
    s = smoothSampling != 0 ? sampleLinear(point) : sampleNearest(point);
  } else {
    s = sampleTexel(int(floor(sourcePoint.x)), int(floor(sourcePoint.y)));
  }
  if (opaque) s |= 0xff000000u;
#ifdef WINDOW_COMPOSITE
  // Fixed-function source-over writes either the opaque window or a private
  // premultiplied accumulation target, without sampling destination pixels.
  colour = vec4(unpackARGB(s).rgb, float(s >> 24u) * float(opacity) / 65025.0);
  return;
#endif
  uint d = packARGB(texelFetch(destinationTexture, ivec2(gl_FragCoord.xy), 0));
  if (operation == 6) { colour = unpackARGB((d & 0x00ffffffu) | (s & 0xff000000u)); return; }
  if (operation == 1) {
    // Motion's own blend branch: not covered by the Layer reference baseline.
    vec4 sf = unpackARGB(s);
    vec4 df = unpackARGB(d);
    float a = sf.a * float(opacity) / 255.0;
    if (mode == 0 || mode > 5) {
      float oa = a + df.a * (1.0 - a);
      vec3 rgb = oa == 0.0 ? df.rgb : (sf.rgb * a + df.rgb * df.a * (1.0 - a)) / oa;
      colour = vec4(rgb, oa);
      return;
    }
    vec3 rgb = df.rgb;
    if (mode == 1) rgb = min(vec3(1.0), df.rgb + sf.rgb * a);
    if (mode == 2 || mode == 5) rgb = max(vec3(0.0), df.rgb - sf.rgb * a);
    if (mode == 3) rgb = df.rgb * (1.0 - a) + df.rgb * sf.rgb * a;
    if (mode == 4) rgb = df.rgb + (vec3(1.0) - df.rgb) * sf.rgb * a;
    colour = vec4(rgb, max(df.a, min(1.0, sf.a * float(opacity) / 255.0 + df.a * (1.0 - a))));
    return;
  }
  colour = unpackARGB(blendPixel(d, s));
}`;

// TVPOpacityOnOpacityTable and ps_soft_light_table, byte for byte.
function createTables(gl) {
  const data = new Uint8Array(256 * 512);
  const f = Math.fround;
  for (let src = 0; src < 256; src++) for (let dest = 0; dest < 256; dest++) {
    let value = 255;
    if (dest) {
      const at = f(dest / 255), bt = f(src / 255);
      const ratio = f(bt / at);
      const c = f(ratio / (1.0 - bt + ratio));
      value = Math.trunc(c * 255);
      if (value >= 256) value = 255;
    }
    data[src * 256 + dest] = value;
  }
  for (let src = 0; src < 256; src++) for (let dest = 0; dest < 256; dest++) {
    const value = src >= 128
      ? Math.pow(dest / 255, 128 / src) * 255
      : Math.pow(dest / 255, (1 - src / 255) / 0.5) * 255;
    data[65536 + src * 256 + dest] = value;
  }
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 512, 0, gl.RED, gl.UNSIGNED_BYTE, data);
  return texture;
}

// Glyphs are rasterised once (the reference keeps a 1-byte coverage bitmap per
// character) and packed into a shared RGBA atlas, so text drawing is textured
// quads on the GPU instead of read-modify-write on the CPU bitmap.
const PREMULTIPLIED_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D sourceTexture;
uniform bool resolveComposite;
in vec2 sourcePoint;
out vec4 colour;
void main() {
  vec4 pixel = texelFetch(sourceTexture, ivec2(floor(sourcePoint)), 0);
  if (resolveComposite) {
    // Leave the original hidden RGB intact wherever the entire run has zero
    // alpha. The original straight target is not sampled while being written.
    if (pixel.a == 0.0) discard;
    colour = vec4(pixel.rgb / pixel.a, pixel.a);
  } else colour = vec4(pixel.rgb * pixel.a, pixel.a);
}`;

class GlyphAtlas {
  constructor(device, size = 2048) {
    this.device = device;
    this.size = size;
    this.image = new Image(size, size, { defer: true });
    this.x = 0;
    this.y = 0;
    this.row = 0;
  }
  entry() {
    const entry = this.device.texture(this.image, true);
    if (!entry.glyphAtlas) {
      entry.glyphAtlas = true;
      this.device.glyphAtlasCount++;
      this.device.glyphAtlasBytes += entry.width * entry.height * 4;
    }
    return entry;
  }
  // Shelf packing: glyphs advance left to right, rows grow downwards. A full
  // atlas returns null and the caller starts a new one (cached glyphs keep a
  // reference to the atlas they were packed into).
  add(width, height, pixels) {
    if (width > this.size || height > this.size) return null;
    if (this.x + width > this.size) {
      this.x = 0;
      this.y += this.row + 1;
      this.row = 0;
    }
    if (this.y + height > this.size) return null;
    const left = this.x, top = this.y;
    const entry = this.entry();
    const gl = this.device.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    if (pixels) gl.texSubImage2D(gl.TEXTURE_2D, 0, left, top, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.device.commit(this.image, entry);
    if (pixels) {
      this.device.stats.uploads++;
      this.device.stats.uploadedBytes += pixels.byteLength;
      this.device.stats.glyphUploads++;
      this.device.stats.glyphUploadedBytes += pixels.byteLength;
    }
    this.x += width + 1;
    this.row = Math.max(this.row, height);
    return { left, top, right: left + width, bottom: top + height };
  }
}

class GPUDevice {
  constructor(document, textBlendShader) {
    this.canvas = new OffscreenCanvas(1, 1);
    const gl = this.gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('WebGL 2 is required');
    this.lost = false;
    this.onLost = event => { event.preventDefault(); this.lost = true; };
    this.canvas.addEventListener('webglcontextlost', this.onLost);
    const fragment = fragmentSource(textBlendShader);
    this.program = this.compile(QUAD_VERTEX, fragment);
    this.compositeProgram = this.compile(QUAD_VERTEX, fragment.replace('#version 300 es', '#version 300 es\n#define LAYER_COMPOSITE'));
    this.windowProgram = this.compile(QUAD_VERTEX, fragment.replace('#version 300 es', '#version 300 es\n#define LAYER_COMPOSITE\n#define WINDOW_COMPOSITE'));
    this.floatCompositing = !!gl.getExtension('EXT_color_buffer_float');
    this.premultipliedProgram = this.floatCompositing ? this.compile(QUAD_VERTEX, PREMULTIPLIED_FRAGMENT) : null;
    gl.useProgram(this.program);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.programUniforms = new Map();
    this.uniforms = null;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.stats = { uploads: 0, uploadedBytes: 0, glyphUploads: 0, glyphUploadedBytes: 0,
      readbacks: 0, readbackBytes: 0, snapshots: 0, draws: 0 };
    this.tables = createTables(gl);
    // Like tTVPOGLTexture2D, a bitmap owns its resident texture. Active render
    // targets cannot be evicted: preserving them would require a GPU readback.
    // Images are JS pixel buffers, not TJS owners; do not keep them alive here.
    this.textures = new WeakMap();
    this.imageTextures = new Set();
    this.textureBytes = 0;
    this.glyphAtlasCount = 0;
    this.glyphAtlasBytes = 0;
    this.glyphImages = new WeakMap();
    this.textureFinalizer = new FinalizationRegistry(entry => this.releaseTexture(entry));
    this.scratch = null;
    // Feature modules own their own programs and textures; release them here so
    // device shutdown stays the single teardown point.
    this.disposers = new Set();
  }
  onDispose(dispose) {
    this.disposers.add(dispose);
  }
  compile(vertex, fragment) {
    const gl = this.gl;
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    return program;
  }
  uniform(name, type, ...values) {
    let uniform = this.uniforms.get(name);
    if (!uniform) {
      uniform = { location: this.gl.getUniformLocation(this.activeProgram, name), values: null };
      this.uniforms.set(name, uniform);
    }
    if (uniform.location === null) return;
    const previous = uniform.values;
    const matrix = type === 'uniformMatrix3fv';
    if (previous) {
      const current = matrix ? values[1] : values;
      let same = current.length === previous.length;
      for (let i = 0; same && i < current.length; i++) same = current[i] === previous[i];
      if (same) return;
    }
    this.gl[type](uniform.location, ...values);
    uniform.values = matrix ? Array.from(values[1]) : values;
  }
  create(width, height, gray = false, halfFloat = false) {
    const gl = this.gl;
    if (width <= 0 || height <= 0 || width > this.maxTextureSize || height > this.maxTextureSize) throw new Error(`GPU image has invalid dimensions: ${width}x${height}`);
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, halfFloat ? gl.RGBA16F : gray ? gl.R8 : gl.RGBA8, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    // Validate the normalized and floating-point attachment layouts once;
    // querying every allocation synchronously drains the GPU command queue.
    if (!this.framebufferValidated || halfFloat && !this.floatFramebufferValidated) {
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('GPU framebuffer is incomplete');
      this.framebufferValidated = true;
      if (halfFloat) this.floatFramebufferValidated = true;
    }
    return { device: this, texture, framebuffer, width, height, gray, bytesPerPixel: halfFloat ? 8 : gray ? 1 : 4, filter: gl.NEAREST };
  }
  texture(image, discard = false) {
    if (this.lost) throw new Error('WebGL context was lost; reload the game');
    // An exported writable view can change without an Image method call.
    // At the next GPU use, explicitly enter the CPU-write contract.
    if (image.externallyWritable) image.markCPUWritten();
    // Storage geometry is immutable; resizing replaces the storage and key.
    const storage = image._storage;
    let entry = this.textures.get(storage);
    if (!entry) {
      entry = this.create(image.width, image.height, image.gray, image.halfFloat);
      entry.storage = new WeakRef(storage);
      this.textures.set(storage, entry);
      this.imageTextures.add(entry);
      this.textureBytes += entry.width * entry.height * entry.bytesPerPixel;
      this.textureFinalizer.register(storage, entry, entry);
    }
    if (!discard && !image.gpuValid) {
      if (!image.cpuValid) throw new Error('Image has no authoritative source');
      const pixels = image._pixels;
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      if (pixels) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, image.width, image.height, image.gray ? gl.RED : gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        this.stats.uploads++;
        this.stats.uploadedBytes += pixels.byteLength;
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, entry.framebuffer);
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      image.gpuValid = true;
      // Uploaded pixels are now owned by the resident texture. CoW aliases
      // share this storage, so retaining its CPU shadow doubles cache memory.
      // External writable views must retain their original backing array.
      if (!image.externallyWritable) image.markGPUWritten();
    }
    image.gpu = entry;
    return entry;
  }
  // Immutable source images can be prepared before drawing. Keep each upload
  // bounded and yield between batches so large resources do not monopolize a
  // frame. GPU authority is published only after all rows have been uploaded.
  async prepareTextures(images) {
    const gl = this.gl;
    let batchBytes = 0, batchStart = performance.now();
    const nextBatch = async () => {
      gl.flush();
      await new Promise(resolve => requestAnimationFrame(resolve));
      batchBytes = 0;
      batchStart = performance.now();
    };
    for (const image of images) {
      if (!image.width || !image.height || image.gpuValid) continue;
      // Uploading synchronizes shared content; it does not modify the image.
      const pixels = image._pixels;
      if (!pixels) {
        this.texture(image);
        continue;
      }
      const entry = this.texture(image, true);
      const rowBytes = image.width * (image.gray ? 1 : 4);
      for (let y = 0; y < image.height;) {
        if (PREPARE_UPLOAD_BYTES - batchBytes < rowBytes) await nextBatch();
        const height = Math.min(image.height - y, Math.floor((PREPARE_UPLOAD_BYTES - batchBytes) / rowBytes));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, entry.texture);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, image.width, height,
          image.gray ? gl.RED : gl.RGBA, gl.UNSIGNED_BYTE,
          pixels.subarray(y * rowBytes, (y + height) * rowBytes));
        const bytes = height * rowBytes;
        this.stats.uploads++;
        this.stats.uploadedBytes += bytes;
        batchBytes += bytes;
        y += height;
        if (batchBytes >= PREPARE_UPLOAD_BYTES || performance.now() - batchStart >= PREPARE_UPLOAD_MS) {
          await nextBatch();
        }
      }
      this.commit(image, entry);
    }
  }
  // Canvas-backed rasterizers upload directly, without a JS pixel readback.
  uploadCanvas(image, canvas) {
    image.detach(false);
    const entry = this.texture(image, true), gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    this.commit(image, entry);
    this.stats.uploads++;
    this.stats.uploadedBytes += image.width * image.height * 4;
  }
  releaseTexture(entry) {
    const storage = entry.storage?.deref();
    if (storage?.gpu === entry) {
      // A shared storage may still be in use by another Image. Preserve its
      // content before the only resident copy disappears.
      if (storage.refs > 1 && !storage.cpuValid && !this.lost) {
        storage.pixels = this.read(entry);
        storage.cpuValid = true;
      }
      storage.gpu = null;
      storage.gpuValid = false;
    }
    if (storage && this.textures.get(storage) === entry) this.textures.delete(storage);
    this.textureFinalizer.unregister(entry);
    this.imageTextures.delete(entry);
    this.textureBytes -= entry.width * entry.height * entry.bytesPerPixel;
    if (entry.glyphAtlas) {
      this.glyphAtlasCount--;
      this.glyphAtlasBytes -= entry.width * entry.height * 4;
    }
    this.gl.deleteFramebuffer(entry.framebuffer);
    this.gl.deleteTexture(entry.texture);
  }
  read(entry, rect = { left: 0, top: 0, right: entry.width, bottom: entry.height }) {
    if (this.lost) throw new Error('Cannot read pixels after WebGL context loss');
    const width = rect.right - rect.left, height = rect.bottom - rect.top;
    const gl = this.gl;
    const pixels = new Uint8ClampedArray(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, entry.framebuffer);
    gl.readPixels(rect.left, rect.top, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.stats.readbacks++; this.stats.readbackBytes += pixels.byteLength;
    if (entry.gray) return Uint8ClampedArray.from({ length: width * height }, (_, i) => pixels[i * 4]);
    return pixels;
  }
  snapshot(target, rect) {
    const gl = this.gl;
    if (!this.scratch || this.scratch.width < target.width || this.scratch.height < target.height) {
      const width = Math.max(this.scratch?.width ?? 0, target.width), height = Math.max(this.scratch?.height ?? 0, target.height);
      if (this.scratch) {
        gl.deleteTexture(this.scratch.texture);
        gl.deleteFramebuffer(this.scratch.framebuffer);
      }
      this.scratch = this.create(width, height);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.scratch.framebuffer);
    gl.blitFramebuffer(rect.left, rect.top, rect.right, rect.bottom, rect.left, rect.top, rect.right, rect.bottom, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.stats.snapshots++;
    return this.scratch;
  }
  bind(entry, unit, uniform) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    this.uniform(uniform, 'uniform1i', unit);
  }
  setup(target, source, rect, matrix, clip, destination, program = this.program) {
    const gl = this.gl;
    gl.useProgram(program);
    this.activeProgram = program;
    this.uniforms = this.programUniforms.get(program);
    if (!this.uniforms) this.programUniforms.set(program, this.uniforms = new Map());
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top);
    this.bind(source, 0, 'sourceTexture');
    this.bind(destination, 1, 'destinationTexture');
    this.bind(destination, 2, 'secondTexture');
    this.bind(destination, 3, 'ruleTexture');
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.tables);
    this.uniform('tableTexture', 'uniform1i', 4);
    this.uniform('sourceSize', 'uniform2f', source.width, source.height);
    this.uniform('smoothSampling', 'uniform1i', 0);
    this.uniform('explicitCoverage', 'uniform1i', 0);
    this.uniform('targetSize', 'uniform2f', target.width, target.height);
    this.uniform('sourceRect', 'uniform4f', rect.left, rect.top, rect.right, rect.bottom);
    this.uniform('transform', 'uniformMatrix3fv', false, [matrix[0], matrix[1], 0, matrix[2], matrix[3], 0, matrix[4], matrix[5], 1]);
  }
  draw(targetImage, sourceImage, options = {}) {
    const {
      matrix = [1, 0, 0, 1, 0, 0],
      sourceRect = { left: 0, top: 0, right: sourceImage.width, bottom: sourceImage.height },
      sampleBounds = sourceRect,
      mode = 2,
      opacity = 255,
      holdAlpha = false,
      destinationAlpha = true,
      additiveDestination = false,
      copySourceAlpha = false,
      ignoreSourceAlpha = false,
      opaque = false,
      motion = false,
      maskOnly = false,
      windowComposite = false,
      smooth = false
    } = options;
    const clip = this.clip(targetImage, options.clip);
    if (sourceRect.right <= sourceRect.left || sourceRect.bottom <= sourceRect.top) return;
    const textMode = mode >= 100 && mode <= 104;
    // Ordinary blits reject non-positive opacity. Text uses negative opacity
    // for RemoveOpacity, while zero remains a no-op.
    if (opacity === 0 || opacity < 0 && !textMode) return;
    const corners = [
      [sourceRect.left, sourceRect.top],
      [sourceRect.right, sourceRect.top],
      [sourceRect.left, sourceRect.bottom],
      [sourceRect.right, sourceRect.bottom]
    ];
    const xs = corners.map(([x, y]) => matrix[0] * x + matrix[2] * y + matrix[4]);
    const ys = corners.map(([x, y]) => matrix[1] * x + matrix[3] * y + matrix[5]);
    clip.left = Math.max(clip.left, Math.floor(Math.min(...xs)));
    clip.right = Math.min(clip.right, Math.ceil(Math.max(...xs)));
    clip.top = Math.max(clip.top, Math.floor(Math.min(...ys)));
    clip.bottom = Math.min(clip.bottom, Math.ceil(Math.max(...ys)));
    if (clip.right <= clip.left || clip.bottom <= clip.top) return;
    // Thumbnail sheets can exceed MAX_TEXTURE_SIZE. Keep their CPU bitmap
    // intact and upload only the source tiles needed by this draw, like the
    // reference renderer's tTVPOGLTexture2D_split.
    if (sourceImage.width > this.maxTextureSize || sourceImage.height > this.maxTextureSize) {
      const inverse = mat2d.invert(new Float64Array(6), matrix);
      if (!inverse) return;
      const points = [[clip.left, clip.top], [clip.right, clip.top],
        [clip.left, clip.bottom], [clip.right, clip.bottom]];
      const sx = points.map(([x, y]) => inverse[0] * x + inverse[2] * y + inverse[4]);
      const sy = points.map(([x, y]) => inverse[1] * x + inverse[3] * y + inverse[5]);
      const left = Math.max(0, sourceRect.left, Math.floor(Math.min(...sx)));
      const top = Math.max(0, sourceRect.top, Math.floor(Math.min(...sy)));
      const right = Math.min(sourceImage.width, sourceRect.right, Math.ceil(Math.max(...sx)));
      const bottom = Math.min(sourceImage.height, sourceRect.bottom, Math.ceil(Math.max(...sy)));
      const channels = sourceImage.gray ? 1 : 4;
      const pixels = sourceImage.pixels;
      // Linear sampling needs a one-pixel border from adjacent tiles.
      const border = smooth ? 1 : 0, step = this.maxTextureSize - border * 2;
      for (let y = Math.floor(top); y < bottom; y += step) {
        for (let x = Math.floor(left); x < right; x += step) {
          const endX = Math.min(x + step, right), endY = Math.min(y + step, bottom);
          const ox = Math.max(0, x - border), oy = Math.max(0, y - border);
          const w = Math.min(sourceImage.width, Math.ceil(endX) + border) - ox;
          const h = Math.min(sourceImage.height, Math.ceil(endY) + border) - oy;
          const data = new Uint8ClampedArray(w * h * channels);
          for (let row = 0; row < h; row++) {
            const offset = ((oy + row) * sourceImage.width + ox) * channels;
            data.set(pixels.subarray(offset, offset + w * channels), row * w * channels);
          }
          const tile = new Image(w, h, { gray: sourceImage.gray, pixels: data });
          try {
            this.draw(targetImage, tile, { ...options, clip,
              sourceRect: { left: Math.max(x, left) - ox, top: Math.max(y, top) - oy,
                right: endX - ox, bottom: endY - oy },
              sampleBounds: { left: Math.max(0, sampleBounds.left - ox), top: Math.max(0, sampleBounds.top - oy),
                right: Math.min(w, sampleBounds.right - ox), bottom: Math.min(h, sampleBounds.bottom - oy) },
              matrix: [matrix[0], matrix[1], matrix[2], matrix[3],
                matrix[4] + matrix[0] * ox + matrix[2] * oy,
                matrix[5] + matrix[1] * ox + matrix[3] * oy],
            });
          } finally { tile.release(); }
        }
      }
      return;
    }
    const overwrite = !maskOnly && !holdAlpha && opacity === 255 && (
      !motion && mode === 1 && copySourceAlpha || motion && opaque && mode === 0);
    // Bounding-box coverage is insufficient for rotated/sheared quads: their
    // uncovered corners must retain the old destination pixels.
    const fullTarget = clip.left === 0 && clip.top === 0 && clip.right === targetImage.width && clip.bottom === targetImage.height
      && matrix[0] === 1 && matrix[1] === 0 && matrix[2] === 0 && matrix[3] === 1
      && Number.isInteger(matrix[4]) && Number.isInteger(matrix[5]);
    // A full overwrite can replace shared storage without preserving it; every
    // other write (including self draws) separates first and keeps old pixels.
    const overwriteFull = sourceImage !== targetImage && overwrite && fullTarget;
    targetImage.detach(sourceImage === targetImage || !overwriteFull);
    const source = this.texture(sourceImage), target = this.texture(targetImage, overwriteFull);
    // CopyRect's full-channel integer translation does not read destination
    // pixels. Blit it directly instead of snapshotting and running the blend
    // shader; self-copies still use the existing snapshot path.
    if (sourceImage !== targetImage && mode === 1 && copySourceAlpha && opacity === 255
      && !holdAlpha && !maskOnly && !ignoreSourceAlpha && !opaque && !motion && !smooth
      && matrix[0] === 1 && matrix[1] === 0 && matrix[2] === 0 && matrix[3] === 1
      && Number.isInteger(matrix[4]) && Number.isInteger(matrix[5])) {
      const left = clip.left - matrix[4], top = clip.top - matrix[5];
      const right = clip.right - matrix[4], bottom = clip.bottom - matrix[5];
      if (left >= 0 && top >= 0 && right <= source.width && bottom <= source.height) {
        const gl = this.gl;
        gl.disable(gl.SCISSOR_TEST);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer);
        gl.blitFramebuffer(left, top, right, bottom, clip.left, clip.top, clip.right, clip.bottom, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        this.stats.draws++;
        this.commit(targetImage, target);
        return;
      }
    }
    const filter = smooth ? this.gl.LINEAR : this.gl.NEAREST;
    if (source.filter !== filter) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      source.filter = filter;
    }
    // Full-opacity copies and opaque normal compositing overwrite the target.
    // They do not need its previous contents. Keep snapshots for self-draws
    // and all blends that actually depend on destination colour or alpha.
    const destination = windowComposite || sourceImage !== targetImage && overwrite
      ? source : this.snapshot(target, sourceImage === targetImage ? this.clip(targetImage) : clip);
    const inverse = mat2d.invert(new Float64Array(6), matrix);
    if (!inverse) return;
    this.setup(target, sourceImage === targetImage ? destination : source, clip, [1,0,0,1,0,0], clip, destination,
      windowComposite ? this.windowProgram : motion && mode === 0 && !maskOnly ? this.compositeProgram : this.program);
    this.uniform('explicitCoverage', 'uniform1i', 1);
    this.uniform('smoothSampling', 'uniform1i', smooth ? 1 : 0);
    this.uniform('inverseTransform', 'uniformMatrix3fv', false, [
      inverse[0], inverse[1], 0,
      inverse[2], inverse[3], 0,
      inverse[4], inverse[5], 1
    ]);
    this.uniform('sampleRect', 'uniform4f', sourceRect.left, sourceRect.top, sourceRect.right, sourceRect.bottom);
    this.uniform('sampleBounds', 'uniform4f', sampleBounds.left, sampleBounds.top, sampleBounds.right, sampleBounds.bottom);
    this.uniform('operation', 'uniform1i', maskOnly ? 6 : motion ? 1 : 0);
    this.uniform('mode', 'uniform1i', mode);
    this.uniform('opacity', 'uniform1i', opacity);
    this.uniform('opaque', 'uniform1i', opaque ? 1 : 0);
    this.uniform('policy', 'uniform1i', Number(holdAlpha) | Number(destinationAlpha)<<1 | Number(additiveDestination)<<2 | Number(copySourceAlpha)<<3 | Number(ignoreSourceAlpha)<<4);
    const gl = this.gl;
    if (windowComposite) {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    if (windowComposite) gl.disable(gl.BLEND);
    this.stats.draws++;
    this.commit(targetImage, target);
  }
  // Batch normal source-over runs in premultiplied RGBA16F. Public images
  // remain straight RGBA8; special modes keep their existing ordered path.
  compositeOffscreen(image, commands) {
    const normal = command => command.source !== image &&
      (command.options.mode === 0 || command.options.mode > 5);
    // The current destination is converted into the accumulation target first,
    // so a shared image must be separated with its pixels preserved.
    image.detach(true);
    for (let i = 0; i < commands.length;) {
      let end = i;
      while (end < commands.length && normal(commands[end])) end++;
      if (!this.floatCompositing || end - i < 3) {
        const { source, options } = commands[i++];
        this.draw(image, source, options);
        continue;
      }
      let intermediate = this.offscreenComposite;
      if (!intermediate || intermediate.width !== image.width || intermediate.height !== image.height) {
        if (intermediate) {
          this.releaseTexture(this.textures.get(intermediate._storage));
        }
        intermediate = this.offscreenComposite = new Image(image.width, image.height, { defer: true });
        intermediate.halfFloat = true;
      }
      const target = this.texture(image), accumulation = this.texture(intermediate, true);
      const rect = this.clip(image), identity = [1, 0, 0, 1, 0, 0];
      const convert = (output, input, resolve) => {
        this.setup(output, input, rect, identity, rect, input, this.premultipliedProgram);
        this.uniform('resolveComposite', 'uniform1i', Number(resolve));
        this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
        this.stats.draws++;
      };
      convert(accumulation, target, false);
      intermediate.markGPUWritten();
      for (; i < end; i++) {
        const { source, options } = commands[i];
        this.draw(intermediate, source, { ...options, windowComposite: true });
      }
      convert(target, accumulation, true);
      this.commit(image, target);
    }
  }
  commit(image, entry) {
    image.gpu = entry;
    image.markGPUWritten();
    if (image.externallyWritable) image.materialize();
  }
  clip(image, rect = null) {
    rect ??= { left: 0, top: 0, right: image.width, bottom: image.height };
    return {
      left: Math.max(0, Math.floor(rect.left)),
      top: Math.max(0, Math.floor(rect.top)),
      right: Math.min(image.width, Math.ceil(rect.right)),
      bottom: Math.min(image.height, Math.ceil(rect.bottom))
    };
  }
  atlas() {
    return this.glyphAtlas ??= new GlyphAtlas(this);
  }
  // Packs one rasterised glyph (RGBA, colour already applied) and returns the
  // atlas plus its rectangle.
  addGlyph(width, height, pixels) {
    let atlas = this.atlas();
    let rect = atlas.add(width, height, pixels);
    if (!rect) {
      atlas = this.glyphAtlas = new GlyphAtlas(this);
      rect = atlas.add(width, height, pixels);
    }
    if (!rect) throw new Error(`GPU glyph atlas is too small for ${width}x${height}`);
    return { atlas, rect };
  }
  glyph(image) {
    let glyph = this.glyphImages.get(image);
    if (glyph) return glyph;
    if (image.gpuValid) {
      const { atlas, rect } = this.addGlyph(image.width, image.height, null);
      this.draw(atlas.image, image, { matrix: [1, 0, 0, 1, rect.left, rect.top], mode: 1, copySourceAlpha: true });
      glyph = { atlas, rect };
      this.glyphImages.set(image, glyph);
      return glyph;
    }
    const pixels = image.pixels;
    let visible = false;
    for (let i = 3; i < pixels.length; i += 4) {
      if (pixels[i]) { visible = true; break; }
    }
    glyph = visible ? this.addGlyph(image.width, image.height, pixels) : { atlas: null, rect: null };
    this.glyphImages.set(image, glyph);
    return glyph;
  }
  drawGlyph(targetImage, glyph, left, top, options = {}) {
    if (!glyph?.rect) glyph = this.glyph(glyph);
    if (!glyph.rect) return false;
    const { rect } = glyph;
    return this.draw(targetImage, glyph.atlas.image, {
      ...options,
      sourceRect: rect,
      matrix: [1, 0, 0, 1, left - rect.left, top - rect.top],
    });
  }
  fill(image, rect, rgba, maskOnly = false) {
    const clip = this.clip(image, rect);
    if (clip.right <= clip.left || clip.bottom <= clip.top) return;
    const full = !maskOnly && clip.left === 0 && clip.top === 0 && clip.right === image.width && clip.bottom === image.height;
    image.detach(!full);
    const target = this.texture(image, full), gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top);
    // TVPFillMask (tvpgl const_alpha_copy) writes only the alpha byte, which is
    // exactly what a colour-masked clear does; no shader pass is needed.
    gl.colorMask(!maskOnly, !maskOnly, !maskOnly, true);
    gl.clearColor(maskOnly ? 0 : rgba[0] / 255, maskOnly ? 0 : rgba[1] / 255, maskOnly ? 0 : rgba[2] / 255, rgba[3] / 255);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.colorMask(true, true, true, true);
    this.commit(image, target);
  }
  copy(targetImage, sourceImage) {
    // Copy replaces every target texel, so shared old content need not survive.
    targetImage.detach(false);
    const source = this.texture(sourceImage), target = this.texture(targetImage, true), gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer);
    gl.blitFramebuffer(0, 0, source.width, source.height, 0, 0, target.width, target.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.commit(targetImage, target);
  }
  diagnostics() {
    return { ...this.stats, textureBytes: this.textureBytes, textureCount: this.imageTextures.size,
      glyphAtlasCount: this.glyphAtlasCount, glyphAtlasBytes: this.glyphAtlasBytes };
  }
  finalize() {
    for (const entry of this.imageTextures) this.releaseTexture(entry);
    this.textures = new WeakMap();
    const gl=this.gl;
    if (this.scratch) {
      gl.deleteTexture(this.scratch.texture);
      gl.deleteFramebuffer(this.scratch.framebuffer);
    }
    gl.deleteTexture(this.tables);
    gl.deleteProgram(this.program);
    gl.deleteProgram(this.compositeProgram);
    gl.deleteProgram(this.windowProgram);
    if (this.premultipliedProgram) gl.deleteProgram(this.premultipliedProgram);
    for (const dispose of this.disposers) dispose();
    this.disposers.clear();
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    if (device === this) device = null;
  }
}
