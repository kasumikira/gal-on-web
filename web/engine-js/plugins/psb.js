// PSB (E-mote / M2 motion) container parser, ported from
// cpp/plugins/psbfile/PSBRawFile.cpp + PSBPackedInternal.h. All integers are
// little-endian; the name block is a double-array trie and dictionaries are
// sorted key/offset packed arrays.
const u16 = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);
const u32 = (bytes, offset) => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
const i32 = (bytes, offset) => u32(bytes, offset) | 0;
const sig32 = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
const f32 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getFloat32(0, true);
const f64 = (bytes, offset) => new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getFloat64(0, true);

// PSBPackedInternal.h ReadPackedCount_guess.
function packedCount(bytes, offset) {
  switch (bytes[offset]) {
    case 0x0d: return bytes[offset + 1];
    case 0x0e: return u16(bytes, offset + 1);
    case 0x0f: return u32(bytes, offset + 1) & 0xffffff;
    case 0x10: return u32(bytes, offset + 1);
    default: return 0;
  }
}
// PSBPackedInternal.h PsbArray_guess: header tag encodes element width.
class PackedArray {
  constructor(bytes, offset) {
    this.bytes = bytes;
    const length = bytes[offset] - 0x0b;
    this.count = packedCount(bytes, offset);
    this.width = bytes[offset + length] - 0x0c;
    this.data = offset + length + 1;
    this.byteLength = this.count * this.width + length + 1;
  }
  get(index) {
    if (this.width < 1 || this.width > 5) return 0;
    const at = this.data + index * this.width;
    let value = 0;
    for (let i = this.width - 1; i >= 0; i--) value = value * 256 + this.bytes[at + i];
    return value >>> 0;
  }
  toArray() { const result = []; for (let i = 0; i < this.count; i++) result.push(this.get(i)); return result; }
}

// PSBPackedInternal.h GetTypeCategory_guess.
export function typeCategory(tag) {
  switch (tag) {
    case 0x01: case 0x23: case 0x24: case 0x25: case 0x26: case 0x3f: return 0;
    case 0x02: case 0x03: case 0x27: case 0x2f: case 0x33: case 0x37: case 0x3b: return 1;
    case 0x04: case 0x05: case 0x06: case 0x07: case 0x08: case 0x09: case 0x0a: case 0x0b: case 0x0c:
    case 0x28: case 0x29: case 0x30: case 0x31: case 0x34: case 0x35: case 0x38: case 0x39: case 0x3c: case 0x3d: return 2;
    case 0x1d: case 0x1e: case 0x1f: case 0x2e: case 0x41: return 3;
    case 0x15: case 0x16: case 0x17: case 0x18: case 0x2c: return 4;
    case 0x19: case 0x1a: case 0x1b: case 0x1c: case 0x2d: return 5;
    case 0x20: return 6;
    case 0x21: return 7;
    default: throw new Error(`psb: unknown internal type 0x${tag.toString(16)}`);
  }
}

