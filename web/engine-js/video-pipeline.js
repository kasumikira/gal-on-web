// 统一视频播放管线：后端 → 有界队列 → 消费端 → 公共图层呈现入口 → Image/GPU。
//
// 架构图中的三段是解耦的：
//   后端        video-libav.js（libav 解封装 + WebCodecs / FFmpeg 解码）、
//               plugins/amv-source.js（AMV 专用 Worker）；
//   有界队列    FrameQueue / VideoPipeline：解码最多领先消费端 capacity 帧。
//   消费端      VideoOverlay 按时钟取帧（video.js），
//               AlphaMovie 按脚本 showNextImage 取帧（plugins/alphamovie.js）。
//   呈现入口    presentVideoFrame：尺寸、像素/画布上传、位置与重绘请求，
//               两条消费路径共用，避免各自维护一份图层写入逻辑。
//
// 与参考实现的对应：VideoOvlImpl 的双缓冲（MAX_BUFFER_COUNT）和 AlphaMovie
// 工作线程的 Free/Ready 有界帧池都是“解码领先有界、消费端取走即归还”，
// 因此两者共用同一个有界队列抽象，只保留取帧触发方式（时钟/脚本）的差异。
import { Image } from './bitmap.js';
import { getGPU } from './gpu.js';

// 后端产出的解码帧契约：
//   frame     帧序号（影片内）
//   timestamp 呈现时间（秒；容器没有时间戳时为 null）
//   width/height 帧的显示尺寸
//   canvas    WebCodecs VideoFrame，呈现时直接上传底层帧
//   rgba      原始 RGBA 字节（AMV Worker 后端）
//   close()   释放后端资源（VideoFrame 等）
export function closeFrame(frame) {
  try { frame?.close?.(); } catch {}
}

