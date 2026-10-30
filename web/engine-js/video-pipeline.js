// Shared video playback pipeline: backend -> bounded queue -> consumer -> shared layer
// presentation in the native Layer backend or browser overlay.
//
// The three stages in the architecture are decoupled:
//   Backend    video-libav.js (libav demuxing + WebCodecs / FFmpeg decoding),
//               plugins/amv-source.js (dedicated AMV Worker);
//   Queue      FrameQueue / VideoPipeline: decoding can get at most capacity frames ahead of the consumer.
//   Consumer   VideoOverlay retrieves frames according to the clock (video.js),
//               AlphaMovie retrieves frames from script showNextImage (plugins/alphamovie.js).
//
// Reference mapping: VideoOvlImpl's double buffer (MAX_BUFFER_COUNT) and AlphaMovie
// The worker's bounded Free/Ready frame pool limits decode-ahead and returns a frame as soon
// as the consumer takes it. Both paths therefore share one bounded-queue abstraction, with
// only the frame retrieval trigger (clock/script) differing.

// Decoded-frame contract produced by the backend:
//   frame       Frame index within the video
//   timestamp   Presentation time in seconds (null if the container has no timestamp)
//   width/height Display dimensions of the frame
//   canvas      WebCodecs VideoFrame; presentation uploads the underlying frame directly
//   rgba        Raw RGBA bytes (AMV Worker backend)
//   close()     Release backend resources (VideoFrame, etc.)
export function closeFrame(frame) {
  try { frame?.close?.(); } catch {}
}

// Bounded queue: the producer checks that there is room (full === false) before enqueueing.
// When full, waitForRoom() waits for the consumer to take a frame. Capacity matches the
// reference implementation's frame-pool size.
// (VideoOverlay's MAX_BUFFER_COUNT and AlphaMovie's preloadSamples), so decoding can get at
// most capacity frames ahead of the consumer.
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
    // Producers waiting for space can resume after capacity increases.
    this.wake();
  }
  get length() { return this.items.length; }
  get full() { return this.items.length >= this._capacity; }
  peek() { return this.items[0] ?? null; }
  // Enqueue a frame; discard it and return false if there is no room or the queue is closed.
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
  // Wake all producers waiting for space. They recheck full and the production state when
  // resumed, so stop(), clear(), and capacity changes let a blocked pump exit promptly.
  wake() {
    while (this.waiters.length) this.waiters.shift()(!this.closed);
  }
  // Wait for space. Registering the waiter and checking full happen in the same synchronous
  // section, so a wake-up cannot be missed.
  waitForRoom() {
    if (!this.full || this.closed) return Promise.resolve(!this.closed);
    return new Promise(resolve => this.waiters.push(resolve));
  }
}

// Backend contract: { info, open?, seek(position), next() -> Promise<frame|null>, dispose() }.
// next() returns null at end of media; the backend or consumer decides whether to loop or
// switch to another file.
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
  // All data has been decoded and the consumer has drained the queue (the reference
  // implementation's EC_COMPLETE condition).
  get drained() { return this.exhausted && this.queue.length === 0; }
  peek() { return this.queue.peek(); }
  shift() { return this.queue.shift(); }
  // Start or resume production; decoding pauses automatically when the queue is full.
  start() {
    if (this.active) return;
    this.active = true;
    this.exhausted = false;
    this.pump();
  }
  // Stop production but keep decoded frames (matching AlphaMovie::stop, which preserves
  // the Ready queue).
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
  // Reseek: discard in-flight decode results, clear the queue, then seek in the backend
  // and resume production.
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
      // Check for space before decoding so decoding can get at most capacity frames ahead
      // of the consumer.
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
      // Decoding is complete and the worker exits (the reference exits when DecodeNext
      // returns 2), but the consumer can still take queued frames. A later start() restarts
      // production.
      if (!frame) { this.exhausted = true; this.active = false; return; }
      this.queue.push(frame);
    }
  }
}

