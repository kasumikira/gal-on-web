import { TJSInterop } from './wasm-vm.js';
import { TextStreamDecoder } from './text-stream.js';

// BinaryAccessor.cpp: byte indexing and xor are relative to the movable ptr.
class BinaryAccessor {
  #bytes;
  constructor(bytes) { this.#bytes = bytes; this.ptr = 0; }
  get count() { return this.#bytes.length; }
  read(index) { return this.#bytes[this.position(index)]; }
  write(index, value) { this.#bytes[this.position(index)] = value; }
  position(index) {
    const position = this.ptr + Number(index);
    if (!Number.isInteger(position) || position < 0 || position >= this.count)
      throw new Error(`XP3 filter byte index out of range: ${position}`);
    return position;
  }
  xor(offset, length, key) {
    const start = this.ptr + Number(offset), end = start + Number(length);
    if (start < 0 || end > this.count) throw new Error('XP3 filter xor range out of bounds');
    for (let i = start; i < end; i++) this.#bytes[i] ^= key;
  }
}

// xp3filter.cpp runs the script in its own interpreter. Use TJS's existing
// missing-member dispatch for indexed bytes; no byte-sized native properties.
const bufferFactory = `class XP3Buffer {
    var data;
    function XP3Buffer(value) { data = value; Scripts.setCallMissing(this); }
    property ptr { getter() { return data.ptr; } setter(value) { data.ptr = value; } }
    property count { getter() { return data.count; } }
    function xor(offset, length, key) { data.xor(offset, length, key); }
    function missing(set, name, value) {
      if (name != (string int name)) return false;
      if (set) data.write(int name, *value);
      else *value = data.read(int name);
      return true;
    }
  }
  return XP3Buffer;`;

export async function createXP3Filter(storage, wasmURL, message) {
  if (!await storage.exists('/xp3filter.tjs')) return;
  const source = await new TextStreamDecoder().read(await storage.read('/xp3filter.tjs'));
  const vm = await new TJSInterop(wasmURL).init(Object.create(null));
  let handler, factory;
  try {
    vm.registerGlobal('Debug', { message });
    vm.registerGlobal('Storages', {
      async setXP3ArchiveExtractionFilter(value) {
        const previous = handler;
        handler = value == null ? undefined : vm.retain(value);
        await vm.dispose(previous);
      },
    });
    factory = await vm.source(bufferFactory, 'XP3Buffer');
    await vm.dispose(await vm.source(source, 'xp3filter.tjs'));
  } catch (error) {
    await vm.dispose();
    throw error;
  }
  return {
    apply(hash, offset, bytes, name) {
      // Corresponds to the reference decoder mutex; independent archive reads
      // must not interleave calls into this interpreter.
      return vm.enqueue(async () => {
        if (!handler) return;
        const buffer = await vm.call(factory, undefined, [new BinaryAccessor(bytes)], true);
        try {
          await vm.dispose(await vm.call(handler, undefined, [hash, offset, buffer, bytes.length, name, undefined]));
        } finally {
          await vm.invalidate(buffer);
          await vm.dispose(buffer);
        }
      });
    },
    async finalize() {
      await vm.enqueue(async () => {
        await vm.dispose(handler);
        await vm.dispose(factory);
      });
      await vm.dispose();
    },
  };
}
