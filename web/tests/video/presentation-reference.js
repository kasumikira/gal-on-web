// Legacy JS Layer presentation retained for comparison tests only.
import { Image } from './bitmap-reference.js';
import { getGPU } from './gpu-reference.js';

// Upload a decoded canvas-backend frame to the Image's resident texture; DOM-source uploads
// preserve straight alpha.
export function uploadVideoCanvas(image, canvas) {
  const gpu = getGPU();
  if (!gpu) throw new Error('Video frame upload requires the GPU renderer');
  gpu.uploadCanvas(image, canvas);
}

// tTVPBaseBitmap::Update(pixels, pitch, 0, 0, width, height): the image may be larger than
// the layer. Write rows using the image's own stride instead of assuming it equals the frame width.
function writeFramePixels(image, rgba, width, height) {
  const stride = image.width;
  const target = image.writablePixels;
  if (stride === width) {
    target.set(rgba.subarray(0, width * height * 4));
    return;
  }
  for (let y = 0; y < height; y++) {
    target.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride * 4);
  }
}

// Shared layer presentation entry point. targets are layer script objects. Upload a canvas
// frame once and copy it to additional layers on the GPU (VideoOvlImpl's double-buffered
// EC_UPDATE); write byte frames directly to the main image.
// If left/top are omitted, leave the layer position unchanged (VideoOverlay manages it via setPos).
export async function presentVideoFrame(targets, frame, { Layer, left, top, size = true, repaint = null } = {}) {
  const width = frame.width | 0, height = frame.height | 0;
  const canvas = frame.canvas;
  const entries = [];
  for (const target of targets ?? []) {
    if (!target) continue;
    const node = Layer.peekState(target)?.node ?? Layer.peekNode(target);
    if (node) entries.push({ target, node });
  }
  let uploaded = null;
  let adopted = null;
  for (const { target, node } of entries) {
    // Empty frames still clear the layer rectangle, move it and request repaint.
    if (size && Layer.resizeNode) Layer.resizeNode(node, width, height);
    else if (size) { node.width = width; node.height = height; }
    if (width > 0 && height > 0) {
      if (canvas) {
        // Canvas upload cannot change texture dimensions; replace the image when dimensions change.
        if (node.image.width !== width || node.image.height !== height) {
          node.image = new Image(width, height, { defer: true });
        }
        if (!uploaded || uploaded.width !== width || uploaded.height !== height) {
          uploadVideoCanvas(node.image, canvas);
          uploaded = node.image;
        } else if (node.image !== uploaded) {
          getGPU().copy(node.image, uploaded);
        }
      } else if (frame.rgba) {
        if (frame.ownedPixels && !node.image.gray && !node.image.externallyWritable &&
            node.image.width === width && node.image.height === height) {
          // Adopt transferred bytes on full overwrite. Other targets share CoW
          // storage rather than sharing a mutable array outside Image ownership.
          if (adopted) node.image.assign(adopted);
          else { node.image.pixels = frame.rgba; adopted = node.image; }
        } else writeFramePixels(node.image, frame.rgba, width, height);
      }
      node.imageModified = true;
    }
    if (left !== undefined) node.left = Math.trunc(left);
    if (top !== undefined) node.top = Math.trunc(top);
    if (repaint) await repaint(target, node);
  }
  return entries.length;
}
