import { config } from './global.js';
// VideoOverlay from VideoOvlIntf.cpp / VideoOvlImpl.cpp. Frames are decoded
// by mediabunny (WebCodecs) and routed into layer1/layer2 exactly like
// KRMovieLayer's double buffer (MoviePlayerLayer::OnPlayEvent EC_UPDATE).
// Only vomLayer rendering is implemented; vomMixer/vomMFEVR playback falls
// back the same way the game's own Movie script falls back when mixer
// playback fails. A format WebCodecs cannot decode fails open() with a thrown
// error, matching "no video decoder available" in the original Open().
import { nativeClass, nativeMembers, nativeProperty, unimplemented, reportUnimplemented, nativeOwner, callScript, retainScriptValue, disposeScriptValue } from '#krkr/native';
import { number, truth } from '#krkr/values';
import { Image } from './bitmap.js';
import { Input, ALL_FORMATS, BufferSource, VideoSampleSink, AudioSampleSink } from './media-core.js';

// tTVPPeriodEventReason (VideoOvlIntf.h).
export const perLoop = 0, perPeriod = 1, perPrepare = 2, perSegLoop = 3;

const unwrap = value => nativeOwner(value);

// Probe metadata once at open: size, fps, duration, track handles. The input
// must stay alive for the sinks; the original keeps the IStream similarly.
async function probeVideo(bytes) {
  const input = new Input({ formats: ALL_FORMATS, source: new BufferSource(bytes) });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) throw new Error('Video storage has no video track');
  const audioTrack = (await input.getAudioTracks())[0] ?? null;
  const stats = await videoTrack.computePacketStats();
  const fps = stats.averagePacketRate;
  const duration = await input.computeDuration();
  return {
    input, videoTrack, audioTrack, fps, duration,
    numberOfFrame: Math.max(1, Math.round(duration * fps)),
    width: videoTrack.displayWidth, height: videoTrack.displayHeight,
    totalTime: Math.round(duration * 1000),
  };
}

// Decode the whole audio track up front and play it through one
// AudioBufferSourceNode. Event/OP clips are 1-3 minutes, so the decoded
// buffer is ~10-30 MB — the same order WaveSoundBuffer already holds. One
// node gives sample-accurate start offsets, native playbackRate and a clock
// (context.currentTime) the video timeline follows.
class Player {
  constructor(info, getAudioContext, view) {
    this.info = info;
    this.getAudioContext = getAudioContext;
    this.view = view;
    this.videoSink = new VideoSampleSink(info.videoTrack);
    this.audioSink = info.audioTrack ? new AudioSampleSink(info.audioTrack) : null; this.audioBuffer = null;
    this.source = null;
    this.gain = null;
    this.videoIterator = null;
    this.pending = [];       // decoded video samples ahead of the clock
    this.pts = 0;            // current presentation time (seconds)
    this.rate = 1;
    this.volume = 1; this.balance = 0;
    this.playing = false;
    this.raf = 0;
    this.startContextTime = 0;  // AudioContext time when pts == startPts
    this.startWallTime = 0;     // performance.now() when pts == startPts
    this.startPts = 0;
    this.onUpdate = null;    // (sample, frame) => void
    this.onEnded = null;     // (finishedAtPts) => void
    this.onError = null;     // (error) => void
    this.onSegmentLoop = null;
    this.segmentLoop = null; // { start, end } frames
    this.stopped = true;
    this.audioError = null;
  }