const decoder = new TextDecoder('utf-8');
const encoder = new TextEncoder();
export class PSBFile {
  constructor(bytes) {
    this.bytes = bytes;
    if (bytes.length < 0x40) throw new Error('psb: file too small');
    if (sig32(bytes, 0) !== 0x00425350 && sig32(bytes, 0) !== 0x0066646d) throw new Error('psb: invalid signature');
    this.version = u16(bytes, 4);
    this.encrypt = u16(bytes, 6);
    this.encryptData = u32(bytes, 8);
    this.names = u32(bytes, 12);
    this.strings = u32(bytes, 16);
    this.stringsData = u32(bytes, 20);
    this.chunkOffsets = u32(bytes, 24);
    this.chunkLengths = u32(bytes, 28);
    this.chunkData = u32(bytes, 32);
    this.entries = u32(bytes, 36);
    if (bytes.length < this.encryptData || bytes.length < this.entries) throw new Error('psb: offsets outside file');
    this.nameCharset = new PackedArray(bytes, this.names);
    this.nameData = new PackedArray(bytes, this.names + this.nameCharset.byteLength);
    this.nameIndexes = new PackedArray(bytes, this.names + this.nameCharset.byteLength + this.nameData.byteLength);
    this.stringOffsets = new PackedArray(bytes, this.strings);
    this.chunkOffsetTable = new PackedArray(bytes, this.chunkOffsets);
    this.chunkLengthTable = new PackedArray(bytes, this.chunkLengths);
  }
  get root() { return new PSBNode(this, this.entries); }
  // PSBRawFile.cpp FindNameIndex_guess: walk the two packed arrays as a
  // double-array trie.
  findNameIndex(name) {
    const charset = this.nameCharset, namesData = this.nameData;
    // The native trie consumes UTF-8 bytes, not UTF-16 JavaScript code units.
    const bytes = encoder.encode(name);
    let parent = 0;
    let state = charset.get(0) + (bytes[0] ?? 0);
    if (state >= charset.count) return -1;
    for (let cursor = 0; ; ) {
      if (namesData.get(state) !== parent) return -1;
      if (cursor === bytes.length) return charset.get(state);
      cursor++;
      parent = state;
      state = charset.get(state) + (bytes[cursor] ?? 0);
      if (state >= charset.count) return -1;
    }
  }
  // PSBRawFile.cpp DecodeName_guess: follow parent links, then reverse.
  decodeName(nameIndex) {
    const charset = this.nameCharset, namesData = this.nameData;
    let node = namesData.get(this.nameIndexes.get(nameIndex));
    const chars = [];
    while (node !== 0) {
      const parent = namesData.get(node);
      chars.push(node - charset.get(parent));
      node = parent;
    }
    return decoder.decode(Uint8Array.from(chars.reverse()));
  }
  // PSBRawFile.cpp FindDictionaryValueOffset_guess: binary search the key table.
  findDictionaryValueOffset(dictionary, nameIndex) {
    const keys = new PackedArray(this.bytes, dictionary);
    let lower = 0, upper = keys.count, middle = 0;
    while (lower < upper) {
      middle = (upper + lower) >> 1;
      const candidate = keys.get(middle);
      if (candidate === nameIndex) break;
      if (candidate >= nameIndex) upper = middle; else lower = middle + 1;
    }
    if (lower >= upper) return -1;
    const offsets = new PackedArray(this.bytes, dictionary + keys.byteLength);
    return keys.byteLength + offsets.byteLength + offsets.get(middle);
  }
  getString(index) {
    const start = this.stringsData + this.stringOffsets.get(index);
    let end = start;
    while (end < this.bytes.length && this.bytes[end] !== 0) end++;
    return decoder.decode(this.bytes.subarray(start, end));
  }
  getResource(index) {
    const start = this.chunkData + this.chunkOffsetTable.get(index);
    const length = this.chunkLengthTable.get(index);
    return this.bytes.subarray(start, start + length);
  }
}

function readInteger32(bytes, offset) {
  switch (bytes[offset]) {
    case 0x05: return (bytes[offset + 1] << 24) >> 24;
    case 0x06: return (u16(bytes, offset + 1) << 16) >> 16;
    case 0x07: return u16(bytes, offset + 1) | (((bytes[offset + 3] << 24) >> 24) << 16);
    case 0x08: return i32(bytes, offset + 1);
    default: return 0;
  }
}
function readInteger64(bytes, offset) {
  const low = u32(bytes, offset + 1);
  switch (bytes[offset]) {
    case 0x09: return BigInt(low) | (BigInt((bytes[offset + 5] << 24) >> 24 >>> 0) << 32n);
    case 0x0a: return BigInt(low) | (BigInt((u16(bytes, offset + 5) << 16) >> 16 >>> 0) << 32n);
    case 0x0b: return BigInt(low) | (BigInt(u16(bytes, offset + 5)) << 32n) | (BigInt(bytes[offset + 7]) << 48n);
    case 0x0c: {
      const high = u32(bytes, offset + 5);
      return BigInt(low) | (BigInt(high) << 32n);
    }
    default: return 0n;
  }
}

