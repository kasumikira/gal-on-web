// XP3 entry-level seekable streams: segment mapping, cache reuse, filter
// offsets and the Storages.openStream dispatch branches.
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { XP3Archive, createXP3Filter } from '../../engine-js/xp3.js';
import { Storages } from '../../engine-js/storage.js';
import { config } from '../../engine-js/global.js';

const pattern = (length, seed) => Uint8Array.from({ length }, (_, i) => (i * 7 + seed) & 0xff);
const rawA = pattern(2000, 1);
const rawB = pattern(3000, 2);
const rawC = pattern(1000, 3);
const storedB = Uint8Array.from(deflateSync(rawB));
const entryBytes = Uint8Array.from([rawA, rawB, rawC].flatMap(b => [...b]));

function makeArchive(filter = null) {
  const backing = new Uint8Array(4096);
  const reads = [];
  backing.set(rawA, 100);
  backing.set(storedB, 2100);
  backing.set(rawC, 3000);
  const archive = new XP3Archive({
    read: async (offset, length) => { reads.push({ offset, length }); return backing.slice(offset, offset + length); },
  }, filter, 'test.xp3');
  archive.entries.set('video/clip.wmv', {
    name: 'video/clip.wmv', size: entryBytes.length, flags: 0, hash: 0x1234,
    segments: [
      { encoding: 0, start: 100, size: rawA.length, storedSize: rawA.length },
      { encoding: 1, start: 2100, size: rawB.length, storedSize: storedB.length },
      { encoding: 0, start: 3000, size: rawC.length, storedSize: rawC.length },
    ],
  });
  return { archive, getReads: () => reads.slice() };
}

function makeSingleSegmentArchive(bytes, storedBytes = bytes, encoding = 0, filter = null) {
  const reads = [];
  const archive = new XP3Archive({
    read: async (offset, length) => {
      reads.push({ offset, length });
      return storedBytes.slice(offset, offset + length);
    },
  }, filter, 'large.xp3');
  archive.entries.set('large/clip.bin', {
    name: 'large/clip.bin', size: bytes.length, flags: 0, hash: 0x5678,
    segments: [{ encoding, start: 0, size: bytes.length, storedSize: storedBytes.length }],
  });
  return { archive, getReads: () => reads.slice() };
}

// --- segment mapping: sequential reassembly, spanning reads, EOF clamp -----
{
  const { archive, getReads } = makeArchive();
  const stream = await archive.openEntryStream('video/clip.wmv');
  assert.equal(stream.size, entryBytes.length);

  let reassembled = new Uint8Array(0);
  for (let at = 0; at < stream.size; at += 700) {
    const chunk = await stream.read(at, 700);
    reassembled = Uint8Array.from([...reassembled, ...chunk]);
  }
  assert.deepEqual(reassembled, entryBytes, 'chunked sequential reads reassemble the entry');

  const spanning = await stream.read(1900, 2200);
  assert.equal(spanning.length, 2200);
  assert.deepEqual(spanning, entryBytes.slice(1900, 1900 + 2200), 'read spanning all three segments');

  const tail = await stream.read(stream.size - 10, 100);
  assert.equal(tail.length, 10, 'read clamps at entry end');
  assert.deepEqual(await stream.read(stream.size, 10), new Uint8Array(0), 'EOF read is empty');

  assert.equal(await stream.read(-50, 10).then(bytes => bytes.length), 10, 'negative offset clamps');
  await stream.close();
  await assert.rejects(() => stream.read(0, 10), /closed/);
}

