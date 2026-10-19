// The browser-side Bitmap native object.  BitmapIntf.cpp stores a writable
// tTVPBaseBitmap per native instance; this class keeps the same ownership
// boundary by storing an engine Image in NativeClass.instances.  Layer copy
// operations deliberately inspect this state instead of accepting arbitrary
// objects that merely happen to contain an image.
import { nativeClass, nativeMethod, nativeProperty } from '#krkr/native';
import { number, truth, Closure } from '#krkr/values';
import { Image, toActualColor } from './bitmap.js';
import { makeBMP, encodeTLG } from './image-codecs/encode.js';

const unwrap = value => value instanceof Closure ? value.object : value;
const integer = value => Math.trunc(number(value));

function imageFromGraphic(result) {
  const image = result?.image ?? result;
  if (!(image instanceof Image)) throw new Error('TJS graphic loader returned no bitmap image');
  return image.clone();
}

function drawableBitmap(state) {
  if (state.loading) throw new Error('TJS bitmap is currently loading');
  if (!state.image) throw new Error('TJS bitmap has no drawable image');
  return state;
}

/**
 * Create the Bitmap class used by the browser runtime.
 *
 * `loadGraphic` is the runtime's existing graphic loader and `storage` is
 * the existing Storages object.  No loader is invented here: attempting to
 * load without one fails explicitly, which keeps browser limitations visible.
 */
