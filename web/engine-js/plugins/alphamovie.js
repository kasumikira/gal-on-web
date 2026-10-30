// AlphaMovie.cpp: TJS binding for the AMV worker backend (./amv-source.js).
//
// The consumer is script-driven: the Worker predecodes frames into a shared bounded queue
// (capacity = preloadSamples), and each showNextImage call takes a frame and sends it through
// the native layer presentation entry point to the target layer. This corresponds to the
// Ready/Free frame pool and layer->SetSize / GetMainImage()->Update / SetPosition / Update path
// in AlphaMovieNative_guess.
import { nativeClass, nativeMethod, nativeProperty, nativeReference } from '#krkr/native';
import { number } from '#krkr/values';
import { config } from '../global.js';
import { VideoPipeline, closeFrame } from '../video-pipeline.js';
import { AmvWorkerSource } from './amv-source.js';

const ERROR_PREFIX = "can't open alpha movie file - ";
// Initial PreloadSamples value from AlphaMovieNative_guess.
const DEFAULT_PRELOAD = 5;

export function registerAlphaMovie({ storage, registerGlobal, presentAlphaMovieFrame }) {
  const report = message => config.inform?.(message);
  // Sessions and error handling are not script members in the reference, so keep them in
  // this module rather than on the native class.
  const closeSession = async state => {
    if (state.pipeline) await state.pipeline.dispose();
    else await state.source?.dispose();
    state.pipeline = null;
    state.source = null;
    state.playing = false;
  };
  const fail = (state, error) => {
    state.playing = false;
    report(`alpha movie decode failed: ${error?.message ?? error}`);
  };

  @nativeClass('AlphaMovie')
  class AlphaMovie {
    static initialize() {
      return {
        source: null,
        pipeline: null,
        leftOffset: 0,
        topOffset: 0,
        preloadSamplesCount: DEFAULT_PRELOAD,
        displayedFrame: 0,
        playing: false,
      };
    }

    @nativeMethod
    async open(name) {
      if (!arguments.length) throw new Error('TJS AlphaMovie.open requires a file name');
      const target = String(name);
      await closeSession(this);
      const source = new AmvWorkerSource({ storage });
      const error = await source.open(target);
      if (error) { await source.dispose(); throw new Error(`${ERROR_PREFIX}${target} (${error})`); }
      this.source = source;
      this.pipeline = new VideoPipeline(source, {
        capacity: this.preloadSamplesCount,
        onError: error => fail(this, error),
      });
    }

    // AlphaMovieNative_guess::clear: discard decoded frames (clear Ready/Free) but keep the
    // decoder open; no new frames are produced until play() is called again.
    @nativeMethod
    clear() {
      this.playing = false;
      const stopping = this.pipeline?.stop();
      this.pipeline?.clear();
      return stopping;
    }

    @nativeMethod
    isPlaying() { return this.playing ? 1 : 0; }

    // stop: stop the worker thread but retain decoded frames in Ready (the reference does not clear Ready).
    @nativeMethod
    stop() {
      this.playing = false;
      return this.pipeline?.stop();
    }

    // play: rebuild the frame pool using PreloadSamples, seek decoding to the beginning, then start predecode.
    @nativeMethod
    async play() {
      const pipeline = this.pipeline, source = this.source;
      if (!pipeline || !source) return;
      this.playing = true;
      pipeline.stop();
      pipeline.clear();
      pipeline.capacity = this.preloadSamplesCount;
      await pipeline.reseek(0);
      pipeline.start();
    }

    @nativeMethod
    setPosition(left, top) {
      if (arguments.length < 2) throw new Error('TJS AlphaMovie.setPosition requires 2 arguments');
      this.leftOffset = Math.trunc(number(left));
      this.topOffset = Math.trunc(number(top));
    }

    @nativeMethod
    setNextMovieFile(name) {
      if (!arguments.length) throw new Error('TJS AlphaMovie.setNextMovieFile requires a file name');
      if (this.source) this.source.nextMovieFile = String(name);
    }

    // AlphaMovieNative::showNextImage: take the queue's first frame, set layer dimensions,
    // write the main image, move it to (left, top), and request repaint. If the queue is empty,
    // keep the previous frame, matching the reference behavior when the worker has not produced one yet.
    @nativeMethod
    async showNextImage(target) {
      if (!arguments.length) throw new Error('TJS AlphaMovie.showNextImage requires a layer');
      const pipeline = this.pipeline;
      if (!pipeline) return this.displayedFrame;
      const frame = pipeline.shift();
      if (!frame) return this.displayedFrame;
      this.displayedFrame = frame.frame;
      try {
        const owner = nativeReference(target);
        await presentAlphaMovieFrame(owner, frame, frame.left + this.leftOffset, frame.top + this.topOffset);
      } finally { closeFrame(frame); }
      return this.displayedFrame;
    }

    @nativeProperty get numOfFrame() { return this.source?.info?.numOfFrame ?? 0; }

    @nativeProperty get frame() { return this.source?.decoderFrame ?? 0; }
    // SetFrame_guess: invalidate in-flight decoding and discard Ready, then seek. Resume
    // predecode only if decoding was active (the reference notifies the worker only when SeekFrame succeeds).
    @nativeProperty set frame(value) {
      const pipeline = this.pipeline, source = this.source;
      if (!pipeline || !source) return;
      const frame = Math.trunc(number(value));
      const active = pipeline.active;
      pipeline.stop();
      pipeline.clear();
      return pipeline.reseek(frame).then(() => {
        if (active && this.playing) pipeline.start();
      });
    }

    @nativeProperty get loop() { return this.source?.loop ? 1 : 0; }
    @nativeProperty set loop(value) {
      if (!this.source) return;
      return this.source.setLoop(!!number(value));
    }

    @nativeProperty get nextLoop() { return this.source?.nextLoop ? 1 : 0; }
    @nativeProperty set nextLoop(value) {
      if (this.source) this.source.nextLoop = !!number(value);
    }

    // AlphaMovieNative::preloadSamples clamps to 1..30 and ignores other values;
    // The reference also rebuilds the frame pool from this value only during play().
    @nativeProperty get preloadSamples() { return this.preloadSamplesCount; }
    @nativeProperty set preloadSamples(value) {
      const count = Math.trunc(number(value));
      if (count >= 1 && count <= 30) this.preloadSamplesCount = count;
    }

    @nativeProperty get left() { return this.leftOffset; }
    @nativeProperty set left(value) { this.leftOffset = Math.trunc(number(value)); }

    @nativeProperty get top() { return this.topOffset; }
    @nativeProperty set top(value) { this.topOffset = Math.trunc(number(value)); }

    @nativeProperty get screenWidth() { return this.source?.info?.screenWidth ?? 0; }
    @nativeProperty get screenHeight() { return this.source?.info?.screenHeight ?? 0; }
    @nativeProperty get FPSScale() { return this.source?.info?.fpsScale ?? 0; }
    @nativeProperty get FPSRate() { return this.source?.info?.fpsRate ?? 0; }
  }

  AlphaMovie.invalidate = owner => {
    const state = AlphaMovie.state(owner);
    return closeSession(state);
  };
  registerGlobal('AlphaMovie', AlphaMovie);
}
