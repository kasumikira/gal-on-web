import { integer } from '#krkr/values';
import { nativeOwner, writeScript } from '#krkr/native';

// getSample.dll (getSample.cpp): WaveSoundBufferAdd attaches a visualization
// window to every WaveSoundBuffer and two class-level defaults. sampleValue is
// the squared peak of a mono 16-bit window that starts sampleAhead samples
// ahead of the play position; getSample() is the older average-based form.
export function registerGetSample({ get }) {
  const Wave = get('WaveSoundBuffer');
  const defaults = { counts: 100, aheads: 0 };
  const states = new WeakMap();
  // TJS integers cross the bridge as BigInt; sample sizes stay within 32 bits.
  const integerValue = value => Number(BigInt.asIntN(32, integer(value)));
  const countValue = integerValue;
  const aheadValue = value => integerValue(value);
  const allocate = counts => new Int16Array(counts);
  const create = () => ({
    counts: defaults.counts,
    aheads: defaults.aheads,
    buffer: allocate(defaults.counts),
  });
  // NCB instance data is initialized on first member access (getSample.cpp 155).
  const pluginState = async state => {
    let plugin = states.get(state);
    if (!plugin) {
      plugin = create();
      await writeScript(nativeOwner(state), 'useVisBuffer', 1);
      states.set(state, plugin);
    }
    return plugin;
  };

  Wave.defineProperty('sampleValue', async state => {
    const plugin = await pluginState(state);
    plugin.buffer.fill(0);
    let count = Wave.readVisSamples(state, plugin.buffer, plugin.counts, 1, plugin.aheads);
    if (count > plugin.counts || count < 0) count = plugin.counts;
    let peak = 0;
    for (let index = 0; index < count; index++) peak = Math.max(peak, Math.abs(plugin.buffer[index]));
    const value = peak / 32768;
    return value * value;
  });
  Wave.defineProperty('sampleCount', async state => (await pluginState(state)).counts, async (state, value) => {
    const plugin = await pluginState(state);
    plugin.counts = countValue(value);
    plugin.buffer = allocate(plugin.counts);
  });
  Wave.defineProperty('sampleAhead', async state => (await pluginState(state)).aheads, async (state, value) => {
    (await pluginState(state)).aheads = aheadValue(value);
  });

  Wave.defineMember('getSample', function(count) {
    const samples = arguments.length > 0 ? countValue(count) : 100;
    if (!(samples > 0)) return undefined;
    const buffer = new Int16Array(samples);
    Wave.readVisSamples(this, buffer, samples, 1, 0);
    let sum = 0, used = 0;
    for (let index = 0; index < samples; index++) {
      if (buffer[index] >= 0) { sum = (sum + buffer[index]) | 0; used++; }
    }
    return used > 0 ? Math.trunc(sum / used) : 0;
  });
  // NCB_ATTACH_FUNCTION registers these on the class object; scripts call
  // `WaveSoundBuffer.setDefaultAheads(...)` before creating buffers.
  Wave.defineMember('setDefaultCounts', function(count) {
    if (!arguments.length) throw new Error('TJS setDefaultCounts requires a count');
    defaults.counts = countValue(count);
  }, { static: true });
  Wave.defineMember('setDefaultAheads', function(ahead) {
    if (!arguments.length) throw new Error('TJS setDefaultAheads requires an offset');
    defaults.aheads = aheadValue(ahead);
  }, { static: true });
}

