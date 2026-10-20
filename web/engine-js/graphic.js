// GraphicsLoaderIntf.cpp: storage lookup, decoded-image cache and _m/_p siblings.
import { Image } from './bitmap.js';
import { LRUCache } from 'lru-cache';
import { loadGraphicAsync as loadGraphic } from './image-codecs/async-decode.js';

const GRAPHIC_CACHE_BYTES = 128 * 1024 * 1024;
const GRAPHIC_EXTENSIONS = ['.tlg', '.png', '.jpg', '.jpeg', '.bmp', '.webp'];

function tiledImage(image, width, height) {
  width = Math.max(width, image.width); height = Math.max(height, image.height);
  if (width === image.width && height === image.height) return image;
  const result = new Image(width, height, { gray: image.gray });
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    result.setPoint(x, y, image.point(x % image.width, y % image.height));
  }
  return result;
}

function alphaColorMat(image, color) {
  const rgb = [(color >> 16) & 255, (color >> 8) & 255, color & 255], p = image.writablePixels;
  for (let i = 0; i < p.length; i += 4) {
    for (let c = 0; c < 3; c++) p[i + c] = rgb[c] + ((p[i + c] - rgb[c]) * p[i + 3] >> 8);
    p[i + 3] = 255;
  }
}

// Cache decoded resources, while each Layer receives independently writable
// pixels (GraphicsLoaderIntf.cpp's cache lookup assigns to the destination).
export function createGraphicLoader(storage) {
  const cache = new LRUCache({
    maxSize: GRAPHIC_CACHE_BYTES,
    sizeCalculation: value => value.image.pixels.byteLength + (value.province?.pixels.byteLength ?? 0),
  });
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
  return async (name, key = 0x1fffffff, { gray = false, province = false, width = 0, height = 0 } = {}) => {
    const path = await storage.getPlacedPath(name);
    if (!path) throw new Error(`Storage not found: ${name}`);
    const cacheKey = JSON.stringify([path, key, gray, province, width, height, storage.revision]);
    let result = cache.get(cacheKey);
    if (!result) {
      result = await loadGraphic({ read: () => storage.read(path), name: path }, key, { gray, province });
      result.image = tiledImage(result.image, width, height);
      if (!gray && !province) {
        const extension = storage.extractStorageExt(path), base = storage.chopStorageExt(path);
        const maskPath = await sibling(base, '_m', extension);
        if (maskPath) {
          const mask = tiledImage((await loadGraphic({ read: () => storage.read(maskPath), name: maskPath }, 0, { gray: true })).image, width, height);
          if (mask.width !== result.image.width || mask.height !== result.image.height) throw new Error('TJS mask size mismatch');
          const pixels = result.image.writablePixels, maskPixels = mask.pixels;
          for (let i = 0; i < maskPixels.length; i++) pixels[i * 4 + 3] = maskPixels[i];
        }
        const provincePath = await sibling(base, '_p', '');
        if (provincePath) {
          result.province = tiledImage((await loadGraphic({ read: () => storage.read(provincePath), name: provincePath }, 0, { province: true })).image, result.image.width, result.image.height);
          if (result.province.width !== result.image.width || result.province.height !== result.image.height) throw new Error('TJS province size mismatch');
        }
        if ((key >>> 24) === 4) alphaColorMat(result.image, key & 0xffffff);
      }
      cache.set(cacheKey, result);
    }
    return { ...result, image: result.image.clone(), province: result.province?.clone() ?? null };
  };
}
