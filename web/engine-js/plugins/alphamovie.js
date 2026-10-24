// AlphaMovie.cpp: TJS binding for the AMV worker backend (./amv-source.js).
//
// 消费端是“脚本驱动”：Worker 把解码帧预解进统一有界队列（容量 =
// preloadSamples），脚本每次 showNextImage 取走一帧，经公共图层呈现入口写进
// 目标图层。这对应 AlphaMovieNative_guess 的 Ready/Free 帧池与
// layer->SetSize / GetMainImage()->Update / SetPosition / Update 路径。
import { nativeClass, nativeMethod, nativeProperty, nativeOwner, callScript } from '#krkr/native';
import { number } from '#krkr/values';
import { config } from '../global.js';
import { VideoPipeline, presentVideoFrame, closeFrame } from '../video-pipeline.js';
import { AmvWorkerSource } from './amv-source.js';

const ERROR_PREFIX = "can't open alpha movie file - ";
// AlphaMovieNative_guess 的 PreloadSamples 初值。
const DEFAULT_PRELOAD = 5;

export function registerAlphaMovie({ storage, get, registerGlobal }) {
  const Layer = get('Layer');
  const report = message => config.inform?.(message);
  // 会话与错误处理不是参考实现的脚本成员，因此留在模块内而不是原生类上。
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

    // AlphaMovieNative_guess::clear：丢弃已解出的帧（Ready/Free 清空），
    // 解码器保持打开；再次 play() 之前不会产生新帧。
    @nativeMethod
    clear() {
      this.playing = false;
      const stopping = this.pipeline?.stop();
      this.pipeline?.clear();
      return stopping;
    }

    @nativeMethod
    isPlaying() { return this.playing ? 1 : 0; }

    // stop：停止工作线程但保留 Ready 中已解出的帧（参考实现不清理 Ready）。
    @nativeMethod
    stop() {
      this.playing = false;
      return this.pipeline?.stop();
    }

    // play：按 PreloadSamples 重建帧池、解码位置回到片头，再启动预解码。
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

    // AlphaMovieNative::showNextImage：取走队列头部的帧，设置图层尺寸、写入
    // 主图像、按 (left, top) 移动并请求重绘。队列为空时保留上一帧，与参考
    // 实现“工作线程尚未产出”的行为一致。
    @nativeMethod
    async showNextImage(target) {
      if (!arguments.length) throw new Error('TJS AlphaMovie.showNextImage requires a layer');
      const pipeline = this.pipeline;
      if (!pipeline) return this.displayedFrame;
      const frame = pipeline.shift();
      if (!frame) return this.displayedFrame;
      this.displayedFrame = frame.frame;
      try {
        const owner = nativeOwner(target);
        await presentVideoFrame([owner], frame, {
          Layer,
          left: frame.left + this.leftOffset,
          top: frame.top + this.topOffset,
          repaint: layer => callScript(layer, 'update', []),
        });
      } finally { closeFrame(frame); }
      return this.displayedFrame;
    }

    @nativeProperty get numOfFrame() { return this.source?.info?.numOfFrame ?? 0; }

    @nativeProperty get frame() { return this.source?.decoderFrame ?? 0; }
    // SetFrame_guess：作废在途解码并丢弃 Ready，再 seek；只有原本在解码时
    // 才继续预解码（参考实现只在 SeekFrame 成功时通知工作线程）。
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
    // 参考实现同样只在 play() 时按该值重建帧池。
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
