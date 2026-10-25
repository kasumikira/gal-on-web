// End-to-end check of getSample.dll through the real sound module: the decoded
// sample window, useVisBuffer gating and the plugin defaults are exercised with a
// fake AudioContext, loaded through Vite so the native decorators compile the
// same way as the production bundle.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.config.mjs',
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
try {
  const { config } = await server.ssrLoadModule('/engine-js/global.js');
  config.inform = message => console.log('[inform]', message);
  const { TJSInterop } = await server.ssrLoadModule('/engine-js/wasm-vm.js');
  const { createWaveSoundBufferClass } = await server.ssrLoadModule('/engine-js/sound.js');
  const { Plugins } = await server.ssrLoadModule('/engine-js/plugins.js');

  const sampleRate = 8000, length = 4000;
  const channels = [new Float32Array(length), new Float32Array(length)];
  for (let i = 0; i < length; i++) {
    const value = 0.5 * Math.sin(i / 4);
    channels[0][i] = value;
    channels[1][i] = value;
  }
  const audioBuffer = {
    duration: length / sampleRate, sampleRate, length, numberOfChannels: 2,
    getChannelData: channel => channels[channel],
  };
  const context = {
    currentTime: 0,
    destination: {},
    async resume() {},
    createGain() { return { gain: { value: 0 }, connect() {}, disconnect() {} }; },
    createBufferSource() {
      return {
        buffer: null, loop: false, playbackRate: { value: 1 }, onended: null,
        connect() {}, disconnect() {}, start() {}, stop() {},
      };
    },
    async decodeAudioData() { return audioBuffer; },
  };
  const vm = await new TJSInterop().init(Object.create(null));
  const Wave = createWaveSoundBufferClass({ async read() { return new Uint8Array([0]); }, async has() { return false; } }, () => context, {
    enqueueEvent: callback => Promise.resolve().then(callback),
  });
  const global = Object.create(null);
  vm.registerGlobal('WaveSoundBuffer', Wave);
  global.WaveSoundBuffer = Wave;
  let plugins;
  plugins = new Plugins({
    global, storage: { async read() { return new Uint8Array(); } },
    registerGlobal: (name, value) => vm.registerGlobal(name, value),
    registerMembers: (target, members) => vm.registerMembers(target, members),
    link: name => plugins.link(name),
    get: name => global[name],
  });
  vm.registerGlobal('Plugins', plugins);
  await plugins.link('getSample.dll');

  const run = source => vm.source(source, 'sound-check');
  // Same reference formulas as WaveIntf.cpp 131 for a mono 16-bit window.
  const downmix = (from, count) => {
    const result = [];
    for (let i = 0; i < count; i++) {
      const t = (channels[0][from + i] + channels[1][from + i]) * (32768 / 2);
      result.push(t > 0 ? Math.min(32767, Math.trunc(t + 0.5)) : Math.max(-32768, Math.trunc(t - 0.5)));
    }
    return result;
  };
  const squaredPeak = samples => (Math.max(...samples.map(Math.abs)) / 32768) ** 2;

  assert.equal(await run('return typeof WaveSoundBuffer.setDefaultAheads;'), 'Object');
  const built = await run(`
    WaveSoundBuffer.setDefaultAheads(0);
    var w = new WaveSoundBuffer();
    w.open("voice.ogg");
    w.play();
    var before = w.useVisBuffer;
    var count = w.sampleCount;
    return [before, count, w.sampleAhead, w.useVisBuffer];
  `);
  assert.deepEqual(built, [0, 100, 0, 1], 'first plugin access enables useVisBuffer');

  const value = await run('var w = new WaveSoundBuffer(); w.open("voice.ogg"); w.play(); return w.sampleValue;');
  assert.equal(value, squaredPeak(downmix(0, 100)), 'sampleValue is the squared peak of the downmixed window');

  const ahead = await run('var w = new WaveSoundBuffer(); w.open("voice.ogg"); w.sampleAhead = 1000; w.play(); return w.sampleValue;');
  assert.equal(ahead, squaredPeak(downmix(1000, 100)), 'sampleAhead shifts the window in samples');

  assert.equal(await run('var w = new WaveSoundBuffer(); w.open("voice.ogg"); w.play(); var count = w.sampleCount; w.useVisBuffer = 0; return w.sampleValue;'), 0,
    'useVisBuffer=0 disables the window');

  const average = await run('var w = new WaveSoundBuffer(); w.open("voice.ogg"); w.play(); w.useVisBuffer = 1; return w.getSample(8);');
  const window = downmix(0, 8).filter(sample => sample >= 0);
  assert.equal(average, Math.trunc(window.reduce((sum, sample) => sum + sample, 0) / window.length),
    'getSample averages the non-negative samples');

  console.log('sound-check passed', { value, ahead, average });
  await vm.dispose();
} finally {
  await server.close();
}
