// The reference mixer saturates each same-sign contribution in sequence.
import assert from 'node:assert/strict';
import { createMixStage, mixSample } from '../../engine-js/sound-master.js';

assert.ok(Math.abs(mixSample(0.4, 0.4) - 0.64) < 1e-12);
assert.ok(Math.abs(mixSample(-0.4, -0.4) + 0.64) < 1e-12);
assert.equal(mixSample(0.4, -0.4), 0);

let captured;
globalThis.AudioWorkletNode = class {
  constructor(context, name, options) { captured = { context, name, options }; }
};
const context = {};
createMixStage(context);
assert.deepEqual(captured, {
  context,
  name: 'krkr-mixer',
  options: {
    numberOfInputs: 2,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  },
});

console.log('sound-master-check passed');
