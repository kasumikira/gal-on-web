import { VideoAudio } from './video-audio.js';
import { config } from './global.js';
// VideoOverlay from VideoOvlIntf.cpp / VideoOvlImpl.cpp. 消费端是“时钟驱动”：
// libav/WebCodecs 后端把帧放进统一有界队列，本文件按媒体
// 时钟取出到期帧，再经公共图层呈现入口写进 layer1/layer2，等价于 KRMovieLayer
// 双缓冲的 MoviePlayerLayer::OnPlayEvent EC_UPDATE。
// Overlay and layer rendering are implemented; vomMixer/vomMFEVR playback falls
// back the same way the game's own Movie script falls back when mixer
// playback fails. A format WebCodecs cannot decode fails open() with a thrown
// error, matching "no video decoder available" in the original Open(); WMV3
// video and WMA2 audio use the modular libav.js backend.
import { nativeClass, nativeMembers, nativeProperty, nativeDictionary, unimplemented, reportUnimplemented, nativeOwner, callScript, retainScriptValue, disposeScriptValue } from '#krkr/native';
import { number, truth } from '#krkr/values';
import { VideoPipeline, presentVideoFrame, closeFrame } from './video-pipeline.js';
import { probeLibavVideo } from './video-libav.js';
import { Image } from './bitmap.js';
import { getGPU } from './gpu.js';
import { present } from './layer-composite.js';

export { uploadVideoCanvas } from './video-pipeline.js';

// tTVPPeriodEventReason (VideoOvlIntf.h).
export const perLoop = 0, perPeriod = 1, perPrepare = 2, perSegLoop = 3;

// Keep at most two decoded frames ahead; the reference GLES backend uses four.
const VIDEO_BUFFER_COUNT = 2;

const unwrap = value => nativeOwner(value);

