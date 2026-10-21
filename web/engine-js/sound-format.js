// Metadata probe for the properties that WaveSoundBuffer exposes directly.
// Web Audio's decodeAudioData always resamples to the AudioContext rate, so the
// original file rate has to be recovered from the container header when a game
// uses `frequency` or `samplePosition`.  Unknown containers fall back to the
// decoded buffer rate.

const readU16 = (bytes, offset) =>
  bytes[offset] | (bytes[offset + 1] << 8);

const readU32 = (bytes, offset) =>
  (bytes[offset] | (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;

const readAscii = (bytes, offset, length) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));

function probeWave(bytes) {
  if (bytes.length < 36 || readAscii(bytes, 0, 4) !== 'RIFF' ||
      readAscii(bytes, 8, 4) !== 'WAVE') return null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = readAscii(bytes, offset, 4);
    const size = readU32(bytes, offset + 4);
    const data = offset + 8;
    if (id === 'fmt ' && size >= 16 && data + 16 <= bytes.length) {
      const channels = readU16(bytes, data + 2);
      const sampleRate = readU32(bytes, data + 4);
      const bits = readU16(bytes, data + 14);
      if (sampleRate > 0 && channels > 0) {
        return { sampleRate, bits: bits || 16, channels };
      }
      return null;
    }
    if (size > bytes.length - data) break;
    offset = data + size + (size & 1);
  }
  return null;
}

function probeOgg(bytes) {
  if (bytes.length < 28 || readAscii(bytes, 0, 4) !== 'OggS') return null;
  const segments = bytes[26];
  const packet = 27 + segments;
  if (packet + 16 > bytes.length) return null;
  const signature = readAscii(bytes, packet, 8);
  // Vorbis identification header: type, "vorbis", version(4), channels(1),
  // sample rate(4), bitrate maxima(12), blocksize(2).
  if (signature.startsWith('\x01vorbis')) {
    const channels = bytes[packet + 11];
    const sampleRate = readU32(bytes, packet + 12);
    if (sampleRate > 0) return { sampleRate, bits: 16, channels };
  }
  // OpusHead: version(1), channels(1), pre-skip(2), input sample rate(4).
  // Opus is decoded at 48 kHz by libopus/opusfile; the original decoder reports
  // that rate as the stream format.
  if (signature.startsWith('OpusHead')) {
    const channels = bytes[packet + 9];
    if (channels > 0) return { sampleRate: 48000, bits: 16, channels };
  }
  return null;
}

function probeFlac(bytes) {
  if (bytes.length < 42 || readAscii(bytes, 0, 4) !== 'fLaC') return null;
  const data = 8; // 4-byte marker, 4-byte metadata block header (STREAMINFO)
  const sampleRate = (bytes[data + 10] << 12) |
    (bytes[data + 11] << 4) | (bytes[data + 12] >> 4);
  const channels = ((bytes[data + 12] >> 1) & 0x07) + 1;
  const bits = (((bytes[data + 12] & 0x01) << 4) | (bytes[data + 13] >> 4)) + 1;
  if (sampleRate > 0) return { sampleRate, bits, channels };
  return null;
}

function probeMp3(bytes) {
  let offset = 0;
  if (bytes.length > 10 && readAscii(bytes, 0, 3) === 'ID3') {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    offset = 10 + size;
  }
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) {
      offset++;
      continue;
    }
    const version = (bytes[offset + 1] >> 3) & 0x03;
    const layer = (bytes[offset + 1] >> 1) & 0x03;
    const bitrate = (bytes[offset + 2] >> 4) & 0x0f;
    const sampleIndex = (bytes[offset + 2] >> 2) & 0x03;
    if (layer === 0 || bitrate === 0 || bitrate === 0x0f || sampleIndex === 3) {
      offset++;
      continue;
    }
    const rates = version === 3 ? [44100, 48000, 32000]
      : version === 2 ? [22050, 24000, 16000]
        : version === 0 ? [11025, 12000, 8000] : null;
    if (!rates) return null;
    return { sampleRate: rates[sampleIndex], bits: 16 };
  }
  return null;
}

export function probeAudioFormat(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return null;
  return probeWave(bytes) || probeOgg(bytes) || probeFlac(bytes) || probeMp3(bytes);
}