export function createBitmapClass({ storage, loadGraphic } = {}) {
  // BitmapIntf.cpp uses clNone as the default colour key.  This is distinct
  // from the numeric zero key used by a few older browser stubs.
  const defaultColorKey = 0x1fffffff;
  const loadBitmap = async (owner, name, key = defaultColorKey) => {
    if (!loadGraphic) throw new Error('TJS Bitmap loading requires the browser graphic loader');
    const state = Bitmap.instances.get(unwrap(owner));
    if (!state) throw new Error('TJS Bitmap native instance not found');
    if (state.loading) throw new Error('TJS bitmap is currently loading');
    state.loading = true;
    try {
      const result = await loadGraphic(name, integer(key));
      state.image = imageFromGraphic(result);
      return result?.metainfo;
    } finally { state.loading = false; }
  };

  @nativeClass('Bitmap')
  class Bitmap {
    // TVPGetInitialBitmap() is a 1x1 writable texture in the native runtime.
    static initialize() { return { image: new Image(1, 1), loading: false }; }

    @nativeMethod async Bitmap(...args) {
      const state = this;
      if (!state) throw new Error('TJS Bitmap native instance not found');
      if (!args.length) return;
      if (typeof args[0] === 'string') {
        if (!loadGraphic) throw new Error('TJS Bitmap loading requires the browser graphic loader');
        state.loading = true;
        try { state.image = imageFromGraphic(await loadGraphic(args[0], args.length >= 2 ? integer(args[1]) : defaultColorKey)); }
        finally { state.loading = false; }
        return;
      }
      if (args.length < 2) throw new Error('TJS Bitmap constructor requires a file name or width and height');
      const width = integer(args[0]), height = integer(args[1]), bpp = args.length >= 3 ? integer(args[2]) : 32;
      if (width <= 0 || height <= 0) throw new Error('TJS cannot create an empty Bitmap');
      if (bpp !== 32) throw new Error('TJS browser Bitmap supports only 32bpp images');
      state.image = new Image(width, height);
    }
    @nativeMethod getPixel(x, y) {
      const image = drawableBitmap(this).image;
      return image.point(integer(x), integer(y)) & 0x00ffffff;
    }
    @nativeMethod setPixel(x, y, color) {
      if (arguments.length < 3) throw new Error('TJS Bitmap.setPixel requires 3 arguments');
      const image = drawableBitmap(this).image;
      const px = integer(x), py = integer(y), old = image.point(px, py);
      image.setPoint(px, py, ((old & 0xff000000) | (toActualColor(color) & 0x00ffffff)) >>> 0);
    }
    @nativeMethod getMaskPixel(x, y) {
      return (drawableBitmap(this).image.point(integer(x), integer(y)) >>> 24) & 0xff;
    }
    @nativeMethod setMaskPixel(x, y, mask) {
      if (arguments.length < 3) throw new Error('TJS Bitmap.setMaskPixel requires 3 arguments');
      const image = drawableBitmap(this).image, px = integer(x), py = integer(y);
      image.setPoint(px, py, ((image.point(px, py) & 0x00ffffff) | ((integer(mask) & 0xff) << 24)) >>> 0);
    }
    @nativeMethod independ(copy = true) {
      const state = drawableBitmap(this);
      // Every Image owns its own pixel array.  Cloning for the copy=true case
      // preserves the native operation's observable isolation; the no-copy
      // branch is already independent because there is no shared backing
      // texture in this browser implementation.
      if (truth(copy)) state.image = state.image.clone();
    }
    @nativeMethod setSize(width, height) {
      if (arguments.length < 2) throw new Error('TJS Bitmap.setSize requires 2 arguments');
      const state = drawableBitmap(this), w = integer(width), h = integer(height);
      if (w <= 0 || h <= 0) throw new Error('TJS cannot create an empty Bitmap');
      state.image = state.image.resized(w, h, 0).clone();
    }
    @nativeMethod copyFrom(source) {
      if (!arguments.length) throw new Error('TJS Bitmap.copyFrom requires a Bitmap');
      const target = drawableBitmap(this), value = unwrap(source), sourceState = Bitmap.instances.get(value);
      if (!sourceState?.image || sourceState.loading) throw new Error('TJS invalid Bitmap parameter');
      target.image = sourceState.image.clone();
    }
    @nativeMethod async save(name, type = 'bmp') {
      const image = drawableBitmap(this).image;
      if (!storage?.write) throw new Error('TJS storage is read-only; Bitmap.save cannot persist browser data');
      const format = String(type).toLowerCase().replace(/^\./, '');
      if (format !== 'bmp' && format !== 'bmp8' && format !== 'bmp24' && format !== 'bmp32'
        && format !== 'tlg' && format !== 'tlg5' && format !== 'tlg6' && format !== 'tlg524' && format !== 'tlg624') {
        throw new Error(`TJS Bitmap.save does not support ${format} without a browser encoder`);
      }
      const bytes = format === 'tlg' || format === 'tlg5' || format === 'tlg6' || format === 'tlg524' || format === 'tlg624'
        ? encodeTLG(image, format === 'tlg' ? 'tlg5' : format)
        : makeBMP(image, format === 'bmp8' ? 8 : format === 'bmp24' ? 24 : 32);
      await storage.write(name, bytes);
    }
    @nativeMethod async load(name, key = defaultColorKey) {
      return loadBitmap(this, name, key);
    }
    @nativeMethod async loadAsync(name, key = defaultColorKey) {
      // Browser decoding is asynchronous already; expose the same completed
      // operation while retaining the native loading guard during the decode.
      return loadBitmap(this, name, key);
    }

    @nativeProperty get width() { return drawableBitmap(this).image.width; }
    @nativeProperty set width(value) {
      const state = drawableBitmap(this);
      const width = integer(value);
      if (width <= 0) throw new Error('TJS cannot create an empty Bitmap');
      state.image = state.image.resized(width, state.image.height, 0).clone();
    }
    @nativeProperty get height() { return drawableBitmap(this).image.height; }
    @nativeProperty set height(value) {
      const state = drawableBitmap(this);
      const height = integer(value);
      if (height <= 0) throw new Error('TJS cannot create an empty Bitmap');
      state.image = state.image.resized(state.image.width, height, 0).clone();
    }
    @nativeProperty get loading() {
      const state = this;
      return state?.loading ? 1 : 0;
    }
  }

  // BitmapIntf.cpp exposes raw pointers for the remaining native members.
  // There is no pointer ABI in a browser VM; the generated native stubs stay in
  // place so callers receive the normal explicit unsupported-operation error.
  return Bitmap;
}
