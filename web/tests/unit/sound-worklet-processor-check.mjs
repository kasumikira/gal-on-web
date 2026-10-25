// AudioWorklet-side transport check.  The worklet module is loaded with a tiny
// AudioWorkletProcessor stub so loop/label/pause/end behavior can be exercised
// without a browser.
import assert from 'node:assert/strict';

let registered;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = {
      messages: [],
      postMessage(message) { this.messages.push(message); },
      onmessage: null,
    };
  }
};
globalThis.registerProcessor = (name, processor) => { registered = { name, processor }; };

await import('../../engine-js/phase-vocoder-worklet.js');
assert.equal(registered.name, 'krkr-wave');

const channels = [Float32Array.from({ length: 300 }, (_, index) => index / 300)];
const processor = new registered.processor({
  processorOptions: {
    channels,
    sampleRate: 1000,
    position: 0,
    looping: true,
    links: [{ From: 256, To: 64, Smooth: false, Condition: 0, RefValue: 0, CondVar: 0 }],
    labels: [{ Position: 100, Name: 'tick' }],
    flags: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    frequency: 1000,
    paused: false,
    filters: [],
  },
});
const output = [[new Float32Array(128)], [new Float32Array(128)]];
assert.equal(processor.process([], output), true);
const collected = [];
for (let index = 0; index < 16; index++) {
  processor.process([], [[new Float32Array(128)], [new Float32Array(128)]]);
  collected.push(...processor.port.messages);
}
assert.ok(collected.some(message => message.type === 'label' && message.name === 'tick'));
assert.ok(collected.some(message => message.type === 'position'));

processor.port.onmessage({ data: { type: 'pause' } });
const paused = [[new Float32Array(128)]];
assert.equal(processor.process([], [paused]), true);
assert.equal(paused[0][0], 0);
processor.port.onmessage({ data: { type: 'start' } });
assert.equal(processor.process([], [[new Float32Array(128)]]), true);

const finite = new registered.processor({
  processorOptions: {
    channels, sampleRate: 1000, position: 0, looping: false,
    links: [], labels: [], flags: [], frequency: 1000, paused: false, filters: [],
  },
});
for (let index = 0; index < 4; index++) finite.process([], [[new Float32Array(128)]]);
assert.ok(finite.port.messages.some(message => message.type === 'ended'));

// PhaseVocoder chain: the transport feeds the filter, which produces the
// output block; this catches worklet-side chain wiring errors.
const longChannels = [
  Float32Array.from({ length: 16384 }, (_, index) => Math.sin(index / 20)),
  Float32Array.from({ length: 16384 }, (_, index) => Math.cos(index / 20)),
];
const filtered = new registered.processor({
  processorOptions: {
    channels: longChannels, sampleRate: 48000, position: 0, looping: false,
    links: [], labels: [], flags: [], frequency: 48000, paused: false,
    filters: [{ window: 1024, overlap: 0, pitch: 1, time: 1 }],
  },
});
const filteredOutput = [[new Float32Array(128)], [new Float32Array(128)]];
assert.equal(filtered.process([], filteredOutput), true);
assert.ok(filteredOutput[0].some(sample => sample !== 0));

console.log('sound-worklet-check passed');