// --- raw ranges bypass the decoded cache; compressed segments are cached ---
{
  const { archive, getReads } = makeArchive();
  const stream = await archive.openEntryStream('video/clip.wmv');
  const rawBefore = getReads().length;
  assert.deepEqual(await stream.read(16, 16), rawA.slice(16, 32));
  assert.deepEqual(getReads().at(-1), { offset: 116, length: 16 }, 'raw data reads only the requested source range');
  assert.deepEqual(await stream.read(16, 16), rawA.slice(16, 32));
  assert.equal(getReads().length, rawBefore + 2, 'raw ranges are fetched directly on each request');

  const compressedOffset = rawA.length + 64;
  const compressedBefore = getReads().length;
  const [first, second] = await Promise.all([
    stream.read(compressedOffset, 16),
    stream.read(compressedOffset + 20, 16),
  ]);
  assert.deepEqual(first, entryBytes.slice(compressedOffset, compressedOffset + 16));
  assert.deepEqual(second, entryBytes.slice(compressedOffset + 20, compressedOffset + 36));
  assert.equal(getReads().length, compressedBefore + 1, 'concurrent compressed reads decode the segment once');
  assert.deepEqual(getReads().at(-1), { offset: 2100, length: storedB.length }, 'compressed segments are read whole for inflate');
  await stream.close();
}

// --- an oversized compressed segment stays decoded for this stream ----------
{
  const large = pattern(8 * 1024 * 1024 + 1, 11);
  const compressed = Uint8Array.from(deflateSync(large));
  const { archive, getReads } = makeSingleSegmentArchive(large, compressed, 1);
  const stream = await archive.openEntryStream('large/clip.bin');
  assert.deepEqual(await stream.read(0, 16), large.slice(0, 16));
  const readsAfterFirst = getReads().length;
  assert.deepEqual(await stream.read(1024, 16), large.slice(1024, 1040));
  assert.equal(getReads().length, readsAfterFirst, 'one oversized decoded segment is retained instead of being repeatedly inflated');
  await stream.close();
}

// --- filter path: per-segment entry offsets and lifecycle ------------------
{
  const appliedOffsets = [];
  let opened = 0, closedCount = 0;
  const filter = {
    open: async () => { opened++; return { mode: 0, stream: { handle: 1 } }; },
    apply: async (stream, hash, offset, bytes) => {
      assert.equal(hash, 0x1234);
      appliedOffsets.push(offset);
      return bytes.map((byte, i) => byte ^ ((offset + i) & 0xff));
    },
    close: async () => { closedCount++; },
  };
  const { archive } = makeArchive(filter);
  const stream = await archive.openEntryStream('video/clip.wmv');
  assert.equal(opened, 1);
  const head = await stream.read(1950, 100);
  assert.deepEqual(appliedOffsets, [0, 2000], 'each segment applies at its entry offset');
  const whole = await archive.read('video/clip.wmv');
  assert.equal(opened, 2, 'whole-entry read opens its own filter stream');
  assert.equal(closedCount, 1, 'whole-entry read closes its own filter stream');
  const expected = Uint8Array.from(entryBytes.map((byte, i) => byte ^ (i & 0xff)));
  assert.deepEqual(whole, expected, 'whole-entry read decodes with the same filter math');
  assert.deepEqual(head, expected.slice(1950, 2050), 'stream and whole read agree byte for byte');
  await stream.close();
  assert.equal(closedCount, 2, 'filter stream closes with the entry stream');
}

// --- complete-read filters are applied once before random stream access -----
{
  const large = pattern(8 * 1024 * 1024 + 1, 17);
  let applyCount = 0, closeCount = 0;
  const filter = {
    open: async () => ({ mode: 1, stream: { calls: 0 } }),
    apply: async (stream, hash, offset, bytes) => {
      assert.equal(hash, 0x5678);
      assert.equal(offset, 0);
      applyCount++;
      stream.calls++;
      return bytes.map(byte => byte + stream.calls);
    },
    close: async () => { closeCount++; },
  };
  const { archive, getReads } = makeSingleSegmentArchive(large, large, 0, filter);
  const whole = await archive.read('large/clip.bin');
  assert.equal(applyCount, 1);
  const stream = await archive.openEntryStream('large/clip.bin');
  assert.equal(applyCount, 2, 'complete mode filters the whole segment once when opening the stream');
  assert.deepEqual(getReads().at(-1), { offset: 0, length: large.length }, 'complete mode performs one full-entry read');
  const first = await stream.read(0, 16);
  assert.deepEqual(first, whole.slice(0, 16));
  assert.deepEqual(await stream.read(0, 16), first, 'repeated stream reads preserve the complete-read filter output');
  assert.equal(applyCount, 2, 'random reads do not replay a stateful complete-read filter');
  await stream.close();
  assert.equal(closeCount, 2, 'each complete filter context closes once');
}

