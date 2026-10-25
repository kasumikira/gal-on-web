// PSB container handling: motion data may be an "mdf\0" + u32 size + zlib
// wrapper (PSBRawFile.cpp tryDecodeMdf_guess). decodePSBContainer must unwrap it
// before PSBFile parses, and PSBFile must reject a raw container.
import assert from 'node:assert/strict';
import { PSBFile, decodePSBContainer } from '../../engine-js/plugins/psb.js';

const deflate = async bytes => {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const payload = new Uint8Array(0x200);
payload.set([0x50, 0x53, 0x42, 0x00]); // "PSB\0"
payload[4] = 0x28; payload[5] = 0x00;  // version 40
for (let i = 8; i < payload.length; i++) payload[i] = (i * 97 + 13) & 0xff;
const compressed = await deflate(payload);
const mdf = new Uint8Array(8 + compressed.length);
mdf.set([0x6d, 0x64, 0x66, 0x00]);     // "mdf\0"
new DataView(mdf.buffer).setUint32(4, payload.length, true);
mdf.set(compressed, 8);

assert.deepEqual(await decodePSBContainer(mdf), payload, 'mdf payload is unwrapped');
assert.equal(await decodePSBContainer(payload), payload, 'plain PSB bytes pass through unchanged');
assert.throws(() => new PSBFile(mdf), /mdf container/, 'PSBFile rejects an undecoded container');

// A minimal PSB header still parses: the packed tables only need readable tags.
const file = new Uint8Array(0x200);
file.set([0x50, 0x53, 0x42, 0x00]);
const view = new DataView(file.buffer);
view.setUint16(4, 40, true);
view.setUint16(6, 0, true);
view.setUint32(8, 0, true);       // encryptData
view.setUint32(12, 0x80, true);   // names
view.setUint32(16, 0x90, true);   // strings
view.setUint32(20, 0xc0, true);   // stringsData
view.setUint32(24, 0xd0, true);   // chunkOffsets
view.setUint32(28, 0xe0, true);   // chunkLengths
view.setUint32(32, 0xf0, true);   // chunkData
view.setUint32(36, 0x40, true);   // entries
for (const offset of [0x80, 0x83, 0x86, 0x90, 0xd0, 0xe0]) {
  file[offset] = 0x0d;            // count tag: one-byte count
  file[offset + 1] = 0;           // zero elements
  file[offset + 2] = 0x0c;        // width tag: zero bytes per element
}
const parsed = new PSBFile(file);
assert.equal(parsed.version, 40);
console.log('psb-check passed');


