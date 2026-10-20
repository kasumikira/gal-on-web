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
  constructor(source, filter) { this.source = source; this.filter = filter; this.entries = new Map(); }
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
  async read(name) {
    const entry = this.entries.get(name.replaceAll('\\', '/').toLowerCase());
    if (!entry) throw new Error(`XP3 storage not found: ${name}`);
    const single = entry.segments.length === 1;
    let result = single ? null : new Uint8Array(entry.size);
    let offset = 0;
    for (const segment of entry.segments) {
      let bytes = await this.source.read(segment.start, segment.storedSize);
      if (segment.encoding === 1) bytes = await inflate(bytes, segment.size);
      if (this.filter) await this.filter(entry.hash, offset, bytes, entry.name);
      if (single) result = bytes;
      else result.set(bytes, offset);
      offset += bytes.length;
    }
    if (offset !== entry.size) throw new Error('XP3 segment size mismatch');
    return result;
  }
}
