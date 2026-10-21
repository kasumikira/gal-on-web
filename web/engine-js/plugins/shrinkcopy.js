import { callScript, nativeOwner } from '#krkr/native';
import { number, integer } from '#krkr/values';
import { captureImageTexture, releaseImageTexture, shrinkArea } from './gpu-resample.js';

// shrinkCopy.cpp: Layer.shrinkCopy(dx, dy, dw, dh, src, sx, sy, sw, sh) and
// Layer.shrinkCopyFast(src, stepx, stepy). Both run on the destination layer
// (the call target) and only ever shrink. The reference averages RGBA bytes
// independently. The box weights are the reference's fractional coverage
// evaluated in floating point instead of 1/256 fixed point; clipped source
// edges are omitted from the accumulated source area.
const trunc = Math.trunc;
const invalid = () => { throw new Error('TJS invalid parameter'); };
// The destination is the call target's native state; sources arrive as script
// values, so ask the Layer class for their state.
const destinationInfo = state => {
  const node = state?.node, image = node?.image;
  return image ? { node, image } : null;
};
const sourceInfo = (Layer, value) => {
  let state;
  try { state = Layer.state(value); } catch { return null; }
  const node = state.node, image = node?.image;
  return image ? { node, image } : null;
};

export function registerShrinkCopy({ get }) {
  const Layer = get('Layer');

  Layer.defineMember('shrinkCopy', async function(dx, dy, dw, dh, src, sx, sy, sw, sh) {
    if (arguments.length < 9) throw new Error('TJS Layer.shrinkCopy requires 9 arguments');
    const source = sourceInfo(Layer, src), destination = destinationInfo(this);
    let ddx = number(dx), ddy = number(dy), ddw = number(dw), ddh = number(dh);
    let ssx = Number(integer(sx)), ssy = Number(integer(sy));
    let ssw = Number(integer(sw)), ssh = Number(integer(sh));
    // ShrinkCopy::check (shrinkCopy.cpp 109): positive sizes, shrink only.
    if (!(ssw > 0 && ssh > 0 && ddw > 0 && ddh > 0 && ssw >= trunc(ddw) && ssh >= trunc(ddh))) invalid();
    if (!source || !destination) invalid();
    const srcImage = source.image, dstImage = destination.image;
    const siw = srcImage.width, sih = srcImage.height, diw = dstImage.width, dih = dstImage.height;
    const zx = ddw / ssw, zy = ddh / ssh;
    // ShrinkCopy::clip (shrinkCopy.cpp 123).
    if (ssx + ssw <= 0 || ssy + ssh <= 0 || ssx >= siw || ssy >= sih) return;
    if (ssx < 0) { ssw += ssx; ddw -= zx * -ssx; ddx += zx * -ssx; ssx = 0; }
    if (ssy < 0) { ssh += ssy; ddh -= zy * -ssy; ddy += zy * -ssy; ssy = 0; }
    let cut = ssx + ssw - siw;
    if (cut > 0) { ssw -= cut; ddw -= zx * cut; }
    cut = ssy + ssh - sih;
    if (cut > 0) { ssh -= cut; ddh -= zy * cut; }
    const dtx = trunc(ddx), dty = trunc(ddy);
    let dtw = trunc(ddx + ddw) - dtx, dth = trunc(ddy + ddh) - dty;
    if (ddx + ddw > dtx + dtw) dtw++;
    if (ddy + ddh > dty + dth) dth++;
    if (dtx + dtw <= 0 || dty + dth <= 0 || dtx >= diw || dty >= dih) return;
    const dsx = dtx < 0 ? -dtx : 0, dsy = dty < 0 ? -dty : 0;
    const dex = dtx + dtw > diw ? diw - dtx : dtw;
    const dey = dty + dth > dih ? dih - dty : dth;
    const ratioX = ssw / ddw, ratioY = ssh / ddh;
    const diffX = ddx - dtx, diffY = ddy - dty;
    shrinkArea(srcImage, dstImage, {
      clip: { left: dtx + dsx, top: dty + dsy, right: dtx + dex, bottom: dty + dey },
      sourceOrigin: [ssx, ssy], sourceExtent: [ssw, ssh],
      destinationOrigin: [dtx, dty], outputOrigin: [dtx + dsx, dty + dsy],
      outputSize: [dex - dsx, dey - dsy], ratio: [ratioX, ratioY], destinationOffset: [diffX, diffY],
    });
    destination.node.imageModified = true;
  });

  Layer.defineMember('shrinkCopyFast', async function(src, stepx, stepy = 0) {
    if (arguments.length < 2) throw new Error('TJS Layer.shrinkCopyFast requires 2 arguments');
    const source = sourceInfo(Layer, src), destination = destinationInfo(this);
    const stepX = Number(integer(stepx)), stepY = Number(integer(stepy)) || stepX;
    // LimitedShrink::check (shrinkCopy.cpp 376): both steps must be positive.
    if (!(stepX > 0 && stepY > 0)) invalid();
    if (!source || !destination) invalid();
    const srcImage = source.image, siw = srcImage.width, sih = srcImage.height;
    // Read the source before resizing: the reference captures the source pointer
    // in check() and only then calls setImageSize on the destination.
    // LimitedShrink::resize: ceil(size / step) through the layer's own method.
    const width = Math.ceil(siw / stepX), height = Math.ceil(sih / stepY);
    const sourceEntry = srcImage === destination.image ? captureImageTexture(srcImage) : null;
    try {
      await callScript(nativeOwner(this), 'setImageSize', [width, height]);
      const dstImage = this.node.image;
      shrinkArea(srcImage, dstImage, {
        sourceEntry,
        clip: { left: 0, top: 0, right: width, bottom: height },
        sourceOrigin: [0, 0], sourceExtent: [siw, sih], destinationOrigin: [0, 0],
        outputOrigin: [0, 0], outputSize: [width, height], ratio: [stepX, stepY], fast: true,
      });
    } finally {
      if (sourceEntry) releaseImageTexture(sourceEntry);
    }
    this.node.imageModified = true;
  });
}
