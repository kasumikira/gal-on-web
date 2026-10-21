import { PhaseVocoderDSP } from './phase-vocoder-core.js';
import { LoopSource } from './sound-loop.js';

class PhaseSource {
  constructor(source, config, channels) {
    this.source = source;
    this.config = config;
    this.dsp = new PhaseVocoderDSP(config.window, channels);
    this.input = Array.from({ length: channels }, () => new Float32Array(config.window));
    this.filled = 0;
    this.pending = null;
    this.pendingIndex = 0;
    this.ended = false;
  }
  read(count) {
    const result = this.input.map(() => new Float32Array(count));
    let written = 0;
    while (written < count) {
      if (!this.pending || this.pendingIndex === this.pending[0].length) {
        if (this.ended) break;
        this.dsp.configure(this.config);
        const required = this.dsp.size - this.filled;
        const next = this.source.read(required);
        const available = next[0].length;
        if (!available) {
          this.ended = true;
          break;
        }
        for (let ch = 0; ch < this.input.length; ch++) this.input[ch].set(next[ch], this.filled);
        this.filled += available;
        if (available < required) {
          const padded = Math.ceil(this.filled / this.dsp.inputHop) * this.dsp.inputHop;
          for (const channel of this.input) channel.fill(0, this.filled, padded);
          this.filled = padded;
          if (this.filled < this.dsp.size) {
            this.ended = true;
            break;
          }
        }
        this.pending = this.dsp.process(this.input);
        this.pendingIndex = 0;
        for (const channel of this.input) channel.copyWithin(0, this.dsp.inputHop);
        this.filled -= this.dsp.inputHop;
      }
      const copy = Math.min(count - written, this.pending[0].length - this.pendingIndex);
      for (let ch = 0; ch < result.length; ch++) {
        result[ch].set(this.pending[ch].subarray(this.pendingIndex, this.pendingIndex + copy), written);
      }
      written += copy;
      this.pendingIndex += copy;
    }
    return result.map(channel => channel.subarray(0, written));
  }
}

class WaveProcessor extends AudioWorkletProcessor {
  constructor({ processorOptions: options }) {
    super();
    this.pcm = new LoopSource({
      channels: options.channels,
      sampleRate: options.sampleRate,
      position: options.position,
      looping: options.looping,
      links: options.links,
      labels: options.labels,
      flags: options.flags,
      frequency: options.frequency,
      onLabel: (name, position) => this.port.postMessage({ type: 'label', name, position }),
      onFlags: values => this.port.postMessage({ type: 'flags', values }),
    });
    this.source = this.pcm;
    this.filters = [];
    for (const config of options.filters) {
      const filter = new PhaseSource(this.source, config, options.channels.length);
      this.filters.push(filter);
      this.source = filter;
    }
    this.paused = !!options.paused;
    this.finished = false;
    this.ended = false;
    this.stash = options.channels.map(() => new Float32Array(0));
    this.port.onmessage = ({ data }) => {
      if (data.type === 'stop') this.ended = true;
      else if (data.type === 'pause') this.paused = true;
      else if (data.type === 'start') this.paused = false;
      else if (data.type === 'looping') this.pcm.setLooping(data.value);
      else if (data.type === 'flag') this.pcm.setFlag(data.index, data.value);
      else if (data.type === 'resetFlags') this.pcm.resetFlags();
      else if (data.type === 'frequency') this.pcm.setFrequency(data.value);
      else if (data.type === 'filter' && this.filters[data.index]) this.filters[data.index].config = data.value;
    };
  }

  process(_inputs, outputs) {
    if (this.ended) return false;
    const output = outputs[0];
    const frames = output[0].length;
    if (this.paused) {
      for (const channel of output) channel.fill(0);
      return true;
    }
    while (this.stash[0].length < frames && !this.finished) {
      const next = this.source.read(128);
      if (!next[0].length) {
        this.finished = true;
        break;
      }
      this.stash = this.stash.map((old, channel) => {
        const joined = new Float32Array(old.length + next[channel].length);
        joined.set(old);
        joined.set(next[channel], old.length);
        return joined;
      });
    }
    if (!this.stash[0].length) {
      if (this.finished) {
        this.ended = true;
        this.port.postMessage({ type: 'ended' });
        return false;
      }
      return true;
    }
    const count = Math.min(frames, this.stash[0].length);
    for (let channel = 0; channel < output.length; channel++) {
      output[channel].set(this.stash[channel].subarray(0, count));
      if (count < frames) output[channel].fill(0, count);
    }
    this.stash = this.stash.map(channel => channel.slice(count));
    // `pcm.position` is the transport position (source samples).  It advances
    // 1:1 with output samples; PhaseVocoder only changes how many output
    // samples are produced from a hop, so this is also the position that a
    // segment queue would map the output cursor back to.
    this.port.postMessage({ type: 'position', value: this.pcm.position });
    if (this.finished && !this.stash[0].length) {
      this.ended = true;
      this.port.postMessage({ type: 'ended' });
      return false;
    }
    return true;
  }
}

registerProcessor('krkr-wave', WaveProcessor);