  // Decode the full audio track once at open. A failure leaves the video
  // playing silently but is recorded and reported to the caller rather than
  // silently discarded (EC_UPDATE keeps running on the wall clock).
  async decodeAudio() {
    if (!this.audioSink) return;
    try {
      const context = this.getAudioContext();
      this.gain = context.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(context.destination);
      let merged = null;
      for await (const sample of this.audioSink.samples()) {
        const buffer = sample.toAudioBuffer();
        sample.close?.();
        if (!merged) {
          merged = context.createBuffer(buffer.numberOfChannels, Math.ceil(buffer.sampleRate * this.info.duration), buffer.sampleRate);
        }
        // Append; samples arrive in presentation order and may have gaps,
        // so write each at its own offset rather than sequential copy.
        const offset = Math.min(merged.length, Math.max(0, Math.round(sample.timestamp * buffer.sampleRate)));
        const frames = Math.min(buffer.length, merged.length - offset);
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
          merged.copyToChannel(buffer.getChannelData(Math.min(ch, buffer.numberOfChannels - 1)).subarray(0, frames), ch, offset);
        }
      }
      this.audioBuffer = merged;
    } catch (error) {
      this.audioBuffer = null;
      this.audioError = error;
      throw error;
    }
  }

  startAt(time) {
    // Restart decode stream; keep playing state untouched (rewind semantics).
    this.videoIterator = this.videoSink.samples(time)[Symbol.asyncIterator]();
    this.pending = [];
    this.startPts = time;
    this.pts = time;
    if (this.playing) this.startClock();
  }

  startClock() {
    const context = this.getAudioContext();
    this.startContextTime = context.currentTime;
    this.startWallTime = performance.now();
    if (this.source) { this.source.onended = null; try { this.source.stop(); } catch {} this.source.disconnect(); this.source = null; }
    if (this.audioBuffer) {
      this.source = context.createBufferSource();
      this.source.buffer = this.audioBuffer;
      this.source.playbackRate.value = this.rate;
      this.source.connect(this.gain);
      const ended = this.onEnded;
      this.source.onended = () => { if (this.playing) ended?.(this.info.duration); };
      // Seeking before the clip start: currentTime runs while silent.
      const silent = this.startPts < 0 ? -this.startPts : 0;
      this.source.start(context.currentTime + silent, Math.max(0, this.startPts), undefined);
      if (silent) this.source.disconnect(); // keep clock, drop early audio
    }
  }

  // Video-only clips follow the wall clock (the reference backend always
  // advances a media clock, audio or not).
  wallPts() {
    if (!this.playing) return this.pts;
    if (this.audioBuffer) {
      return this.startPts + (this.getAudioContext().currentTime - this.startContextTime) * this.rate;
    }
    return this.startPts + (performance.now() - this.startWallTime) / 1000 * this.rate;
  }

  async play(time) {
    if (!this.videoIterator) {
      // First play after open: start the decode stream at the current pts.
      this.startAt(time ?? this.pts);
    }
    const context = this.getAudioContext();
    await context.resume();
    this.playing = true; this.stopped = false;
    if (time !== undefined) { this.startPts = time; this.pts = time; }
    else this.startPts = this.pts;
    this.startClock();
    this.view.cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.playing) return;
      this.raf = this.view.requestAnimationFrame(tick);
      this.present();
    };
    tick();
  }

  // Present frames whose pts <= clock (WndProc EC_UPDATE branch).
  present() {
    const pts = this.pts = this.wallPts();
    while (this.pending.length && this.pending[0].timestamp <= pts) {
      const sample = this.pending.shift();
      const frame = Math.floor(sample.timestamp * this.info.fps);
      const end = this.segmentLoop?.end ?? 0;
      if (end > 0 && frame >= end) {
        const start = this.segmentLoop.start > 0 ? this.segmentLoop.start : 0;
        this.playing = false;
        this.view.cancelAnimationFrame(this.raf);
        this.onSegmentLoop?.(start);
        return;
      }
      this.onUpdate?.(sample, frame);
      sample.close();
    }
    // Refill the two-slot buffer like MAX_BUFFER_COUNT.
    if (this.videoIterator && this.pending.length < 2 && !this.fillPromise) {
      this.fillPromise = (async () => {
        try {
          while (this.pending.length < 2) {
            const { value, done } = await this.videoIterator.next();
            if (done || !value) { this.videoIterator = null; this.exhausted = true; break; }
            this.pending.push(value);
          }
        } catch (error) {
          // A decode failure terminates playback and is reported; the status
          // must not keep claiming "play" (EC_COMPLETE -> Stop).
          this.videoIterator = null;
          this.playing = false;
          this.view.cancelAnimationFrame(this.raf);
          this.onError?.(error);
        } finally { this.fillPromise = null; }
      })();
    }
  }

  pause() {
    // Freeze the clock at the current pts; audio node discarded.
    this.pts = this.wallPts();
    this.playing = false;
    this.view.cancelAnimationFrame(this.raf);
    if (this.source) { this.source.onended = null; try { this.source.stop(); } catch {} this.source.disconnect(); this.source = null; }
  }

  resume() {
    this.play().then(() => {}, error => this.onError?.(error));
  }

  setRate(rate) {
    const anchor = this.wallPts();
    this.rate = rate;
    this.startPts = anchor;
    if (this.playing) this.startClock();
  }

  setVolume(volume, balance) {
    this.volume = Math.max(0, Math.min(1, volume / 100000));
    this.balance = Math.max(-1, Math.min(1, balance / 100000));
    if (!this.gain) return;
    this.gain.gain.value = this.volume;
    const context = this.getAudioContext();
    // StereoPanner replaces the connection when balance is used.
    if (this.balance && context.createStereoPanner) {
      if (!this.pan) {
        this.gain.disconnect();
        this.pan = context.createStereoPanner();
        this.pan.pan.value = this.balance;
        this.gain.connect(this.pan);
        this.pan.connect(context.destination);
      } else this.pan.pan.value = this.balance;
    }
  }

  stopPlayback() {
    this.playing = false; this.stopped = true;
    this.view.cancelAnimationFrame(this.raf);
    if (this.source) { this.source.onended = null; try { this.source.stop(); } catch {} this.source.disconnect(); this.source = null; }
    this.pending = []; this.videoIterator = null; this.pts = 0;
  }

  dispose() {
    this.stopPlayback();
    if (this.gain) { this.gain.disconnect(); this.gain = null; }
    if (this.pan) { this.pan.disconnect(); this.pan = null; }
    this.info.input.dispose();
  }
}

