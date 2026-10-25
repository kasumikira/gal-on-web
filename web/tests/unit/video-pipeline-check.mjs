// 视频管线定向检查：有界队列、管线生产/消费、公共图层呈现入口、AMV Worker
// 会话协议与脚本驱动消费。不依赖浏览器：Worker 传输层用回环端点替代，
// GPU 上传路径单独断言其缺少 WebGL2 时的报错边界。
import assert from 'node:assert/strict';
import {
  FrameQueue, VideoPipeline, presentVideoFrame,
} from '../../engine-js/video-pipeline.js';
import { Image } from '../../engine-js/bitmap.js';
import { createAmvSession, createAmvWorkerEndpoint } from '../../engine-js/plugins/amv-worker-core.js';
import { AmvWorkerSource } from '../../engine-js/plugins/amv-source.js';
import { buildAmv } from '../fixtures/amv-fixture.mjs';
import { createWebDecoder } from '../../engine-js/video-webcodecs.js';
import { createDemuxer } from '../../engine-js/video-demux.js';
import { readFile } from 'node:fs/promises';
import { VideoAudio } from '../../engine-js/video-audio.js';

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
// amv.js 通过 `?url` 引入 WASM，Node 无法直接解析；按 amv-benchmark 的做法把
// 该导入替换成 data URL，以便在 Node 里驱动真实解码器。
const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`;
let passed = 0;
async function check(label, fn) {
  await fn();
  passed++;
  console.log(`ok   ${label}`);
}

await check('WebCodecs bridge: signed i64 low words preserve negative AAC timestamps', async () => {
  const previous = { AudioDecoder: globalThis.AudioDecoder, EncodedAudioChunk: globalThis.EncodedAudioChunk };
  globalThis.EncodedAudioChunk = class { constructor(init) { Object.assign(this, init); } };
  globalThis.AudioDecoder = class {
    static async isConfigSupported() { return { supported: true }; }
    constructor(callbacks) { this.callbacks = callbacks; this.decodeQueueSize = 0; this.state = 'configured'; }
    configure() {}
    decode(chunk) { this.callbacks.output({ timestamp: chunk.timestamp, close() {} }); }
    close() { this.state = 'closed'; }
  };
  let decoder;
  try {
    const libav = {
      ff_copyout_codecpar: async () => ({ codec_id: 1, channels: 2, sample_rate: 48000 }),
      avcodec_get_name: async () => 'aac',
    };
    decoder = await createWebDecoder(libav, { codecpar: 1, time_base_num: 1, time_base_den: 48000 }, false);
    for (const [pts, ptshi, expected] of [[-1024, -1, -21333], [-2147483648, 0, 44739242667], [-1, 1, 178956970646]]) {
      const frame = await decoder.next({ next: async () => ({ pts, ptshi, duration: 1024, durationhi: 0, data: new Uint8Array(1) }) });
      assert.equal(frame.timestamp, expected);
      frame.close();
    }
  } finally {
    decoder?.dispose();
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
});

// --- 有界队列 -------------------------------------------------------------
await check('Shared demux: demand-driven reads, delayed audio, cancel and reset', async () => {
  let reads = 0, freed = 0, release;
  const video = { index: 0 }, audio = { index: 1 };
  const packet = id => ({ id, data: new Uint8Array(8) });
  const libav = {
    AVERROR_EOF: -1, EAGAIN: 6, av_packet_alloc: async () => 1,
    av_packet_free_js: async () => { freed++; },
    ff_read_frame_multi: async () => {
      reads++;
      if (reads === 1) return [0, { 0: Array.from({ length: 80 }, (_, i) => packet(i)) }];
      if (reads === 2) return [0, { 1: [packet(99)] }];
      await new Promise(resolve => { release = resolve; });
      return [-1, {}];
    },
  };
  const demux = await createDemuxer(libav, 1, [video, audio]);
  const vr = demux.reader(video), ar = demux.reader(audio);
  assert.equal((await vr.next()).id, 0);
  assert.equal((await vr.next()).id, 1);
  assert.equal(reads, 1, 'cached packets must not trigger speculative reads');
  assert.equal((await ar.next()).id, 99, 'a full video queue must not block delayed audio');
  assert.equal(reads, 2);
  assert.equal(demux.diagnostics()[0].packets, 78, 'retain every video packet');
  const cancelled = ar.next(); await flush(); demux.cancel(); release();
  assert.equal(await cancelled, null);
  await demux.reset();
  assert(demux.diagnostics().every(track => track.bytes === 0 && track.packets === 0));
  reads = 0;
  const [v, a] = await Promise.all([vr.next(), ar.next()]);
  assert.equal(v.id, 0); assert.equal(a.id, 99); assert.equal(reads, 2);
  await demux.dispose(); assert.equal(freed, 1);
});

await check('Web Audio PCM: native scheduling, pause, rate, underrun and EOF', async () => {
  const scheduled = [];
  const context = {
    currentTime: 0,
    createGain: () => ({ disconnect() {} }),
    createBuffer: (channels, length, sampleRate) => ({ length, sampleRate,
      planes: Array.from({ length: channels }, () => new Float32Array(length)),
      copyToChannel(values, index) { this.planes[index].set(values); },
    }),
    createBufferSource: () => {
      const node = { playbackRate: {}, connect() {}, disconnect() {},
        start(when, offset) { this.when = when; this.offset = offset; scheduled.push(this); },
        stop() { this.stopped = true; },
      };
      return node;
    },
  };
  let index = 0;
  const source = { info: { duration: 1 }, async nextAudio() {
    if (index === 8) return null;
    return { timestamp: index++ / 10 - .02, sampleRate: 44100,
      channels: [new Float32Array(4410).fill(.25), new Float32Array(4410).fill(.5)] };
  } };
  const audio = new VideoAudio(context, source, error => { throw error; });
  await audio.play(); await flush();
  assert(audio.buffered >= .5 && audio.buffered <= .6);
  assert.equal(scheduled[0].buffer.sampleRate, 44100, 'browser owns sample-rate conversion');
  assert.equal(scheduled[0].offset, .02, 'trim negative timestamp preroll');
  assert.equal(scheduled[0].buffer.planes[1][0], .5);
  context.currentTime = .03; audio.pause();
  const paused = audio.time; assert.equal(paused, .03);
  assert(scheduled.every(node => node.stopped));
  context.currentTime = 1; assert.equal(audio.time, paused);
  await audio.play(); assert.equal(scheduled.at(-1).when > 1, true);
  audio.setRate(2); assert.equal(scheduled.at(-1).playbackRate.value, 2);
  assert.equal(audio.time, paused);
  context.currentTime = 2;
  assert.equal(audio.time, audio.bufferEnd, 'underrun freezes media time');
  const end = audio.bufferEnd;
  scheduled.at(-1).onended(); await flush();
  assert.equal(audio.underruns, 1);
  assert.equal(audio.time, end, 'new PCM must not jump across the underrun');
  assert.equal(audio.eof, true);
  context.currentTime = 3; assert.equal(audio.ended, true);
  await audio.dispose();
});

const tracked = (id, closed) => ({ id, close: () => closed.push(id) });

await check('FrameQueue: 满队列拒绝入队，shift 唤醒等待空位的生产者', async () => {
  const closed = [];
  const queue = new FrameQueue(2);
  assert.equal(queue.push(tracked(1, closed)), true);
  assert.equal(queue.push(tracked(2, closed)), true);
  assert.equal(queue.full, true);
  assert.equal(queue.push(tracked(3, closed)), false, '满队列不得入队，帧被丢弃');
  assert.deepEqual(closed, [3]);
  let woken = false;
  queue.waitForRoom().then(() => { woken = true; });
  await flush();
  assert.equal(woken, false, '满队列时生产者必须等待');
  assert.equal(queue.shift().id, 1);
  await flush();
  assert.equal(woken, true);
  assert.deepEqual(queue.items.map(frame => frame.id), [2]);
});

await check('FrameQueue: clear 关闭排队帧并唤醒等待者', async () => {
  const closed = [];
  const queue = new FrameQueue(1);
  queue.push(tracked(1, closed));
  let woken;
  queue.waitForRoom().then(value => { woken = value; });
  await flush();
  assert.equal(woken, undefined);
  queue.clear();
  assert.deepEqual(closed, [1]);
  await flush();
  assert.equal(woken, true);
  assert.equal(queue.length, 0);
});

await check('FrameQueue: 容量变化与 close 都会唤醒等待者', async () => {
  const closed = [];
  const queue = new FrameQueue(1);
  queue.push(tracked(1, closed));
  let woken;
  queue.waitForRoom().then(value => { woken = value; });
  await flush();
  assert.equal(woken, undefined);
  queue.capacity = 2;
  await flush();
  assert.equal(woken, true);

  const closing = new FrameQueue(1);
  closing.push(tracked(2, closed));
  let closedWake;
  closing.waitForRoom().then(value => { closedWake = value; });
  await flush();
  closing.close();
  await flush();
  assert.equal(closedWake, false, '关闭后等待者以 false 结束');
  assert.equal(closing.push(tracked(3, closed)), false);
  assert.deepEqual(closed, [2, 3]);
  queue.clear();
  assert.deepEqual([...closed].sort(), [1, 2, 3]);
});

// --- 管线 -----------------------------------------------------------------
function scriptedSource(frames) {
  const state = { calls: 0, seeks: [], closed: 0, disposed: false };
  let index = 0;
  return {
    state,
    info: { numOfFrame: frames.length },
    async seek(position) { state.seeks.push(position); index = position; },
    async next() {
      state.calls++;
      if (index >= frames.length) return null;
      const frame = frames[index++];
      return { ...frame, close: () => { state.closed++; } };
    },
    dispose() { state.disposed = true; },
  };
}

await check('VideoPipeline: 解码最多领先 capacity 帧，取走一帧后继续', async () => {
  const source = scriptedSource([{ frame: 0 }, { frame: 1 }, { frame: 2 }, { frame: 3 }]);
  const pipeline = new VideoPipeline(source, { capacity: 2 });
  pipeline.start();
  await flush();
  assert.equal(source.state.calls, 2, '生产者必须停在队列容量上');
  assert.equal(pipeline.length, 2);
  assert.equal(pipeline.shift().frame, 0);
  await flush();
  assert.equal(source.state.calls, 3);
  assert.equal(pipeline.length, 2);
  await pipeline.dispose();
  assert.equal(source.state.disposed, true);
});

await check('VideoPipeline: 数据解完且消费完才算 drained', async () => {
  const source = scriptedSource([{ frame: 0 }, { frame: 1 }]);
  const pipeline = new VideoPipeline(source, { capacity: 2 });
  pipeline.start();
  await flush();
  assert.equal(pipeline.drained, false, '队列未取空时不得判定完成');
  pipeline.shift();
  pipeline.shift();
  await flush();
  assert.equal(pipeline.length, 0);
  assert.equal(pipeline.drained, true);
  assert.equal(await source.next(), null);
  await pipeline.dispose();
});

await check('VideoPipeline: reseek 作废在途帧并重新定位', async () => {
  let call = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  const closed = [];
  const source = {
    info: null,
    async seek(position) { this.seeked = position; },
    async next() {
      const current = ++call;
      if (current === 1) await gate;
      return { frame: current, close: () => closed.push(current) };
    },
    dispose() {},
  };
  const pipeline = new VideoPipeline(source, { capacity: 1 });
  pipeline.start();
  await flush();
  const seeking = pipeline.reseek(7);
  await flush();
  assert.equal(source.seeked, undefined, '必须等待在途解码后再 seek');
  assert.equal(call, 1, '不得并行启动第二次 next');
  release();
  await seeking;
  assert.equal(source.seeked, 7);
  await flush();
  assert.equal(pipeline.peek().frame, 2, 'reseek 之后取到的是新位置的帧');
  await flush();
  assert.deepEqual(closed, [1], 'seek 之前发出的帧必须被丢弃');
  assert.equal(pipeline.length, 1);
  await pipeline.dispose();
});

await check('VideoPipeline: stop 保留已解码帧且不再生产，错误上报后停止', async () => {
  const source = scriptedSource([{ frame: 0 }, { frame: 1 }]);
  const pipeline = new VideoPipeline(source, { capacity: 2 });
  pipeline.start();
  await flush();
  pipeline.stop();
  assert.equal(pipeline.length, 2, 'stop 对应参考实现保留 Ready 队列');
  const calls = source.state.calls;
  await flush();
  assert.equal(source.state.calls, calls);

  const failing = {
    info: null, async seek() {},
    async next() { throw new Error('decode failed'); },
    dispose() {},
  };
  let reported = null;
  const broken = new VideoPipeline(failing, { capacity: 1, onError: error => { reported = error; } });
  broken.start();
  await flush();
  assert.equal(reported?.message, 'decode failed');
  assert.equal(broken.active, false);
  await broken.dispose();
});

// --- 公共图层呈现入口 -----------------------------------------------------
await check('presentVideoFrame: 尺寸、位置、逐行写入与重绘请求', async () => {
  const node = { image: new Image(8, 8), width: 0, height: 0, left: 0, top: 0, imageModified: false };
  const Layer = {
    peekState: () => ({ node }),
    peekNode: () => node,
    resizeNode: (target, width, height) => { target.width = width; target.height = height; },
  };
  const rgba = new Uint8ClampedArray(4 * 3 * 4).fill(0x7f);
  const repainted = [];
  const presented = await presentVideoFrame([{ id: 'layer' }, null], { width: 4, height: 3, rgba }, {
    Layer, left: 5, top: 6, repaint: (target, targetNode) => { repainted.push([target, targetNode]); },
  });
  assert.equal(presented, 1, '空图层被跳过');
  assert.equal(node.width, 4);
  assert.equal(node.height, 3);
  assert.equal(node.left, 5);
  assert.equal(node.top, 6);
  assert.equal(node.imageModified, true);
  assert.equal(repainted.length, 1);
  // 图像(8x8)大于帧(4x3)：按图像行距写入，帧外的行与列保持不变。
  const pixels = node.image.pixels;
  assert.equal(pixels[0], 0x7f);
  assert.equal(pixels[3 * 4 + 3], 0x7f);
  assert.equal(pixels[4 * 4], 0, '帧右侧的图像列不得被写入');
  assert.equal(pixels[8 * 4 * 3], 0, '帧下方的图像行不得被写入');
  assert.equal(pixels[8 * 4 * 1], 0x7f, '第 2 行按图像行距写入');
});

await check('presentVideoFrame: 无 GPU 时画布帧给出明确边界错误', async () => {
  const node = { image: new Image(4, 4), width: 0, height: 0, left: 0, top: 0, imageModified: false };
  const Layer = { peekState: () => ({ node }), peekNode: () => node };
  await assert.rejects(
    presentVideoFrame([{ id: 'layer' }], { width: 4, height: 4, canvas: {} }, { Layer }),
    /requires the GPU renderer/,
  );
});

await check('presentVideoFrame: 空帧更新矩形、位置与重绘', async () => {
  const node = { image: new Image(4, 4), width: 4, height: 4 };
  let updates = 0;
  await presentVideoFrame([{}], { width: 0, height: 0 }, {
    Layer: { peekState: () => ({ node }), resizeNode: (n, w, h) => { n.width = w; n.height = h; } },
    left: 7, top: 8, repaint: () => { updates++; },
  });
  assert.deepEqual([node.width, node.height, node.left, node.top, updates], [0, 0, 7, 8, 1]);
});

await check('presentVideoFrame: 接管整帧缓冲，多目标共享 CoW 而非裸数组', async () => {
  const nodes = [{ image: new Image(2, 2) }, { image: new Image(2, 2) }];
  const bytes = new Uint8ClampedArray(16).fill(128);
  await presentVideoFrame(nodes, { width: 2, height: 2, rgba: bytes, ownedPixels: true }, {
    Layer: { peekState: n => ({ node: n }), resizeNode() {} },
  });
  assert.equal(nodes[0].image.pixels, bytes, '整帧覆盖不得复制像素');
  assert.equal(nodes[1].image.pixels, bytes);
  nodes[1].image.writablePixels[0] = 9;
  assert.equal(nodes[0].image.pixels[0], 128, '后续写入必须触发 CoW');
  assert.equal(nodes[1].image.pixels[0], 9);
  const held = nodes[0].image.writablePixels;
  nodes[0].image.externallyWritable = true;
  await presentVideoFrame([nodes[0]], { width: 2, height: 2, rgba: new Uint8ClampedArray(16).fill(7), ownedPixels: true }, {
    Layer: { peekState: n => ({ node: n }), resizeNode() {} },
  });
  assert.equal(nodes[0].image.pixels, held, '已导出的可写视图不能被替换');
  assert.equal(held[0], 7);
});

// --- AMV Worker 会话协议 --------------------------------------------------
// 帧号编码在文件首字节；每帧 2x2，像素值等于帧号，用来验证复用缓冲的拷贝。
class FakeDecoder {
  constructor() {
    this.bytes = null; this.frame = 0; this.position = 0; this.firstPosition = 0;
    this.loop = true; this.numOfFrame = 0; this.rgba = null;
  }
  open(bytes) {
    if (!bytes || bytes.length < 1) return 'File read error';
    this.bytes = bytes;
    this.numOfFrame = bytes[0];
    this.frame = 0;
    this.position = 0;
    this.firstPosition = 0;
    return null;
  }
  advance() {
    if (this.frame < this.numOfFrame - 1) return null;
    if (this.loop) { this.position = 0; this.frame = 0; return null; }
    return 'next';
  }
  async decodeNext({ transferable = false } = {}) {
    const index = this.position;
    if (index >= this.numOfFrame) return null;
    this.position = index + 1;
    this.frame = index;
    if (transferable || !this.rgba) this.rgba = new Uint8ClampedArray(2 * 2 * 4);
    this.rgba.fill(index & 0xff);
    return { header: { frame: index, left: index, top: index * 2, width: 2, height: 2 }, width: 2, height: 2, rgba: this.rgba };
  }
  seekFrame(frame) {
    if (frame >= this.numOfFrame) return false;
    this.frame = frame;
    this.position = frame;
    return true;
  }
  dispose() { this.bytes = null; }
}

await check('AMV 会话: open/decode/loop/seek/rewind/dispose 与缓冲拷贝', async () => {
  const session = createAmvSession(() => new FakeDecoder());
  const opened = await session.handle({ type: 'open', bytes: Uint8Array.of(3) });
  assert.equal(opened.reply.ok, true);
  assert.equal(opened.reply.info.numOfFrame, 3);

  const first = await session.handle({ type: 'decode' });
  assert.equal(first.reply.frame.frame, 0);
  assert.equal(first.reply.pixels[0], 0);
  assert.equal(first.reply.pixels, session.decoder.rgba, '直接转移解码输出，不做第二次 slice');
  const second = await session.handle({ type: 'decode' });
  assert.equal(second.reply.frame.frame, 1);
  assert.equal(first.reply.pixels[0], 0, '解码器复用缓冲，回复必须是拷贝');
  assert.equal(second.reply.pixels[0], 1);
  assert.deepEqual(first.transfer, [first.reply.pixels.buffer]);

  await session.handle({ type: 'loop', loop: false });
  assert.equal((await session.handle({ type: 'decode' })).reply.frame.frame, 2);
  const ended = await session.handle({ type: 'decode' });
  assert.equal(ended.reply.end, true, 'loop=false 时片尾返回 end');

  await session.handle({ type: 'rewind' });
  assert.equal((await session.handle({ type: 'decode' })).reply.frame.frame, 0);
  assert.equal((await session.handle({ type: 'seek', frame: 1 })).reply.found, true);
  assert.equal((await session.handle({ type: 'decode' })).reply.frame.frame, 1);
  assert.equal((await session.handle({ type: 'decode' })).reply.frame.frame, 2);
  assert.equal((await session.handle({ type: 'seek', frame: 9 })).reply.found, false);
  // 参考 DecodeNext_guess 先判 Frame >= NumOfFrame-1：seek 到最后一帧后再解
  // 会直接走片尾分支，而不是解出该帧。
  assert.equal((await session.handle({ type: 'seek', frame: 2 })).reply.found, true);
  assert.equal((await session.handle({ type: 'decode' })).reply.end, true);
  assert.equal((await session.handle({ type: 'nonsense' })).reply.ok, false);
  assert.equal((await session.handle({ type: 'dispose' })).reply.ok, true);
  assert.equal((await session.handle({ type: 'decode' })).reply.end, true, '释放后没有解码器');
});

await check('AMV 会话: 无效文件返回打开错误', async () => {
  const session = createAmvSession(() => new FakeDecoder());
  const failed = await session.handle({ type: 'open', bytes: new Uint8Array(0) });
  assert.equal(failed.reply.ok, false);
  assert.equal(failed.reply.error, 'File read error');
});

// --- Worker 后端（回环传输）+ 脚本驱动消费 --------------------------------
function loopbackTransport() {
  const handlers = new Set();
  const handle = createAmvWorkerEndpoint({
    createDecoder: () => new FakeDecoder(),
    postMessage: message => { queueMicrotask(() => { for (const handler of [...handlers]) handler(message); }); },
  });
  return {
    subscribe(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    postMessage(message) { handle(message); },
  };
}

await check('AMV Worker: 同一会话的 dispose 等待在途 decode', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const events = [];
  class SlowDecoder extends FakeDecoder {
    async decodeNext(options) {
      events.push('decode');
      await gate;
      assert.ok(this.bytes, '解码期间不能释放 decoder');
      return super.decodeNext(options);
    }
    dispose() { events.push('dispose'); super.dispose(); }
  }
  const replies = [];
  const handle = createAmvWorkerEndpoint({ createDecoder: () => new SlowDecoder(), postMessage: m => replies.push(m) });
  await handle({ session: 1, request: { id: 1, type: 'open', bytes: Uint8Array.of(3) } });
  const decoding = handle({ session: 1, request: { id: 2, type: 'decode' } });
  await flush();
  const disposing = handle({ session: 1, request: { id: 3, type: 'dispose' } });
  await flush();
  assert.deepEqual(events, ['decode']);
  release();
  await Promise.all([decoding, disposing]);
  assert.deepEqual(events, ['decode', 'dispose']);
  assert.deepEqual(replies.map(reply => reply.id), [1, 2, 3]);
});

const amvStorage = names => ({
  transferOwnership: true,
  async read(name) {
    const count = names[name];
    if (count === undefined) throw new Error(`missing storage ${name}`);
    return Uint8Array.of(count);
  },
});

await check('AmvWorkerSource: 共享 Worker 的同编号请求按 session 隔离', async () => {
  const transport = loopbackTransport();
  const storage = amvStorage({ 'a.amv': 2, 'b.amv': 4 });
  const sources = [new AmvWorkerSource({ storage, createTransport: () => transport }),
    new AmvWorkerSource({ storage, createTransport: () => transport })];
  assert.deepEqual(await Promise.all([sources[0].open('a.amv'), sources[1].open('b.amv')]), [null, null]);
  assert.deepEqual(sources.map(source => source.info.numOfFrame), [2, 4]);
  await Promise.all(sources.map(source => source.setLoop(false)));
  await Promise.all(sources.map(source => source.next()));
  await Promise.all(sources.map(source => source.next()));
  const frames = await Promise.all(sources.map(source => source.next()));
  assert.equal(frames[0], null);
  assert.equal(frames[1].frame, 2);
  await Promise.all(sources.map(source => source.dispose()));
});

await check('AmvWorkerSource: 顺序解帧、片尾结束、释放后拒绝在途请求', async () => {
  const source = new AmvWorkerSource({ storage: amvStorage({ 'a.amv': 2 }), createTransport: loopbackTransport });
  assert.equal(await source.open('a.amv'), null);
  assert.equal(source.info.numOfFrame, 2);
  await source.setLoop(false);
  assert.deepEqual((await source.next()).frame, 0);
  assert.deepEqual((await source.next()).frame, 1);
  assert.equal(await source.next(), null, '没有下一个文件时影片结束');
  assert.equal(source.decoderFrame, 1, 'Decoder.Frame 跟随最后解出的帧');
  const pending = source.request({ type: 'decode' });
  const closing = source.dispose();
  await assert.rejects(pending, /disposed/);
  await closing;
});

await check('AmvWorkerSource: nextMovieFile 切换文件并按 nextLoop 恢复循环', async () => {
  const source = new AmvWorkerSource({
    storage: amvStorage({ 'a.amv': 2, 'b.amv': 3 }), createTransport: loopbackTransport,
  });
  assert.equal(await source.open('a.amv'), null);
  await source.setLoop(false);
  source.nextMovieFile = 'b.amv';
  source.nextLoop = false;
  assert.deepEqual((await source.next()).frame, 0);
  assert.deepEqual((await source.next()).frame, 1);
  assert.deepEqual((await source.next()).frame, 0, '切换到下一个文件的第 0 帧');
  assert.equal(source.info.numOfFrame, 3, 'info 跟随新文件');
  assert.deepEqual((await source.next()).frame, 1);
  assert.deepEqual((await source.next()).frame, 2);
  // NextMovieFile 仍指向 b：片尾会再次打开同一个文件（参考实现同样如此）。
  assert.deepEqual((await source.next()).frame, 0);
  source.nextMovieFile = '';
  assert.deepEqual((await source.next()).frame, 1);
  assert.deepEqual((await source.next()).frame, 2);
  assert.equal(await source.next(), null);
  await source.dispose();
});

await check('AmvWorkerSource: 脚本驱动消费经有界队列受 preloadSamples 限制', async () => {
  const source = new AmvWorkerSource({ storage: amvStorage({ 'a.amv': 6 }), createTransport: loopbackTransport });
  assert.equal(await source.open('a.amv'), null);
  const pipeline = new VideoPipeline(source, { capacity: 3 });
  pipeline.start();
  await flush();
  assert.equal(pipeline.length, 3, '预解码不超过帧池容量');
  // showNextImage：每次只取一帧，取走后队列按容量补满。
  for (let expected = 0; expected < 6; expected++) {
    const frame = pipeline.shift();
    assert.equal(frame.frame, expected);
    assert.ok(pipeline.length <= 3, '预解码不得超过帧池容量');
    await flush();
  }
  assert.equal(pipeline.length, 3);
  assert.equal(pipeline.peek().frame, 0, 'loop=true 时片尾回到第 0 帧');
  await pipeline.dispose();
});

await check('AmvWorkerSource: 容器策略失败时停止播放而不是抛出', async () => {
  const source = new AmvWorkerSource({
    storage: amvStorage({ 'a.amv': 2 }), createTransport: loopbackTransport,
  });
  assert.equal(await source.open('a.amv'), null);
  await source.setLoop(false);
  source.nextMovieFile = 'missing.amv';
  await source.next();
  await source.next();
  assert.equal(await source.next(), null);
  assert.match(source.lastError, /missing storage/);
  await source.dispose();
});

await check('AMV 会话 + 真实 AMVDecoder：合成素材经 Rust/WASM 解码并逐字节返回', async () => {
  const fs = await import('node:fs');
  const wasmBytes = fs.readFileSync('web/engine-js/codecs/codecs.wasm');
  const adapterSource = fs.readFileSync('web/engine-js/codecs/wasm.js', 'utf8')
    .replace("import wasmUrl from './codecs.wasm?url';", `const wasmUrl = 'data:application/wasm;base64,${wasmBytes.toString('base64')}';`);
  const adapterUrl = moduleUrl(adapterSource);
  const adapter = await import(adapterUrl);
  await adapter.initializeCodecs();
  const containerSource = fs.readFileSync('web/engine-js/plugins/amv.js', 'utf8')
    .replace("'../codecs/wasm.js'", JSON.stringify(adapterUrl));
  const { AMVDecoder } = await import(moduleUrl(containerSource));

  const session = createAmvSession(() => new AMVDecoder());
  const bytes = await buildAmv({ frames: 3 });
  const opened = await session.handle({ type: 'open', bytes });
  assert.equal(opened.reply.ok, true);
  assert.equal(opened.reply.info.numOfFrame, 3);
  assert.equal(opened.reply.info.screenWidth, 16);
  assert.equal(opened.reply.info.fpsScale, 30);
  await session.handle({ type: 'loop', loop: false });
  for (let index = 0; index < 3; index++) {
    const decoded = await session.handle({ type: 'decode' });
    assert.equal(decoded.reply.frame.frame, index);
    assert.equal(decoded.reply.frame.left, 2 * index);
    assert.equal(decoded.reply.frame.width, 16);
    assert.equal(decoded.reply.pixels.length, 16 * 16 * 4);
    // 中性位流：Rust/WASM 解码结果恒为 (128,128,128,128)。
    assert.deepEqual([...decoded.reply.pixels.subarray(0, 4)], [128, 128, 128, 128]);
    assert.deepEqual(decoded.transfer, [decoded.reply.pixels.buffer]);
    const received = structuredClone(decoded.reply, { transfer: decoded.transfer });
    assert.equal(decoded.reply.pixels.byteLength, 0, '模拟真实 Worker 转移并分离缓冲');
    assert.equal(received.pixels[0], 128);
  }
  assert.equal((await session.handle({ type: 'decode' })).reply.end, true);
  await session.handle({ type: 'rewind' });
  assert.equal((await session.handle({ type: 'decode' })).reply.frame.frame, 0);
  await session.handle({ type: 'dispose' });
});

await check('VideoOverlay: 过期帧、循环边界、取消及脚本事件分发', async () => {
  const { createServer } = await import('vite');
  const server = await createServer({ configFile: 'vite.config.mjs', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
  let vm;
  try {
    const { config } = await server.ssrLoadModule('/engine-js/global.js');
    Object.assign(config, { document: { defaultView: {} }, inform: message => { throw new Error(message); } });
    const { TJSInterop } = await server.ssrLoadModule('/engine-js/wasm-vm.js');
    const { defineNativeClass } = await server.ssrLoadModule('/engine-js/common/native.js');
    const { createVideoOverlayClass, Player } = await server.ssrLoadModule('/engine-js/video.js');
    let animationStarts = 0;
    const cancelledPlayer = new Player({ hasAudio: false, source: {
      interrupt() {}, seek: async () => {}, next: async () => null, dispose: async () => {},
    } }, () => ({ resume: async () => {} }), {
      requestAnimationFrame() { animationStarts++; return 1; }, cancelAnimationFrame() {},
    });
    const cancelledPlay = cancelledPlayer.play();
    cancelledPlayer.stopPlayback(); await cancelledPlay;
    assert.equal(cancelledPlayer.playing, false, 'stop must cancel queued play');
    const cancelledSeek = cancelledPlayer.startAt(1, true);
    cancelledPlayer.pause(); await cancelledSeek;
    assert.equal(cancelledPlayer.playing, false, 'pause must cancel seek auto-resume');
    assert.equal(animationStarts, 0);
    await cancelledPlayer.dispose();
    const latePlayer = new Player({ hasAudio: false, source: {
      interrupt() {}, seek: async () => {}, next: async () => null, dispose: async () => {},
    } }, () => ({}), { cancelAnimationFrame() {} });
    latePlayer.pipeline.capacity = 4;
    latePlayer.wallPts = () => 0.1;
    const notified = [], closed = [];
    latePlayer.onUpdate = (frame, render) => notified.push([frame.frame, render]);
    const queuedFrame = (index, timestamp) => ({ frame: index, timestamp, close: () => closed.push(index) });
    for (const [index, at] of [[0, 0], [1, .04], [2, .08], [3, .2]])
      latePlayer.pipeline.queue.push(queuedFrame(index, at));
    latePlayer.present(); await flush();
    assert.deepEqual(notified, [[0, false], [1, false], [2, true]], 'only the latest due frame uploads, every frame still notifies');
    assert.deepEqual(closed, [0, 1, 2], 'skipped and uploaded frames each close once');
    assert.equal(latePlayer.pipeline.peek().frame, 3, 'future frame stays queued');
    latePlayer.pipeline.clear(); notified.length = 0; closed.length = 0;
    for (const [index, at] of [[0, 0], [1, .04], [2, .08]])
      latePlayer.pipeline.queue.push(queuedFrame(index, at));
    latePlayer.segmentLoop = { start: 0, end: 2 };
    let loopStart;
    latePlayer.onSegmentLoop = start => { loopStart = start; };
    latePlayer.present(); await flush();
    assert.deepEqual(notified, [[0, false], [1, true]], 'render the final frame before the loop boundary');
    assert.equal(loopStart, 0); assert.equal(latePlayer.pipeline.peek().frame, 2);
    assert.deepEqual(closed, [0, 1]);
    await latePlayer.dispose(); assert.deepEqual(closed, [0, 1, 2]);
    const endOrder = [];
    let finishFrame;
    const endPlayer = new Player({ duration: 1, hasAudio: false, source: {
      interrupt() {}, dispose: async () => {},
    } }, () => ({}), { cancelAnimationFrame() {} });
    endPlayer.playing = true; endPlayer.wallPts = () => 1;
    endPlayer.pipeline.exhausted = true;
    endPlayer.pipeline.queue.push({ frame: 0, timestamp: 0, close: () => endOrder.push('close') });
    endPlayer.onUpdate = async () => { endOrder.push('frame'); await new Promise(resolve => { finishFrame = resolve; }); endOrder.push('event-done'); };
    endPlayer.onEnded = () => endOrder.push('ended');
    const rendering = endPlayer.present(); await flush();
    assert.deepEqual(endOrder, ['frame'], 'EOF must wait for frame presentation and events');
    assert.equal(endPlayer.present(), rendering, 'serialize presentation across animation ticks');
    finishFrame(); await rendering;
    assert.deepEqual(endOrder, ['frame', 'event-done', 'close', 'ended']);
    await endPlayer.dispose();
    endOrder.length = 0;
    const closePlayer = new Player({ duration: 1, hasAudio: false, source: {
      interrupt() {}, dispose: async () => { endOrder.push('disposed'); },
    } }, () => ({}), { cancelAnimationFrame() {} });
    closePlayer.playing = true; closePlayer.wallPts = () => 1;
    closePlayer.pipeline.exhausted = true;
    closePlayer.pipeline.queue.push({ frame: 0, timestamp: 0, close: () => endOrder.push('close') });
    closePlayer.onUpdate = () => closePlayer.dispose();
    closePlayer.onEnded = () => endOrder.push('ended');
    await closePlayer.present();
    assert.deepEqual(endOrder, ['disposed', 'close'], 'closing inside a frame event must not deadlock or emit a stale EOF');
    vm = await new TJSInterop().init(Object.create(null));
    const Window = defineNativeClass('Window', { initialize: () => ({}) });
    const Video = createVideoOverlayClass({ Window, Layer: {}, storage: {}, getAudioContext() {}, enqueueEvent: callback => Promise.resolve().then(callback) });
    vm.registerGlobal('Window', Window);
    vm.registerGlobal('VideoOverlay', Video);
    await vm.source(`
      var observed = "", lastEvent;
      class TestWindow extends Window {
        function action(event) { lastEvent = event; }
      }
      class Movie extends VideoOverlay {
        function Movie(win) { super.VideoOverlay(win); }
        function onStatusChanged(status) { observed = status; }
      }
      var win = new TestWindow(), movie = new Movie(win);
    `, 'video-events');
    assert.equal(await vm.source('movie.setSize(100,80); movie.setPos(50,20); return movie.width+","+movie.height;'), '100,80');
    assert.equal(await vm.source('movie.left=60; movie.top=25; return movie.width+","+movie.height;'), '100,80');
    const state = [...Video.instances.values()][0];
    state.status = 'play';
    await vm.source('movie.close();', 'video-owner-event');
    assert.equal(await vm.source('return observed;'), 'unload', '状态事件必须命中影片子类覆盖');
    for (const [call, expression, expected] of [
      ['movie.onFrameUpdate(42);', 'lastEvent.type + ":" + lastEvent.frame', 'onFrameUpdate:42'],
      ['movie.onPeriod(2);', 'lastEvent.type + ":" + lastEvent.reason', 'onPeriod:2'],
      ['movie.onCallbackCommand("x", "y");', 'lastEvent.type + ":" + lastEvent.command + ":" + lastEvent.arg', 'onCallbackCommand:x:y'],
    ]) {
      await vm.source(call);
      assert.equal(await vm.source(`return ${expression};`), expected);
      assert.equal(await vm.source('return lastEvent.target === movie;'), 1);
    }
    await vm.source('lastEvent = void; invalidate movie; movie = void; invalidate win; win = void;');
  } catch (error) { console.error("video event check:", error); throw error; }
  finally { try { if (vm) await vm.dispose(); } finally { await server.close(); } }
});

console.log(`passed ${passed} checks`);