// Video and PCM have independent bounded consumers; Web Audio provides the clock.
export class Player {
  constructor(info, getAudioContext, view) {
    this.info = info; this.source = info.source; this.getAudioContext = getAudioContext; this.view = view;
    this.pipeline = new VideoPipeline(this.source, { capacity: VIDEO_BUFFER_COUNT, onError: error => this.fail(error) });
    this.audio = null; this.gain = null; this.pan = null;
    this.pts = 0; this.startPts = 0; this.rate = 1; this.volume = 1; this.balance = 0;
    this.playing = false; this.stopped = true; this.completed = false; this.needsRewind = false;
    this.raf = 0; this.startWallTime = 0; this.segmentLoop = null;
    this.operation = Promise.resolve(); this.version = 0;
    this.presentation = null;
    this.onUpdate = null; this.onEnded = null; this.onError = null; this.onSegmentLoop = null;
  }
  run(operation) {
    const task = this.operation.then(operation);
    this.operation = task.catch(() => {});
    return task;
  }
  fail(error) { this.stopPlayback(); this.onError?.(error); }
  async prepareAudio() {
    if (!this.info.hasAudio || this.audio) return;
    const context = this.getAudioContext();
    this.audio = await VideoAudio.create(context, this.source, error => this.fail(error));
    this.gain = context.createGain(); this.gain.gain.value = this.volume;
    this.pan = context.createStereoPanner(); this.pan.pan.value = this.balance;
    this.audio.node.connect(this.gain); this.gain.connect(this.pan); this.pan.connect(context.destination);
    this.audio.setRate(this.rate);
  }
  async resetPosition(time) {
    this.playing = false; this.view.cancelAnimationFrame(this.raf);
    this.presentation = null;
    this.source.interrupt();
    const audioTask = this.audio?.stop();
    this.pipeline.clear();
    await Promise.all([audioTask, this.pipeline.stop()]);
    await this.pipeline.reseek(time);
    this.audio?.reset(time);
    this.pts = this.startPts = time; this.completed = false; this.needsRewind = false;
  }
  startAt(time, resume = false) {
    const version = this.version;
    return this.run(async () => {
      const playing = resume || this.playing;
      await this.resetPosition(time);
      if (playing) await this.beginPlay(undefined, version);
    });
  }
  wallPts() {
    if (!this.playing) return this.pts;
    return this.audio ? this.audio.time : this.startPts + (performance.now() - this.startWallTime) / 1000 * this.rate;
  }
  play(time) {
    const version = this.version;
    return this.run(() => this.beginPlay(time, version));
  }
  async beginPlay(time, version) {
    if (version !== this.version) return;
    // Browser autoplay may leave this promise pending until a gesture. PCM can
    // prebuffer meanwhile; AudioContext time stays frozen without audio output.
    this.getAudioContext().resume().catch(error => this.fail(error));
    await this.prepareAudio();
    if (version !== this.version) return;
    if (time !== undefined && time !== this.pts) await this.resetPosition(time);
    else if (this.needsRewind) await this.resetPosition(0);
    if (version !== this.version) return;
    this.startPts = this.pts; this.startWallTime = performance.now();
    this.playing = true; this.stopped = false; this.completed = false;
    this.pipeline.start();
    await this.audio?.play();
    if (!this.playing) return;
    this.view.cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.playing) return;
      this.raf = this.view.requestAnimationFrame(tick); this.present();
    };
    tick();
  }
  present() {
    if (this.presentation) return this.presentation;
    const task = Promise.resolve().then(() => this.presentFrames(task));
    this.presentation = task;
    task.finally(() => {
      if (this.presentation === task) this.presentation = null;
    }).catch(error => this.fail(error));
    return task;
  }
  async presentFrames(task) {
    if (this.presentation !== task) return;
    const pts = this.pts = this.wallPts();
    for (;;) {
      const frame = this.pipeline.peek();
      if (!frame || frame.timestamp > pts) break;
      const end = this.segmentLoop?.end ?? 0;
      if (end > 0 && frame.frame >= end) {
        const start = this.segmentLoop.start > 0 ? this.segmentLoop.start : 0;
        this.pause(); this.onSegmentLoop?.(start); return;
      }
      this.pipeline.shift();
      const next = this.pipeline.peek();
      // Another due frame supersedes these pixels, except across a loop edge.
      const render = !next || next.timestamp === null || next.timestamp > pts || (end > 0 && next.frame >= end);
      await this.push(frame, render);
      if (this.presentation !== task) return;
    }
    if (this.playing && !this.completed && this.pipeline.drained && (!this.audio || this.audio.ended)) {
      this.completed = true; this.pause(); this.onEnded?.(this.info.duration);
    }
  }
  async push(frame, render = true) {
    try { await this.onUpdate?.(frame, render); }
    catch (error) { this.fail(error); }
    finally { closeFrame(frame); }
  }
  pause() {
    this.version++;
    this.presentation = null;
    this.pts = this.wallPts(); this.playing = false;
    this.view.cancelAnimationFrame(this.raf); this.audio?.pause(); this.pipeline.stop();
  }
  resume() { return this.play().catch(error => this.fail(error)); }
  setRate(rate) {
    const time = this.wallPts(); this.rate = rate; this.startPts = this.pts = time;
    this.startWallTime = performance.now(); this.audio?.setRate(rate);
  }
  setVolume(volume, balance) {
    this.volume = Math.max(0, Math.min(1, volume / 100000));
    this.balance = Math.max(-1, Math.min(1, balance / 100000));
    if (this.gain) this.gain.gain.value = this.volume;
    if (this.pan) this.pan.pan.value = this.balance;
  }
  stopPlayback() {
    this.version++; this.playing = false; this.stopped = true;
    this.presentation = null;
    this.view.cancelAnimationFrame(this.raf); this.source.interrupt(); this.audio?.stop();
    this.pipeline.stop(); this.pipeline.clear(); this.pts = 0; this.needsRewind = true;
  }
  async dispose() {
    // onUpdate may be awaiting a script event that calls close(). Invalidating
    // presentation cancels its continuation; push() still releases its frame.
    // Waiting for that same event here would deadlock the VM event queue.
    this.stopPlayback(); await this.operation;
    await this.audio?.dispose(); await this.pipeline.dispose();
    this.gain?.disconnect(); this.pan?.disconnect();
  }
}

