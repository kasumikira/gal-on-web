import { callScript, nativeOwner } from '#krkr/native';
import { number, integer } from '#krkr/values';
import { rasterCopy } from './gpu-resample.js';

// layerExRaster.cpp: Layer.copyRaster(src, maxh, lines, cycle, time) copies the
// source layer row by row into this layer, shifting each row horizontally by
// sin(rad) * maxh. The phase advances once per row and is driven by `time`, so
// the result is a raster-scroll wave over the clipped area. redraw() in the
// reference is Layer.update(clip), which the port implements as the virtual
// onPaint dispatch plus a repaint request.
const sourceImage = (Layer, value) => {
  let state;
  try { state = Layer.state(value); } catch { return null; }
  const node = state.node, image = node?.image;
  return image ? image : null;
};

export function registerLayerExRaster({ get }) {
  const Layer = get('Layer');
  Layer.defineMember('copyRaster', async function(layer, maxh, lines, cycle, time) {
    if (arguments.length < 5) throw new Error('TJS Layer.copyRaster requires 5 arguments');
    const srcImage = sourceImage(Layer, layer), node = this.node, dstImage = node?.image;
    if (!srcImage || !dstImage) return;
    // layerExRaster::copyRaster (layerExRaster.cpp 44): the cached geometry must
    // match the source layer exactly.
    if (srcImage.width !== dstImage.width || srcImage.height !== dstImage.height) return;
    const amplitude = Math.trunc(number(maxh)), lineCount = Math.trunc(number(lines));
    const period = Math.trunc(number(cycle)), now = Number(integer(time));
    // The reference divides by these without a guard; refuse instead of writing
    // NaN offsets.
    if (!(lineCount > 0) || !(period > 0)) return;
    const clip = node.clip;
    const clipLeft = clip?.left ?? 0, clipTop = clip?.top ?? 0;
    const clipWidth = (clip?.right ?? dstImage.width) - clipLeft;
    const clipHeight = (clip?.bottom ?? dstImage.height) - clipTop;
    const omega = 2 * Math.PI / lineCount;
    // The wave is centred on the source height and starts at the clip top.
    let rad = -omega * now / period * Math.trunc(srcImage.height / 2) + omega * clipTop;
    const shifts = [];
    for (let row = 0; row < clipHeight; row++, rad += omega) {
      shifts.push(Math.trunc(Math.sin(rad) * amplitude));
    }
    if (clipWidth <= 0 || clipHeight <= 0) return;
    rasterCopy(srcImage, dstImage, shifts, {
      left: clipLeft, top: clipTop, right: clipLeft + clipWidth, bottom: clipTop + clipHeight,
    });
    node.imageModified = true;
    // layerExBase::redraw(): update(clipLeft, clipTop, clipWidth, clipHeight).
    await callScript(nativeOwner(this), 'update', [clipLeft, clipTop, clipWidth, clipHeight]);
  });
}