// 有界队列：生产者先确认有空位（full === false）再入队，队列满时用
// waitForRoom() 等待消费端取走一帧；容量对应参考实现的帧池大小
// （VideoOverlay 的 MAX_BUFFER_COUNT、AlphaMovie 的 preloadSamples），
// 因此解码最多领先消费端 capacity 帧。
export class FrameQueue {
  constructor(capacity = 2) {
    this._capacity = Math.max(1, Math.trunc(capacity) || 1);
    this.items = [];
    this.waiters = [];
    this.closed = false;
  }
  get capacity() { return this._capacity; }
  set capacity(value) {
    const next = Math.max(1, Math.trunc(value) || 1);
    if (next === this._capacity) return;
    this._capacity = next;
    // 容量变大后等待中的生产者可以继续。
    this.wake();
  }
  get length() { return this.items.length; }
  get full() { return this.items.length >= this._capacity; }
  peek() { return this.items[0] ?? null; }
  // 入队；没有空位或队列已关闭时丢弃该帧并返回 false。
  push(frame) {
    if (this.closed || this.full) { closeFrame(frame); return false; }
    this.items.push(frame);
    return true;
  }
  shift() {
    if (!this.items.length) return null;
    const frame = this.items.shift();
    this.wake();
    return frame;
  }
  clear() {
    for (const frame of this.items) closeFrame(frame);
    this.items.length = 0;
    this.wake();
  }
  close() {
    this.closed = true;
    this.clear();
  }
  // 唤醒所有等待空位的生产者；它们恢复后重新检查 full 与生产状态，
  // 因此 stop()、clear() 和容量变化都能让阻塞的 pump 及时退出。
  wake() {
    while (this.waiters.length) this.waiters.shift()(!this.closed);
  }
  // 生产者等待空位；注册与 full 检查在同一同步段内，不存在丢失唤醒。
  waitForRoom() {
    if (!this.full || this.closed) return Promise.resolve(!this.closed);
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

// 后端契约：{ info, open?, seek(position), next() -> Promise<frame|null>, dispose() }。
// next() 返回 null 表示影片数据结束（是否循环、是否切换下一个文件由后端或消费端决定）。
export class VideoPipeline {
  constructor(source, { capacity = 2, onError = null } = {}) {
    this.source = source;
    this.queue = new FrameQueue(capacity);
    this.onError = onError;
    this.active = false;
    this.exhausted = false;
    this.generation = 0;
    this.operation = Promise.resolve();
    this.pumpTask = null;
    this.positionTask = null;
  }
  get info() { return this.source?.info ?? null; }
  get capacity() { return this.queue.capacity; }
  set capacity(value) { this.queue.capacity = value; }
  get length() { return this.queue.length; }
  // 数据已全部解出并且消费端也取空（参考实现 EC_COMPLETE 的判定条件）。
  get drained() { return this.exhausted && this.queue.length === 0; }
  peek() { return this.queue.peek(); }
  shift() { return this.queue.shift(); }
  // 开始（或恢复）生产；队列满时自动暂停解码。
  start() {
    if (this.active) return;
    this.active = true;
    this.exhausted = false;
    this.pump();
  }
  // 停止生产但保留已解码的帧（参考 AlphaMovie::stop 保留 Ready 队列）。
  stop() {
    this.active = false;
    this.queue.wake();
    return this.operation;
  }
  clear() { this.generation++; this.queue.clear(); }
  // Backend state belongs to one operation at a time, including in-flight next().
  run(operation) {
    const task = this.operation.then(operation);
    this.operation = task.catch(() => {});
    return task;
  }
  // 重定位：作废在途解码结果、清空队列，再让后端 seek 并恢复生产。
  async reseek(position) {
    const generation = ++this.generation;
    this.exhausted = false;
    this.queue.clear();
    const task = this.positionTask = this.run(() => this.source.seek(position));
    try { await task; }
    finally {
      if (this.positionTask === task) this.positionTask = null;
    }
    if (this.active && generation === this.generation) this.pump();
  }
  dispose() {
    this.active = false;
    this.generation++;
    this.queue.close();
    return this.run(() => this.source.dispose?.());
  }
  pump() {
    if (this.pumpTask || this.positionTask || !this.active) return;
    this.pumpTask = this.produce().finally(() => {
      this.pumpTask = null;
      if (this.active && !this.positionTask) this.pump();
    });
  }
  async produce() {
    const generation = this.generation;
    while (this.active && generation === this.generation) {
      // 先确认有空位再解码，解码最多领先消费端 capacity 帧。
      if (this.queue.full) {
        await this.queue.waitForRoom();
        continue;
      }
      let frame;
      try {
        frame = await this.run(() => this.source.next());
      } catch (error) {
        if (generation === this.generation) {
          this.active = false;
          this.onError?.(error);
        }
        return;
      }
      if (generation !== this.generation) { closeFrame(frame); return; }
      // 数据解完：工作线程结束（参考实现 DecodeNext 返回 2 后线程退出），
      // 已解码的帧继续供消费端取用；再次 start() 会重新拉起生产。
      if (!frame) { this.exhausted = true; this.active = false; return; }
      this.queue.push(frame);
    }
  }
}

// 上传 canvas 后端的解码帧到 Image 的驻留纹理；DOM 源上传保留直通 alpha。
export function uploadVideoCanvas(image, canvas) {
  const gpu = getGPU();
  if (!gpu) throw new Error('Video frame upload requires the GPU renderer');
  gpu.uploadCanvas(image, canvas);
}

// Direct sample upload; transforms use a reusable GPU source texture.
let sampleImage = null;
function uploadVideoSample(image, sample) {
  // Borrow synchronously: MediaBunny closes temporary VideoFrames next microtask.
  const source = sample.toCanvasImageSource();
  const width = source.displayWidth ?? source.width;
  const height = source.displayHeight ?? source.height;
  const rotation = sample.rotation;
  if (!rotation && !sample.flip && image.width === width && image.height === height) {
    uploadVideoCanvas(image, source);
    return;
  }
  if (!sampleImage || sampleImage.width !== width || sampleImage.height !== height) {
    sampleImage?.release();
    sampleImage = new Image(width, height);
  }
  uploadVideoCanvas(sampleImage, source);
  const angle = rotation * Math.PI / 180;
  const cos = Math.round(Math.cos(angle)), sin = Math.round(Math.sin(angle));
  const flip = sample.flip ? -1 : 1;
  const rotated = rotation % 180 !== 0;
  const sx = (rotated ? image.height : image.width) / width;
  const sy = (rotated ? image.width : image.height) / height;
  const a = flip * cos * sx, b = sin * sx;
  const c = -flip * sin * sy, d = cos * sy;
  getGPU().draw(image, sampleImage, {
    matrix: [a, b, c, d, (image.width - a * width - c * height) / 2,
      (image.height - b * width - d * height) / 2],
    mode: 1, copySourceAlpha: true, smooth: true,
  });
}

// tTVPBaseBitmap::Update(pixels, pitch, 0, 0, width, height)：图像可能大于图层，
// 因此按图像自身的行距逐行写入，而不是假设行距等于帧宽。
function writeFramePixels(image, rgba, width, height) {
  const stride = image.width;
  const target = image.writablePixels;
  if (stride === width) {
    target.set(rgba.subarray(0, width * height * 4));
    return;
  }
  for (let y = 0; y < height; y++) {
    target.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride * 4);
  }
}

// 公共图层呈现入口。targets 是图层脚本对象；画布帧只上传一次，其余图层在
// GPU 上复制（VideoOvlImpl EC_UPDATE 的双缓冲写入），字节帧直接写主图像。
// left/top 省略时不改变图层位置（VideoOverlay 由 setPos 管理）。
export async function presentVideoFrame(targets, frame, { Layer, left, top, size = true, repaint = null } = {}) {
  const width = frame.width | 0, height = frame.height | 0;
  const canvas = frame.canvas, sample = frame.sample;
  const entries = [];
  for (const target of targets ?? []) {
    if (!target) continue;
    const node = Layer.peekState(target)?.node ?? Layer.peekNode(target);
    if (node) entries.push({ target, node });
  }
  let uploaded = null;
  let adopted = null;
  for (const { target, node } of entries) {
    // Empty frames still clear the layer rectangle, move it and request repaint.
    if (size && Layer.resizeNode) Layer.resizeNode(node, width, height);
    else if (size) { node.width = width; node.height = height; }
    if (width > 0 && height > 0) {
      if (canvas || sample) {
        // Canvas 上传无法改变纹理尺寸，尺寸变化时替换图像。
        if (node.image.width !== width || node.image.height !== height) {
          node.image = new Image(width, height, { defer: true });
        }
        if (!uploaded || uploaded.width !== width || uploaded.height !== height) {
          if (sample) uploadVideoSample(node.image, sample);
          else uploadVideoCanvas(node.image, canvas);
          uploaded = node.image;
        } else if (node.image !== uploaded) {
          getGPU().copy(node.image, uploaded);
        }
      } else if (frame.rgba) {
        if (frame.ownedPixels && !node.image.gray && !node.image.externallyWritable &&
            node.image.width === width && node.image.height === height) {
          // Adopt transferred bytes on full overwrite. Other targets share CoW
          // storage rather than sharing a mutable array outside Image ownership.
          if (adopted) node.image.assign(adopted);
          else { node.image.pixels = frame.rgba; adopted = node.image; }
        } else writeFramePixels(node.image, frame.rgba, width, height);
      }
      node.imageModified = true;
    }
    if (left !== undefined) node.left = Math.trunc(left);
    if (top !== undefined) node.top = Math.trunc(top);
    if (repaint) await repaint(target, node);
  }
  return entries.length;
}
