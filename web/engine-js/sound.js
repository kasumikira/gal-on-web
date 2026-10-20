import { config } from './global.js';
import { nativeClass, nativeMethod, nativeEvent, nativeProperty, createNativeInstance, nativeOwnedArray, callScript, script, nativeOwner, retainScriptValue, disposeScriptValue } from '#krkr/native';
import { number, truth } from '#krkr/values';
import phaseVocoderWorkletURL from './phase-vocoder-worklet.js?worker&url';
// WaveIntf.cpp / WaveImpl.cpp. Audio decoding and output cross the browser
// platform boundary through Web Audio; TJS owns playback state and properties.
//
// Lifecycle notes taken from the reference implementation:
//  - Paused is written only by the constructor, Clear() (open/unload) and
//    SetPaused (WaveImpl.cpp 2061, 2517, 3498). play()/stop() do NOT clear it:
//    a paused buffer plays silently until unpaused, and stop() leaves the flag
//    set. Only open() resets it.
//  - Pausing never changes Status; the buffer stays "play" (SoundBufferBaseIntf
//    GetStatusString has no "pause" arm).
//  - SetPosition while playing restarts the device and resets the filter
//    chain (WaveImpl.cpp 3793-3807), i.e. a seek, not a soft update.
//  - A position at or beyond the end is silently ignored (no clamp).
export function createWaveSoundBufferClass(storage, getAudioContext, { enqueueEvent }) {
  const { inform: report } = config;
  let scheduling = true;
  let filterHandle = 1, workletContext, workletRegistration;
  const buffers = new Set();
  let globalVolume = 100000, globalFocusMode = 0;
  let gainQueryCallback = null, gainQueryCallbackOPUS = null;
  const BEAT = 60; // TVP_SB_BEAT_INTERVAL (win32/SoundBufferBaseImpl.h 15)
  const clampVolume = value => Math.max(0, Math.min(100000, Math.trunc(number(value))));

  @nativeClass('PhaseVocoder')
  class Phase {
    static initialize() { return { handle: filterHandle++, window: 4096, overlap: 0, pitch: 1, time: 1, sound: null, index: 0 }; }
    @nativeMethod PhaseVocoder() {}
    @nativeProperty get interface() { return this.handle; }
  }
  for (const name of ['window', 'overlap', 'pitch', 'time']) Phase.defineProperty(name, owner => Phase.state(owner)[name], (owner, value) => {
    const state = Phase.state(owner), next = name === 'window' || name === 'overlap' ? Math.trunc(number(value)) : Math.fround(number(value));
    if (name === 'window' && ![64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768].includes(next)) throw new Error('PhaseVocoder window must be a power of two from 64 to 32768');
    if (name === 'overlap' && ![0, 2, 4, 8, 16, 32].includes(next)) throw new Error('PhaseVocoder overlap must be 0, 2, 4, 8, 16 or 32');
    state[name] = next;
    if (state.sound?.source) state.sound.source.port.postMessage({ type: 'filter', index: state.index, value: filterConfig(state) });
  });

  // WaveFlags (WaveIntf.cpp 1893-1985): a per-buffer view of the loop manager's
  // 16 integer flags; with no loop manager every flag reads 0.
  @nativeClass('WaveFlags')
  class WaveFlags {
    static initialize() { return { buffer: null }; }
    @nativeMethod WaveFlags() {}
    @nativeMethod reset() { if (this.buffer) this.buffer.flags.fill(0); }
    @nativeProperty get count() { return 16; }
  }
  for (let index = 0; index < 16; index++) WaveFlags.defineProperty(String(index),
    owner => WaveFlags.state(owner).buffer?.flags[index] ?? 0,
    (owner, value) => { const b = WaveFlags.state(owner).buffer; if (b) b.flags[index] = Math.trunc(number(value)); },
  );

  const filterConfig = filter => ({ pitch: filter.pitch, time: filter.time, overlap: filter.overlap, window: filter.window });

  // Push the effective gain: volume * volume2 * globalVolume / 1e15, muted when
  // the window has no focus and globalFocusMode asks for it (WaveImpl.cpp 3829).
  const applyGain = state => {
    if (!state.gain) return;
    let value = state.volume * state.volume2 * globalVolume / 1e15 * state.codecGain;
    if (globalFocusMode === 0 && typeof document !== 'undefined' && !document.hasFocus()) value = 0;
    state.gain.gain.value = value;
  };
  // Reset device/filter state; the buffer remains loaded and Status follows
  // WaveImpl.cpp StopPlay (no status change here).
  const stopPlay = state => {
    buffers.delete(state);
    if (state.source) {
      state.source.onended = null;
      try {
        if (state.activeFilters?.length) state.source.port.postMessage({ type: 'stop' }); else state.source.stop();
      } catch {}
      state.source.disconnect(); state.source = undefined;
    }
    for (const filter of state.activeFilters ?? []) filter.sound = null;
    state.activeFilters = [];
    if (state.gain) { state.gain.disconnect(); state.gain = undefined; }
    state.bufferPlaying = false;
  };
  // Clear (WaveImpl.cpp 2495-2521): drop the decoder, reset Paused, unload.
  const clear = state => {
    stopPlay(state);
    state.buffer = null; state.frequency = 0; state.position = 0;
    state.sampleData = null;
    state.codecGain = 1;
    state.paused = false; state.looping = false;
    state.flags.fill(0);
  };
  const statusString = status => status === 'unload' ? 'unload' : status === 'play' ? 'play' : status === 'stop' ? 'stop' : 'unknown';
  // SetStatus (SoundBufferBaseIntf.cpp 75): deliver onStatusChanged to the
  // owning object when the value actually changes.
  const setStatus = (state, status) => {
    if (state.status === status) return;
    state.status = status;
    if (state.owner) fire(state, 'onStatusChanged', [statusString(status)]);
  };
  const fire = (state, name, args) => {
    if (!state.owner) return;
    const deliver = async () => {
      // BaseSoundBuffer::Invalidate cancels undelivered source events.
      // Resolve the receiver at delivery, not before it enters the queue.
      const owner = state.owner;
      if (!owner) return;
      await callScript(owner, name, args, { receiver: owner, ignoreMissing: true });
    };
    enqueueEvent(deliver).catch(error => {
      const message = `WaveSoundBuffer ${name} failed: ${error?.message ?? error}`;
      report(message);
    });
  };
  // GetPosition (WaveImpl.cpp 3809): decode position in ms.
  const currentPosition = state => {
    if (!state.buffer) return 0;
    if (state.bufferPlaying && state.source) {
      if (state.activeFilters?.length) return state.position;
      const elapsed = (getAudioContext().currentTime - state.startedAt) * 1000;
      return state.playStart + elapsed * (state.frequency ? state.frequency / state.buffer.sampleRate : 1);
    }
    return state.position;
  };
  // SetSamplePosition (WaveImpl.cpp 3793): ignore beyond EOF; while playing a
  // seek restarts the device and the filter chain.
  const seek = (state, positionMs) => {
    const total = state.buffer ? state.buffer.duration * 1000 : 0;
    if (total && positionMs >= total) return;
    state.position = Math.max(0, positionMs);
    if (state.bufferPlaying) {
      // Seek-while-playing restarts the device and the filter chain
      // (WaveImpl.cpp 3800).
      stopPlay(state);
      startPlay(state);
    } else if (state.buffer) {
      setStatus(state, 'stop');
    }
  };
  // PCMConvertLoopFloat32ToInt16 (WaveFormatConverter.cpp 40): scale by 32767,
  // clamp, round half away from zero.
  const floatToInt16 = value => {
    const scaled = value * 32767;
    if (scaled > 32767) return 32767;
    if (scaled < -32768) return -32768;
    return scaled < 0 ? Math.trunc(scaled - 0.5) : Math.trunc(scaled + 0.5);
  };
  // GetVisBuffer (WaveImpl.cpp 4063) copies the samples at the play cursor plus
  // `ahead` samples. The DirectSound ring buffer becomes the decoded track:
  // looping buffers wrap around, one-shot buffers report silence past the end
  // instead of replaying their beginning. Float samples convert like
  // CopyVisBuffer (WaveImpl.cpp 4040), including the mono downmix
  // (WaveIntf.cpp 108).
  const readVisSamples = (state, dest, numsamples, channels, ahead) => {
    if (!state.useVisBuffer || !state.buffer || !state.bufferPlaying) return 0;
    const source = state.buffer, sourceChannels = source.numberOfChannels;
    if (channels !== 1 && channels !== sourceChannels) return 0;
    const count = Math.trunc(number(numsamples)), total = source.length;
    if (!(count > 0) || !total) return 0;
    const data = state.sampleData ??= Array.from({ length: sourceChannels }, (_, channel) => source.getChannelData(channel));
    const looping = !!state.looping;
    const start = Math.trunc(currentPosition(state) * source.sampleRate / 1000) + Math.trunc(number(ahead));
    for (let index = 0; index < count; index++) {
      const raw = start + index;
      const at = looping ? ((raw % total) + total) % total : raw;
      if (at < 0 || at >= total) {
        if (channels === 1) dest[index] = 0;
        else for (let channel = 0; channel < sourceChannels; channel++) dest[index * sourceChannels + channel] = 0;
        continue;
      }
      if (channels === 1) {
        // Downmix: sum * 32768/channels, then clamp and round half away
        // (WaveIntf.cpp 131). Mono input keeps the same rounding path.
        const scale = 32768 / sourceChannels;
        let sum = 0;
        for (let channel = 0; channel < sourceChannels; channel++) sum += data[channel][at] * scale;
        dest[index] = sum > 0 ? Math.min(32767, Math.trunc(sum + 0.5)) : Math.max(-32768, Math.trunc(sum - 0.5));
      } else {
        for (let channel = 0; channel < sourceChannels; channel++) dest[index * sourceChannels + channel] = floatToInt16(data[channel][at]);
      }
    }
    return count;
  };

  @nativeClass('WaveSoundBuffer')
  class Wave {
    static initialize(owner) {
      return {
        owner, status: 'unload', volume: 100000, volume2: 100000, looping: false,
        position: 0, frequency: 0, paused: false, pan: 0, posX: 0, posY: 0, posZ: 0,
        filters: nativeOwnedArray(owner), flags: new Int32Array(16), useVisBuffer: false,
        buffer: null, sampleData: null, source: undefined, gain: undefined, codecGain: 1, activeFilters: [],
        bufferPlaying: false, startedAt: 0, playStart: 0,
        fading: false, fadeTarget: 0, fadeCount: 0, blankLeft: 0, deltaVolume: 0, fadeTimer: null,
      };
    }

    @nativeMethod WaveSoundBuffer() {}
    @nativeMethod async open(name) {
      if (!arguments.length) throw new Error('TJS WaveSoundBuffer.open requires storage');
      const state = this;
      clear(state);
      setStatus(state, 'unload');
      const bytes = await storage.read(name), context = getAudioContext();
      // The first Ogg packet identifies the decoder independently of the
      // storage extension. Query once at open, on the script execution queue.
      if (bytes[0] === 79 && bytes[1] === 103 && bytes[2] === 103 && bytes[3] === 83) {
        const packet = 27 + bytes[26];
        const signature = String.fromCharCode(...bytes.subarray(packet, packet + 8));
        const callback = signature === 'OpusHead' ? gainQueryCallbackOPUS
          : signature.startsWith('\x01vorbis') ? gainQueryCallback : null;
        if (callback) {
          const value = await script(callback)(name);
          try { state.codecGain = 10 ** (number(value) / 20); }
          finally { await disposeScriptValue(value); }
        }
      }
      state.buffer = await context.decodeAudioData(bytes.slice().buffer);
      state.frequency = state.buffer.sampleRate; state.position = 0;
      setStatus(state, 'stop');
    }
    @nativeMethod async play() {
      const state = this;
      if (!state.buffer || state.bufferPlaying) return;
      stopPlay(state);
      startPlay(state);
      // WaveImpl.cpp 3446: Status becomes play even while Paused, where the
      // device stays silent (StartPlay gates the device on !Paused).
      setStatus(state, 'play');
    }
    @nativeMethod stop() {
      const state = this;
      // Stop (WaveImpl.cpp 3451): halt, status stop, rewind. Paused is kept.
      stopPlay(state);
      if (state.status !== 'unload') setStatus(state, 'stop');
      state.position = 0;
      state.fadeCount = 0; state.blankLeft = 0;
    }
    @nativeMethod fade(to, time, blanktime = 0) {
      if (arguments.length < 2) throw new Error('TJS WaveSoundBuffer.fade requires a target volume and a time');
      if (!scheduling) return;
      const state = this;
      if (time <= 0 || blanktime < 0) throw new Error('TJS invalid parameter');
      if (state.fading) stopFade(state, false, false);
      state.deltaVolume = (clampVolume(to) - state.volume) * BEAT / time;
      state.fadeTarget = clampVolume(to);
      state.fadeCount = Math.trunc(time / BEAT);
      state.blankLeft = blanktime;
      state.fading = true;
      if (state.fadeCount === 0 && state.blankLeft === 0) stopFade(state, false, true);
      else if (!state.fadeTimer) state.fadeTimer = setInterval(() => beat(state), BEAT);
    }
    @nativeMethod stopFade() { stopFade(this, true, false); }
    // The engine's WaveSoundBuffer exposes finalize for the per-instance device
    // state; the game's VoiceSoundBuffer calls it from its own finalize before
    // invalidation (system/voice.tjs). Release the audio path without detaching
    // the owner reference, which the invalidate hook still owns. TJS also calls
    // a member named finalize during invalidation, so this runs at most twice
    // and both paths are idempotent.
    @nativeMethod finalize() {
      const state = this;
      if (state.fadeTimer) { clearInterval(state.fadeTimer); state.fadeTimer = null; }
      state.fading = false;
      stopPlay(state);
      state.buffer = null;
      state.position = 0;
    }
    @nativeMethod setPos(x, y, z) {
      if (arguments.length < 3) throw new Error('TJS WaveSoundBuffer.setPos requires 3 arguments');
      const state = this;
      state.posX = number(x); state.posY = number(y); state.posZ = number(z);
    }
    @nativeEvent onStatusChanged() {}
    @nativeEvent onFadeCompleted() {}
    @nativeEvent onLabel() {}
    @nativeMethod static async setGainQueryCallback(callback) {
      if (!arguments.length) throw new Error('TJS setGainQueryCallback requires a callback or null');
      const previous = gainQueryCallback;
      gainQueryCallback = retainScriptValue(callback);
      await disposeScriptValue(previous);
    }
    @nativeMethod static async setGainQueryCallbackOPUS(callback) {
      if (!arguments.length) throw new Error('TJS setGainQueryCallbackOPUS requires a callback or null');
      const previous = gainQueryCallbackOPUS;
      gainQueryCallbackOPUS = retainScriptValue(callback);
      await disposeScriptValue(previous);
    }

    @nativeProperty get status() { return this.status; }
    @nativeProperty get filters() { return this.filters; }
    @nativeProperty get flags() { return createNativeInstance(WaveFlags, { buffer: Wave.state(nativeOwner(this)) }); }
    // WaveImpl.cpp 4005: visualization data is only produced while this flag is
    // set. The reference allocates a DirectSound ring buffer on enable; the port
    // reads the decoded AudioBuffer instead, so only the flag is kept.
    @nativeProperty get useVisBuffer() { return Number(this.useVisBuffer); }
    @nativeProperty set useVisBuffer(value) { this.useVisBuffer = !!truth(value); }
    @nativeProperty get volume() { return this.volume; }
    @nativeProperty set volume(value) { this.volume = clampVolume(value); applyGain(this); }
    @nativeProperty get volume2() { return this.volume2; }
    @nativeProperty set volume2(value) { this.volume2 = clampVolume(value); applyGain(this); }
    @nativeProperty get looping() { return Number(this.looping); }
    @nativeProperty set looping(value) {
      const state = this;
      state.looping = !!truth(value);
      if (state.source) {
        if (state.activeFilters?.length) state.source.port.postMessage({ type: 'looping', value: state.looping });
        else state.source.loop = state.looping;
      }
    }
    @nativeProperty get frequency() { return this.frequency; }
    @nativeProperty set frequency(value) {
      const state = this;
      state.frequency = Math.trunc(number(value));
      if (state.source) {
        if (state.activeFilters?.length) state.source.port.postMessage({ type: 'frequency', value: state.frequency });
        else if (state.buffer) state.source.playbackRate.value = state.frequency / state.buffer.sampleRate;
      }
    }
    @nativeProperty get paused() { return Number(this.paused); }
    @nativeProperty set paused(value) { setPaused(this, value); }
    // position/samplePosition (WaveIntf.cpp 1466/1488) are ms/sample seeks.
    @nativeProperty get position() { return Math.trunc(currentPosition(this)); }
    @nativeProperty set position(value) { seek(this, Math.trunc(number(value))); }
    @nativeProperty get samplePosition() {
      const s = this;
      return s.buffer ? Math.trunc(currentPosition(s) * s.buffer.sampleRate / 1000) : 0;
    }
    @nativeProperty set samplePosition(value) {
      const s = this;
      if (s.buffer) seek(s, Math.trunc(number(value)) * 1000 / s.buffer.sampleRate);
    }
    @nativeProperty get totalTime() {
      const s = this;
      return s.buffer ? Math.trunc(s.buffer.duration * 1000) : 0;
    }
    @nativeProperty get bits() { return 16; }
    @nativeProperty get channels() { return this.buffer?.numberOfChannels ?? 0; }
    @nativeProperty get labels() { return new Map(); }
    @nativeProperty get pan() { return this.pan; }
    @nativeProperty set pan(value) { this.pan = Math.max(-100000, Math.min(100000, Math.trunc(number(value)))); }
    @nativeProperty static get globalVolume() { return globalVolume; }
    @nativeProperty static set globalVolume(value) {
      globalVolume = clampVolume(value);
      for (const state of buffers) applyGain(state);
    }
    @nativeProperty static get globalFocusMode() { return globalFocusMode; }
    @nativeProperty static set globalFocusMode(value) {
      globalFocusMode = Math.trunc(number(value));
      for (const state of buffers) applyGain(state);
    }
  }
  Wave.invalidate = async owner => {
    const state = Wave.state(owner);
    state.owner = null;
    if (state.fadeTimer) clearInterval(state.fadeTimer);
    state.fadeTimer = null;
    state.fading = false;
    stopPlay(state);
    state.buffer = null;
    await disposeScriptValue(state.filters);
    state.filters = null;
  };
  Wave.stop = () => {
    scheduling = false;
    if (!Wave.instances.vm) return;
    for (const state of Wave.instances.values()) {
      if (state.fadeTimer) clearInterval(state.fadeTimer);
      state.fadeTimer = null;
      state.fading = false;
      stopPlay(state);
    }
  };
  Wave.finalize = async () => {
    const callbacks = [gainQueryCallback, gainQueryCallbackOPUS];
    gainQueryCallback = gainQueryCallbackOPUS = null;
    let failure;
    for (const callback of callbacks) {
      try { await disposeScriptValue(callback); }
      catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  };
  // StartPlay (WaveImpl.cpp 3190): build the filter chain, start the device
  // unless Paused, and begin delivering.
  async function startPlay(state) {
    if (!scheduling) return;
    const context = getAudioContext(); await context.resume();
    if (!scheduling) return;
    const filters = state.filters.map(value => Phase.state(value));
    for (const filter of filters) if (filter.sound) throw new Error('PhaseVocoder cannot connect multiple WaveSoundBuffers at once');
    let source;
    if (filters.length) {
      if (workletContext !== context) {
        workletContext = context;
        workletRegistration = context.audioWorklet.addModule(phaseVocoderWorkletURL);
      }
      await workletRegistration;
      if (!scheduling) return;
      source = new AudioWorkletNode(context, 'krkr-wave', { numberOfInputs: 0, outputChannelCount: [state.buffer.numberOfChannels], processorOptions: {
        channels: Array.from({ length: state.buffer.numberOfChannels }, (_, ch) => state.buffer.getChannelData(ch)),
        position: Math.trunc(state.position * state.buffer.sampleRate / 1000), looping: state.looping,
        frequency: state.frequency, sampleRate: state.buffer.sampleRate, filters: filters.map(filterConfig),
      } });
      filters.forEach((filter, index) => { filter.sound = state; filter.index = index; });
      state.activeFilters = filters;
      source.port.onmessage = ({ data }) => {
        if (state.source !== source) return;
        if (data.type === 'ended') { stopPlay(state); state.position = 0; setStatus(state, 'stop'); }
        else if (data.type === 'position') state.position = data.value / state.buffer.sampleRate * 1000;
      };
    } else {
      source = context.createBufferSource();
      source.buffer = state.buffer; source.loop = state.looping;
      source.playbackRate.value = state.frequency / state.buffer.sampleRate;
    }
    const gain = context.createGain();
    source.connect(gain); gain.connect(context.destination);
    state.gain = gain; applyGain(state); state.source = source;
    buffers.add(state);
    state.startedAt = context.currentTime; state.playStart = state.position;
    if (!filters.length) source.onended = () => {
      if (state.source !== source) return;
      buffers.delete(state);
      state.source = undefined; state.bufferPlaying = false; gain.disconnect();
      state.position = 0; setStatus(state, 'stop');
    };
    if (!state.paused) {
      state.bufferPlaying = true;
      if (filters.length) source.port.postMessage({ type: 'start' });
      else source.start(0, state.position / 1000);
    }
  }
  // SetPaused (WaveImpl.cpp 3491, FillBuffer 2891): the flag suppresses device
  // playback in place; the filter decoder freezes with it. Position is frozen
  // by restarting the device at the same offset when the flag is lifted.
  const setPaused = (state, value) => {
    const paused = !!truth(value);
    if (state.paused === paused) return;
    state.paused = paused;
    if (!state.buffer) return;
    if (paused) {
      if (state.source && state.bufferPlaying) {
        if (state.activeFilters?.length) state.source.port.postMessage({ type: 'pause' });
        else {
          state.position = currentPosition(state);
          state.bufferPlaying = false;
          const source = state.source;
          source.onended = null;
          try { source.stop(); } catch {}
          source.disconnect(); state.source = undefined;
        }
      }
    } else if (state.buffer && !state.bufferPlaying && state.status === 'play') {
      // Unpause: refill the device and resume from the frozen position.
      startPlay(state).catch(error => { report(`WaveSoundBuffer resume failed: ${error?.message ?? error}`); });
    }
  };
  function beat(state) {
    if (state.blankLeft) {
      state.blankLeft -= BEAT; if (state.blankLeft < 0) state.blankLeft = 0;
    } else if (state.fadeCount) {
      if (state.fadeCount === 1) stopFade(state, true, true);
      else {
        state.fadeCount--;
        state.volume = clampVolume(state.volume + Math.trunc(state.deltaVolume));
        applyGain(state);
      }
    } else if (state.fadeTimer) { clearInterval(state.fadeTimer); state.fadeTimer = null; }
  }
  function stopFade(state, async, settargetvol) {
    if (state.fadeTimer) { clearInterval(state.fadeTimer); state.fadeTimer = null; }
    if (!state.fading) return;
    state.fading = false;
    if (settargetvol) { state.volume = state.fadeTarget; applyGain(state); }
    fire(state, 'onFadeCompleted', []);
  }
  for (const name of ['posX', 'posY', 'posZ']) {
    Wave.defineProperty(name, owner => Wave.state(owner)[name], (owner, value) => { Wave.state(owner)[name] = number(value); });
  }
  // WaveFlags is a standalone native class; the buffer's `flags` property is a
  // view of its loop manager's flag array.
  Wave.WaveFlags = WaveFlags;
  // Plugin-side view access for getSample.dll and derived plugins. The reference
  // plugin fills its own short[] through getVisBuffer, so the port keeps the same
  // entry point but hands the buffer over as a host Int16Array.
  Wave.readVisSamples = (state, dest, numsamples, channels = 1, ahead = 0) =>
    readVisSamples(state, dest, numsamples, channels, ahead);
  // The class-valued member stays a member value: encodeNativeValue registers
  // it as a linked class rather than a script getter.
  Wave.members.set('PhaseVocoder', Phase);
  return Wave;
}
