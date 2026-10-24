// Bounded PCM buffering; Web Audio schedules, resamples and plays each chunk.
const BUFFER_SECONDS = 0.5;
const PREBUFFER_SECONDS = 0.15;

export class VideoAudio {
  static async create(context, source, onError) {
    await source.openAudio();
    return new VideoAudio(context, source, onError);
  }
  constructor(context, source, onError) {
    this.context = context; this.source = source; this.onError = onError;
    this.node = context.createGain();
    this.queue = [];
    this.generation = 0; this.active = false; this.eof = false;
    this.playing = false; this.wantPlay = false; this.task = null;
    this.position = 0; this.contextTime = 0; this.rate = 1; this.bufferEnd = 0;
    this.underruns = 0; this.chunks = 0;
    this.waiters = [];
  }
  get time() {
    if (!this.playing) return this.position;
    const time = this.position + (this.context.currentTime - this.contextTime) * this.rate;
    return this.eof ? time : Math.min(this.bufferEnd, time);
  }
  get ended() { return this.eof && this.time >= Math.max(this.source.info.duration, this.bufferEnd); }
  get buffered() {
    const time = this.time;
    return this.queue.reduce((sum, chunk) => sum + Math.max(0, chunk.end - Math.max(time, chunk.timestamp)), 0);
  }
  wake() { for (const resolve of this.waiters.splice(0)) resolve(); }
  wait() { return new Promise(resolve => this.waiters.push(resolve)); }
  prune() {
    const time = this.time;
    this.queue = this.queue.filter(chunk => chunk.end > time);
  }
  schedule(chunk) {
    if (chunk.end <= this.time) return;
    const node = this.context.createBufferSource();
    chunk.node = node;
    node.buffer = chunk.buffer;
    node.playbackRate.value = this.rate;
    node.connect(this.node);
    node.onended = () => {
      node.disconnect();
      this.queue = this.queue.filter(entry => entry !== chunk);
      this.wake();
    };
    const offset = Math.max(0, this.position - chunk.timestamp);
    const when = this.contextTime + Math.max(0, chunk.timestamp - this.position) / this.rate;
    node.start(when, offset);
  }
  stopNodes() {
    for (const chunk of this.queue) {
      if (!chunk.node) continue;
      chunk.node.onended = null;
      chunk.node.stop(); chunk.node.disconnect(); chunk.node = null;
    }
  }
  async produce(generation) {
    try {
      while (this.active && generation === this.generation) {
        this.prune();
        if (this.buffered >= BUFFER_SECONDS) { await this.wait(); continue; }
        const chunk = await this.source.nextAudio();
        if (!this.active || generation !== this.generation) return;
        if (!chunk) {
          this.position = this.time; this.contextTime = this.context.currentTime;
          this.eof = true; this.wake(); return;
        }
        const end = chunk.timestamp + chunk.channels[0].length / chunk.sampleRate;
        if (end <= this.time) continue;
        const buffer = this.context.createBuffer(chunk.channels.length, chunk.channels[0].length, chunk.sampleRate);
        chunk.channels.forEach((channel, index) => buffer.copyToChannel(channel, index));
        // An underrun froze time at bufferEnd. Re-anchor before extending it,
        // so decoding delays cannot make the clock jump over unplayed samples.
        if (this.playing && this.position + (this.context.currentTime - this.contextTime) * this.rate > this.bufferEnd) {
          this.position = this.time; this.contextTime = this.context.currentTime; this.underruns++;
        }
        this.bufferEnd = Math.max(this.bufferEnd, end);
        const entry = { buffer, timestamp: chunk.timestamp, end, node: null };
        this.queue.push(entry); this.chunks++;
        this.onChunk?.(chunk);
        if (this.playing) this.schedule(entry);
        this.wake();
      }
    } catch (error) { this.error = error; this.wake(); this.onError(error); }
  }
  async play() {
    this.wantPlay = true; this.active = true;
    if (!this.task) {
      const task = this.produce(this.generation).finally(() => { if (this.task === task) this.task = null; });
      this.task = task;
    }
    while (this.active && this.wantPlay && this.buffered < PREBUFFER_SECONDS && !this.eof && !this.error) await this.wait();
    if (this.error) throw this.error;
    if (!this.active || !this.wantPlay || this.playing) return;
    this.contextTime = this.context.currentTime; this.playing = true;
    for (const chunk of this.queue) this.schedule(chunk);
  }
  pause() {
    this.position = this.time; this.playing = false; this.wantPlay = false;
    this.stopNodes(); this.prune(); this.wake();
  }
  stop() {
    this.pause(); this.active = false; this.generation++; this.queue = []; this.wake();
    return this.task;
  }
  reset(time) {
    this.position = this.bufferEnd = time; this.contextTime = this.context.currentTime;
    this.eof = false; this.error = null;
  }
  setRate(rate) {
    if (!(rate > 0)) throw new RangeError('Video playback rate must be positive');
    this.position = this.time; this.contextTime = this.context.currentTime;
    this.stopNodes(); this.prune(); this.rate = rate;
    if (this.playing) for (const chunk of this.queue) this.schedule(chunk);
  }
  async dispose() { await this.stop(); this.node.disconnect(); }
}
