import { loadGraphic } from './decode.js';

self.onmessage = async ({ data: { id, bytes, name, key, options } }) => {
  try {
    const { image, metainfo } = await loadGraphic({ read: async () => bytes, name }, key, options);
    const pixels = image.pixels;
    self.postMessage({ id, width: image.width, height: image.height, gray: image.gray, pixels, metainfo }, [pixels.buffer]);
  } catch (error) {
    self.postMessage({ id, error: error.message });
  }
};
