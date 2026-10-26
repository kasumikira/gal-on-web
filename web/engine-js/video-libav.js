// Unified libav demuxer. Browser codecs use WebCodecs; WMV3/WMA2 use FFmpeg.
import backendUrl from './codecs/libav/libav-krkr-wmv.wasm.mjs?url';
import wasmUrl from './codecs/libav/libav-krkr-wmv.wasm.wasm?url';
import { createWebDecoder, createPacketReader, webCodecsCanDecode } from './video-webcodecs.js';
import { createDemuxer } from './video-demux.js';
// Block reader devices key their buffers by FS basename (node.name), so the
// demuxer input name must stay a bare relative name; a leading slash would
// desync mkblockreaderdev's registration from the read callback's lookup and
// spin EAGAIN forever.
const INPUT_FILE = 'input';
const FPS_FALLBACK = 30;
const ASF_HEADER = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11, 0xa6, 0xd9, 0, 0xaa, 0, 0x62, 0xce, 0x6c];
const AVFMT_FLAG_NOFILLIN = 0x10, AVFMT_FLAG_NOPARSE = 0x20;

// Demuxers read in small AVIO blocks; without read-ahead every block miss
// would cost one range request. One window ahead, discarded on seek.
const READAHEAD_BYTES = 1 << 20;
function createReadAheadStream(stream) {
  let window = null; // { start, bytes }
  return {
    size: stream.size,
    async read(offset, length) {
      if (!(window && offset >= window.start && offset + length <= window.start + window.bytes.length)) {
        const requestLength = Math.max(0, Math.min(Math.max(length, READAHEAD_BYTES), stream.size - offset));
        const bytes = await stream.read(offset, requestLength);
        window = { start: offset, bytes };
      }
      const at = offset - window.start;
      return window.bytes.slice(at, at + length);
    },
    close: () => stream.close(),
  };
}
function createByteStream(bytes) {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.slice(offset, offset + length),
    close: async () => {},
  };
}

let libavModulePromise;
async function createLibAV() {
  libavModulePromise ??= import('./codecs/libav/libav-krkr-wmv.mjs');
  const { default: LibAV } = await libavModulePromise;
  return LibAV.LibAV({ toImport: backendUrl, wasmurl: wasmUrl });
}

function timestamp(frame, stream) {
  const lo = frame.best_effort_timestamp ?? frame.pts;
  const hi = frame.best_effort_timestamphi ?? frame.ptshi ?? 0;
  if (lo === undefined || lo === null || (lo === 0 && hi === -2147483648)) return null;
  const ticks = hi ? (lo >>> 0) + hi * 0x100000000 : lo;
  const num = frame.time_base_num || stream.time_base_num;
  const den = frame.time_base_den || stream.time_base_den;
  return den ? ticks * num / den : null;
}

async function openDecoder(libav, stream) {
  return libav.ff_init_decoder(stream.codec_id, {
    // Pass the demuxer's codecpar pointer through unchanged. libav.js's
    // ff_copyout_codecpar omits fields such as WMA2 block_align.
    codecpar: stream.codecpar,
    time_base: [stream.time_base_num, stream.time_base_den],
  });
}

// Ask FFmpeg's decoder which input DTS belongs to its first presented frame.
// Only the initial reorder window is decoded here; playback uses WebCodecs.
async function probeReorderDelay(libav, format, stream) {
  const reader = await createPacketReader(libav, format, stream);
  const decoder = await openDecoder(libav, stream);
  const times = [];
  try {
    for (;;) {
      const packet = await reader.next();
      if (!packet) throw new Error('ASF has no timestamped decoded video frame');
      if (packet.ptshi !== -2147483648) return 0;
      times.push(libav.i64tof64(packet.dts, packet.dtshi));
      const frames = await libav.ff_decode_multi(decoder[1], decoder[2], decoder[3], [packet], { copyoutFrame: 'ptr' });
      if (!frames.length) continue;
      try {
        const at = libav.i64tof64(
          await libav.AVFrame_best_effort_timestamp(frames[0]),
          await libav.AVFrame_best_effort_timestamphi(frames[0]),
        );
        const delay = times.indexOf(at);
        if (delay < 0) throw new Error('ASF presentation clock cannot be matched to DTS');
        return delay;
      } finally {
        for (const frame of frames) await libav.av_frame_free_js(frame);
      }
    }
  } finally {
    await reader.dispose();
    await libav.ff_free_decoder(decoder[1], decoder[2], decoder[3]);
    const result = await libav.av_seek_frame(format, stream.index, 0, 0, libav.AVSEEK_FLAG_BACKWARD);
    if (result < 0) throw new Error(`ASF probe rewind failed: ${result}`);
  }
}

