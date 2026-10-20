import { integer } from '#krkr/values';

// getSample.dll (getSample.cpp): WaveSoundBufferAdd attaches a visualization
// window to every WaveSoundBuffer and two class-level defaults. sampleValue is
// the squared peak of a mono 16-bit window that starts sampleAhead samples
// ahead of the play position; getSample() is the older average-based form.
export function registerGetSample({ get }) {
  const Wave = get('WaveSoundBuffer');
  const defaults = { counts: 100, aheads: 0 };
  const states = new WeakMap();
  // TJS integers cross the bridge as BigInt; sample sizes stay within 32 bits.
  const integerValue = value => Number(integer(value));
  const countValue = value => Math.max(0, integerValue(value));
  const aheadValue = value => integerValue(value);
  const allocate = counts => new Int16Array(Math.max(0, counts));
  const create = () => ({
    counts: defaults.counts,
    aheads: defaults.aheads,
    buffer: allocate(defaults.counts),
  });
  // NCB instance data is initialized on first member access (getSample.cpp 155).
  const pluginState = state => {
    let plugin = states.get(state);
    if (!plugin) {
      plugin = create();
      states.set(state, plugin);
      state.useVisBuffer = true;
    }
    return plugin;
  };

  Wave.defineProperty('sampleValue', state => {
    const plugin = pluginState(state);
    plugin.buffer.fill(0);
    const count = Math.min(plugin.counts, Math.max(0, Wave.readVisSamples(state, plugin.buffer, plugin.counts, 1, plugin.aheads)));
    let peak = 0;
    for (let index = 0; index < count; index++) peak = Math.max(peak, Math.abs(plugin.buffer[index]));
    const value = peak / 32768;
    return value * value;
  });
  Wave.defineProperty('sampleCount', state => pluginState(state).counts, (state, value) => {
    const plugin = pluginState(state);
    plugin.counts = countValue(value);
    plugin.buffer = allocate(plugin.counts);
  });
  Wave.defineProperty('sampleAhead', state => pluginState(state).aheads, (state, value) => {
    pluginState(state).aheads = aheadValue(value);
  });

  Wave.defineMember('getSample', function(count) {
    const samples = arguments.length > 0 ? countValue(count) : 100;
    if (!(samples > 0)) return undefined;
    const buffer = new Int16Array(samples);
    Wave.readVisSamples(this, buffer, samples, 1, 0);
    let sum = 0, used = 0;
    for (let index = 0; index < samples; index++) {
      if (buffer[index] >= 0) { sum += buffer[index]; used++; }
    }
    return used > 0 ? Math.trunc(sum / used) : 0;
  });
  // NCB_ATTACH_FUNCTION registers these on the class object; scripts call
  // `WaveSoundBuffer.setDefaultAheads(...)` before creating buffers.
  Wave.defineMember('setDefaultCounts', count => { defaults.counts = countValue(count); }, { static: true });
  Wave.defineMember('setDefaultAheads', ahead => { defaults.aheads = aheadValue(ahead); }, { static: true });
}

