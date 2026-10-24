// libav owns demuxing/timestamps; WebCodecs owns decoding and frame reordering.
import {
  videoStreamToConfig, audioStreamToConfig,
  packetToEncodedVideoChunk, packetToEncodedAudioChunk,
} from 'libavjs-webcodecs-bridge';

const DECODE_QUEUE_LIMIT = 8;
const annexB = data => data?.[0] === 0 && data[1] === 0 &&
  (data[2] === 1 || (data[2] === 0 && data[3] === 1));

export async function createWebDecoder(libav, stream, video, reorderDelay = 0) {
  const config = await (video ? videoStreamToConfig : audioStreamToConfig)(libav, stream);
  const Decoder = video ? VideoDecoder : AudioDecoder;
  const support = await Decoder.isConfigSupported(config);
  if (!support.supported) throw new Error(`WebCodecs cannot decode ${config.codec}`);
  const codec = await libav.ff_copyout_codecpar(stream.codecpar);
  // ASF can carry SPS/PPS only in extradata. Annex B decoding has no
  // description, so send those parameter sets in-band at random access points.
  const prefix = video && !config.description && annexB(codec.extradata) ? codec.extradata : null;
  const frames = [];
  let error = null, ended = false, wake = null, clockFromDts = null, flushing = null;
  let lastTime = null;
  const rateNum = video ? await libav.AVCodecParameters_framerate_num(stream.codecpar) : 0;
  const rateDen = video ? await libav.AVCodecParameters_framerate_den(stream.codecpar) : 0;
  const frameDuration = rateNum > 0 ? 1e6 * rateDen / rateNum : 0;
  const presentationTimes = [];
  const decoder = new Decoder({
    output: frame => { frames.push(frame); wake?.(); },
    error: failure => { error = failure; wake?.(); },
  });
  decoder.ondequeue = () => wake?.();
  decoder.configure(config);
  const clear = () => { for (const frame of frames.splice(0)) frame.close(); };
  return {
    async next(reader) {
      while (!frames.length || (video && clockFromDts && presentationTimes.length <= reorderDelay && !flushing && !ended)) {
        if (error) throw error;
        if (ended) return null;
        if (flushing || decoder.decodeQueueSize >= DECODE_QUEUE_LIMIT) {
          await new Promise(resolve => { wake = resolve; });
          wake = null;
          continue;
        }
        let packet = await reader.next();
        if (!packet) {
          // Consume and close outputs while flush is pending: holding all of
          // them until flush resolves can exhaust hardware decoder surfaces.
          const task = decoder.flush().then(() => {
            if (flushing !== task) return;
            ended = true; wake?.();
          }, failure => {
            if (flushing !== task) return;
            error = failure; wake?.();
          });
          flushing = task;
          continue;
        }
        if (prefix && (packet.flags & 1)) {
          const data = new Uint8Array(prefix.length + packet.data.length);
          data.set(prefix); data.set(packet.data, prefix.length);
          packet = { ...packet, data };
        }
        if (clockFromDts === null) clockFromDts = packet.ptshi === -2147483648;
        if (clockFromDts) {
          if (packet.dtshi === -2147483648) throw new Error('Media packet has neither PTS nor DTS');
          packet = { ...packet, pts: packet.dts, ptshi: packet.dtshi };
        }
        // libav's low i64 word is signed. The bridge's ESM fallback adds it
        // directly to the high word, so pass unsigned low words at this boundary.
        packet = { ...packet, pts: packet.pts >>> 0, duration: packet.duration >>> 0 };
        const chunk = (video ? packetToEncodedVideoChunk : packetToEncodedAudioChunk)(packet, stream);
        if (video && clockFromDts) presentationTimes.push(chunk.timestamp);
        decoder.decode(chunk);
      }
      if (error) throw error;
      const frame = frames.shift();
      if (!video || !clockFromDts) return frame;
      // Match FFmpeg's best-effort clock after its measured reorder delay.
      // Drained frames have no corresponding DTS even in FFmpeg; advance the
      // final frames using the stream's nominal frame duration.
      const at = presentationTimes[reorderDelay] ?? (lastTime === null || !frameDuration ? null : lastTime + frameDuration);
      presentationTimes.shift();
      if (at === null) { frame.close(); throw new Error('ASF frame has no presentation time'); }
      lastTime = at;
      const timed = new VideoFrame(frame, { timestamp: Math.round(at) });
      frame.close();
      return timed;
    },
    reset() {
      clear(); ended = false; flushing = null; clockFromDts = null; lastTime = null; presentationTimes.length = 0;
      decoder.reset(); decoder.configure(config);
    },
    dispose() {
      clear();
      flushing = null;
      if (decoder.state !== 'closed') decoder.close();
    },
  };
}

export async function createPacketReader(libav, format, stream) {
  const pointer = await libav.av_packet_alloc();
  let packets = [], ended = false;
  return {
    async next() {
      while (!packets.length && !ended) {
        const [result, groups] = await libav.ff_read_frame_multi(format, pointer, { limit: 64 * 1024 });
        if (result < 0 && result !== libav.AVERROR_EOF && result !== -libav.EAGAIN)
          throw new Error(`Video demux failed: ${result}`);
        ended = result === libav.AVERROR_EOF;
        packets = groups[stream.index] ?? [];
      }
      return packets.shift() ?? null;
    },
    reset() { packets = []; ended = false; },
    dispose: () => libav.av_packet_free_js(pointer),
  };
}