// --- Storages.openStream dispatch ------------------------------------------
{
  const plain = pattern(16, 9);
  const storages = new Storages({
    list: async () => [{ path: '/plain.bin', size: plain.length }, { path: '/fake.xp3', size: 100 }],
    read: async (path, offset, length) => {
      assert.equal(path, '/plain.bin');
      return plain.slice(offset, offset + length);
    },
  }, null, '/');
  await storages.initialize();

  const loose = await storages.openStream('plain.bin');
  assert.equal(loose.size, plain.length);
  assert.deepEqual(await loose.read(4, 8), plain.slice(4, 12), 'loose file streams by range');

  let entryOpened = false, entryClosed = 0;
  storages.archives.set('/fake.xp3', {
    entries: new Map([['e.wmv', { name: 'e.wmv', size: 7, segments: [] }]]),
    openEntryStream: async name => {
      entryOpened = name === 'e.wmv';
      return { size: 7, read: async () => new Uint8Array(7), close: async () => { entryClosed++; } };
    },
    read: async () => { throw new Error('whole read must not be used'); },
  });
  const fromArchive = await storages.openStream('fake.xp3>e.wmv');
  assert.ok(entryOpened, 'archive entries route to openEntryStream');
  assert.equal((await fromArchive.read(0, 10)).length, 7);
  await fromArchive.close();
  assert.equal((await storages.read('fake.xp3>e.wmv')).length, 7, 'whole reads use the archive stream too');
  assert.equal(entryClosed, 2, 'whole reads close their temporary stream');

  storages.archives.get('/fake.xp3').openEntryStream = async () => ({
    size: 7,
    read: async () => { throw new Error('stream read failed'); },
    close: async () => { entryClosed++; },
  });
  await assert.rejects(() => storages.readPlaced('/fake.xp3>e.wmv'), /stream read failed/);
  assert.equal(entryClosed, 3, 'failed whole reads also close their stream');

  storages.registerMedia('mem://', { isExistent: async () => true, read: async () => plain });
  const mediaStream = await storages.openStream('mem://clip.wmv');
  assert.deepEqual(await mediaStream.read(2, 5), plain.slice(2, 7), 'media falls back to a whole-read stream');
  await mediaStream.close();
}

// Exercise the real WASM filter adapter, including its opaque stream handle.
Object.assign(config, { document: { defaultView: {} }, arguments: {}, continuousFrameRate: 60, onTitleChange() {} });
for (const mode of [0, 1]) {
  const script = `
    Storages.setXP3ArchiveContentFilter(function(name, archive, size) { return [${mode}, %["calls" => 0]]; });
    Storages.setXP3ArchiveExtractionFilter(function(hash, offset, buffer, size, name, context) {
      context.calls++;
      buffer[0] ^= context.calls;
    });
  `;
  const scriptBytes = new Uint8Array(Buffer.concat([Buffer.from([255, 254]), Buffer.from(script, 'utf16le')]));
  const storage = new Storages({
    list: async () => [{ path: '/xp3filter.tjs', size: scriptBytes.length }],
    read: async () => scriptBytes.slice(),
  }, null, '/');
  await storage.initialize();
  const filter = await createXP3Filter(storage, undefined, () => {});
  try {
    const bytes = new Uint8Array(8);
    const { archive } = makeSingleSegmentArchive(bytes, bytes, 0, filter);
    const whole = await archive.read('large/clip.bin');
    assert.equal(whole[0], 1);
    const stream = await archive.openEntryStream('large/clip.bin');
    try {
      assert.deepEqual(await stream.read(0, 8), whole);
      assert.deepEqual(await stream.read(0, 8), whole, 'repeat reads reuse the filtered result');
    } finally { await stream.close(); }
  } finally { await filter.finalize(); }
}

console.log('xp3-stream-check passed');