function checkResult(libav, result, operation) {
  if (result < 0 && result !== libav.AVERROR_EOF && result !== -libav.EAGAIN) {
    throw new Error(`${operation} failed: ${result}`);
  }
}

async function createSource(libav, fmtCtx, videoStream, audioStream, duration, videoDecoder, webDecoder, audioSoftware) {
  const info = {
    fps: FPS_FALLBACK,
    duration,
    numberOfFrame: 0,
    width: 0,
    height: 0,
    totalTime: Math.round(duration * 1000),
    hasAudio: !!audioStream,
    videoDecoder: webDecoder ? 'WebCodecs' : 'FFmpeg',
  };
  const demux = await createDemuxer(libav, fmtCtx, [videoStream]);
  const reader = demux.reader(videoStream);
  let audioDecoder, audioReader, audioCodec, audioNative = false, audioFlushed = false, audioFrames = [], decodedSamples = 0;
  let pendingFrames = [];
  let eof = false;
  let videoFlushed = false;
  let disposed = false;
  let filterGraph = 0;
  let filterSource = 0;
  let filterSink = 0;
  let frameNumber = 0;
  let seekTarget = 0;

  const freeDecoder = async decoder => {
    if (decoder) await libav.ff_free_decoder(decoder[1], decoder[2], decoder[3]);
  };
  const nativeChannels = frame => {
    const count = audioCodec.channels, samples = frame.nb_samples;
    const deinterleave = (source, scale) => {
      const planes = [];
      for (let channel = 0; channel < count; channel++) {
        const plane = new Float32Array(samples);
        for (let i = 0; i < samples; i++) plane[i] = source[i * count + channel] * scale;
        planes.push(plane);
      }
      return planes;
    };
    switch (frame.format) {
      case libav.AV_SAMPLE_FMT_FLTP: return frame.data;
      case libav.AV_SAMPLE_FMT_S16P: return frame.data.map(plane => Float32Array.from(plane, v => v / 32768));
      case libav.AV_SAMPLE_FMT_FLT: return deinterleave(frame.data, 1);
      case libav.AV_SAMPLE_FMT_S16: return deinterleave(frame.data, 1 / 32768);
      default: throw new Error(`Unsupported native audio sample format ${frame.format}`);
    }
  };
  const convertVideoFrame = async frame => {
    // Decode output stays in WASM until the final packed RGBA copyout.
    try {
      if (!filterGraph) {
        const [width, height, format] = await Promise.all([
          libav.AVFrame_width(frame), libav.AVFrame_height(frame), libav.AVFrame_format(frame),
        ]);
        info.width = width;
        info.height = height;
        [filterGraph, filterSource, filterSink] = await libav.ff_init_filter_graph(
          'scale=iw:ih,format=pix_fmts=rgba',
          {
            type: libav.AVMEDIA_TYPE_VIDEO,
            width,
            height,
            pix_fmt: format,
            time_base: [videoStream.time_base_num, videoStream.time_base_den],
            frame_rate: info.fps,
          },
          {
            type: libav.AVMEDIA_TYPE_VIDEO,
            width,
            height,
            pix_fmt: libav.AV_PIX_FMT_RGBA,
            time_base: [videoStream.time_base_num, videoStream.time_base_den],
            frame_rate: info.fps,
          },
        );
      }
    } catch (error) {
      await libav.av_frame_free_js(frame);
      throw error;
    }
    // ff_filter_multi consumes and frees pointer inputs in ff_copyin_frame.
    const outputs = await libav.ff_filter_multi(filterSource, filterSink, videoDecoder[3], [frame], {
      copyoutFrame: 'video_packed',
    });
    return outputs.map(output => {
      const at = timestamp(output, videoStream);
      return {
        frame: at === null ? frameNumber++ : Math.max(0, Math.round(at * info.fps)),
        timestamp: at,
        width: output.width,
        height: output.height,
        rgba: output.data,
        ownedPixels: true,
        close() {},
      };
    });
  };

  const seek = async time => {
    seekTarget = time;
    await demux.reset();
    const ticks = Math.max(0, Math.round(time * videoStream.time_base_den / videoStream.time_base_num));
    const [lo, hi] = libav.f64toi64(ticks);
    const ret = await libav.av_seek_frame(fmtCtx, videoStream.index, lo, hi, libav.AVSEEK_FLAG_BACKWARD);
    if (ret < 0) throw new Error(`Video seek failed: ${ret}`);
    if (webDecoder) {
      webDecoder.reset();
    } else {
      await freeDecoder(videoDecoder);
      videoDecoder = await openDecoder(libav, videoStream);
    }
    if (audioDecoder) {
      if (audioNative) { await freeDecoder(audioDecoder); audioDecoder = await openDecoder(libav, audioStream); }
      else audioDecoder.reset();
    }
    audioFrames = []; audioFlushed = false; decodedSamples = 0;
    pendingFrames = [];
    eof = false;
    videoFlushed = false;
    frameNumber = Math.max(0, Math.round(time * info.fps));
  };

  const next = async () => {
    if (disposed) return null;
    if (webDecoder) {
      const frame = await webDecoder.next(reader);
      if (!frame) return null;
      const at = frame.timestamp / 1e6;
      info.width = frame.displayWidth; info.height = frame.displayHeight;
      return {
        frame: Math.max(0, Math.round(at * info.fps)), timestamp: at,
        width: frame.displayWidth, height: frame.displayHeight,
        canvas: frame, close: () => frame.close(),
      };
    }
    while (!pendingFrames.length) {
      const packet = eof ? null : await reader.next();
      if (packet) {
        const frames = await libav.ff_decode_multi(videoDecoder[1], videoDecoder[2], videoDecoder[3], [packet], { copyoutFrame: 'ptr' });
        for (const frame of frames) pendingFrames.push(...await convertVideoFrame(frame));
        continue;
      }
      eof = true;
      if (!videoFlushed) {
        videoFlushed = true;
        const frames = await libav.ff_decode_multi(videoDecoder[1], videoDecoder[2], videoDecoder[3], [], { fin: true, copyoutFrame: 'ptr' });
        for (const frame of frames) pendingFrames.push(...await convertVideoFrame(frame));
        if (pendingFrames.length) break;
      }
      return null;
    }
    return pendingFrames.shift() ?? null;
  };

  const openAudio = async () => {
    if (!audioStream) return null;
    if (!audioDecoder) {
      audioCodec = await libav.ff_copyout_codecpar(audioStream.codecpar);
      audioNative = audioSoftware
        || await libav.avcodec_get_name(audioStream.codec_id) === 'wmav2';
      audioDecoder = audioNative ? await openDecoder(libav, audioStream) : await createWebDecoder(libav, audioStream, false);
      demux.add(audioStream); audioReader = demux.reader(audioStream);
    }
    return { channels: audioCodec.channels, sampleRate: audioCodec.sample_rate };
  };
  const nextAudio = async () => {
    if (!audioDecoder) throw new Error('Video audio is not initialized');
    if (!audioNative) {
      const frame = await audioDecoder.next(audioReader);
      if (!frame) return null;
      try {
        const channels = Array.from({ length: frame.numberOfChannels }, (_, planeIndex) => {
          const plane = new Float32Array(frame.numberOfFrames);
          frame.copyTo(plane, { planeIndex, format: 'f32-planar' });
          return plane;
        });
        return { channels, sampleRate: frame.sampleRate, timestamp: frame.timestamp / 1e6 };
      } finally { frame.close(); }
    }
    while (!audioFrames.length) {
      if (audioFlushed) return null;
      const packet = await audioReader.next();
      audioFlushed = !packet;
      audioFrames = await libav.ff_decode_multi(audioDecoder[1], audioDecoder[2], audioDecoder[3], packet ? [packet] : [], { fin: !packet });
    }
    const frame = audioFrames.shift();
    // Native decoders pick their own sample formats (wmadec/aac: planar
    // float); anything the software fallback produces converts to planar f32.
    const channels = nativeChannels(frame);
    const at = timestamp(frame, audioStream) ?? decodedSamples / audioCodec.sample_rate;
    decodedSamples += frame.nb_samples;
    return { channels, sampleRate: audioCodec.sample_rate, timestamp: at };
  };

  return {
    info,
    async seek(time) { await seek(time); },
    async next() {
      for (;;) {
        const frame = await next();
        if (!frame || frame.timestamp === null || frame.timestamp >= seekTarget) return frame;
        frame.close();
      }
    },
    openAudio, nextAudio,
    interrupt: () => demux.cancel(),
    diagnostics: () => demux.diagnostics(),
    async dispose() {
      if (disposed) return;
      disposed = true;
      try {
        webDecoder?.dispose();
        await demux.dispose();
        if (audioNative) await freeDecoder(audioDecoder); else audioDecoder?.dispose();
        await freeDecoder(videoDecoder);
        await libav.avformat_close_input_js(fmtCtx);
        await libav.unlink(INPUT_FILE);
      } finally {
        await libav.terminate();
      }
    },
  };
}

