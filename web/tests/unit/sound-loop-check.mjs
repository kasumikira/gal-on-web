// Unit checks for the WaveLoopManager port.  These run without a browser or
// AudioWorklet, so they cover the .sli grammar and the sample/loop/label state
// machine directly.
import assert from 'node:assert/strict';
import { LoopSource, parseLoopInformation, LoopCondition } from '../../engine-js/sound-loop.js';

const old = parseLoopInformation('LoopStart=100\nLoopLength=50\n');
assert.equal(old.links.length, 1);
assert.deepEqual(
  { from: old.links[0].From, to: old.links[0].To, smooth: old.links[0].Smooth },
  { from: 150, to: 100, smooth: false },
);

const v2 = parseLoopInformation(`#2.00
# Sound Loop Information (utf-8)
Link { From=8; To=3; Smooth=False; Condition=eq; RefValue=1; CondVar=0; }
Link { From=6; To=2; Smooth=True; }
Label { Position=2; Name='loop point'; }
Label { Position=4; Name=':[0]+=1'; }
`);
assert.equal(v2.links.length, 2);
assert.equal(v2.labels.length, 2);
assert.equal(v2.links[0].From, 6); // sorted by From
assert.equal(v2.links[1].Condition, LoopCondition.equal);
assert.equal(v2.labels[1].Name, ':[0]+=1');

const channels = [Float32Array.from({ length: 10 }, (_, index) => index)];
const source = new LoopSource({
  channels, sampleRate: 1000, position: 0, looping: true,
  links: [{ From: 8, To: 3, Smooth: false, Condition: LoopCondition.none, RefValue: 0, CondVar: 0 }],
  labels: [{ Position: 4, Name: 'tick' }],
  onLabel: name => labels.push(name),
});
const labels = [];
const first = source.read(5);
assert.deepEqual(Array.from(first[0]), [0, 1, 2, 3, 4]);
const second = source.read(5);
assert.deepEqual(Array.from(second[0]), [5, 6, 7, 3, 4]);
const third = source.read(4);
assert.deepEqual(Array.from(third[0]), [5, 6, 7, 3]);
assert.ok(labels.length >= 2, 'label fires on every loop pass');

// Conditional links only jump while the flag matches.
const conditional = new LoopSource({
  channels, sampleRate: 1000, position: 4, looping: true,
  links: [{ From: 4, To: 0, Smooth: false, Condition: LoopCondition.equal, RefValue: 1, CondVar: 0 }],
});
conditional.setFlag(0, 0);
assert.deepEqual(Array.from(conditional.read(2)[0]), [4, 5]);
conditional.setFlag(0, 1);
conditional.position = 4;
assert.deepEqual(Array.from(conditional.read(2)[0]), [0, 1]);

// Smooth links produce a crossfade and then continue at To + after.
const smooth = new LoopSource({
  channels, sampleRate: 1000, position: 0, looping: true,
  links: [{ From: 6, To: 2, Smooth: true, Condition: LoopCondition.none, RefValue: 0, CondVar: 0 }],
});
const smoothOutput = [];
for (let index = 0; index < 8; index++) smoothOutput.push(...Array.from(smooth.read(2)[0]));
assert.equal(smoothOutput.length, 16);
assert.ok(smoothOutput.some(value => value >= 0 && value < 6));

// After a smooth crossfade the link must not fire again from the event
// position; audio continues at To + after while Position is From + after.
const smoothAgain = new LoopSource({
  channels, sampleRate: 1000, position: 0, looping: false,
  links: [{ From: 6, To: 2, Smooth: true, Condition: LoopCondition.none, RefValue: 0, CondVar: 0 }],
});
assert.deepEqual(Array.from(smoothAgain.read(4)[0]), [0, 1, 2, 3]);
assert.deepEqual(Array.from(smoothAgain.read(6)[0]), [4, 4, 4, 4.5, 5, 5.5]);
assert.deepEqual(Array.from(smoothAgain.read(4)[0]), [6, 7, 8, 9]);

// Label expressions mutate the flag array and are reported to the script side.
const expression = new LoopSource({
  channels, sampleRate: 1000, position: 0, looping: true,
  labels: [{ Position: 1, Name: ':[0]=2' }],
});
const flagUpdates = [];
expression.onFlags = values => flagUpdates.push(values[0]);
expression.read(3);
assert.equal(expression.flags[0], 2);
assert.deepEqual(flagUpdates, [2]);

console.log('sound-loop-check passed');