// VideoSample -> engine Image (RGBA). Rotation metadata is applied by
// sample.draw; the scratch canvas matches the current video size.
let scratchCanvas = null, scratchContext = null, scratchKey = '';
function sampleToImage(sample) {
  const width = sample.displayWidth, height = sample.displayHeight;
  const key = width + 'x' + height;
  if (scratchKey !== key) {
    scratchCanvas = new OffscreenCanvas(width, height);
    scratchContext = scratchCanvas.getContext('2d', { willReadFrequently: true });
    scratchKey = key;
  }
  scratchContext.clearRect(0, 0, width, height);
  sample.draw(scratchContext, 0, 0, width, height);
  const data = scratchContext.getImageData(0, 0, width, height);
  return Image.from(data.data, width, height);
}

// tTJSNI_VideoOverlay state machine, geometry and TJS surface.
export function createVideoOverlayClass({ Window, Layer, storage, getAudioContext }) {
  const { document, inform: report } = config;
  const view = document.defaultView;
  const players = new Set();
  let schedulingActive = true;
  // TVP_ACTION_INVOKE: call the named member on the action owner closure
  // (VideoOvlIntf.cpp TVP_ACTION_INVOKE_BEGIN/MEMBER/END).
  const fire = async (s, name, args) => {
    const owner = s.actionOwner;
    if (!owner) return;
    await callScript(owner, name, args, { receiver: owner, ignoreMissing: true });
  };
  const statusString = s => ({ unload: 'unload', play: 'play', stop: 'stop', pause: 'pause', ready: 'ready' })[s] ?? 'unknown';
  const setStatus = (s, status) => {
    if (s.status === status) return;
    s.status = status;
    if (s.owner) fire(s, 'onStatusChanged', [statusString(status)]);
  };
  // EC_UPDATE branch: size both layers to the video, replace the main
  // image, then fire onFrameUpdate / period events.
  const pushFrame = (s, sample, frame) => {
    const image = sampleToImage(sample);
    for (const slot of [1, 2]) {
      const owner = s['layer' + slot];
      if (!owner) continue;
      const node = Layer.peekNode(owner);
      if (!node) continue;
      if (node.image.width !== image.width || node.image.height !== image.height) {
        node.image = image.clone();
        node.width = image.width;
        node.height = image.height;
      } else {
        node.image.writablePixels.set(image.pixels);
      }
      node.imageModified = true;
      if (s.onLayerChange) s.onLayerChange();
    }
    fire(s, 'onFrameUpdate', [frame]);
    if (s.isPrepare) {
      s.isPrepare = false;
      fire(s, 'onPeriod', [perPrepare]);
    } else if (s.eventFrame >= 0 && !s.isEventPast && frame >= s.eventFrame) {
      s.eventFrame = -1;
      fire(s, 'onPeriod', [perPeriod]);
    }
  };
  const eachVideoLayer = (s, fn) => {
    for (const slot of [1, 2]) {
      const owner = s['layer' + slot];
      if (!owner) continue;
      const node = Layer.peekNode(owner);
      if (node) fn(node);
    }
  };

  @nativeClass('VideoOverlay')
  @nativeMembers({
    // Construct (VideoOvlIntf.cpp 28): param[0] must be a Window; the game's
    // Movie passes (window, id) and the id is ignored by the native form.
    VideoOverlay: function(window) {
      if (!arguments.length) throw new Error('TJS VideoOverlay constructor requires a window');
      const s = this;
      const windowOwner = unwrap(window);
      if (!windowOwner || !Window.state?.(windowOwner)) throw new Error('TJS specify window');
      s.window = Window.state(windowOwner);
      s.owner = unwrap(this);
      s.actionOwner = retainScriptValue(windowOwner, this);
      s.onLayerChange = s.window.onUpdate;
    },
    open: async function(name) {
      if (!arguments.length) throw new Error('TJS VideoOverlay.open requires a storage name');
      const s = this;
      await this.close();
      const bytes = await storage.read(String(name));
      // Open (VideoOvlImpl.cpp 132) closes first, then throws when no decoder
      // can be built; the exception propagates so the caller can fall back.
      s.info = await probeVideo(bytes);
      const player = s.player = new Player(s.info, getAudioContext, view);
      players.add(player);
      player.onUpdate = (sample, frame) => pushFrame(s, sample, frame);
      player.onError = error => {
        // A mid-playback decode failure terminates playback (EC_COMPLETE ->
        // Stop + ssStop) and is reported rather than shown as success.
        s.lastError = error;
        player.stopPlayback();
        if (s.mode !== 3) setStatus(s, 'stop');
        report(`video decode failed: ${error?.message ?? error}`);
      };
      player.onEnded = finishedPts => {
        if (s.loop) {
          player.startAt(0);
          player.play(0).then(() => fire(s, 'onPeriod', [perLoop]), error => player.onError?.(error));
        } else {
          // All data has been rendered (WndProc EC_COMPLETE).
          setStatus(s, 'stop');
        }
      };
      player.onSegmentLoop = start => {
        player.startAt(start / s.info.fps);
        player.play(start / s.info.fps).then(() => fire(s, 'onPeriod', [perSegLoop]), error => player.onError?.(error));
      };
      // Audio decode failure must not be hidden: report it and let the video
      // run silently on the wall clock, or fail the open. The reference treats
      // a missing audio track as normal, but a decode error surfaces.
      try { await player.decodeAudio(); } catch (error) {
        report(`video audio decode failed: ${error?.message ?? error}`);
        throw error;
      }
      setStatus(s, 'stop');
    },
    play: function() {
      const s = this;
      if (!schedulingActive || !s.player) return;
      s.player.resume();
      if (s.mode !== 3) setStatus(s, 'play');
    },
    stop: function() {
      const s = this;
      if (!s.player) return;
      s.player.stopPlayback();
      if (s.mode !== 3) setStatus(s, 'stop');
    },
    close: function() {
      const s = this;
      if (s.player) { players.delete(s.player); s.player.dispose(); s.player = null; s.info = null; }
      s.isPrepare = false;
      setStatus(s, 'unload');
    },
    setPos: function(left, top) {
      if (arguments.length < 2) throw new Error('TJS VideoOverlay.setPos requires 2 arguments');
      const s = this;
      left = Math.trunc(number(left)); top = Math.trunc(number(top));
      if (s.mode === 1) eachVideoLayer(s, node => { node.left = left; node.top = top; });
      else { s.rect.left = left; s.rect.top = top; }
    },
    setSize: function(width, height) {
      if (arguments.length < 2) throw new Error('TJS VideoOverlay.setSize requires 2 arguments');
      const s = this;
      if (s.mode === 1) return;
      s.rect.right = s.rect.left + Math.trunc(number(width));
      s.rect.bottom = s.rect.top + Math.trunc(number(height));
    },
    setBounds: function(left, top, width, height) {
      if (arguments.length < 4) throw new Error('TJS VideoOverlay.setBounds requires 4 arguments');
      const s = this;
      if (s.mode === 1) return;
      s.rect.left = Math.trunc(number(left)); s.rect.top = Math.trunc(number(top));
      s.rect.right = s.rect.left + Math.trunc(number(width));
      s.rect.bottom = s.rect.top + Math.trunc(number(height));
    },
    pause: function() {
      const s = this;
      if (!s.player) return;
      s.player.pause();
      if (s.mode !== 3) setStatus(s, 'pause');
    },
    rewind: function() {
      const s = this;
      if (!schedulingActive || !s.player) return;
      s.player.startAt(0);
      if (s.status === 'play') s.player.resume();
      if (s.eventFrame >= 0 && s.isEventPast) s.isEventPast = false;
    },
    prepare: function() {
      // Prepare mode only exists for vomLayer (VideoOvlImpl.cpp 350).
      const s = this;
      if (!schedulingActive || !s.player || s.mode !== 1) return;
      s.player.pause();
      s.player.startAt(0);
      s.isPrepare = true;
      s.player.resume();
    },
    setSegmentLoop: function(start, end) {
      if (arguments.length < 2) throw new Error('TJS VideoOverlay.setSegmentLoop requires 2 arguments');
      const s = this;
      s.segLoopStart = Math.trunc(number(start));
      s.segLoopEnd = Math.trunc(number(end));
      if (s.player) s.player.segmentLoop = { start: s.segLoopStart, end: s.segLoopEnd };
    },
    cancelSegmentLoop: function() {
      const s = this;
      s.segLoopStart = -1; s.segLoopEnd = -1;
      if (s.player) s.player.segmentLoop = null;
    },
    setPeriodEvent: function(frame) {
      if (arguments.length < 1) throw new Error('TJS VideoOverlay.setPeriodEvent requires a frame');
      const s = this;
      s.eventFrame = arguments.length ? Math.trunc(number(frame)) : -1;
      const current = s.player && s.info ? Math.floor(s.player.pts * s.info.fps) : 0;
      s.isEventPast = s.eventFrame >= 0 && s.eventFrame <= current;
    },
    cancelPeriodEvent: function() {
      this.eventFrame = -1;
    },
    selectAudioStream: function(stream) {
      if (arguments.length < 1) throw new Error('TJS VideoOverlay.selectAudioStream requires a stream index');
      // Single audio track is always the selection; multi-track mp4 files in
      // this game carry one stream.
    },
    setMixingLayer: function(layer) {
      if (!arguments.length) throw new Error('TJS VideoOverlay.setMixingLayer requires a layer');
      // Mixing overlays are a vomMixer feature; accepted and ignored.
    },
    resetMixingLayer: unimplemented('VideoOverlay.resetMixingLayer'),
    // Event dispatch stubs (VideoOvlIntf.cpp 424-486): the native methods
    // invoke the same-named member on the action owner with named params.
    onStatusChanged: function(status) {
      const s = this;
      if (s.actionOwner) fire(s, 'status', [status]);
    },
    onCallbackCommand: function(command, arg) {
      const s = this;
      if (s.actionOwner) fire(s, 'Go', [command, arg]);
    },
    onPeriod: function(reason) {
      const s = this;
      if (s.actionOwner) fire(s, 'reason', [reason]);
    },
    onFrameUpdate: function(frame) {
      const s = this;
      if (s.actionOwner) fire(s, 'frame', [frame]);
    },
  })
  class VideoOverlay {
    static initialize(owner) {
      return {
        owner: null, actionOwner: null, window: null,
        status: 'unload', player: null, info: null,
        rect: { left: 0, top: 0, right: 320, bottom: 240 },
        visible: false, loop: false, mode: 0,
        layer1: null, layer2: null, onLayerChange: null,
        isPrepare: false,
        segLoopStart: -1, segLoopEnd: -1,
        eventFrame: -1, isEventPast: false,
        audioVolume: 100000, audioBalance: 0, playRate: 1,
        lastError: null,
      };
    }

    @nativeProperty get position() { const s = this; return s.player ? Math.round(s.player.pts * 1000) : 0; }
    @nativeProperty set position(value) { const s = this; if (s.player) s.player.startAt(number(value) / 1000); }
    @nativeProperty get left() { const s = this; return s.mode === 1 ? (Layer.peekNode(s.layer1)?.left ?? 0) : s.rect.left; }
    @nativeProperty set left(value) {
      const s = this;
      const left = Math.trunc(number(value));
      if (s.mode === 1) eachVideoLayer(s, node => { node.left = left; });
      else s.rect.left = left;
    }
    @nativeProperty get top() { const s = this; return s.mode === 1 ? (Layer.peekNode(s.layer1)?.top ?? 0) : s.rect.top; }
    @nativeProperty set top(value) {
      const s = this;
      const top = Math.trunc(number(value));
      if (s.mode === 1) eachVideoLayer(s, node => { node.top = top; });
      else s.rect.top = top;
    }
    @nativeProperty get width() { const s = this; return s.mode === 1 ? (Layer.peekNode(s.layer1)?.width ?? 0) : s.rect.right - s.rect.left; }
    @nativeProperty set width(value) { const s = this; s.rect.right = s.rect.left + Math.trunc(number(value)); }
    @nativeProperty get height() { const s = this; return s.mode === 1 ? (Layer.peekNode(s.layer1)?.height ?? 0) : s.rect.bottom - s.rect.top; }
    @nativeProperty set height(value) { const s = this; s.rect.bottom = s.rect.top + Math.trunc(number(value)); }
    @nativeProperty get originalWidth() { return this.info?.width ?? 0; }
    @nativeProperty get originalHeight() { return this.info?.height ?? 0; }
    @nativeProperty get visible() { return Number(this.visible); }
    @nativeProperty set visible(value) {
      const s = this;
      s.visible = !!truth(value);
      eachVideoLayer(s, node => { node.visible = s.visible; });
      if (s.onLayerChange) s.onLayerChange();
    }
    @nativeProperty get loop() { return Number(this.loop); }
    @nativeProperty set loop(value) { this.loop = !!truth(value); }
    @nativeProperty get frame() { const s = this; return s.player && s.info ? Math.floor(s.player.pts * s.info.fps) : 0; }
    @nativeProperty set frame(value) { const s = this; if (s.player) s.player.startAt(number(value) / (s.info?.fps || 1)); }
    @nativeProperty get fps() { return this.info?.fps ?? 0; }
    @nativeProperty get numberOfFrame() { return this.info?.numberOfFrame ?? 0; }
    @nativeProperty get totalTime() { return this.info?.totalTime ?? 0; }
    @nativeProperty get layer1() { return this.layer1; }
    @nativeProperty set layer1(value) { const s = this; s.layer1 = value === null || value === undefined ? null : unwrap(value); }
    @nativeProperty get layer2() { return this.layer2; }
    @nativeProperty set layer2(value) { const s = this; s.layer2 = value === null || value === undefined ? null : unwrap(value); }
    @nativeProperty get mode() { return this.mode; }
    // SetMode refuses changes after open (VideoOvlImpl.cpp 797).
    @nativeProperty set mode(value) { const s = this; if (!s.player) s.mode = Math.trunc(number(value)); }
    @nativeProperty get playRate() { return this.playRate; }
    @nativeProperty set playRate(value) {
      const s = this;
      s.playRate = number(value);
      if (s.player) s.player.setRate(s.playRate);
    }
    @nativeProperty get segmentLoopStartFrame() { return this.segLoopStart; }
    @nativeProperty get segmentLoopEndFrame() { return this.segLoopEnd; }
    @nativeProperty get periodEventFrame() { return this.eventFrame; }
    @nativeProperty get audioBalance() { return this.audioBalance; }
    @nativeProperty set audioBalance(value) {
      const s = this;
      s.audioBalance = Math.trunc(number(value));
      if (s.player) s.player.setVolume(s.audioVolume, s.audioBalance);
    }
    @nativeProperty get audioVolume() { return this.audioVolume; }
    @nativeProperty set audioVolume(value) {
      const s = this;
      s.audioVolume = Math.trunc(number(value));
      if (s.player) s.player.setVolume(s.audioVolume, s.audioBalance);
    }
    // Stream counts and the mixing/color parameter groups follow the reference
    // behavior when no mixer backend is attached: one enabled stream and the
    // disabled (-1) filter values (VideoOvlImpl.cpp 946-1098).
    @nativeProperty get numberOfAudioStream() { return this.info?.audioTrack ? 1 : 0; }
    @nativeProperty get enabledAudioStream() { return this.info?.audioTrack ? 0 : -1; }
    @nativeProperty get numberOfVideoStream() { return 1; }
    @nativeProperty get enabledVideoStream() { return 0; }
    @nativeProperty get mixingMovieAlpha() { return 0; }
    @nativeProperty set mixingMovieAlpha(value) { reportUnimplemented('VideoOverlay.mixingMovieAlpha setter'); }
    @nativeProperty get mixingMovieBGColor() { return 0; }
    @nativeProperty set mixingMovieBGColor(value) { reportUnimplemented('VideoOverlay.mixingMovieBGColor setter'); }
  }
  const state = owner => VideoOverlay.state(owner);
  for (const name of [
    'contrastRangeMin', 'contrastRangeMax', 'contrastDefaultValue', 'contrastStepSize', 'contrast',
    'brightnessRangeMin', 'brightnessRangeMax', 'brightnessDefaultValue', 'brightnessStepSize', 'brightness',
    'hueRangeMin', 'hueRangeMax', 'hueDefaultValue', 'hueStepSize', 'hue',
    'saturationRangeMin', 'saturationRangeMax', 'saturationDefaultValue', 'saturationStepSize', 'saturation',
  ]) VideoOverlay.defineProperty(name, () => -1, () => reportUnimplemented(`VideoOverlay.${name} setter`));
  VideoOverlay.stop = () => {
    schedulingActive = false;
    for (const player of players) player.stopPlayback();
  };
  VideoOverlay.invalidate = async owner => {
    const s = state(owner);
    if (s.player) { players.delete(s.player); s.player.dispose(); }
    s.player = null;
    s.info = null;
    await disposeScriptValue(s.actionOwner);
    s.actionOwner = null;
    s.owner = null;
  };
  return VideoOverlay;
}
