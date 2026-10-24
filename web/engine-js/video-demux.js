// One demux cursor, advanced only when a consumer runs out of packets.
// A full sibling track cannot block that read: its next packet may precede
// the requested track in the file. Decoded video/PCM provide backpressure;
// compressed packet retention depends on the container's interleaving.

export async function createDemuxer(libav, format, streams) {
  const pointer = await libav.av_packet_alloc();
  const tracks = new Map(streams.map(stream => [stream.index, { packets: [], bytes: 0 }]));
  let ended = false, cancelled = false, reading = null;
  async function read() {
    if (cancelled) return;
    const [result, groups] = await libav.ff_read_frame_multi(format, pointer, { limit: 64 * 1024 });
    if (result < 0 && result !== libav.AVERROR_EOF && result !== -libav.EAGAIN)
      throw new Error(`Video demux failed: ${result}`);
    ended = result === libav.AVERROR_EOF;
    if (cancelled) return;
    for (const [index, track] of tracks) {
      for (const packet of groups[index] ?? []) {
        track.packets.push(packet);
        track.bytes += packet.data.byteLength;
      }
    }
  }
  return {
    add(stream) { tracks.set(stream.index, { packets: [], bytes: 0 }); },
    reader(stream) {
      const track = tracks.get(stream.index);
      return { async next() {
        while (!cancelled && !track.packets.length && !ended) {
          if (!reading) reading = read().finally(() => { reading = null; });
          await reading;
        }
        if (cancelled) return null;
        const packet = track.packets.shift() ?? null;
        if (packet) track.bytes -= packet.data.byteLength;
        return packet;
      } };
    },
    cancel() { cancelled = true; },
    async reset() {
      cancelled = true; await reading;
      for (const track of tracks.values()) { track.packets = []; track.bytes = 0; }
      ended = false; cancelled = false;
    },
    async dispose() {
      cancelled = true; await reading;
      tracks.clear(); await libav.av_packet_free_js(pointer);
    },
    diagnostics() {
      return [...tracks].map(([index, track]) => ({ index, packets: track.packets.length, bytes: track.bytes }));
    },
  };
}
