// TransIntf.cpp's three default providers and tvpgl.cpp's software blends.
import { Image } from './bitmap.js';
import { getGPU } from './gpu.js';
import { number } from '#krkr/values';

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
    getGPU().crossfade(frame, src1, src2, phase, type);
  },
}));

registerTransition('universal', async ({ option, required, loadGraphic, width, height, type }) => {
  const vague = Math.trunc(number(await option('vague', 64)));
  const ruleName = String(await required('rule'));
  const { image } = await loadGraphic(ruleName, 0x02ffffff, { gray: true });
  // GraphicsLoaderIntf.cpp expands undersized requested images by tiling.
  const rule = new Image(Math.max(width, image.width), Math.max(height, image.height), { gray: true });
  for (let y = 0; y < rule.height; y++) for (let x = 0; x < rule.width; x++) {
    const offset = image.index(x % image.width, y % image.height);
    rule.pixels[rule.index(x, y)] = image.gray ? image.pixels[offset]
      : (image.pixels[offset * 4] * 54 + image.pixels[offset * 4 + 1] * 183 + image.pixels[offset * 4 + 2] * 19) >> 8;
  }
  const ruleRGBA = new Image(rule.width, rule.height);
  for (let i = 0; i < rule.pixels.length; i++) {
    ruleRGBA.pixels[i * 4] = rule.pixels[i];
    ruleRGBA.pixels[i * 4 + 3] = 255;
  }
  return {
    maxPhase: 255 + vague,
    render(frame, src1, src2, phase) {
      getGPU().universal(frame, src1, src2, ruleRGBA, phase, vague, type);
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