// tTJSNI_VideoOverlay state machine, geometry and TJS surface.
export function createVideoOverlayClass({ Window, Layer, storage, getAudioContext, enqueueEvent }) {
  const { document, inform: report } = config;
  const view = document.defaultView;
  const players = new Set();
  let schedulingActive = true;
  // Overlay pixels use the same upload/presentation path as movie layers, but
  // live above the window canvas, like the native overlay draw device.
  const overlayLayer = {
    peekState: node => ({ node }),
    peekNode: node => node,
    resizeNode(node, width, height) {
      node.width = width; node.height = height;
      if (node.image.width !== width || node.image.height !== height) node.image.resize(width, height);
    },
  };
  const moveOverlay = (s, left, top) => {
    s.rect.right += left - s.rect.left;
    s.rect.bottom += top - s.rect.top;
    s.rect.left = left; s.rect.top = top;
  };
  const updateOverlay = s => {
    if (!s.overlay) return;
    const canvas = s.window.canvas;
    const box = canvas.getBoundingClientRect();
    const sx = box.width / s.window.width, sy = box.height / s.window.height;
    Object.assign(s.overlay.canvas.style, {
      left: `${box.left + s.rect.left * sx}px`, top: `${box.top + s.rect.top * sy}px`,
      width: `${(s.rect.right - s.rect.left) * sx}px`, height: `${(s.rect.bottom - s.rect.top) * sy}px`,
    });
    s.overlay.canvas.hidden = !s.visible || canvas.hidden;
  };
  const closeOverlay = s => {
    if (!s.overlay) return;
    s.overlay.canvas.remove();
    s.overlay.image.release();
    s.overlay = null;
  };
  // Backend events target the VideoOverlay object so script overrides run.
  // Only the native default handlers below forward an event to ActionOwner.
  const fire = async (s, name, args) => {
    const owner = s.owner;
    if (!owner) return;
    const result = await callScript(owner, name, args);
    await disposeScriptValue(result);
  };
  const post = (s, name, args) => {
    if (!s.owner) return Promise.resolve();
    const owner = retainScriptValue(s.owner);
    const token = s.eventToken;
    return enqueueEvent(async () => {
      if (!s.owner || token !== s.eventToken) return;
      const result = await callScript(owner, name, args);
      await disposeScriptValue(result);
    }, () => disposeScriptValue(owner)).catch(error => report(`video ${name} failed: ${error.message}`));
  };
  const action = async (s, type, fields) => {
    if (!s.actionOwner) return;
    const event = nativeDictionary(s.owner, [['type', type], ['target', s.owner], ...fields]);
    try {
      const result = await callScript(s.actionOwner, 'action', [event]);
      await disposeScriptValue(result);
    } finally { await disposeScriptValue(event); }
  };
  const statusString = s => ({ unload: 'unload', play: 'play', stop: 'stop', pause: 'pause', ready: 'ready' })[s] ?? 'unknown';
  const setStatus = (s, status, deliver = fire) => {
    if (s.status === status) return;
    s.status = status;
    s.eventToken++;
    if (s.owner) return deliver(s, 'onStatusChanged', [statusString(status)]);
  };
  // EC_UPDATE branch: size both layers to the video, replace the main
  // image, then fire onFrameUpdate / period events.
  const pushFrame = async (s, frame, render) => {
    const token = s.eventToken;
    // Prepare still needs its first image; layer events run even without upload.
    render ||= s.isPrepare;
    if (s.mode === 0) {
      if (!render) return;
      if (!s.overlay) {
        const canvas = document.createElement('canvas');
        Object.assign(canvas.style, { position: 'fixed', pointerEvents: 'none', zIndex: '1' });
        s.window.canvas.parentNode.append(canvas);
        s.overlay = { canvas, image: new Image(1, 1) };
      }
      await presentVideoFrame([s.overlay], frame, { Layer: overlayLayer });
      if (token !== s.eventToken || !s.overlay) return;
      const { canvas, image } = s.overlay;
      if (canvas.width !== image.width) canvas.width = image.width;
      if (canvas.height !== image.height) canvas.height = image.height;
      if (image.width && image.height) present(getGPU(), image, canvas);
      updateOverlay(s);
      // VideoOvlImpl.cpp EC_UPDATE dispatches frame/period events only for vomLayer.
      return;
    } else if (render) {
      await presentVideoFrame([s.layer1, s.layer2], frame, { Layer });
      if (token !== s.eventToken) return;
      s.onLayerChange?.();
    }
    await post(s, 'onFrameUpdate', [frame.frame]);
    if (token !== s.eventToken) return;
    if (s.isPrepare) {
      s.isPrepare = false;
      await post(s, 'onPeriod', [perPrepare]);
    } else if (s.eventFrame >= 0 && !s.isEventPast && frame.frame >= s.eventFrame) {
      s.eventFrame = -1;
      await post(s, 'onPeriod', [perPeriod]);
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
      if (s.mode !== 0 && s.mode !== 1) throw new Error('VideoOverlay supports only vomOverlay and vomLayer playback');
      const target = String(name);
      // Open (VideoOvlImpl.cpp 132) closes first, then throws when no decoder
      // can be built; the exception propagates so the caller can fall back.
      const bytes = await storage.read(target);
      s.info = await probeLibavVideo(bytes);
      const player = s.player = new Player(s.info, getAudioContext, view);
      players.add(player);
      player.onUpdate = (frame, render) => pushFrame(s, frame, render);
      player.onError = error => {
        // A mid-playback decode failure terminates playback (EC_COMPLETE ->
        // Stop + ssStop) and is reported rather than shown as success.
        s.lastError = error;
        player.stopPlayback();
        if (s.mode !== 3) setStatus(s, 'stop', post);
        report(`video decode failed: ${error?.message ?? error}`);
      };
      player.onEnded = finishedPts => {
        if (s.loop) {
          player.startAt(0, true).then(() => player.playing && post(s, 'onPeriod', [perLoop]), error => player.onError?.(error));
        } else {
          // All data has been rendered (WndProc EC_COMPLETE).
          setStatus(s, 'stop', post);
        }
      };
      player.onSegmentLoop = start => {
        player.startAt(start / s.info.fps, true).then(() => player.playing && post(s, 'onPeriod', [perSegLoop]), error => player.onError?.(error));
      };
      // Initialize decoders and output only; PCM is produced during playback.
      try { await player.prepareAudio(); } catch (error) {
        report(`video audio decode failed: ${error?.message ?? error}`);
        players.delete(player);
        await player.dispose();
        s.player = null;
        s.info = null;
        throw error;
      }
      return setStatus(s, 'stop');
    },
    play: async function() {
      const s = this;
      if (!schedulingActive || !s.player) return;
      await s.player.play();
      if (s.mode !== 3) return setStatus(s, 'play');
    },
    stop: function() {
      const s = this;
      if (!s.player) return;
      s.player.stopPlayback();
      if (s.mode !== 3) return setStatus(s, 'stop');
    },
    close: async function() {
      const s = this;
      if (s.player) { players.delete(s.player); await s.player.dispose(); s.player = null; s.info = null; }
      closeOverlay(s);
      s.isPrepare = false;
      return setStatus(s, 'unload');
    },
    setPos: function(left, top) {
      if (arguments.length < 2) throw new Error('TJS VideoOverlay.setPos requires 2 arguments');
      const s = this;
      left = Math.trunc(number(left)); top = Math.trunc(number(top));
      if (s.mode === 1) eachVideoLayer(s, node => { node.left = left; node.top = top; });
      else moveOverlay(s, left, top);
      updateOverlay(s);
    },
    setSize: function(width, height) {
      if (arguments.length < 2) throw new Error('TJS VideoOverlay.setSize requires 2 arguments');
      const s = this;
      if (s.mode === 1) return;
      s.rect.right = s.rect.left + Math.trunc(number(width));
      s.rect.bottom = s.rect.top + Math.trunc(number(height));
      updateOverlay(s);
    },
    setBounds: function(left, top, width, height) {
      if (arguments.length < 4) throw new Error('TJS VideoOverlay.setBounds requires 4 arguments');
      const s = this;
      if (s.mode === 1) return;
      s.rect.left = Math.trunc(number(left)); s.rect.top = Math.trunc(number(top));
      s.rect.right = s.rect.left + Math.trunc(number(width));
      s.rect.bottom = s.rect.top + Math.trunc(number(height));
      updateOverlay(s);
    },
    pause: function() {
      const s = this;
      if (!s.player) return;
      s.player.pause();
      if (s.mode !== 3) return setStatus(s, 'pause');
    },
    rewind: async function() {
      const s = this;
      if (!schedulingActive || !s.player) return;
      await s.player.startAt(0);
      if (s.status === 'play' && !s.player.playing) await s.player.play();
      if (s.eventFrame >= 0 && s.isEventPast) s.isEventPast = false;
    },
    prepare: async function() {
      // Prepare mode only exists for vomLayer (VideoOvlImpl.cpp 350).
      const s = this;
      if (!schedulingActive || !s.player || s.mode !== 1) return;
      s.player.pause();
      await s.player.startAt(0);
      s.isPrepare = true;
      await s.player.play();
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
    // Native defaults forward TVP_ACTION_INVOKE event dictionaries to action().
    onStatusChanged: function(status) {
      const s = this;
      return action(s, 'onStatusChanged', [['status', status]]);
    },
    onCallbackCommand: function(command, arg) {
      const s = this;
      return action(s, 'onCallbackCommand', [['command', command], ['arg', arg]]);
    },
    onPeriod: function(reason) {
      const s = this;
      return action(s, 'onPeriod', [['reason', reason]]);
    },
    onFrameUpdate: function(frame) {
      const s = this;
      return action(s, 'onFrameUpdate', [['frame', frame]]);
    },
  })
  class VideoOverlay {
    static initialize(owner) {
      return {
        owner: null, actionOwner: null, window: null,
        status: 'unload', player: null, info: null, overlay: null,
        rect: { left: 0, top: 0, right: 320, bottom: 240 },
        visible: false, loop: false, mode: 0,
        layer1: null, layer2: null, onLayerChange: null,
        isPrepare: false,
        segLoopStart: -1, segLoopEnd: -1,
        eventFrame: -1, isEventPast: false,
        audioVolume: 100000, audioBalance: 0, playRate: 1,
        lastError: null,
        eventToken: 0,
      };
    }

    @nativeProperty get position() { const s = this; return s.player ? Math.round(s.player.pts * 1000) : 0; }
    @nativeProperty set position(value) { const s = this; if (s.player) return s.player.startAt(number(value) / 1000); }
    @nativeProperty get left() { const s = this; return s.mode === 1 ? (Layer.peekNode(s.layer1)?.left ?? 0) : s.rect.left; }
    @nativeProperty set left(value) {
      const s = this;
      const left = Math.trunc(number(value));
      if (s.mode === 1) eachVideoLayer(s, node => { node.left = left; });
      else moveOverlay(s, left, s.rect.top);
      updateOverlay(s);
    }
    @nativeProperty get top() { const s = this; return s.mode === 1 ? (Layer.peekNode(s.layer1)?.top ?? 0) : s.rect.top; }
    @nativeProperty set top(value) {
      const s = this;
      const top = Math.trunc(number(value));
      if (s.mode === 1) eachVideoLayer(s, node => { node.top = top; });
      else moveOverlay(s, s.rect.left, top);
      updateOverlay(s);
    }
    @nativeProperty get width() { const s = this; return s.mode === 1 ? (Layer.peekNode(s.layer1)?.width ?? 0) : s.rect.right - s.rect.left; }
    @nativeProperty set width(value) { const s = this; s.rect.right = s.rect.left + Math.trunc(number(value)); updateOverlay(s); }
    @nativeProperty get height() { const s = this; return s.mode === 1 ? (Layer.peekNode(s.layer1)?.height ?? 0) : s.rect.bottom - s.rect.top; }
    @nativeProperty set height(value) { const s = this; s.rect.bottom = s.rect.top + Math.trunc(number(value)); updateOverlay(s); }
    @nativeProperty get originalWidth() { return this.info?.width ?? 0; }
    @nativeProperty get originalHeight() { return this.info?.height ?? 0; }
    @nativeProperty get visible() { return Number(this.visible); }
    @nativeProperty set visible(value) {
      const s = this;
      s.visible = !!truth(value);
      eachVideoLayer(s, node => { node.visible = s.visible; });
      updateOverlay(s);
      if (s.onLayerChange) s.onLayerChange();
    }
    @nativeProperty get loop() { return Number(this.loop); }
    @nativeProperty set loop(value) { this.loop = !!truth(value); }
    @nativeProperty get frame() { const s = this; return s.player && s.info ? Math.floor(s.player.pts * s.info.fps) : 0; }
    @nativeProperty set frame(value) { const s = this; if (s.player) return s.player.startAt(number(value) / (s.info?.fps || 1)); }
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
    @nativeProperty get numberOfAudioStream() { return this.info?.hasAudio ? 1 : 0; }
    @nativeProperty get enabledAudioStream() { return this.info?.hasAudio ? 0 : -1; }
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
    s.owner = null;
    s.eventToken++;
    if (s.player) { players.delete(s.player); await s.player.dispose(); }
    closeOverlay(s);
    s.player = null;
    s.info = null;
    await disposeScriptValue(s.actionOwner);
    s.actionOwner = null;
    s.owner = null;
  };
  return VideoOverlay;
}
