import { Input, ALL_FORMATS, BufferSource, VideoSampleSink, AudioSampleSink } from 'mediabunny';

// Re-exports for video.js: the sinks decode frames and audio samples.
export { Input, ALL_FORMATS, BufferSource, VideoSampleSink, AudioSampleSink };

export async function readVideoMetadata(bytes) {
  const input = new Input({formats:ALL_FORMATS,source:new BufferSource(bytes)});
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error('Video storage has no video track');
    const stats = await track.computePacketStats();
    return {width:track.displayWidth,height:track.displayHeight,fps:stats.averagePacketRate,
      frames:stats.packetCount,duration:await input.computeDuration(),
      audioTracks:(await input.getAudioTracks()).length,videoTracks:(await input.getVideoTracks()).length};
  } finally { input.dispose(); }
}
