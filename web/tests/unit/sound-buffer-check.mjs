// End-to-end check of the worklet-backed WaveSoundBuffer path with a fake
// AudioContext.  Verifies .sli conversion, source-rate metadata, labels,
// pause/resume messaging and position updates.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

class FakeNode {
  constructor(_context, name, options) {
    this.name = name;
    this.options = options;
    this.port = {
      messages: [],
      postMessage(message) { this.messages.push(message); },
      onmessage: null,
    };
    if (name === 'krkr-wave') globalThis.lastWaveNode = this;
  }
  connect() {}
  disconnect() {}
}
globalThis.AudioWorkletNode = FakeNode;

const sampleRate = 48000, length = 48000;
const channels = [new Float32Array(length), new Float32Array(length)];
const audioBuffer = {
  duration: 1, sampleRate, length, numberOfChannels: 2,
  getChannelData: channel => channels[channel],
};
const wav = new Uint8Array(44);
const view = new DataView(wav.buffer);
const ascii = (offset, text) => { for (let i = 0; i < text.length; i++) wav[offset + i] = text.charCodeAt(i); };
ascii(0, 'RIFF'); view.setUint32(4, 36, true); ascii(8, 'WAVE');
ascii(12, 'fmt '); view.setUint32(16, 16, true);
view.setUint16(20, 1, true); view.setUint16(22, 2, true);
view.setUint32(24, 44100, true); view.setUint32(28, 44100 * 4, true);
view.setUint16(32, 4, true); view.setUint16(34, 16, true);
ascii(36, 'data'); view.setUint32(40, 0, true);

const sli = new TextEncoder().encode(`#2.00
Link { From=22050; To=11025; Smooth=False; Condition=no; RefValue=0; CondVar=0; }
Label { Position=11025; Name='tick'; }
`);
const files = new Map([['voice.wav', wav], ['voice.wav.sli', sli]]);
const gains = [];
const context = {
  currentTime: 0,
  state: 'running',
  destination: {},
  outputLatency: 0,
  audioWorklet: { async addModule() {} },
  async resume() {},
  createGain() {
    const node = { gain: { value: 0 }, connect() {}, disconnect() {} };
    gains.push(node);
    return node;
  },
  createPanner() {
    const panner = {
      positionX: { value: 0 }, positionY: { value: 0 }, positionZ: { value: 0 },
      connect() {}, disconnect() {},
    };
    globalThis.lastPanner = panner;
    return panner;
  },
  createChannelSplitter() { return { connect() {}, disconnect() {} }; },
  createChannelMerger() { return { connect() {}, disconnect() {} }; },
  createBufferSource() { return { connect() {}, disconnect() {}, start() {}, stop() {} }; },
  async decodeAudioData() { return audioBuffer; },
};
const storage = {
  async read(name) { const bytes = files.get(name); if (!bytes) throw new Error(`missing ${name}`); return bytes; },
  async has(name) { return files.has(name); },
};

