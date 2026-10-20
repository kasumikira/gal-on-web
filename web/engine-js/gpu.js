import { mat2d } from 'gl-matrix';

// All image storage is straight RGBA8, including RGB underneath zero alpha.
// Only presentation converts to premultiplied colour for the browser.
let device = null;
export const getGPU = () => device;
export function initializeGPU(document) {
  if (device) throw new Error('GPU renderer is already initialized');
  try {
    device = new GPUDevice(document);
  } catch (error) {
    document.defaultView.alert(`WebGL 2 初始化失败，无法启动游戏。\n${error.message}`);
    throw error;
  }
  return device;
}

const VERTEX = `#version 300 es
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

// Blending is a word-for-word port of the reference C implementation
// (third_party/kirikiroid2 .../visual/gl/blend_functor_c.h and the native
// blend slots installed by TVPInitTVPGL). Packed pixels are 0xAARRGGBB in a
// uint so that every masking, borrow and 32 bit truncation reproduces the
// original byte results, including the engine's own oddities.
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D sourceTexture;
uniform sampler2D destinationTexture;
uniform sampler2D secondTexture;
uniform sampler2D ruleTexture;
uniform sampler2D tableTexture;
uniform vec2 sourceSize;
uniform vec2 targetSize;
uniform vec4 sourceRect;
uniform mat3 transform;
uniform mat3 inverseTransform;
uniform vec4 sampleRect;
uniform int operation;
uniform int mode;
uniform int policy;
uniform int phase;
uniform int vague;
uniform int layerType;
uniform int opacity;
uniform int smoothSampling;
uniform bool opaque;
uniform bool explicitCoverage;
uniform int colourOp;
uniform int colourValue;
uniform int colourOpa;
uniform int lutOp;
uniform sampler2D lutTexture;
uniform int transformOp;
uniform sampler2D kernelTexture;
uniform int blurRadius;
uniform float blurSigma;
uniform ivec2 blurStep;
uniform int blurLeft;
uniform int blurTop;
uniform int blurRight;
uniform int blurBottom;
uniform bool blurAlpha;
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
uint blendARGB(uint b, uint a, uint ratio) {
  uint b2 = b & 0x00ff00ffu;
  uint t = (b2 + (((a & 0x00ff00ffu) - b2) * ratio >> 8u)) & 0x00ff00ffu;
  b2 = (b & 0xff00ff00u) >> 8u;
  return t + (((b2 + ((((a & 0xff00ff00u) >> 8u) - b2) * ratio >> 8u)) << 8u) & 0xff00ff00u);
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
  uint addr = ((s >> 16u) & 0xff00u) + (d >> 24u);
  uint alpha = opacityOnOpacity((s >> 24u), d >> 24u);
  return alphaBlendLanes(d, s, alpha) + (negativeMul((s >> 24u), d >> 24u) << 24u);
}
uint alphaBlendDO(uint d, uint s, uint opa) {
  uint srcAlpha = ((s >> 24u) * opa) >> 8u;
  uint addr = (srcAlpha << 8u) + (d >> 24u);
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

// LayerBitmapIntf::PartialBlt dispatch for the source layer's operation mode.
uint blendPixel(uint d, uint s) {
  uint bits = uint(policy);
  bool hold = (bits & POLICY_HOLD) != 0u;
  bool destAlpha = (bits & POLICY_DEST_ALPHA) != 0u;
  bool additive = (bits & POLICY_ADDITIVE) != 0u;
  bool copyAlpha = (bits & POLICY_COPY_ALPHA) != 0u;
  if ((bits & POLICY_IGNORE_ALPHA) != 0u || opaque) s |= 0xff000000u;
  uint opa = uint(opacity);
  if (opa == 0u) return d;
  int m = mode;
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

// premulalpha_blend_a_ca_func: additive-alpha fill with an explicit source alpha.
uint premulAC(uint d, uint sopa, uint sopaInv, uint src) {
  uint dopa = d >> 24u;
  dopa = dopa + sopa - (dopa * sopa >> 8u);
  dopa -= dopa >> 8u;
  return (dopa << 24u) + satAdd((((d & 0xff00ffu) * sopaInv >> 8u) & 0xff00ffu) + (((d & 0xff00u) * sopaInv >> 8u) & 0xff00u), src);
}

// LayerBitmapIntf FillColor / BlendColor family (tvpgl const_alpha_fill_blend).
uint constColourPixel(uint d) {
  uint c = uint(colourValue) & 0x00ffffffu;
  uint opa = uint(colourOpa);
  if (colourOp == 0) return (d & 0xff000000u) | c;                                   // TVPFillColor
  if (colourOp == 1) {                                                               // TVPConstColorAlphaBlend
    uint inv = 255u - opa;
    return (d & 0xff000000u)
      + ((((d & 0xff00ffu) * inv + (c & 0xff00ffu) * opa) >> 8u) & 0xff00ffu)
      + ((((d & 0xff00u) * inv + (c & 0xff00u) * opa) >> 8u) & 0xff00u);
  }
  if (colourOp == 2) {                                                               // TVPConstColorAlphaBlend_d
    uint dopa = d >> 24u;
    uint alpha = opacityOnOpacity(opa, dopa);
    uint d1 = d & 0xff00ffu;
    d1 = (d1 + (((c & 0xff00ffu) - d1) * alpha >> 8u)) & 0xff00ffu;
    d1 |= (255u - ((255u - dopa) * (255u - opa) >> 8u)) << 24u;
    uint dd = d & 0xff00u;
    return d1 | ((dd + (((c & 0xff00u) - dd) * alpha >> 8u)) & 0xff00u);
  }
  if (colourOp == 3) {                                                               // TVPConstColorAlphaBlend_a
    uint premul = (((((c & 0x00ff00u) * opa) & 0x00ff0000u) + (((c & 0xff00ffu) * opa) & 0xff00ff00u)) >> 8u);
    return premulAC(d, opa, opa ^ 0xffu, premul);
  }
  if (colourOp == 4) return uint(colourValue);                                       // TVPFillARGB
  return (d & 0x00ffffffu) + ((((d >> 24u) * (255u - opa)) << 16u) & 0xff000000u);   // TVPRemoveConstOpacity
}

// TVPAdjustGamma / Layer.light: per channel 256 entry lookup table.
// TVPAdjustGamma_c indexes the table with recip*t>>8, which reaches 256 when
// t equals alpha and alpha is a power of two; that index is one past the array,
// so the reference reads out of bounds. Return zero there instead of a rounded
// value, matching the fetch semantics and the reference's observed output.
uint lutEntry(uint channel, uint index) {
  if (index > 255u) return 0u;
  return uint(round(texelFetch(lutTexture, ivec2(int(index), int(channel)), 0).r * 255.0));
}
uint lutPixel(uint d) {
  uint alpha = d >> 24u;
  if (lutOp == 0) {
    if (alpha == 0u) return d;
    return (d & 0xff000000u) | (lutEntry(0u, d & 255u)) | (lutEntry(1u, (d >> 8u) & 255u) << 8u) | (lutEntry(2u, (d >> 16u) & 255u) << 16u);
  }
  if (lutOp == 2 || alpha == 255u) {
    return (d & 0xff000000u) | (lutEntry(0u, d & 255u)) | (lutEntry(1u, (d >> 8u) & 255u) << 8u) | (lutEntry(2u, (d >> 16u) & 255u) << 16u);
  }
  if (alpha == 0u) return d;
  // Additive-alpha face: weight by the adjusted alpha and the recip table.
  uint adjusted = alpha + (alpha >> 7u);
  uint recip = min(0x7fffu, 65536u / alpha);
  uint result = d & 0xff000000u;
  for (int c = 0; c < 3; c++) {
    uint t = (d >> uint(8 * c)) & 255u;
    uint value;
    // The reference ORs the unclamped value, so a value of 256 carries into the
    // neighbouring channel; reproduce that bit spill exactly.
    if (t > alpha) value = (lutEntry(uint(c), 255u) * adjusted >> 8u) + t - alpha;
    else value = lutEntry(uint(c), recip * t >> 8u) * adjusted >> 8u;
    result |= value << uint(8 * c);
  }
  return result;
}

// TVPDoGrayScale / TVPConvert(Additive)Alpha: whole image value transforms.
uint transformedPixel(uint s) {
  if (transformOp == 0) {
    uint v = ((s & 255u) * 19u + ((s >> 8u) & 255u) * 183u + ((s >> 16u) & 255u) * 54u) >> 8u;
    return (v * 0x010101u) | (s & 0xff000000u);
  }
  if (transformOp == 1) return mulColor(s, s >> 24u) | (s & 0xff000000u);
  uint alpha = s >> 24u;
  uint result = s & 0xff000000u;
  for (int c = 0; c < 3; c++) {
    uint v = (s >> uint(8 * c)) & 255u;
    result |= (alpha == 0u ? 0u : min(255u, v * 255u / alpha)) << uint(8 * c);
  }
  return result;
}

// iTVPBaseBitmap::DoBoxBlur / DoBoxBlurForAlpha over the clamped area.
uint boxBlurPixel() {
  ivec2 size = ivec2(sourceSize);
  ivec2 centre = ivec2(gl_FragCoord.xy);
  int x0 = max(0, centre.x + blurLeft), x1 = min(size.x - 1, centre.x + blurRight);
  int y0 = max(0, centre.y + blurTop), y1 = min(size.y - 1, centre.y + blurBottom);
  if (x1 < x0 || y1 < y0) return 0u;
  uint n = uint((x1 - x0 + 1) * (y1 - y0 + 1));
  uint rounding = n >> 1u;
  uint sumB = 0u, sumG = 0u, sumR = 0u, sumA = 0u;
  for (int y = y0; y <= y1; y++) for (int x = x0; x <= x1; x++) {
    uint v = packARGB(texelFetch(sourceTexture, ivec2(x, y), 0));
    if (blurAlpha) {
      uint a = v >> 24u;
      uint aadj = a + (a >> 7u);
      sumA += a;
      sumB += (v & 255u) * aadj >> 8u;
      sumG += ((v >> 8u) & 255u) * aadj >> 8u;
      sumR += ((v >> 16u) & 255u) * aadj >> 8u;
    } else {
      sumA += v >> 24u;
      sumB += v & 255u;
      sumG += (v >> 8u) & 255u;
      sumR += (v >> 16u) & 255u;
    }
  }
  if (!blurAlpha) {
    return (((sumR + rounding) / n) << 16u) | (((sumG + rounding) / n) << 8u) | ((sumB + rounding) / n) | (((sumA + rounding) / n) << 24u);
  }
  uint alpha = (sumA + rounding) / n;
  uint result = alpha << 24u;
  for (int c = 0; c < 3; c++) {
    uint value = (c == 0 ? sumB : c == 1 ? sumG : sumR);
    uint mean = (value + rounding) / n;
    result |= (alpha == 0u ? 0u : min(255u, mean * 255u / alpha)) << uint(8 * c);
  }
  return result;
}

// tTJSNI_BaseLayer::ApplyGaussianBlur: separable convolution with the
// generate_1d_gaussian_kernel weights, clamp-to-edge sampling, float
// accumulation and per pass truncation at the 8 bit target.
void gaussianPass() {
  ivec2 size = ivec2(sourceSize);
  ivec2 base = ivec2(gl_FragCoord.xy);
  vec4 sum = vec4(0.0);
  for (int k = -blurRadius; k <= blurRadius; k++) {
    ivec2 p = clamp(base + k * blurStep, ivec2(0), size - 1);
    float weight = texelFetch(kernelTexture, ivec2(k + blurRadius, 0), 0).r;
    sum += texelFetch(sourceTexture, p, 0) * 255.0 * weight;
  }
  colour = clamp(floor(sum), 0.0, 255.0) / 255.0;
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
  vec2 inset = clamp(point, sampleRect.xy + 0.5, sampleRect.zw - 0.5);
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
  if (operation == 4) {
    // Default framebuffer origin is bottom-left: TVPAlphaColorMat on black.
    uint flipped = sampleTexel(int(floor(sourcePoint.x)), int(sourceSize.y) - 1 - int(floor(sourcePoint.y)));
    float sa = float(flipped >> 24u);
    vec3 premultiplied = vec3(
      float((flipped >> 16u) & 255u) * sa / 256.0,
      float((flipped >> 8u) & 255u) * sa / 256.0,
      float(flipped & 255u) * sa / 256.0);
    colour = vec4(floor(premultiplied) / 255.0, 1.0);
    return;
  }
  if (operation == 13) { gaussianPass(); return; }
  uint d = packARGB(texelFetch(destinationTexture, ivec2(gl_FragCoord.xy), 0));
  if (operation == 3 || operation == 8) {
    uint bridge = packARGB(texelFetch(secondTexture, ivec2(gl_FragCoord.xy), 0));
    uint p = uint(phase);
    if (operation == 8) {
      int value = int(round(texelFetch(ruleTexture, ivec2(gl_FragCoord.xy), 0).r * 255.0));
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
    return;
  }
  if (operation == 9) { colour = unpackARGB(constColourPixel(d)); return; }
  if (operation == 10) { colour = unpackARGB(lutPixel(d)); return; }
  if (operation == 11) { colour = unpackARGB(transformedPixel(s)); return; }
  if (operation == 12) { colour = unpackARGB(boxBlurPixel()); return; }
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

class GPUDevice {
  constructor(document) {
    this.canvas = new OffscreenCanvas(1, 1);
    const gl = this.gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('WebGL 2 is required');
    this.lost = false;
    this.onLost = event => { event.preventDefault(); this.lost = true; };
    this.canvas.addEventListener('webglcontextlost', this.onLost);
    this.program = this.compile(VERTEX, FRAGMENT);
    gl.useProgram(this.program);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.locations = new Map();
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.stats = { uploads: 0, uploadedBytes: 0, readbacks: 0, readbackBytes: 0, draws: 0 };
    this.tables = createTables(gl);
    // Like tTVPOGLTexture2D, a bitmap owns its resident texture. Active render
    // targets cannot be evicted: preserving them would require a GPU readback.
    // Images are JS pixel buffers, not TJS owners; do not keep them alive here.
    this.textures = new WeakMap();
    this.imageTextures = new Set();
    this.textureBytes = 0;
    this.textureFinalizer = new FinalizationRegistry(entry => this.releaseTexture(entry));
    this.scratch = null;
    this.presenters = new WeakMap();
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
    if (!this.locations.has(name)) this.locations.set(name, this.gl.getUniformLocation(this.program, name));
    this.gl[type](this.locations.get(name), ...values);
  }
  create(width, height) {
    const gl = this.gl;
    if (width <= 0 || height <= 0 || width > this.maxTextureSize || height > this.maxTextureSize) throw new Error(`GPU image has invalid dimensions: ${width}x${height}`);
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    // Every target uses one immutable, sized RGBA8 colour attachment. Validate
    // this layout once; querying every allocation synchronously drains the GPU
    // command queue during rapid layer creation (notably Ctrl skip).
    if (!this.framebufferValidated) {
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('GPU framebuffer is incomplete');
      this.framebufferValidated = true;
    }
    return { device: this, texture, framebuffer, width, height, modified: false, filter: gl.NEAREST };
  }
  texture(image, discard = false) {
    if (this.lost) throw new Error('WebGL context was lost; reload the game');
    if (image.gray) throw new Error('GPU operations require an RGBA image');
    let entry = this.textures.get(image);
    if (entry && (entry.width !== image.width || entry.height !== image.height)) {
      this.releaseTexture(entry);
      entry = null;
    }
    if (!entry) {
      entry = this.create(image.width, image.height);
      entry.image = new WeakRef(image);
      this.textures.set(image, entry);
      this.imageTextures.add(entry);
      this.textureBytes += entry.width * entry.height * 4;
      this.textureFinalizer.register(image, entry, entry);
    }
    if (!discard && (image.gpu !== entry || image.externallyWritable)) {
      const pixels = '_pixels' in image ? image._pixels : image.pixels;
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      if (pixels) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, image.width, image.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        this.stats.uploads++;
        this.stats.uploadedBytes += pixels.byteLength;
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, entry.framebuffer);
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      entry.modified = false;
    }
    image.gpu = entry;
    return entry;
  }
  releaseTexture(entry) {
    const image = entry.image.deref();
    if (image?.gpu === entry) image.gpu = null;
    this.textureFinalizer.unregister(entry);
    this.imageTextures.delete(entry);
    this.textureBytes -= entry.width * entry.height * 4;
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
    return this.scratch;
  }
  bind(entry, unit, uniform) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    this.uniform(uniform, 'uniform1i', unit);
  }
  setup(target, source, rect, matrix, clip, destination) {
    const gl = this.gl;
    gl.useProgram(this.program);
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
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture ?? null);
    this.uniform('lutTexture', 'uniform1i', 5);
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.kernelTexture ?? null);
    this.uniform('kernelTexture', 'uniform1i', 6);
    this.uniform('blurRadius', 'uniform1i', 0);
    this.uniform('blurSigma', 'uniform1f', 1);
    this.uniform('blurStep', 'uniform2i', 1, 0);
    this.uniform('sourceSize', 'uniform2f', source.width, source.height);
    this.uniform('smoothSampling', 'uniform1i', 0);
    this.uniform('explicitCoverage', 'uniform1i', 0);
    this.uniform('colourOp', 'uniform1i', 0);
    this.uniform('colourValue', 'uniform1i', 0);
    this.uniform('colourOpa', 'uniform1i', 255);
    this.uniform('lutOp', 'uniform1i', 0);
    this.uniform('transformOp', 'uniform1i', 0);
    this.uniform('blurLeft', 'uniform1i', 0);
    this.uniform('blurTop', 'uniform1i', 0);
    this.uniform('blurRight', 'uniform1i', 0);
    this.uniform('blurBottom', 'uniform1i', 0);
    this.uniform('blurAlpha', 'uniform1i', 0);
    this.uniform('targetSize', 'uniform2f', target.width, target.height);
    this.uniform('sourceRect', 'uniform4f', rect.left, rect.top, rect.right, rect.bottom);
    this.uniform('transform', 'uniformMatrix3fv', false, [matrix[0], matrix[1], 0, matrix[2], matrix[3], 0, matrix[4], matrix[5], 1]);
  }
  draw(targetImage, sourceImage, options = {}) {
    const {
      matrix = [1, 0, 0, 1, 0, 0],
      sourceRect = { left: 0, top: 0, right: sourceImage.width, bottom: sourceImage.height },
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
      smooth = false
    } = options;
    const clip = this.clip(targetImage, options.clip);
    if (sourceRect.right <= sourceRect.left || sourceRect.bottom <= sourceRect.top) return;
    // LayerBitmapIntf::Blt returns before any primitive at opacity zero.
    if (opacity <= 0) return;
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
    const source = this.texture(sourceImage), target = this.texture(targetImage);
    const filter = smooth ? this.gl.LINEAR : this.gl.NEAREST;
    if (source.filter !== filter) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      source.filter = filter;
    }
    const destination = this.snapshot(target, sourceImage === targetImage ? this.clip(targetImage) : clip);
    const inverse = mat2d.invert(new Float64Array(6), matrix);
    if (!inverse) return;
    this.setup(target, sourceImage === targetImage ? destination : source, clip, [1,0,0,1,0,0], clip, destination);
    this.uniform('explicitCoverage', 'uniform1i', 1);
    this.uniform('smoothSampling', 'uniform1i', smooth ? 1 : 0);
    this.uniform('inverseTransform', 'uniformMatrix3fv', false, [
      inverse[0], inverse[1], 0,
      inverse[2], inverse[3], 0,
      inverse[4], inverse[5], 1
    ]);
    this.uniform('sampleRect', 'uniform4f', sourceRect.left, sourceRect.top, sourceRect.right, sourceRect.bottom);
    this.uniform('operation', 'uniform1i', maskOnly ? 6 : motion ? 1 : 0);
    this.uniform('mode', 'uniform1i', mode);
    this.uniform('opacity', 'uniform1i', opacity);
    this.uniform('opaque', 'uniform1i', opaque ? 1 : 0);
    this.uniform('policy', 'uniform1i', Number(holdAlpha) | Number(destinationAlpha)<<1 | Number(additiveDestination)<<2 | Number(copySourceAlpha)<<3 | Number(ignoreSourceAlpha)<<4);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    this.stats.draws++;
    this.commit(targetImage, target);
  }
  commit(image, entry) {
    entry.modified = true;
    if (image.externallyWritable) {
      const pixels = this.read(entry);
      if (image._pixels) image._pixels.set(pixels); else image._pixels = pixels;
      image.gpu = null;
    }
  }
  clip(image, rect = { left: 0, top: 0, right: image.width, bottom: image.height }) {
    return {
      left: Math.max(0, Math.floor(rect.left)),
      top: Math.max(0, Math.floor(rect.top)),
      right: Math.min(image.width, Math.ceil(rect.right)),
      bottom: Math.min(image.height, Math.ceil(rect.bottom))
    };
  }
  fill(image, rect, rgba, maskOnly = false) {
    const clip = this.clip(image, rect);
    if (clip.right <= clip.left || clip.bottom <= clip.top) return;
    const full = !maskOnly && clip.left === 0 && clip.top === 0 && clip.right === image.width && clip.bottom === image.height;
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
  // LayerBitmapIntf FillColor / FillColorOnAlpha / FillColorOnAddAlpha /
  // RemoveConstOpacity: the colour ops only touch the destination buffer.
  colour(image, rect, argb, opa, op) {
    this.pixelOperation(image, rect, 9, () => {
      this.uniform('colourOp', 'uniform1i', op);
      this.uniform('colourValue', 'uniform1i', argb | 0);
      this.uniform('colourOpa', 'uniform1i', opa);
    });
  }
  // TVPAdjustGamma / Layer.light: the tables are computed on the host with the
  // reference arithmetic and applied as a lookup texture.
  applyLookup(image, rect, tables, additive = false) {
    const data = new Uint8Array(256 * 3);
    for (let channel = 0; channel < 3; channel++) data.set(tables[channel], channel * 256);
    const gl = this.gl;
    if (!this.lutTexture) {
      this.lutTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, 3, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 3, gl.RED, gl.UNSIGNED_BYTE, data);
    }
    this.pixelOperation(image, rect, 10, () => this.uniform('lutOp', 'uniform1i', additive ? 1 : 0));
  }
  // TVPDoGrayScale (0) / TVPConvertAlphaToAdditiveAlpha (1) / TVPConvertAdditiveAlphaToAlpha (2).
  transform(image, rect, kind) {
    this.pixelOperation(image, rect, 11, () => this.uniform('transformOp', 'uniform1i', kind));
  }
  // tTJSNI_BaseLayer::ApplyGaussianBlur: two separable convolution passes.
  // Pass one writes the horizontally blurred copy into a scratch target, pass
  // two writes the image texture in place, so no readback is needed.
  gaussianBlur(image, radius, sigma) {
    if (this.lost) throw new Error('WebGL context was lost; reload the game');
    if (image.gray) throw new Error('GPU operations require an RGBA image');
    if (!image.width || !image.height || !(radius > 0) || !(sigma > 0)) return;
    const gl = this.gl;
    this.uploadKernel(radius, sigma);
    const source = this.texture(image);
    const clip = this.clip(image);
    const full = { left: 0, top: 0, right: image.width, bottom: image.height };
    // The scratch target must match the image exactly: the pass clamps sample
    // coordinates to the texture size, which has to be the image size.
    if (!this.blurTarget || this.blurTarget.width !== image.width || this.blurTarget.height !== image.height) {
      if (this.blurTarget) {
        gl.deleteTexture(this.blurTarget.texture);
        gl.deleteFramebuffer(this.blurTarget.framebuffer);
      }
      this.blurTarget = this.create(image.width, image.height);
    }
    const identity = [1, 0, 0, 1, 0, 0];
    const pass = (target, input, stepX, stepY) => {
      this.setup(target, input, full, identity, clip, input);
      this.uniform('operation', 'uniform1i', 13);
      this.uniform('opaque', 'uniform1i', 0);
      this.uniform('blurRadius', 'uniform1i', radius);
      this.uniform('blurStep', 'uniform2i', stepX, stepY);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    };
    pass(this.blurTarget, source, 1, 0);
    pass(source, this.blurTarget, 0, 1);
    this.stats.draws += 2;
    this.commit(image, source);
  }
  uploadKernel(radius, sigma) {
    const gl = this.gl;
    const size = radius * 2 + 1;
    const data = new Float32Array(size);
    // generate_1d_gaussian_kernel, including its float32 rounding at every step.
    const s32 = Math.fround(sigma);
    const rSquared = Math.fround(Math.fround(2 * s32) * s32);
    let sum = 0;
    for (let i = 0; i < size; i++) {
      const x = i - radius;
      data[i] = Math.fround(Math.exp(Math.fround(-Math.fround(x * x) / rSquared)));
      sum = Math.fround(sum + data[i]);
    }
    for (let i = 0; i < size; i++) data[i] = Math.fround(data[i] / sum);
    if (!this.kernelTexture) {
      this.kernelTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.kernelTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    gl.bindTexture(gl.TEXTURE_2D, this.kernelTexture);
    if (this.kernelSize !== size) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, size, 1, 0, gl.RED, gl.FLOAT, data);
      this.kernelSize = size;
    } else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, 1, gl.RED, gl.FLOAT, data);
  }
  // iTVPBaseBitmap::DoBoxBlur / DoBoxBlurForAlpha with area offsets.
  boxBlur(image, rect, area, alphaMode) {
    this.pixelOperation(image, rect, 12, () => {
      this.uniform('blurLeft', 'uniform1i', area.left);
      this.uniform('blurTop', 'uniform1i', area.top);
      this.uniform('blurRight', 'uniform1i', area.right);
      this.uniform('blurBottom', 'uniform1i', area.bottom);
      this.uniform('blurAlpha', 'uniform1i', alphaMode ? 1 : 0);
    });
  }
  // Runs a whole-buffer pass reading the previous content and writing it back.
  pixelOperation(image, rect, operation, setUniforms) {
    if (this.lost) throw new Error('WebGL context was lost; reload the game');
    if (image.gray) throw new Error('GPU operations require an RGBA image');
    const clip = this.clip(image, rect);
    if (clip.right <= clip.left || clip.bottom <= clip.top) return;
    const target = this.texture(image);
    const previous = this.snapshot(target, this.clip(image));
    const full = { left: 0, top: 0, right: image.width, bottom: image.height };
    this.setup(target, previous, full, [1, 0, 0, 1, 0, 0], clip, previous);
    // Scratch capacity may exceed this image; neighbourhood filters must clamp
    // to the logical image bounds, not to unused texels in the scratch buffer.
    this.uniform('sourceSize', 'uniform2f', image.width, image.height);
    this.uniform('operation', 'uniform1i', operation);
    this.uniform('opaque', 'uniform1i', 0);
    setUniforms();
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    this.stats.draws++;
    this.commit(image, target);
  }
  copy(targetImage, sourceImage) {
    const source = this.texture(sourceImage), target = this.texture(targetImage, true), gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer);
    gl.blitFramebuffer(0, 0, source.width, source.height, 0, 0, target.width, target.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.commit(targetImage, target);
  }
  crossfade(image, a, b, phase, type, rule = null, vague = 0) {
    const ruleSource = rule ? this.texture(rule) : null;
    const source = this.texture(a);
    const second = this.texture(b);
    const target = this.texture(image, true);
    this.setup(target, source, { left: 0, top: 0, right: image.width, bottom: image.height }, [1, 0, 0, 1, 0, 0], this.clip(image), second);
    this.bind(second, 2, 'secondTexture');
    if (ruleSource) this.bind(ruleSource, 3, 'ruleTexture');
    this.uniform('operation', 'uniform1i', rule ? 8 : 3);
    this.uniform('phase', 'uniform1i', phase);
    this.uniform('layerType', 'uniform1i', type);
    this.uniform('vague', 'uniform1i', vague);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 6);
    this.stats.draws++;
    this.commit(image, target);
  }
  universal(image, a, b, rule, phase, vague, type) {
    this.crossfade(image, a, b, phase, type, rule, vague);
  }
  present(image, canvas) {
    const source = this.texture(image);
    const gl = this.gl;
    if (this.canvas.width !== image.width) this.canvas.width = image.width;
    if (this.canvas.height !== image.height) this.canvas.height = image.height;
    this.setup({ framebuffer: null, width: image.width, height: image.height }, source, { left: 0, top: 0, right: image.width, bottom: image.height }, [1, 0, 0, 1, 0, 0], this.clip(image), source);
    this.uniform('operation', 'uniform1i', 4);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    let context = this.presenters.get(canvas);
    if (!context) {
      context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('GPU presentation requires CanvasRenderingContext2D');
      this.presenters.set(canvas, context);
    }
    // Copy the rendered canvas directly. Safari's transferToImageBitmap path
    // can block for an entire frame while exporting the WebGL drawing buffer.
    context.drawImage(this.canvas, 0, 0);
  }
  diagnostics() { return { ...this.stats, textureBytes: this.textureBytes }; }
  stop() {}
  finalize() {
    for (const entry of this.imageTextures) this.releaseTexture(entry);
    this.textures = new WeakMap();
    const gl=this.gl;
    if (this.scratch) {
      gl.deleteTexture(this.scratch.texture);
      gl.deleteFramebuffer(this.scratch.framebuffer);
    }
    gl.deleteTexture(this.tables);
    if (this.lutTexture) gl.deleteTexture(this.lutTexture);
    if (this.kernelTexture) gl.deleteTexture(this.kernelTexture);
    if (this.blurTarget) {
      gl.deleteTexture(this.blurTarget.texture);
      gl.deleteFramebuffer(this.blurTarget.framebuffer);
    }
    gl.deleteProgram(this.program);
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    if (device === this) device = null;
  }
}