// source: async () => seekable byte stream ({ size, read, close }), or a
// Uint8Array wrapped as one. Streams stay on the JS side; the demuxer reads
// them through a fixed-size block reader device.
export async function probeLibavVideo(source) {
  const openStream = typeof source === 'function' ? source : async () => createByteStream(new Uint8Array(source));
  const stream = createReadAheadStream(await openStream());
  const libav = await createLibAV();
  let fmtCtx = 0;
  let videoDecoder = null;
  let webDecoder = null;
  let sourceObject = null;
  try {
    await libav.mkblockreaderdev(INPUT_FILE, stream.size);
    libav.onblockread = (name, pos, len) => {
      stream.read(pos, len)
        .then(data => libav.ff_block_reader_dev_send(name, pos, data))
        .catch(ex => libav.ff_block_reader_dev_send(name, pos, null, { error: ex }));
    };
    const opened = await libav.ff_init_demuxer_file(INPUT_FILE);
    fmtCtx = opened[0];
    const streams = opened[1];
    const videoStream = streams.find(stream => stream.codec_type === libav.AVMEDIA_TYPE_VIDEO);
    const audioStream = streams.find(stream => stream.codec_type === libav.AVMEDIA_TYPE_AUDIO) ?? null;
    if (!videoStream) throw new Error('Video storage has no video stream');
    if (await libav.avcodec_get_name(videoStream.codec_id) === 'wmv3') {
      videoDecoder = await openDecoder(libav, videoStream);
    } else if (await webCodecsCanDecode(libav, videoStream, true)) {
      let reorderDelay = 0;
      // After probing codec parameters, preserve ASF's complete codec packets
      // and DTS clock. The H.264 parser otherwise drops DTS after seeking.
      const header = await stream.read(0, ASF_HEADER.length);
      if (ASF_HEADER.every((value, i) => header[i] === value)) {
        const flags = await libav.AVFormatContext_flags(fmtCtx);
        await libav.AVFormatContext_flags_s(fmtCtx, flags | AVFMT_FLAG_NOPARSE | AVFMT_FLAG_NOFILLIN);
        if (await libav.avcodec_get_name(videoStream.codec_id) === 'h264') {
          reorderDelay = await probeReorderDelay(libav, fmtCtx, videoStream);
        }
      }
      webDecoder = await createWebDecoder(libav, videoStream, true, reorderDelay);
    } else {
      // WebCodecs fallback: FFmpeg software decode. The container keeps its
      // normal parsing — the NOPARSE/DTS clock above only serves the WebCodecs
      // presentation path.
      const name = await libav.avcodec_get_name(videoStream.codec_id);
      if (!await libav.avcodec_find_decoder(videoStream.codec_id))
        throw new Error(`No decoder for ${name}: WebCodecs is unavailable and the libav build carries no software decoder`);
      videoDecoder = await openDecoder(libav, videoStream);
    }
    // Audio plan: WMA2 always decodes natively; other codecs prefer WebCodecs
    // and fall back to software decode when the browser has none.
    let audioSoftware = false;
    if (audioStream && await libav.avcodec_get_name(audioStream.codec_id) !== 'wmav2'
        && !await webCodecsCanDecode(libav, audioStream, false)) audioSoftware = true;
    let duration = libav.i64tof64(await libav.AVFormatContext_duration(fmtCtx), await libav.AVFormatContext_durationhi(fmtCtx)) / 1e6;
    if (!(duration > 0)) {
      // Live-recorded WebM may omit duration. Measure packet bounds once.
      const scan = await createPacketReader(libav, fmtCtx, videoStream);
      duration = 0;
      try {
        for (;;) {
          const packet = await scan.next();
          if (!packet) break;
          const at = timestamp(packet, videoStream);
          if (at !== null) duration = Math.max(duration, at + packet.duration * videoStream.time_base_num / videoStream.time_base_den);
        }
      } finally { await scan.dispose(); }
      const ret = await libav.av_seek_frame(fmtCtx, videoStream.index, 0, 0, libav.AVSEEK_FLAG_BACKWARD);
      if (ret < 0) throw new Error(`Video seek failed: ${ret}`);
    }
    sourceObject = await createSource(libav, fmtCtx, videoStream, audioStream, duration, videoDecoder, webDecoder, audioSoftware);
    fmtCtx = 0;
    videoDecoder = null;

    const samples = [];
    for (let i = 0; i < 8; i++) {
      const frame = await sourceObject.next();
      if (!frame) break;
      if (frame.timestamp !== null) samples.push(frame.timestamp);
      frame.close();
    }
    const rateNum = await libav.AVCodecParameters_framerate_num(videoStream.codecpar);
    const rateDen = await libav.AVCodecParameters_framerate_den(videoStream.codecpar);
    let fps = rateNum > 0 && rateDen > 0 ? rateNum / rateDen : FPS_FALLBACK;
    if (!(rateNum > 0) && samples.length > 1 && samples.at(-1) > samples[0]) {
      fps = (samples.length - 1) / (samples.at(-1) - samples[0]);
    }
    sourceObject.info.fps = fps;
    sourceObject.info.numberOfFrame = Math.max(1, Math.round(duration * fps));
    await sourceObject.seek(0);
    sourceObject.info.source = sourceObject;
    // The block reader must stay alive for the demuxer's lifetime; close the
    // backing stream exactly when the demuxer goes away.
    const innerDispose = sourceObject.dispose.bind(sourceObject);
    sourceObject.dispose = async () => {
      try { await innerDispose(); }
      finally { libav.onblockread = null; await stream.close().catch(() => {}); }
    };
    return sourceObject.info;
  } catch (error) {
    if (sourceObject) await sourceObject.dispose();
    else {
      libav.onblockread = null;
      await stream.close().catch(() => {});
      webDecoder?.dispose();
      if (videoDecoder) await libav.ff_free_decoder(videoDecoder[1], videoDecoder[2], videoDecoder[3]);
      if (fmtCtx) await libav.avformat_close_input_js(fmtCtx);
      await libav.unlink(INPUT_FILE).catch(() => {});
      await libav.terminate();
    }
    throw error;
  }
}
