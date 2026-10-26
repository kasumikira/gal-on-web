import { TJSInterop } from './wasm-vm.js';
import { createDebugClass } from './debug.js';
import { createSystem } from './system.js';
import { LRUCache } from 'lru-cache';

// Port of cpp/core/base/XP3Archive.cpp: index chunks and segmented streams.
const signature = [88, 80, 51, 13, 10, 32, 10, 26, 139, 103, 1];
const utf16 = new TextDecoder('utf-16le');
const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const u64 = (data, offset) => {
  const high = data.getUint32(offset + 4, true);
  if (high > 0x1fffff) throw new Error('XP3 offset exceeds JS integer precision');
  return high * 0x100000000 + data.getUint32(offset, true);
};
async function inflate(bytes, size) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  const result = new Uint8Array(await new Response(stream).arrayBuffer());
  if (result.length !== size) throw new Error('XP3 uncompressed size mismatch');
  return result;
}
function chunkEnd(data, offset, limit) {
  if (offset + 12 > limit) throw new Error('Truncated XP3 chunk');
  const end = offset + 12 + u64(data, offset + 4);
  if (end > limit) throw new Error('Truncated XP3 chunk');
  return end;
}
export class XP3Archive {
  constructor(source, filter, name) { this.source = source; this.filter = filter; this.name = name; this.entries = new Map(); }
  async open(header) {
    header ??= await this.source.read(0, 19);
    if (!signature.every((byte, i) => header[i] === byte)) throw new Error('Invalid XP3 signature');
    let pointer = u64(view(header), 11);
    for (;;) {
      const flag = (await this.source.read(pointer, 1))[0];
      const method = flag & 7;
      if (method !== 0 && method !== 1) throw new Error(`Unknown XP3 index encoding ${method}`);
      const sizes = await this.source.read(pointer + 1, method === 1 ? 16 : 8);
      const sizeData = view(sizes);
      const storedSize = u64(sizeData, 0);
      const originalSize = method === 1 ? u64(sizeData, 8) : storedSize;
      const start = pointer + 1 + sizes.length;
      let index = await this.source.read(start, storedSize);
      if (method === 1) index = await inflate(index, originalSize);
      const data = view(index);
      for (let offset = 0; offset < index.length;) {
        const end = chunkEnd(data, offset, index.length);
        const type = data.getUint32(offset, true);
        const body = offset + 12;
        offset = end;
        if (type !== 0x656c6946) continue; // File
        let info = -1, infoEnd = 0, segments = -1, segmentsEnd = 0, hash = -1, hashEnd = 0;
        for (let field = body; field < end;) {
          const fieldEnd = chunkEnd(data, field, end);
          switch (data.getUint32(field, true)) {
            case 0x6f666e69: info = field + 12; infoEnd = fieldEnd; break; // info
            case 0x6d676573: segments = field + 12; segmentsEnd = fieldEnd; break; // segm
            case 0x726c6461: hash = field + 12; hashEnd = fieldEnd; break; // adlr
          }
          field = fieldEnd;
        }
        if (info < 0 || segments < 0 || hash < 0) throw new Error('Missing XP3 file chunk');
        if (infoEnd - info < 22 || hashEnd - hash < 4 || (segmentsEnd - segments) % 28) throw new Error('Truncated XP3 file chunk');
        const nameEnd = Math.min(infoEnd, info + 22 + data.getUint16(info + 20, true) * 2);
        const name = utf16.decode(index.subarray(info + 22, nameEnd)).replaceAll('\\', '/').toLowerCase();
        const entry = { name, size: u64(data, info + 4), flags: data.getUint32(info, true), hash: data.getUint32(hash, true), segments: [] };
        for (let i = segments; i < segmentsEnd; i += 28) {
          const encoding = data.getUint32(i, true) & 7;
          if (encoding > 1) throw new Error('Unknown XP3 segment encoding');
          entry.segments.push({ encoding, start: u64(data, i + 4), size: u64(data, i + 12), storedSize: u64(data, i + 20) });
        }
        this.entries.set(name, entry);
      }
      if (!(flag & 128)) break;
      pointer = u64(view(await this.source.read(start + storedSize, 8)), 0);
    }
    // StorageIntf.cpp GetFirstIndexStartsWith searches sorted archive names.
    this.names = [...this.entries.keys()].sort();
    return this;
  }
  *namesStartingWith(prefix) {
    let low = 0, high = this.names.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (this.names[mid] < prefix) low = mid + 1;
      else high = mid;
    }
    for (let i = low; i < this.names.length && this.names[i].startsWith(prefix); i++) {
      yield this.names[i];
    }
  }
  async #decodeSegment(entry, segment, offset, filterStream) {
    let bytes = await this.source.read(segment.start, segment.storedSize);
    if (segment.encoding === 1) bytes = await inflate(bytes, segment.size);
    if (filterStream) bytes = await this.filter.apply(filterStream, entry.hash, offset, bytes);
    if (bytes.length !== segment.size) throw new Error('XP3 segment size mismatch');
    return bytes;
  }
  async #readEntry(entry, filterStream) {
    const single = entry.segments.length === 1;
    let result = single ? null : new Uint8Array(entry.size);
    let offset = 0;
    for (const segment of entry.segments) {
      const bytes = await this.#decodeSegment(entry, segment, offset, filterStream);
      if (single) result = bytes;
      else result.set(bytes, offset);
      offset += bytes.length;
    }
    if (offset !== entry.size) throw new Error('XP3 segment size mismatch');
    return result;
  }
  async read(name) {
    const stream = await this.openEntryStream(name);
    try {
      return await stream.read(0, stream.size);
    } finally {
      await stream.close();
    }
  }
  // Seekable entry stream. Plain segments use source ranges directly. A
  // complete-read content filter materializes the entry once; other decoded
  // segments use an 8 MiB LRU plus at most one oversized decoded segment.
  async openEntryStream(name) {
    const entry = this.entries.get(name.replaceAll('\\', '/').toLowerCase());
    if (!entry) throw new Error(`XP3 storage not found: ${name}`);
    const starts = [];
    let total = 0;
    for (const segment of entry.segments) { starts.push(total); total += segment.size; }
    if (total !== entry.size) throw new Error('XP3 segment size mismatch');
    const archive = this;
    const decoding = new Map(); // segment index -> in-flight decode
    const CACHE_LIMIT = 8 * 1024 * 1024;
    const cache = new LRUCache({ maxSize: CACHE_LIMIT, sizeCalculation: bytes => Math.max(1, bytes.length) });
    let oversizedSegment = null, closed = false;
    const filterSession = archive.filter ? await archive.filter.open(entry.name, archive.name, entry.size) : null;
    const filterStream = filterSession?.stream ?? null;
    const segmentAt = index => {
      if (oversizedSegment?.index === index) return Promise.resolve(oversizedSegment.bytes);
      if (oversizedSegment) oversizedSegment = null;
      const cached = cache.get(index);
      if (cached) return Promise.resolve(cached);
      let pending = decoding.get(index);
      if (pending) return pending;
      pending = archive.#decodeSegment(entry, entry.segments[index], starts[index], filterStream).then(bytes => {
        if (bytes.length > CACHE_LIMIT) {
          cache.clear();
          oversizedSegment = { index, bytes };
          return bytes;
        }
        cache.set(index, bytes);
        return bytes;
      }).finally(() => { decoding.delete(index); });
      decoding.set(index, pending);
      return pending;
    };
    if (filterSession?.mode === 1) {
      let completeBytes;
      try {
        completeBytes = await this.#readEntry(entry, filterStream);
      } finally {
        if (filterStream) await archive.filter.close(filterStream);
      }
      return {
        size: entry.size,
        name: entry.name,
        async read(offset, length) {
          if (closed) throw new Error('XP3 entry stream is closed');
          offset = Math.max(0, Math.min(offset, entry.size));
          length = Math.max(0, Math.min(length, entry.size - offset));
          return completeBytes.slice(offset, offset + length);
        },
        async close() {
          if (closed) return;
          closed = true;
          completeBytes = null;
        },
      };
    }
    return {
      size: entry.size,
      name: entry.name,
      async read(offset, length) {
        if (closed) throw new Error('XP3 entry stream is closed');
        offset = Math.max(0, Math.min(offset, entry.size));
        length = Math.max(0, Math.min(length, entry.size - offset));
        if (length === 0) return new Uint8Array(0);
        let index = 0;
        while (index + 1 < starts.length && starts[index + 1] <= offset) index++;
        const result = new Uint8Array(length);
        let written = 0, at = offset;
        while (written < length) {
          if (index >= entry.segments.length) throw new Error('XP3 segment size mismatch');
          const segment = entry.segments[index];
          const within = at - starts[index];
          const take = Math.min(length - written, segment.size - within);
          let bytes;
          if (!filterStream && segment.encoding === 0 && segment.storedSize === segment.size) {
            bytes = await archive.source.read(segment.start + within, take);
            if (bytes.length !== take) throw new Error('Truncated XP3 segment range');
          } else {
            bytes = (await segmentAt(index)).subarray(within, within + take);
          }
          result.set(bytes, written);
          written += take; at += take;
          if (within + take === segment.size) index++;
        }
        return result;
      },
      async close() {
        if (closed) return;
        closed = true;
        cache.clear();
        oversizedSegment = null;
        decoding.clear();
        if (filterStream) await archive.filter.close(filterStream);
      },
    };
  }
}

