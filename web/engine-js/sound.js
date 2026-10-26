import { config } from './global.js';
import { nativeClass, nativeMethod, nativeEvent, nativeProperty, createNativeInstance, nativeOwnedArray, nativeDictionary, callScript, script, nativeOwner, retainScriptValue, disposeScriptValue } from '#krkr/native';
import { number, truth } from '#krkr/values';
import phaseVocoderWorkletURL from './phase-vocoder-worklet.js?worker&url';
import soundMixerWorkletURL from './sound-mixer-worklet.js?worker&url';
import { parseLoopInformation, convertLoopInformation } from './sound-loop.js';
import { probeAudioFormat } from './sound-format.js';
import { createMixStage } from './sound-master.js';
// WaveIntf.cpp / WaveImpl.cpp / WaveLoopManager.cpp.  The TJS state machine is
// kept in JS; decoded PCM is transported by one AudioWorklet per loaded buffer so
// loop links, crossfades, labels, flags and pause/seek behave like the
// reference implementation.  Web Audio provides the output graph (gain, pan,
// 3D panner and destination) and the audio clock.

export function createWaveSoundBufferClass(storage, getAudioContext, { enqueueEvent }) {
  const { inform: report } = config;
  let scheduling = true;
  let filterHandle = 1;
  let workletContext, workletModule, workletUnavailable = false;
  let mixerContext, mixerModule, mixerUnavailable = false;
  let masterContext, masterStages = [];
  const buffers = new Set();
  let globalVolume = 100000, globalFocusMode = 0;
  let gainQueryCallback = null, gainQueryCallbackOPUS = null;
  const BEAT = 60; // TVP_SB_BEAT_INTERVAL (win32/SoundBufferBaseImpl.h 15)
  const clampVolume = value => Math.max(0, Math.min(100000, Math.trunc(number(value))));
  const clampFlag = value => Math.max(0, Math.min(9999, Math.trunc(number(value))));
  const documentObject = config.document ?? (typeof document === 'undefined' ? null : document);
  const view = documentObject?.defaultView ?? null;

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
    if (state.sound?.source?.port) state.sound.source.port.postMessage({ type: 'filter', index: state.index, value: filterConfig(state) });
  });

  // WaveFlags (WaveIntf.cpp 1893-1985): a per-buffer view of the loop manager's
  // 16 integer flags.
  @nativeClass('WaveFlags')
  class WaveFlags {
    static initialize() { return { buffer: null }; }
    @nativeMethod WaveFlags() {}
    @nativeMethod reset() {
      const state = this.buffer;
      if (!state) return;
      state.flags.fill(0);
      state.source?.port?.postMessage({ type: 'resetFlags' });
    }
    @nativeProperty get count() { return 16; }
  }
  for (let index = 0; index < 16; index++) WaveFlags.defineProperty(String(index),
    owner => WaveFlags.state(owner).buffer?.flags[index] ?? 0,
    (owner, value) => {
      const state = WaveFlags.state(owner).buffer;
      if (!state) return;
      const next = clampFlag(value);
      state.flags[index] = next;
      state.source?.port?.postMessage({ type: 'flag', index, value: next });
    },
  );

  const filterConfig = filter => ({ pitch: filter.pitch, time: filter.time, overlap: filter.overlap, window: filter.window });

  const focusMuted = () => {
    if (globalFocusMode === 0 || !documentObject) return false;
    const hidden = documentObject.visibilityState === 'hidden' || documentObject.hidden === true;
    // sgfmMuteOnMinimize = 1; sgfmMuteOnDeactivate = 2.
    if (globalFocusMode === 1) return hidden;
    return hidden || (typeof documentObject.hasFocus === 'function' && !documentObject.hasFocus());
  };
  // WaveImpl.cpp SetVolumeToSoundBuffer: the reference computes the gain in
  // three integer-truncating stages, then divides by 100000.
  const effectiveVolume = state => {
    let value = Math.trunc(state.volume / 10);
    value = Math.trunc(value * Math.trunc(state.volume2 / 10) / 1000);
    value = Math.trunc(Math.trunc(value / 10) * Math.trunc(globalVolume / 10) / 1000);
    const mute = focusMuted() ? 0 : 100000;
    value = Math.trunc(Math.trunc(value / 10) * Math.trunc(mute / 10) / 1000);
    return value / 100000;
  };
  const applyGain = state => {
    if (!state.gain) return;
    state.gain.gain.value = effectiveVolume(state) * state.codecGain;
  };
  const applyAllGains = () => {
    for (const state of buffers) applyGain(state);
  };
  const focusHandler = () => {
    if (scheduling) applyAllGains();
  };
  // Browsers may keep an AudioContext suspended until a user gesture.  Install
  // a one-shot unlock so auto-play at startup starts as soon as the player
  // clicks or presses a key (the native engine has no such gate).
  const unlockAudio = () => {
    const context = getAudioContext();
    if (context.state === 'suspended') context.resume().catch(() => {});
    documentObject?.removeEventListener('pointerdown', unlockAudio, true);
    documentObject?.removeEventListener('keydown', unlockAudio, true);
  };
  if (documentObject?.addEventListener) {
    documentObject.addEventListener('pointerdown', unlockAudio, true);
    documentObject.addEventListener('keydown', unlockAudio, true);
    documentObject.addEventListener('visibilitychange', focusHandler);
  }
  if (view?.addEventListener) {
    view.addEventListener('focus', focusHandler);
    view.addEventListener('blur', focusHandler);
  }

  const applyPan = state => {
    const pan = state.panNodes;
    if (!pan) return;
    const value = state.pan / 100000;
    pan.gainL.gain.value = value > 0 ? 1 - value : 1;
    pan.gainR.gain.value = value < 0 ? 1 + value : 1;
  };
  const createPannerNode = context => {
    if (typeof context.createPanner !== 'function') return null;
    const panner = context.createPanner();
    try {
      panner.panningModel = 'equalpower';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1;
      panner.maxDistance = 10000;
      panner.rolloffFactor = 1;
    } catch {}
    return panner;
  };
  // A PannerNode is inserted only once a position is actually used.  A default
  // panner at the listener position (or front-center) would apply equal-power
  // attenuation to every sound, which the reference AL_GAIN path does not do.
  const ensurePanner = state => {
    if (state.panner) return state.panner;
    if (!state.source || !state.panInputs?.length) return null;
    const panner = createPannerNode(getAudioContext());
    if (!panner) return null;
    for (const target of state.panInputs) {
      try { state.source.disconnect(target); } catch {}
      panner.connect(target);
    }
    state.source.connect(panner);
    state.panner = panner;
    return panner;
  };
  const removePanner = state => {
    if (!state.panner) return;
    try { state.panner.disconnect(); } catch {}
    if (state.source) {
      for (const target of state.panInputs ?? []) {
        try { state.source.connect(target); } catch {}
      }
    }
    state.panner = undefined;
  };
  const applyPanner = state => {
    const positioned = state.posX !== 0 || state.posY !== 0 || state.posZ !== 0;
    if (!positioned) {
      removePanner(state);
      return;
    }
    const panner = ensurePanner(state);
    if (!panner) return;
    if (panner.positionX) {
      panner.positionX.value = state.posX;
      panner.positionY.value = state.posY;
      panner.positionZ.value = state.posZ;
    } else if (typeof panner.setPosition === 'function') {
      panner.setPosition(state.posX, state.posY, state.posZ);
    }
  };
  // Reset the transport; the buffer remains loaded and Status follows
  // WaveImpl.cpp StopPlay (no status change here).
  const stopPlay = state => {
    const wasPlaying = buffers.delete(state);
    const source = state.source;
    state.source = undefined;
    if (source) {
      if (source.port) {
        source.port.onmessage = null;
        try { source.port.postMessage({ type: 'stop' }); } catch {}
      }
      source.onended = null;
      source.onprocessorerror = null;
      try { source.stop?.(); } catch {}
      try { source.disconnect(); } catch {}
    }
    for (const node of [state.panner, state.panNodes?.splitter, state.panNodes?.gainL, state.panNodes?.gainR, state.panNodes?.merger, state.inputGain]) {
      try { node?.disconnect(); } catch {}
    }
    if (state.gain) {
      try { state.gain.disconnect(); } catch {}
      state.gain = undefined;
    }
    state.panner = undefined;
    state.panNodes = null;
    state.panInputs = null;
    state.inputGain = undefined;
    state.bufferPlaying = false;
    state.sourceStarted = false;
    state.transport = 'none';
    if (wasPlaying) disconnectMaster(state);
  };
  const releaseWorklet = state => {
    if (!state.workletSource) return;
    state.workletSource.port.postMessage({ type: 'dispose' });
    state.workletSource.disconnect();
    state.workletSource = null;
  };
  // A PhaseVocoder is claimed from StartPlay until Clear/Invalidate; Stop does
  // not release it in WaveLoopManager/PhaseVocoderFilter.
  const releaseFilterClaims = state => {
    for (const filter of state.activeFilters ?? []) {
      if (filter.sound === state) filter.sound = null;
    }
    state.activeFilters = [];
  };
  // Clear (WaveImpl.cpp 2495-2521): drop the decoder, reset Paused, unload.
  // Looping is intentionally preserved: the reference Clear does not touch it,
  // so `looping = true; open(...)` is valid.
  const clear = state => {
    stopPlay(state);
    releaseWorklet(state);
    releaseFilterClaims(state);
    state.buffer = null;
    state.frequency = 0;
    state.sourceRate = 0;
    state.decodedRate = 0;
    state.bits = 16;
    state.position = 0;
    state.sampleData = null;
    state.codecGain = 1;
    state.paused = false;
    state.fallbackLoopStart = undefined;
    state.fallbackLoopEnd = undefined;
    state.filterSnapshot = null;
    state.flags.fill(0);
    state.loopInfo = { links: [], labels: [] };
  };
  const statusString = status => status === 'unload' ? 'unload' : status === 'play' ? 'play' : status === 'stop' ? 'stop' : 'unknown';
  // SetStatus (SoundBufferBaseIntf.cpp 75): deliver onStatusChanged to the
  // owning object when the value actually changes.  eventToken models
  // TVPCancelSourceEvents: queued events from the previous status are dropped.
  const setStatus = (state, status) => {
    if (state.status === status) return;
    state.status = status;
    state.eventToken++;
    fire(state, 'onStatusChanged', [statusString(status)], state.eventToken);
  };
  const fire = (state, name, args, token = state.eventToken) => {
    if (!state.owner) return;
    const deliver = async () => {
      if (token !== state.eventToken) return;
      // BaseSoundBuffer::Invalidate cancels undelivered source events.
      const owner = state.owner;
      if (!owner) return;
      await callScript(owner, name, args, { receiver: owner, ignoreMissing: true });
    };
    enqueueEvent(deliver).catch(error => {
      const message = `WaveSoundBuffer ${name} failed: ${error?.message ?? error}`;
      report(message);
    });
  };
  // GetPosition (WaveImpl.cpp 3809): decode position in ms.  Worklet playback
  // reports the transport position directly; the BufferSource fallback derives
  // it from the audio clock.
  const currentPosition = state => {
    if (!state.buffer) return 0;
    if (state.transport === 'worklet') {
      // The worklet reports the render cursor.  Web Audio's currentTime is the
      // render clock, not the audible play cursor, so subtract the device
      // output latency to match GetCurrentPlaySamples' device position.
      const context = getAudioContext();
      const latency = Math.max(0, (context.outputLatency ?? context.baseLatency ?? 0) * 1000);
      return Math.max(0, state.position - latency);
    }
    if (state.bufferPlaying && state.sourceStarted && !state.paused) {
      const elapsed = (getAudioContext().currentTime - state.startedAt) * 1000;
      let position = state.playStart + elapsed;
      const total = state.buffer.duration * 1000;
      if (state.looping) {
        const start = state.fallbackLoopStart ?? 0;
        const end = state.fallbackLoopEnd ?? total;
        if (end > start && position >= end) position = start + ((position - start) % (end - start));
        else if (total > 0 && position >= total) position %= total;
      } else if (total > 0) {
        position = Math.min(position, total);
      }
      return position;
    }
    return state.position;
  };
  // SetSamplePosition (WaveImpl.cpp 3793): ignore positions at or beyond EOF;
  // while a transport exists a seek restarts it at the new position.  The
  // reference keeps Status unchanged, including when the buffer is paused.
  const seek = (state, positionMs) => {
    if (!state.buffer) return;
    const total = state.buffer.duration * 1000;
    if (!(positionMs >= 0) || (total && positionMs >= total)) return;
    state.position = positionMs;
    if (state.bufferPlaying && state.source) {
      stopPlay(state);
      startPlay(state);
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
  // `ahead` samples.  The DirectSound ring buffer becomes the decoded track:
  // looping buffers wrap around, one-shot buffers report silence past the end.
  const readVisSamples = (state, dest, numsamples, channels, ahead) => {
    if (!state.useVisBuffer || !state.buffer || !state.bufferPlaying || !state.sourceStarted || state.paused) return 0;
    const source = state.buffer, sourceChannels = source.numberOfChannels;
    if (channels !== 1 && channels !== sourceChannels) return 0;
    const count = Math.trunc(number(numsamples)), total = source.length;
    if (!(count > 0) || !total) return 0;
    const data = state.sampleData ??= Array.from({ length: sourceChannels }, (_, channel) => source.getChannelData(channel));
    const looping = !!state.looping;
    const aheadDecoded = Math.trunc(number(ahead) *
      (state.decodedRate || source.sampleRate) / (state.sourceRate || source.sampleRate));
    const start = Math.trunc(currentPosition(state) * source.sampleRate / 1000) + aheadDecoded;
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
        position: 0, frequency: 0, sourceRate: 0, decodedRate: 0, bits: 16,
        paused: false, pan: 0, posX: 0, posY: 0, posZ: 0,
        filters: nativeOwnedArray(owner), flags: new Int32Array(16), useVisBuffer: false,
        filterSnapshot: null,
        buffer: null, sampleData: null, source: undefined, workletSource: null, gain: undefined, panner: undefined,
        panNodes: null, panInputs: null, inputGain: undefined, codecGain: 1, activeFilters: [],
        transport: 'none', bufferPlaying: false, sourceStarted: false,
        startedAt: 0, playStart: 0, fallbackLoopStart: undefined, fallbackLoopEnd: undefined,
        loopInfo: { links: [], labels: [] }, openGeneration: 0, eventToken: 0,
        fading: false, fadeTarget: 0, fadeCount: 0, blankLeft: 0, deltaVolume: 0, fadeTimer: null,
      };
    }

    @nativeMethod WaveSoundBuffer() {}
    @nativeMethod async open(name) {
      if (!arguments.length) throw new Error('TJS WaveSoundBuffer.open requires storage');
      const state = this;
      const generation = ++state.openGeneration;
      clear(state);
      // WaveImpl.cpp Clear -> Stop -> SetStatus(ssStop) -> SetStatus(ssUnload).
      if (state.status !== 'unload') setStatus(state, 'stop');
      setStatus(state, 'unload');
      let bytes, buffer, loopInfo = { links: [], labels: [] }, format;
      try {
        // WaveImpl.cpp RebuildFilterChain runs at Open; later changes to the
        // filters array are not visible until the next open.  Requiring the
        // filter instance here also reproduces Recreate's "one buffer at a
        // time" error at open time rather than at play time.
        state.filterSnapshot = (state.filters ?? []).slice();
        const claimedFilters = state.filterSnapshot.map(value => Phase.state(value));
        for (const filter of claimedFilters) {
          if (filter.sound && filter.sound !== state) {
            throw new Error('PhaseVocoder cannot connect multiple WaveSoundBuffers at once');
          }
        }
        for (const filter of claimedFilters) filter.sound = state;
        state.activeFilters = claimedFilters;
        bytes = await storage.read(name);
        if (generation !== state.openGeneration) return;
        // The first Ogg packet identifies the decoder independently of the
        // storage extension. Query once at open, on the script execution queue.
        if (bytes[0] === 79 && bytes[1] === 103 && bytes[2] === 103 && bytes[3] === 83 && bytes.length > 26) {
          const packet = 27 + bytes[26];
          if (packet + 8 <= bytes.length) {
            const signature = String.fromCharCode(...bytes.subarray(packet, packet + 8));
            const callback = signature === 'OpusHead' ? gainQueryCallbackOPUS
              : signature.startsWith('\x01vorbis') ? gainQueryCallback : null;
            if (callback) {
              const value = await script(callback)(name);
              let gain;
              try { gain = 10 ** (number(value) / 20); }
              finally { await disposeScriptValue(value); }
              if (generation !== state.openGeneration) return;
              state.codecGain = gain;
            }
          }
        }
        format = probeAudioFormat(bytes);
        const context = getAudioContext();
        buffer = await context.decodeAudioData(bytes.slice().buffer);
        if (generation !== state.openGeneration) return;

        const sliName = String(name) + '.sli';
        if (await storage.has(sliName)) {
          const sli = await storage.read(sliName);
          if (generation !== state.openGeneration) return;
          try {
            loopInfo = parseLoopInformation(new TextDecoder().decode(sli));
          } catch (error) {
            throw new Error(`Invalid loop information: ${sliName}: ${error?.message ?? error}`);
          }
        }
        if (generation !== state.openGeneration) return;

        state.buffer = buffer;
        state.decodedRate = buffer.sampleRate;
        state.sourceRate = format?.sampleRate || buffer.sampleRate;
        // RebuildFilterChain converts float/24/32-bit decoder output to PCM16;
        // only 8-bit sources remain 8-bit in InputFormat.
        state.bits = format?.bits === 8 ? 8 : 16;
        state.frequency = state.sourceRate;
        state.position = 0;
        state.sampleData = null;
        state.loopInfo = loopInfo;
        setStatus(state, 'stop');
      } catch (error) {
        if (generation !== state.openGeneration) return;
        clear(state);
        setStatus(state, 'unload');
        throw error;
      }
    }
    @nativeMethod async play() {
      const state = this;
      if (!scheduling || !state.buffer || state.bufferPlaying) return;
      const generation = state.openGeneration;
      const { context } = await ensureAudio();
      if (!scheduling || state.openGeneration !== generation || !state.buffer || state.bufferPlaying) return;
      stopPlay(state);
      startPlay(state, context);
      // WaveImpl.cpp Play: Status becomes play after StartPlay.  The transport
      // is created even while Paused; in that case it remains silent.
      setStatus(state, 'play');
    }
    @nativeMethod stop() {
      const state = this;
      // Stop (WaveImpl.cpp 3451): halt, status stop, rewind. Paused is kept;
      // the reference does not stop an active fade.
      stopPlay(state);
      if (state.status !== 'unload') setStatus(state, 'stop');
      state.position = 0;
    }
    @nativeMethod fade(to, time, blanktime = 0) {
      if (arguments.length < 2) throw new Error('TJS WaveSoundBuffer.fade requires a target volume and a time');
      if (!scheduling) return;
      const state = this;
      if (!state.owner) return;
      time = Math.trunc(number(time));
      blanktime = Math.trunc(number(blanktime));
      if (time <= 0 || blanktime < 0) throw new Error('TJS invalid parameter');
      if (state.fading) stopFade(state, false, false);
      // SoundBufferBaseIntf.cpp Fade: target/delta are integer values; SetVolume
      // clamps only when each beat is applied.
      state.fadeTarget = Math.trunc(number(to));
      state.deltaVolume = Math.trunc((state.fadeTarget - state.volume) * BEAT / time);
      state.fadeCount = Math.trunc(time / BEAT);
      state.blankLeft = blanktime;
      state.fading = true;
      if (state.fadeCount === 0 && state.blankLeft === 0) stopFade(state, false, true);
      else if (!state.fadeTimer) state.fadeTimer = setInterval(() => beat(state), BEAT);
    }
    @nativeMethod stopFade() { stopFade(this, false, true); }
    // The engine's WaveSoundBuffer exposes finalize for the per-instance device
    // state; the game's VoiceSoundBuffer calls it from its own finalize before
    // invalidation (system/voice.tjs).
    @nativeMethod finalize() {
      const state = this;
      ++state.openGeneration;
      if (state.fadeTimer) { clearInterval(state.fadeTimer); state.fadeTimer = null; }
      state.fading = false;
      stopPlay(state);
      releaseWorklet(state);
      releaseFilterClaims(state);
      state.buffer = null;
      state.sampleData = null;
      state.loopInfo = { links: [], labels: [] };
      state.position = 0;
    }
    @nativeMethod setPos(x, y, z) {
      if (arguments.length < 3) throw new Error('TJS WaveSoundBuffer.setPos requires 3 arguments');
      const state = this;
      state.posX = number(x); state.posY = number(y); state.posZ = number(z);
      applyPanner(state);
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
        if (state.transport === 'worklet') state.source.port.postMessage({ type: 'looping', value: state.looping });
        else state.source.loop = state.looping;
      }
    }
    @nativeProperty get frequency() { return this.frequency; }
    @nativeProperty set frequency(value) {
      const state = this;
      state.frequency = Math.trunc(number(value));
      // WaveImpl.cpp SetFrequencyToBuffer is a no-op; Frequency only feeds the
      // label/position estimator and never changes playback rate or pitch.
      if (state.source?.port) state.source.port.postMessage({ type: 'frequency', value: state.frequency });
    }
    @nativeProperty get paused() { return Number(this.paused); }
    @nativeProperty set paused(value) { setPaused(this, value); }
    // position/samplePosition (WaveIntf.cpp 1466/1488) are ms/sample seeks.
    @nativeProperty get position() { return Math.trunc(currentPosition(this)); }
    @nativeProperty set position(value) { seek(this, Math.trunc(number(value))); }
    @nativeProperty get samplePosition() {
      const state = this;
      if (!state.buffer) return 0;
      return Math.trunc(currentPosition(state) * (state.sourceRate || state.decodedRate) / 1000);
    }
    @nativeProperty set samplePosition(value) {
      const state = this;
      if (!state.buffer) return;
      const rate = state.sourceRate || state.decodedRate;
      if (rate > 0) seek(state, Math.trunc(number(value)) * 1000 / rate);
    }
    @nativeProperty get totalTime() {
      const state = this;
      return state.buffer ? Math.trunc(state.buffer.duration * 1000) : 0;
    }
    @nativeProperty get bits() { return this.bits; }
    @nativeProperty get channels() { return this.buffer?.numberOfChannels ?? 0; }
    @nativeProperty get labels() {
      const state = this;
      const entries = [];
      for (const label of state.loopInfo?.labels ?? []) {
        if (!label.Name) continue;
        const rate = state.sourceRate || state.decodedRate || 1;
        const item = nativeDictionary(this, [
          ['name', label.Name],
          ['samplePosition', label.Position],
          ['position', Math.trunc(label.Position * 1000 / rate)],
        ]);
        entries.push([label.Name, item]);
      }
      return nativeDictionary(this, entries);
    }
    @nativeProperty get pan() { return this.pan; }
    @nativeProperty set pan(value) {
      this.pan = Math.max(-100000, Math.min(100000, Math.trunc(number(value))));
      applyPan(this);
    }
    @nativeProperty static get globalVolume() { return globalVolume; }
    @nativeProperty static set globalVolume(value) {
      globalVolume = clampVolume(value);
      applyAllGains();
    }
    @nativeProperty static get globalFocusMode() { return globalFocusMode; }
    @nativeProperty static set globalFocusMode(value) {
      globalFocusMode = Math.trunc(number(value));
      applyAllGains();
    }
  }

  Wave.invalidate = async owner => {
    const state = Wave.state(owner);
    ++state.openGeneration;
    state.owner = null;
    if (state.fadeTimer) clearInterval(state.fadeTimer);
    state.fadeTimer = null;
    state.fading = false;
    stopPlay(state);
    releaseWorklet(state);
    releaseFilterClaims(state);
    state.buffer = null;
    state.loopInfo = { links: [], labels: [] };
    state.sampleData = null;
    state.filterSnapshot = null;
    state.position = 0;
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
      releaseWorklet(state);
      releaseFilterClaims(state);
    }
  };
  Wave.finalize = async () => {
    if (documentObject?.removeEventListener) {
      documentObject.removeEventListener('pointerdown', unlockAudio, true);
      documentObject.removeEventListener('keydown', unlockAudio, true);
      documentObject.removeEventListener('visibilitychange', focusHandler);
    }
    if (view?.removeEventListener) {
      view.removeEventListener('focus', focusHandler);
      view.removeEventListener('blur', focusHandler);
    }
    const callbacks = [gainQueryCallback, gainQueryCallbackOPUS];
    gainQueryCallback = gainQueryCallbackOPUS = null;
    let failure;
    for (const callback of callbacks) {
      try { await disposeScriptValue(callback); }
      catch (error) { failure ??= error; }
    }
    workletModule = null;
    workletContext = null;
    for (const stage of masterStages) {
      stage.mixStage.port.postMessage({ type: 'dispose' });
      try { stage.mixStage.disconnect(); } catch {}
    }
    masterStages = [];
    masterContext = null;
    mixerModule = null;
    mixerContext = null;
    if (failure) throw failure;
  };

  // Extend/splice the ordered mix chain without rebuilding unrelated stages.
  // Connect replacement edges before removing the old edge, so a short sound
  // cannot temporarily disconnect every already-playing stream.
  function connectMaster(state, context) {
    masterContext = context;
    const canMix = mixerContext === context && !!mixerModule && !mixerUnavailable &&
      typeof AudioWorkletNode === 'function';
    if (canMix) {
      const previous = masterStages.at(-1)?.mixStage;
      const stage = state.mixStage = createMixStage(context);
      state.gain.connect(stage, 0, 1);
      stage.connect(context.destination);
      if (previous) {
        previous.connect(stage, 0, 0);
        previous.disconnect(context.destination);
      }
      masterStages.push(state);
    } else state.gain.connect(context.destination);
  }
  function disconnectMaster(state) {
    const index = masterStages.indexOf(state);
    if (index < 0) return;
    const stage = state.mixStage;
    const previous = masterStages[index - 1]?.mixStage;
    const next = masterStages[index + 1]?.mixStage;
    if (previous) {
      previous.connect(next ?? masterContext.destination, 0, 0);
      previous.disconnect(stage);
    }
    stage.port.postMessage({ type: 'dispose' });
    stage.disconnect();
    masterStages.splice(index, 1);
    state.mixStage = null;
  }

  // Build the Web Audio output graph.  Volume is a GainNode; pan is the
  // reference software mixer's linear left/right attenuation, implemented with
  // splitter + two gains + merger.  posX/Y/Z insert a PannerNode on demand.
  function createAudioGraph(context, source) {
    const gain = context.createGain();
    // Explicit stereo up/down-mix: mono is duplicated to both channels before
    // the pan splitter, and a PannerNode output stays stereo after insertion.
    const inputGain = context.createGain();
    try {
      inputGain.channelCount = 2;
      inputGain.channelCountMode = 'explicit';
      inputGain.channelInterpretation = 'speakers';
    } catch {}
    source.connect(inputGain);
    let panNodes = null;
    const panInputs = [inputGain];
    if (typeof context.createChannelSplitter === 'function' && typeof context.createChannelMerger === 'function') {
      const gainL = context.createGain();
      const gainR = context.createGain();
      const merger = context.createChannelMerger(2);
      const splitter = context.createChannelSplitter(2);
      inputGain.connect(splitter);
      splitter.connect(gainL, 0);
      splitter.connect(gainR, 1);
      gainL.connect(merger, 0, 0);
      gainR.connect(merger, 0, 1);
      merger.connect(gain);
      panNodes = { splitter, gainL, gainR, merger };
    } else {
      inputGain.connect(gain);
    }
    return { gain, pan: panNodes, panInputs, inputGain };
  }

  async function ensureWorklet(context) {
    if (!context.audioWorklet || workletUnavailable) return false;
    if (workletContext !== context) {
      workletContext = context;
      workletModule = null;
    }
    if (!workletModule) workletModule = context.audioWorklet.addModule(phaseVocoderWorkletURL);
    try {
      await workletModule;
      return true;
    } catch (error) {
      workletUnavailable = true;
      workletModule = null;
      report(`AudioWorklet unavailable: ${error?.message ?? error}`);
      return false;
    }
  }
  async function ensureMixer(context) {
    if (!context.audioWorklet || mixerUnavailable) return false;
    if (mixerContext !== context) {
      mixerContext = context;
      mixerModule = null;
    }
    if (!mixerModule) mixerModule = context.audioWorklet.addModule(soundMixerWorkletURL);
    try {
      await mixerModule;
      return true;
    } catch (error) {
      mixerUnavailable = true;
      mixerModule = null;
      report(`AudioWorklet mixer unavailable: ${error?.message ?? error}`);
      return false;
    }
  }
  async function ensureAudio() {
    const context = getAudioContext();
    const worklet = await ensureWorklet(context);
    await ensureMixer(context);
    // Do not await resume(): browsers may keep this promise pending until a
    // user gesture, which would block the TJS play() call (the reference Play
    // is synchronous).  The scheduled source starts as soon as the context
    // becomes running.
    if (context.state === 'suspended') context.resume().catch(() => {});
    return { context, worklet };
  }

  // StartPlay (WaveImpl.cpp 3190): build the transport and filter chain, then
  // start the device unless Paused.  The worklet is created synchronously so
  // property setters such as seek/paused can restart it in call order.
  function startPlay(state, context = getAudioContext()) {
    if (!scheduling || !state.buffer) return;
    const filters = (state.filterSnapshot ?? state.filters ?? []).map(value => Phase.state(value));
    for (const filter of filters) {
      if (filter.sound && filter.sound !== state) throw new Error('PhaseVocoder cannot connect multiple WaveSoundBuffers at once');
    }
    const channels = state.buffer.numberOfChannels;
    const ratio = state.sourceRate > 0 ? state.decodedRate / state.sourceRate : 1;
    const loopInfo = convertLoopInformation(state.loopInfo, ratio);
    const startSample = Math.max(0, Math.min(state.buffer.length,
      Math.trunc(state.position * state.decodedRate / 1000)));
    const needsWorklet = filters.length || loopInfo.links.length || loopInfo.labels.length;
    // Plain tracks already have native looping, seek and pause support. They
    // do not need a second PCM copy or a JS callback per render quantum.
    const canWorklet = needsWorklet && !workletUnavailable && !!context.audioWorklet &&
      typeof AudioWorkletNode !== 'undefined' && workletContext === context && !!workletModule;
    if (filters.length && !canWorklet) throw new Error('PhaseVocoder requires AudioWorklet support');
    const generation = state.playGeneration = (state.playGeneration ?? 0) + 1;
    let source;
    if (canWorklet) {
      const options = {
        generation,
        sampleRate: state.decodedRate,
        position: startSample,
        looping: state.looping,
        links: loopInfo.links,
        labels: loopInfo.labels,
        flags: Array.from(state.flags),
        frequency: state.frequency,
        paused: state.paused,
        filters: filters.map(filterConfig),
      };
      source = state.workletSource;
      if (!source) {
        source = state.workletSource = new AudioWorkletNode(context, 'krkr-wave', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [channels],
        });
        // AudioBuffer owns its PCM: copy once on the main thread, then transfer
        // ownership instead of cloning a whole track on the audio render thread.
        const pcm = Array.from({ length: channels }, (_, channel) => state.buffer.getChannelData(channel).slice());
        source.port.postMessage({ type: 'load', channels: pcm, options }, pcm.map(channel => channel.buffer));
      } else source.port.postMessage({ type: 'restart', options });
      state.transport = 'worklet';
      source.port.onmessage = ({ data }) => {
        if (state.source !== source || data.generation !== generation) return;
        if (data.type === 'position') {
          if (!state.paused && state.decodedRate > 0) {
            state.position = Math.min(state.buffer.duration * 1000, data.value / state.decodedRate * 1000);
          }
        } else if (data.type === 'label') {
          fire(state, 'onLabel', [data.name]);
        } else if (data.type === 'flags') {
          for (let index = 0; index < 16; index++) state.flags[index] = data.values?.[index] ?? 0;
        } else if (data.type === 'ended') {
          finishEnded(state, source, generation);
        }
      };
      source.onprocessorerror = error => report(`WaveSoundBuffer worklet failed: ${error?.message ?? error}`);
    } else {
      source = context.createBufferSource();
      source.buffer = state.buffer;
      source.loop = state.looping;
      source.playbackRate.value = 1;
      state.transport = 'buffer';
      state.fallbackLoopStart = undefined;
      state.fallbackLoopEnd = undefined;
      const simple = (state.loopInfo?.links ?? []).find(link => !link.Smooth && link.To < link.From);
      if (state.looping && simple) {
        const loopStart = simple.To / (state.sourceRate || state.decodedRate);
        const loopEnd = simple.From / (state.sourceRate || state.decodedRate);
        if (loopEnd > loopStart) {
          source.loopStart = loopStart;
          source.loopEnd = Math.min(loopEnd, state.buffer.duration);
          state.fallbackLoopStart = loopStart * 1000;
          state.fallbackLoopEnd = Math.min(loopEnd, state.buffer.duration) * 1000;
        }
      }
      source.onended = () => {
        if (state.source !== source) return;
        stopPlay(state);
        state.position = 0;
        setStatus(state, 'stop');
      };
    }
    const graph = createAudioGraph(context, source);
    state.gain = graph.gain;
    state.inputGain = graph.inputGain;
    state.panNodes = graph.pan;
    state.panInputs = graph.panInputs;
    state.panner = undefined;
    state.source = source;
    applyGain(state);
    applyPan(state);
    applyPanner(state);
    state.bufferPlaying = true;
    state.sourceStarted = !state.paused;
    state.startedAt = context.currentTime;
    state.playStart = state.position;
    buffers.add(state);
    connectMaster(state, context);
    filters.forEach((filter, index) => { filter.sound = state; filter.index = index; });
    state.activeFilters = filters;
    if (!canWorklet && !state.paused) {
      source.start(0, Math.max(0, state.position / 1000));
    }
  }

  function finishEnded(state, source, generation) {
    const context = getAudioContext();
    const latency = Math.max(0, ((context.outputLatency ?? context.baseLatency ?? 0) * 1000));
    setTimeout(() => {
      if (state.source !== source || state.playGeneration !== generation) return;
      stopPlay(state);
      state.position = 0;
      setStatus(state, 'stop');
    }, latency);
  }

  // SetPaused (WaveImpl.cpp 3491): the flag suppresses transport output.  The
  // worklet keeps its DSP/loop state; the fallback BufferSource is stopped and
  // recreated from the frozen position.
  const setPaused = (state, value) => {
    const paused = !!truth(value);
    if (state.paused === paused) return;
    state.paused = paused;
    if (!state.buffer) return;
    if (paused) {
      if (state.source && state.sourceStarted) {
        if (state.transport === 'worklet') {
          state.source.port.postMessage({ type: 'pause' });
          state.sourceStarted = false;
        } else {
          state.position = currentPosition(state);
          stopPlay(state);
          // BufferPlaying stays true in the reference while the device is
          // paused; a later unpause recreates the transport.
          state.bufferPlaying = true;
        }
      }
    } else if (state.bufferPlaying && state.status === 'play' && !state.sourceStarted) {
      if (state.transport === 'worklet' && state.source) {
        state.source.port.postMessage({ type: 'start' });
        state.sourceStarted = true;
      } else if (state.transport === 'buffer' && state.source) {
        const context = getAudioContext();
        state.startedAt = context.currentTime;
        state.playStart = state.position;
        state.source.start(0, Math.max(0, state.position / 1000));
        state.sourceStarted = true;
      } else {
        startPlay(state);
      }
    }
  };

  function beat(state) {
    if (state.blankLeft) {
      state.blankLeft -= BEAT;
      if (state.blankLeft < 0) state.blankLeft = 0;
    } else if (state.fadeCount) {
      if (state.fadeCount === 1) stopFade(state, true, true);
      else {
        state.fadeCount--;
        state.volume = clampVolume(state.volume + state.deltaVolume);
        applyGain(state);
      }
    } else if (state.fadeTimer) {
      clearInterval(state.fadeTimer);
      state.fadeTimer = null;
    }
  }
  function stopFade(state, async, settargetvol) {
    if (state.fadeTimer) { clearInterval(state.fadeTimer); state.fadeTimer = null; }
    if (!state.fading) return;
    state.fading = false;
    if (settargetvol) {
      state.volume = clampVolume(state.fadeTarget);
      applyGain(state);
    }
    fire(state, 'onFadeCompleted', []);
  }
  for (const name of ['posX', 'posY', 'posZ']) {
    Wave.defineProperty(name, owner => Wave.state(owner)[name], (owner, value) => {
      const state = Wave.state(owner);
      state[name] = number(value);
      applyPanner(state);
    });
  }
  // WaveFlags is a standalone native class; the buffer's `flags` property is a
  // view of its loop manager's flag array.
  Wave.WaveFlags = WaveFlags;
  Wave.PhaseVocoder = Phase;
  // Plugin-side view access for getSample.dll and derived plugins.
  Wave.readVisSamples = (state, dest, numsamples, channels = 1, ahead = 0) =>
    readVisSamples(state, dest, numsamples, channels, ahead);
  // The class-valued member stays a member value: encodeNativeValue registers
  // it as a linked class rather than a script getter.
  Wave.members.set('PhaseVocoder', Phase);
  return Wave;
}