const server = await createServer({
  configFile: 'vite.config.mjs',
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
try {
  const { config } = await server.ssrLoadModule('/engine-js/global.js');
  config.inform = message => console.log('[inform]', message);
  const fakeDocument = {
    visibilityState: 'visible', hidden: false, hasFocus: () => true,
    addEventListener() {}, removeEventListener() {},
    defaultView: { addEventListener() {}, removeEventListener() {} },
  };
  config.document = fakeDocument;
  const { TJSInterop } = await server.ssrLoadModule('/engine-js/wasm-vm.js');
  const { createWaveSoundBufferClass } = await server.ssrLoadModule('/engine-js/sound.js');
  const vm = await new TJSInterop().init(Object.create(null));
  const Wave = createWaveSoundBufferClass(storage, () => context, {
    enqueueEvent: callback => Promise.resolve().then(callback),
  });
  vm.registerGlobal('WaveSoundBuffer', Wave);
  vm.registerGlobal('PhaseVocoder', Wave.PhaseVocoder);
  const run = source => vm.source(source, 'sound-worklet-check');

  const metadata = await run(`
    var w = new WaveSoundBuffer();
    w.open("voice.wav");
    return [w.frequency, w.bits, w.totalTime, w.status,
      w.labels["tick"].position, w.labels["tick"].samplePosition];
  `);
  assert.deepEqual(metadata, [44100, 16, 1000, 'stop', 250, 11025]);

  await run('var w = new WaveSoundBuffer(); w.open("voice.wav"); w.play();');
  const node = globalThis.lastWaveNode;
  assert.equal(node.name, 'krkr-wave');
  assert.equal(node.options.processorOptions.links[0].From, 24000);
  assert.equal(node.options.processorOptions.links[0].To, 12000);
  assert.equal(node.options.processorOptions.labels[0].Position, 12000);
  assert.equal(node.options.processorOptions.position, 0);

  // pan uses the reference software mixer's linear left/right attenuation:
  // gains[0] is the volume node, gains[1] the stereo input, gains[2]/[3] the
  // left/right pan gains.
  await run('w.pan = -50000;');
  assert.equal(gains[2].gain.value, 1);
  assert.equal(gains[3].gain.value, 0.5);
  await run('w.pan = 0;');
  assert.equal(gains[3].gain.value, 1);

  // sgfmNeverMute (0) must not mute, and sgfmMuteOnDeactivate (2) follows the
  // document focus state.  The old implementation checked mode 0 backwards.
  await run('WaveSoundBuffer.globalFocusMode = 2;');
  assert.equal(gains[0].gain.value, 1);
  fakeDocument.hasFocus = () => false;
  await run('WaveSoundBuffer.globalFocusMode = 2;');
  assert.equal(gains[0].gain.value, 0);
  fakeDocument.hasFocus = () => true;
  await run('WaveSoundBuffer.globalFocusMode = 0;');
  assert.equal(gains[0].gain.value, 1);

  // setPos inserts a PannerNode on demand and removes it when centered again.
  await run('w.setPos(0.003, 0.001, 0);');
  assert.equal(globalThis.lastPanner.positionX.value, 0.003);
  await run('w.setPos(0, 0, 0);');

  // Position messages are decoded samples; the TJS property is milliseconds in
  // the source rate.
  node.port.onmessage({ data: { type: 'position', value: 24000 } });
  assert.equal(await run('return w.position;'), 500);
  node.port.onmessage({ data: { type: 'position', value: 48000 } });
  assert.equal(await run('return w.samplePosition;'), 44100);

  // Pause posts pause/start messages without tearing down the transport.
  await run('w.paused = 1;');
  assert.deepEqual(node.port.messages.at(-1), { type: 'pause' });
  await run('w.paused = 0;');
  assert.deepEqual(node.port.messages.at(-1), { type: 'start' });

  // frequency no longer changes playback speed.
  await run('w.frequency = 22050;');
  assert.equal(await run('return w.frequency;'), 22050);
  assert.equal(node.port.messages.at(-1).type, 'frequency');

  // Label expressions update flags from the worklet; script writes travel back.
  node.port.onmessage({ data: { type: 'flags', values: [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] } });
  assert.equal(await run('return w.flags[0];'), 2);
  await run('w.flags[0] = 5;');
  assert.deepEqual(node.port.messages.at(-1), { type: 'flag', index: 0, value: 5 });

  // Looping is preserved across open (WaveImpl.cpp Clear does not reset it).
  assert.equal(await run('var l = new WaveSoundBuffer(); l.looping = 1; l.open("voice.wav"); return l.looping;'), 1);

  // Seeking a paused buffer keeps Status play and starts a paused transport.
  const seekResult = await run(`
    var s = new WaveSoundBuffer();
    s.open("voice.wav");
    s.play();
    s.paused = 1;
    s.position = 250;
    return [s.status, s.position];
  `);
  assert.deepEqual(seekResult, ['play', 250]);

  // Label messages dispatch through the owner's onLabel event hook.
  await run(`
    var labelEvents = [];
    var lw = new WaveSoundBuffer();
    lw.onLabel = function(name) { labelEvents.push(name); };
    lw.open("voice.wav");
    lw.play();
  `);
  await new Promise(resolve => setTimeout(resolve, 0));
  const labelNode = globalThis.lastWaveNode;
  labelNode.port.onmessage({ data: { type: 'label', name: 'tick' } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(await run('return labelEvents;'), ['tick']);
  await run('lw.stop();');

  // Filters are snapshotted at open (RebuildFilterChain); PhaseVocoder is a
  // global class in addition to the linked member.
  const filterCount = await run(`
    var fw = new WaveSoundBuffer();
    fw.filters.push(new PhaseVocoder());
    fw.open("voice.wav");
    fw.play();
    return fw.filters.count;
  `);
  assert.equal(filterCount, 1);
  assert.equal(globalThis.lastWaveNode.options.processorOptions.filters.length, 1);
  await run('fw.stop();');

  // Invalid loop information fails open and leaves the buffer unloaded.
  files.set('bad.wav', wav);
  files.set('bad.wav.sli', new TextEncoder().encode('#2.01\nLink { From=1; To=0; }'));
  const invalid = await run(`
    var b = new WaveSoundBuffer();
    try { b.open("bad.wav"); } catch (e) { return [b.status, e.message]; }
    return [b.status, ""];
  `);
  assert.equal(invalid[0], 'unload');
  assert.match(invalid[1], /Invalid loop information/);

  // stopFade() is StopFade(false, true): it snaps to the target volume.
  await run('w.volume = 0; w.fade(100000, 1000); w.stopFade();');
  assert.equal(await run('return w.volume;'), 100000);

  await run('w.stop();');
  assert.equal(await run('return w.status;'), 'stop');
  assert.equal(await run('return w.position;'), 0);

  console.log('sound-worklet-check passed');
  await vm.dispose();
} finally {
  await server.close();
}
