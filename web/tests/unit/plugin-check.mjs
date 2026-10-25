// Targeted check for plugin attachments added after the class was exported:
// getSample.dll's static defaults/instance window and the static-member path in
// the native binding. Uses the real plugin module against a stub WaveSoundBuffer
// so it runs without Web Audio; sound.js keeps its own decorator build path.
import assert from 'node:assert/strict';
import { TJSInterop } from '../../engine-js/wasm-vm.js';
import { defineNativeClass } from '../../engine-js/common/native.js';
import { registerGetSample } from '../../engine-js/plugins/getsample.js';

const vm = await new TJSInterop().init(Object.create(null));
const data = [1000, -2000, 3000, 4000, -5000, 6000];
const Wave = defineNativeClass('WaveSoundBuffer', {
  initialize: () => ({ useVisBuffer: false, samples: data, cursor: 0 }),
});
Wave.testCount = 41;
Wave.defineProperty('testCount', klass => klass.testCount, (klass, value) => {
  klass.testCount = value;
}, { static: true });
const state = owner => Wave.state(owner);
// Core WaveSoundBuffer.useVisBuffer (WaveImpl.cpp 4005).
Wave.defineProperty('useVisBuffer', owner => Number(Wave.state(owner).useVisBuffer), (owner, value) => {
  Wave.state(owner).useVisBuffer = !!value;
});
// GetVisBuffer stand-in: mono window at cursor + ahead, wrapping like the track.
Wave.readVisSamples = (owner, dest, numsamples, channels, ahead) => {
  const s = Wave.state(owner);
  if (!s.useVisBuffer) return 0;
  const count = Math.trunc(numsamples), total = s.samples.length;
  if (!(count > 0) || !total) return 0;
  let offset = ((s.cursor + Math.trunc(ahead)) % total + total) % total;
  for (let index = 0; index < count; index++, offset = (offset + 1) % total) dest[index] = s.samples[offset];
  return count;
};
vm.registerGlobal('WaveSoundBuffer', Wave);
registerGetSample({ get: name => name === 'WaveSoundBuffer' ? Wave : undefined });

const run = source => vm.source(source, 'plugin-check');

assert.equal(await run('return WaveSoundBuffer.testCount;'), 41, 'static getter receives the JS class');
await run('WaveSoundBuffer.testCount = 42;');
assert.equal(Wave.testCount, 42, 'static setter writes to the JS class');
Wave.defineProperty('testLateCount', klass => klass.testCount, undefined, { static: true });
assert.equal(await run('return WaveSoundBuffer.testLateCount;'), 42, 'post-export static getter receives the JS class');

// NCB_ATTACH_FUNCTION registers on the class object; typeof must stop being
// "undefined" so system/voice.tjs enters its link path.
assert.equal(await run('return typeof WaveSoundBuffer.setDefaultAheads;'), 'Object');
assert.equal(await run('return typeof WaveSoundBuffer.setDefaultCounts;'), 'Object');

// The NCB getter creates plugin state on first property access, not construction.
await run('WaveSoundBuffer.setDefaultAheads(1); WaveSoundBuffer.setDefaultCounts(3);');
const built = await run(`
var w = new WaveSoundBuffer();
var before = w.useVisBuffer;
WaveSoundBuffer.setDefaultCounts(4);
var count = w.sampleCount;
WaveSoundBuffer.setDefaultCounts(3);
return [before, count, w.sampleCount, w.sampleAhead, w.useVisBuffer];
`);
assert.deepEqual(built, [0, 4, 4, 1, 1], 'first access captures defaults once and enables useVisBuffer');

// sampleValue = (peak / 32768)^2 over the window at cursor + ahead.
const value = await run('var w = new WaveSoundBuffer(); return w.sampleValue;');
assert.equal(value, (4000 / 32768) ** 2, 'sampleValue uses the ahead window peak');

// The window is a live property: sampleCount/sampleAhead rewrite the buffer.
const changed = await run(`
var w = new WaveSoundBuffer();
w.sampleAhead = 0;
w.sampleCount = 2;
return w.sampleValue;
`);
assert.equal(changed, (2000 / 32768) ** 2, 'sampleCount/sampleAhead resize the window');

// getSample averages the non-negative samples of the window from the cursor
// (getSample.cpp 15-43).
const average = await run('var w = new WaveSoundBuffer(); w.useVisBuffer = 1; return w.getSample(3);');
assert.equal(average, 2000, 'getSample averages non-negative samples');

// UseVisBuffer stays a real switch: without it the window reads 0.
const disabled = await run('var w = new WaveSoundBuffer(); var count = w.sampleCount; w.useVisBuffer = 0; return w.sampleValue;');
assert.equal(disabled, 0, 'useVisBuffer=0 disables the window');

console.log('plugin-check passed');
await vm.dispose();
