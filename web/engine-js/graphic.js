// GraphicsLoaderIntf.cpp: storage lookup, decoded-image cache and _m/_p siblings.
import { tileImage as tiledImage } from './bitmap.js';
import { LRUCache } from 'lru-cache';
import { loadGraphicAsync as loadGraphic } from './image-codecs/async-decode.js';
import { gpuBtoa } from './plugins/gpu-btoa.js';

// TVPGraphicCacheSystemLimit: the browser platform's maximum decoded-image
// cache size. System.graphicCacheLimit can lower it but never raise it.
export const GRAPHIC_CACHE_LIMIT = 128 * 1024 * 1024;
const GRAPHIC_EXTENSIONS = ['.tlg', '.png', '.jpg', '.jpeg', '.bmp', '.webp'];

function alphaColorMat(image, color) {
  gpuBtoa.alphaColorMat(image, color);
}

// Eviction drops the cache's reference; live layers keep their shared texture.
function releaseCachedGraphics(value) {
  for (const image of [value.image, value.province]) {
    image?.release();
  }
}

function graphicSize(value) {
  return value.image.width * value.image.height * (value.image.gray ? 1 : 4)
    + (value.province ? value.province.width * value.province.height : 0);
}

// Cache decoded resources, while each Layer receives independently writable
// pixels (GraphicsLoaderIntf.cpp's cache lookup assigns to the destination).
// Returns the loader plus the controls behind System.clearGraphicCache and
// System.graphicCacheLimit.
export function createGraphicLoader(storage) {
  const cache = new LRUCache({
    maxSize: GRAPHIC_CACHE_LIMIT,
    sizeCalculation: graphicSize,
    dispose: releaseCachedGraphics,
  });
  let limit = GRAPHIC_CACHE_LIMIT;
  // The effective limit can be lower than the LRU's construction-time maxSize;
  // chop from the least recently used end until the byte budget is met.
  const trim = () => {
    while (cache.calculatedSize > limit) {
      const oldest = cache.rkeys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  };
  const sibling = async (base, suffix, extension) => {
    if (extension) {
      const same = await storage.getPlacedPath(base + suffix + extension);
      if (same) return same;
    }
    for (const extension of GRAPHIC_EXTENSIONS) {
      const path = await storage.getPlacedPath(base + suffix + extension);
      if (path) return path;
    }
    return '';
  };
  const load = async (name, key = 0x1fffffff, { gray = false, province = false, width = 0, height = 0 } = {}) => {
    const path = await storage.getPlacedPath(name);
    if (!path) throw new Error(`Storage not found: ${name}`);
    const cacheKey = JSON.stringify([path, key, gray, province, width, height, storage.revision]);
    let result = cache.get(cacheKey);
    if (!result) {
      result = await loadGraphic({ read: () => storage.read(path), name: path, transferOwnership: true }, key, { gray, province });
      result.image = tiledImage(result.image, width, height);
      if (!gray && !province) {
        const extension = storage.extractStorageExt(path), base = storage.chopStorageExt(path);
        const maskPath = await sibling(base, '_m', extension);
        if (maskPath) {
          const mask = tiledImage((await loadGraphic({ read: () => storage.read(maskPath), name: maskPath, transferOwnership: true }, 0, { gray: true })).image, width, height);
          if (mask.width !== result.image.width || mask.height !== result.image.height) throw new Error('TJS mask size mismatch');
          gpuBtoa.assignAlpha(result.image, mask);
        }
        const provincePath = await sibling(base, '_p', '');
        if (provincePath) {
          result.province = tiledImage((await loadGraphic({ read: () => storage.read(provincePath), name: provincePath, transferOwnership: true }, 0, { province: true })).image, result.image.width, result.image.height);
          if (result.province.width !== result.image.width || result.province.height !== result.image.height) throw new Error('TJS province size mismatch');
        }
        if ((key >>> 24) === 4) alphaColorMat(result.image, key & 0xffffff);
      }
      const size = graphicSize(result);
      if (limit > 0 && size <= limit) {
        cache.set(cacheKey, result);
        trim();
      } else return { ...result, province: result.province ?? null };
    }
    return { ...result, image: result.image.copyReference(), province: result.province?.copyReference() ?? null };
  };
  return {
    load,
    clear() { cache.clear(); },
    // TVPSetGraphicCacheLimit: 0 disables the cache, -1 means the system
    // limit, and any other value is clamped to it (SystemIntf.cpp 358-368).
    setLimit(value) {
      let requested = Math.trunc(Number(value));
      if (!Number.isFinite(requested)) requested = -1;
      limit = requested === 0 ? 0
        : requested < 0 || requested > GRAPHIC_CACHE_LIMIT ? GRAPHIC_CACHE_LIMIT : requested;
      if (limit === 0) cache.clear(); else trim();
      return limit;
    },
    get limit() { return limit; },
  };
}
