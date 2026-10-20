import { callScript, nativeOwner } from '#krkr/native';
import { number, integer } from '#krkr/values';

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

// Coverage of source pixel i by the interval [r1, r2) inside [0, size).
const axisWeights = (r1, r2, size) => {
  const result = [];
  const first = Math.max(0, Math.floor(r1)), last = Math.min(size - 1, Math.ceil(r2) - 1);
  for (let i = first; i <= last; i++) {
    const weight = Math.min(r2, i + 1) - Math.max(r1, i);
    if (weight > 0) result.push([i, weight]);
  }
  return result;
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
    // makeAvgTable (shrinkCopy.cpp 221): source interval per destination column
    // and row. Coordinates stay relative to the clipped source origin.
    const columns = [];
    for (let x = dsx; x < dex; x++) {
      const r1 = (x - diffX) * ratioX;
      columns.push(axisWeights(r1, r1 + ratioX, ssw));
    }
    const rows = [];
    for (let y = dsy; y < dey; y++) {
      const r1 = (y - diffY) * ratioY;
      rows.push(axisWeights(r1, r1 + ratioY, ssh));
    }
    const pixels = srcImage.pixels, target = dstImage.pixels;
    const srcPitch = siw * 4, dstPitch = diw * 4, area = ratioX * ratioY;
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y], dy = (dty + dsy + y) * dstPitch;
      for (let x = 0; x < columns.length; x++) {
        const column = columns[x];
        let alpha = 0, red = 0, green = 0, blue = 0;
        for (const [sy, wy] of row) {
          const line = (ssy + sy) * srcPitch;
          for (const [sx, wx] of column) {
            const weight = wx * wy, index = line + (ssx + sx) * 4;
            red += weight * pixels[index];
            green += weight * pixels[index + 1];
            blue += weight * pixels[index + 2];
            alpha += weight * pixels[index + 3];
          }
        }
        const index = dy + (dtx + dsx + x) * 4;
        target[index] = Math.min(255, Math.trunc(red / area));
        target[index + 1] = Math.min(255, Math.trunc(green / area));
        target[index + 2] = Math.min(255, Math.trunc(blue / area));
        target[index + 3] = Math.min(255, Math.trunc(alpha / area));
      }
    }
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
    const pixels = srcImage.pixels;
    // LimitedShrink::resize: ceil(size / step) through the layer's own method.
    const width = Math.ceil(siw / stepX), height = Math.ceil(sih / stepY);
    await callScript(nativeOwner(this), 'setImageSize', [width, height]);
    const dstImage = this.node.image;
    const target = dstImage.pixels;
    const srcPitch = siw * 4, dstPitch = dstImage.width * 4;
    const xGroups = Math.trunc(siw / stepX), xRemainder = siw - xGroups * stepX;
    const yGroups = Math.trunc(sih / stepY), yRemainder = sih - yGroups * stepY;
    // ShrinkLine (shrinkCopy.cpp 419): RGB is averaged, alpha is forced opaque.
    const block = (srcX, srcY, columns, rows, outX, outY) => {
      let red = 0, green = 0, blue = 0;
      for (let y = 0; y < rows; y++) {
        const line = (srcY + y) * srcPitch;
        for (let x = 0; x < columns; x++) {
          const index = line + (srcX + x) * 4;
          red += pixels[index];
          green += pixels[index + 1];
          blue += pixels[index + 2];
        }
      }
      const count = columns * rows, index = outY * dstPitch + outX * 4;
      target[index] = count > 0 ? Math.min(255, Math.trunc(red / count)) : 0;
      target[index + 1] = count > 0 ? Math.min(255, Math.trunc(green / count)) : 0;
      target[index + 2] = count > 0 ? Math.min(255, Math.trunc(blue / count)) : 0;
      target[index + 3] = 255;
    };
    for (let group = 0; group < yGroups; group++) {
      const srcY = group * stepY;
      for (let column = 0; column < xGroups; column++) block(column * stepX, srcY, stepX, stepY, column, group);
      if (xRemainder) block(xGroups * stepX, srcY, xRemainder, stepY, xGroups, group);
    }
    if (yRemainder) {
      const srcY = yGroups * stepY;
      for (let column = 0; column < xGroups; column++) block(column * stepX, srcY, stepX, yRemainder, column, yGroups);
      if (xRemainder) block(xGroups * stepX, srcY, xRemainder, yRemainder, xGroups, yGroups);
    }
    this.node.imageModified = true;
  });
}