// Archive IO stays in JS. Native owns the decoder, file contexts and accessors.
export async function createXP3Filter(storage, wasmURL, message) {
  if (!await storage.exists('/xp3filter.tjs')) return;
  const vm = await new TJSInterop(wasmURL).init(Object.create(null));
  const system = createSystem({ vm, storage, enqueueEvent: callback => vm.enqueue(callback) });
  let service;
  try {
    vm.registerGlobal('Debug', createDebugClass(message));
    vm.registerGlobal('System', system.api);
    vm.attachStorage(storage);
    await vm.nativePlugins(0, 'xp3filter.dll');
    service = await vm.get(vm.global.Storages, '_xp3Filter');
    await vm.callMember(service, 'initialize');
    await vm.dispose(await vm.callMember(vm.global.Scripts, 'execStorage', undefined, ['/xp3filter.tjs']));
  } catch (error) {
    system.stop();
    try { await vm.enqueue(() => system.finalize()); }
    finally { await vm.dispose(); }
    throw error;
  }
  return {
    open(name, archiveName, size) {
      return vm.enqueue(async () => {
        const stream = await vm.callMember(service, 'open', undefined, [name, archiveName, size]);
        return { stream, mode: await vm.get(stream, 'mode') };
      });
    },
    apply(stream, hash, offset, bytes) {
      // Independent archive reads serialize only their calls into this VM.
      return vm.enqueue(() => vm.callMember(stream, 'apply', undefined, [hash, offset, bytes]));
    },
    close(stream) { return vm.enqueue(() => vm.dispose(stream)); },
    async finalize() {
      system.stop();
      try {
        await vm.enqueue(async () => {
          await system.finalize();
          await vm.dispose(service);
        });
      } finally { await vm.dispose(); }
    },
  };
}
