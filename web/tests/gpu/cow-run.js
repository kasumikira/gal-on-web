// Focused Image assign copy-on-write checks without the reference fixtures.
import { Image } from '/engine-js/bitmap.js';
import { TEXT_BLEND } from '/engine-js/font.js';
import { initializeGPU, getGPU } from '/engine-js/gpu.js';

const output = document.getElementById('result');
const checks = [];
const assert = (value, message) => { if (!value) throw Error(message); };
const check = (name, run) => {
  try { run(); checks.push({ name, passed: true }); }
  catch (error) { checks.push({ name, passed: false, error: error.stack }); }
};
const image = (bytes, width = 8, height = 8) =>
  new Image(width, height, { pixels: Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => bytes[i % bytes.length]) });
const solid = (rgba, width = 8, height = 8) =>
  new Image(width, height, { pixels: Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => rgba[i % 4]) });
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

try {
  const gpu = initializeGPU(document, TEXT_BLEND);
  const sourceBytes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  check('assign shares one resident texture', () => {
    const source = image(sourceBytes), target = solid([90, 80, 70, 60]);
    const entry = gpu.texture(source);
    gpu.texture(target);
    target.assign(source);
    assert(target._storage === source._storage, 'storage not shared');
    assert(gpu.texture(target) === entry, 'assign allocated/copyied a texture');
  });
  check('partial write detaches and preserves pixels', () => {
    const source = image(sourceBytes), target = solid([90, 80, 70, 60]);
    const entry = gpu.texture(source), original = Uint8ClampedArray.from(source.pixels);
    target.assign(source);
    target.fill({ left: 0, top: 0, right: 1, bottom: 1 }, 0x11223344);
    assert(target._storage !== source._storage, 'write kept sharing');
    const expected = Uint8ClampedArray.from(original);
    expected.set([0x22, 0x33, 0x44, 0x11], 0);
    assert(same(expected, target.pixels), 'detach lost pixels');
    assert(same(original, gpu.read(entry)), 'source pixels changed');
  });
  check('full overwrite detaches without copying', () => {
    const source = image(sourceBytes), target = solid([90, 80, 70, 60]);
    const entry = gpu.texture(source), original = Uint8ClampedArray.from(source.pixels);
    target.assign(source);
    gpu.fill(target, { left: 0, top: 0, right: 8, bottom: 8 }, [91, 37, 203, 255]);
    assert(target._storage !== source._storage, 'full fill kept sharing');
    assert(same(original, gpu.read(entry)), 'source pixels changed by overwrite');
  });
  check('no-copy independ recreates transparent content', () => {
    const source = image(sourceBytes), target = solid([90, 80, 70, 60]);
    const original = Uint8ClampedArray.from(source.pixels);
    target.assign(source);
    target.detach(false);
    assert(target._storage !== source._storage, 'no-copy detach kept sharing');
    assert(target.pixels.every(v => v === 0), 'no-copy detach retained pixels');
    assert(same(original, gpu.read(gpu.texture(source))), 'source changed');
  });
  const failed = checks.filter(entry => !entry.passed);
  const report = { ok: failed.length === 0, checks, diagnostics: gpu.diagnostics(), renderer: gpu.gl.getParameter(gpu.gl.RENDERER) };
  output.textContent = JSON.stringify(report, null, 2);
  window.cowResult = report;
  gpu.finalize();
} catch (error) {
  output.textContent = error.stack;
  window.cowResult = { ok: false, error: String(error), stack: error.stack, checks };
}