// PSBRawNode: an immutable view of one packed value inside the file.
export class PSBNode {
  constructor(file, offset) { this.file = file; this.offset = offset; }
  get bytes() { return this.file.bytes; }
  get type() { return this.bytes[this.offset]; }
  get category() { return typeCategory(this.type); }
  // PSBRawFile.cpp GetInt.
  toInt() {
    switch (this.type) {
      case 0x02: return 1;
      case 0x03: return 0;
      case 0x04: case 0x05: case 0x06: case 0x07: case 0x08: return readInteger32(this.bytes, this.offset);
      case 0x09: case 0x0a: case 0x0c: return Number(BigInt.asIntN(64, readInteger64(this.bytes, this.offset)));
      case 0x0b: return i32(this.bytes, this.offset + 1);
      case 0x1d: return 0;
      case 0x1e: return Math.trunc(f32(this.bytes, this.offset + 1));
      case 0x1f: return Math.trunc(f64(this.bytes, this.offset + 1));
      default: throw new Error("psb: can't convert value to int");
    }
  }
  toNumber() {
    switch (this.type) {
      case 0x02: return 1;
      case 0x03: return 0;
      case 0x04: case 0x05: case 0x06: case 0x07: case 0x08: return readInteger32(this.bytes, this.offset);
      case 0x09: case 0x0a: case 0x0b: case 0x0c: return Number(BigInt.asIntN(64, readInteger64(this.bytes, this.offset)));
      case 0x1d: return 0;
      case 0x1e: return f32(this.bytes, this.offset + 1);
      case 0x1f: return f64(this.bytes, this.offset + 1);
      default: throw new Error("psb: can't convert value to double");
    }
  }
  toBoolean() {
    switch (this.category) {
      case 1: return this.type === 0x02;
      case 2: return this.toNumber() !== 0;
      case 3: return this.type === 0x1e ? f32(this.bytes, this.offset + 1) !== 0 : this.type === 0x1f ? f64(this.bytes, this.offset + 1) !== 0 : false;
      default: throw new Error("psb: can't convert value to bool");
    }
  }
  toValue() {
    switch (this.category) {
      case 1: return this.type === 0x02;
      case 2: return this.toNumber();
      case 3: return this.toNumber();
      case 4: return this.toText();
      case 5: return this.toResource();
      case 6: return this.toArray();
      case 7: return this.toObject();
      default: return undefined;
    }
  }
  toText() {
    if (this.category !== 4) return null;
    let index = 0;
    switch (this.type) {
      case 0x15: index = this.bytes[this.offset + 1]; break;
      case 0x16: index = u16(this.bytes, this.offset + 1); break;
      case 0x17: index = u32(this.bytes, this.offset + 1) & 0xffffff; break;
      case 0x18: index = u32(this.bytes, this.offset + 1); break;
      default: break;
    }
    return this.file.getString(index);
  }
  toResource() {
    if (this.category !== 5) return null;
    let index = 0;
    switch (this.type) {
      case 0x19: index = this.bytes[this.offset + 1]; break;
      case 0x1a: index = u16(this.bytes, this.offset + 1); break;
      case 0x1b: index = u32(this.bytes, this.offset + 1) & 0xffffff; break;
      case 0x1c: index = u32(this.bytes, this.offset + 1); break;
      default: break;
    }
    return this.file.getResource(index);
  }
  // PSBFile.cpp PropGet array path: packed offsets table after the header.
  toArray() {
    if (this.category !== 6) return null;
    const packed = this.offset + 1;
    const offsets = new PackedArray(this.bytes, packed);
    const result = [];
    for (let i = 0; i < offsets.count; i++) result.push(new PSBNode(this.file, packed + offsets.byteLength + offsets.get(i)));
    return result;
  }
  // PSBFile.cpp PropGet dictionary path.
  toObject() {
    if (this.category !== 7) return null;
    const packed = this.offset + 1;
    const keys = new PackedArray(this.bytes, packed);
    const result = {};
    for (let i = 0; i < keys.count; i++) {
      const name = this.file.decodeName(keys.get(i));
      const relative = this.file.findDictionaryValueOffset(packed, keys.get(i));
      if (relative < 0) continue;
      result[name] = new PSBNode(this.file, this.offset + 1 + relative);
    }
    return result;
  }
  toJS() {
    switch (this.category) {
      case 6: return this.toArray().map(node => node.toJS());
      case 7: { const result = {}; for (const [name, node] of Object.entries(this.toObject())) result[name] = node.toJS(); return result; }
      default: return this.toValue();
    }
  }
  get(key) {
    if (this.category !== 7) return undefined;
    const nameIndex = this.file.findNameIndex(key);
    if (nameIndex < 0) return undefined;
    const relative = this.file.findDictionaryValueOffset(this.offset + 1, nameIndex);
    if (relative < 0) return undefined;
    return new PSBNode(this.file, this.offset + 1 + relative);
  }
  has(key) {
    if (this.category !== 7) return false;
    return this.file.findNameIndex(key) >= 0 && this.file.findDictionaryValueOffset(this.offset + 1, this.file.findNameIndex(key)) >= 0;
  }
  keys() { const object = this.toObject(); return object ? Object.keys(object) : []; }
  get count() {
    if (this.category !== 6) return 0;
    return packedCount(this.bytes, this.offset + 1);
  }
}
