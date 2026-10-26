import { defineNativeClass } from '#krkr/native';
import { XP3Archive } from './xp3.js';
const PREFETCH_MAX_BYTES = 8 * 1024 * 1024;
// StorageIntf.cpp TVPParseStorageName: a name with a "<media>://" prefix
// belongs to the media registered for that prefix; the media receives the
// normalized local name only ("domain/path", without the prefix).
function splitMediaName(name) {
  const mark = name.indexOf('://');
  return mark<=0?null:{ prefix:name.slice(0,mark+3), local:name.slice(mark+3) };
}
// StorageIntf.cpp: direct lookup first, then the basename auto-path table.
function normalizeParts(name) {
  const parts = [];
  for (const part of name.split('/')) {
    if (!part || part==='.') continue;
    if (part==='..') parts.pop(); else parts.push(part);
  }
  return parts.join('/')+(name.endsWith('/') && parts.length?'/':'');
}
export class Storages {
  constructor(gameStorage, saveStorage, currentDirectory) {
    this.files = new Map();
    this.gameStorage = gameStorage;
    this.currentDirectory = currentDirectory;
    this.saveStorage = saveStorage;
    // Graphic caches include this monotonically increasing generation.  A
    // successful host write therefore cannot leave a decoded pre-write image
    // in createGraphicLoader's cache.
    this.revision = 0;
    this.archives = new Map();
    this.autoPaths = [];
    this.autoPathTable = undefined;
    // Storage media contributed by plugins (StorageIntf.cpp
    // TVPRegisterStorageMedia), keyed by their "scheme://" prefix.
    this.mediaTable = new Map();
    // Speculative prefetch state (KAG tag lookahead hints).
    this.prefetchDone = new Set();
    this.prefetchQueue = [];
    this.prefetchActive = 0;
  }
  async initialize() {
    for (const entry of await this.gameStorage.list()) {
      this.files.set(this.normalize(entry.path), { path: entry.path, size: entry.size });
    }
    if (!this.saveStorage) return;
    for (const entry of await this.saveStorage.list()) {
      const path = this.normalize(entry.path);
      this.files.set(path, { path: entry.path, size: entry.size, saved: true });
    }
  }
  // A media resolves names below its own prefix; the searched auto paths stay
  // a host concern, exactly as iTVPStorageMedia::CheckExistentStorage sees the
  // local name after TVPParseStorageName.
  registerMedia(prefix, media) {
    prefix = String(prefix).toLowerCase();
    if (!prefix.endsWith('://')) throw new Error('Storage media prefix requires ://');
    if (typeof media?.isExistent!=='function' || typeof media?.read!=='function') throw new Error('Storage media requires isExistent and read');
    this.mediaTable.set(prefix,media);
  }
  findMedia(name) {
    const path = String(name).toLowerCase();
    const split = splitMediaName(path);
    if (!split) return null;
    const media = this.mediaTable.get(split.prefix);
    return media?{ ...split, media }:null;
  }
  normalize(name) {
    name = String(name).replaceAll('\\','/').toLowerCase();
    const found = this.findMedia(name);
    if (found) return found.prefix+normalizeParts(found.local);
    const sharp = name.indexOf('>');
    if (sharp>=0) return '/'+normalizeParts(name.slice(0,sharp))+'>'+normalizeParts(name.slice(sharp+1));
    return '/'+normalizeParts(name);
  }
  getFullPath(name) {
    const path = String(name).replaceAll('\\','/');
    // TVPParseStorageName splits the media before resolving the name, so a
    // media name never becomes relative to TJS's current directory.
    if (this.findMedia(path)) return this.normalize(path);
    return this.normalize(path.startsWith('/')?path:this.currentDirectory+path);
  }
  async archive(name) {
    const path = this.normalize(name);
    if (this.archives.has(path)) return this.archives.get(path);
    const file = this.files.get(path);
    if (!file) throw new Error(`Archive not found: ${path}`);
    const backend = file.saved ? this.saveStorage : this.gameStorage;
    const source = { read: (offset, length) => backend.read(file.path, offset, length) };
    // StorageImpl.cpp TVPOpenArchive selects by file contents, not extension.
    const header = await source.read(0, 19);
    const sevenZip = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c].every((byte, i) => header[i] === byte);
    const archive = sevenZip
      ? await (await import('./seven-zip.js')).openSevenZip(source, file.size)
      : await new XP3Archive(source, this.extractionFilter, path).open(header);
    this.archives.set(path,archive); return archive;
  }
  async closeArchive(name) {
    const path = this.normalize(name), archive = this.archives.get(path);
    if (!archive) return;
    await archive.finalize?.();
    this.archives.delete(path);
  }
  async clearArchiveCache() {
    await this.finalize();
    this.autoPathTable = undefined;
  }
  async finalize() {
    await Promise.all([...this.archives.values()].map(archive => archive.finalize?.()));
    this.archives.clear();
  }
  async exists(path) {
    const found = this.findMedia(path);
    if (found) return !!(await found.media.isExistent(found.local));
    const sharp = path.indexOf('>');
    if (sharp<0) return this.files.has(path);
    if (!this.files.has(path.slice(0,sharp))) return false;
    return (await this.archive(path.slice(0,sharp))).entries.has(path.slice(sharp+1));
  }
  addAutoPath(name) {
    if (!/[\/>\\]$/.test(name)) throw new Error('Auto path requires a trailing delimiter');
    const path = this.getFullPath(name);
    if (!this.autoPaths.includes(path)) this.autoPaths.push(path);
    this.autoPathTable = undefined;
  }
  removeAutoPath(name) {
    if (!/[\/>\\]$/.test(name)) throw new Error('Auto path requires a trailing delimiter');
    const path = this.getFullPath(name);
    this.autoPaths = this.autoPaths.filter(value=>value!==path);
    this.autoPathTable = undefined;
  }
  async rebuildAutoPaths() {
    const table = new Map();
    for (const path of this.autoPaths) {
      const sharp = path.indexOf('>');
      const prefix = sharp<0?path:path.slice(sharp+1);
      const entries = sharp<0?this.files.keys():(await this.archive(path.slice(0,sharp))).namesStartingWith(prefix);
      for (const entry of entries) {
        if (!entry.startsWith(prefix)) continue;
        const name = entry.slice(prefix.length);
        if (name && !name.includes('/')) table.set(name,path);
      }
    }
    this.autoPathTable = table;
  }
  async getPlacedPath(name) {
    const path = this.getFullPath(name);
    // A media has no auto-path search of its own: PSBMedia resolves its
    // container as an ordinary storage name and decides the path inside it.
    const found = this.findMedia(path);
    if (found) return (await found.media.isExistent(found.local))?path:'';
    if (await this.exists(path)) return path;
    if (!this.autoPathTable) await this.rebuildAutoPaths();
    const base = path.split(/[\/>]/).at(-1), directory = this.autoPathTable.get(base);
    return directory===undefined?'':directory+base;
  }
  async has(name) { return (await this.getPlacedPath(name)) !== ''; }
  async read(name) {
    // Return independently owned writable bytes. Consumers may transfer a
    // complete result buffer; backends/media must not expose cached buffers.
    const path = await this.getPlacedPath(name);
    if (!path) throw new Error(`Storage not found: ${name}`);
    return this.readPlaced(path);
  }
  async readPlaced(path) {
    const stream = await this.#openPlacedStream(path);
    try {
      return await stream.read(0, stream.size);
    } finally {
      await stream.close();
    }
  }
  // Seekable byte stream over one placed storage entry: loose files and
  // XP3-backed entries read ranges incrementally (video and other large media
  // must not load whole files); backends without a stream surface fall back to
  // one whole read wrapped as a stream.
  async openStream(name) {
    const path = await this.getPlacedPath(name);
    if (!path) throw new Error(`Storage not found: ${name}`);
    return this.#openPlacedStream(path);
  }
  async #openPlacedStream(path) {
    const found = this.findMedia(path);
    if (found) {
      if (typeof found.media.openStream === 'function') return found.media.openStream(found.local);
      return staticStream(await found.media.read(found.local));
    }
    const file = this.files.get(path);
    if (file) {
      const backend = file.saved ? this.saveStorage : this.gameStorage;
      return {
        size: file.size,
        read: (offset, length) => backend.read(file.path, offset, length),
        close: async () => {},
      };
    }
    const sharp = path.indexOf('>');
    if (sharp >= 0) {
      const archive = await this.archive(path.slice(0, sharp));
      if (archive.openEntryStream) return archive.openEntryStream(path.slice(sharp + 1));
      return staticStream(await archive.read(path.slice(sharp + 1)));
    }
    throw new Error(`Storage not found: ${path}`);
  }
  // Speculative warm-up from KAG tag lookahead: resolve the name and pull the
  // bytes into the bounded range cache before the conductor asks for them.
  // Best-effort by contract — misses are normal and nothing here may throw
  // or block the caller.
  prefetch(name) {
    const key = String(name);
    if (this.prefetchDone.has(key)) return;
    if (this.prefetchDone.size >= 512) this.prefetchDone.clear();
    this.prefetchDone.add(key);
    this.prefetchQueue.push(key);
    this.pumpPrefetch();
  }
  pumpPrefetch() {
    while (this.prefetchActive < 3 && this.prefetchQueue.length > 0) {
      const name = this.prefetchQueue.shift();
      this.prefetchActive++;
      this.getPlacedPath(name)
        .then(async path => {
          if (!path || this.findMedia(path)) return;
          const sharp = path.indexOf('>');
          let size;
          if (sharp >= 0) {
            const archive = await this.archive(path.slice(0, sharp));
            size = archive.entries.get(path.slice(sharp + 1))?.size;
          } else {
            size = this.files.get(path)?.size;
          }
          if (size <= PREFETCH_MAX_BYTES) return this.readPlaced(path);
        })
        .catch(() => {})
        .finally(() => { this.prefetchActive--; this.pumpPrefetch(); });
    }
  }
  listDirectory(path) {
    if (path.includes('>') || this.findMedia(path)) throw new Error('Local directory required');
    const entries = new Map();
    for (const [key, file] of this.files) {
      if (!key.startsWith(path)) continue;
      const name = key.slice(path.length).split('/')[0];
      if (!name || entries.has(name)) continue;
      const depth = path.split('/').filter(Boolean).length;
      const displayName = file.path.replaceAll('\\', '/').split('/').filter(Boolean)[depth];
      entries.set(name, { name, displayName, directory: key.slice(path.length).includes('/') });
    }
    return { exists: path === '/' || entries.size > 0, entries: [...entries.values()] };
  }
  stat(path) {
    if (path.includes('>') || this.findMedia(path)) throw new Error('Local path required');
    const file = this.files.get(path);
    if (file) return { directory: false, size: file.size, writable: !!file.saved, displayName: file.path.replaceAll('\\', '/').split('/').at(-1) };
    const directory = path.endsWith('/') ? path : path + '/';
    if (!this.listDirectory(directory).exists) return null;
    const parent = directory.slice(0, -1).lastIndexOf('/');
    const name = directory.slice(parent + 1, -1);
    const entry = this.listDirectory(directory.slice(0, parent + 1)).entries.find(entry => entry.name === name);
    return { directory: true, displayName: entry?.displayName ?? '' };
  }
  async delete(name) {
    const path = await this.getPlacedPath(name);
    return path ? this.deletePlaced(path) : false;
  }
  async deletePlaced(path) {
    if (this.findMedia(path) || path.includes('>')) return false;
    const file = this.files.get(path);
    if (!file?.saved || !this.saveStorage) return false;
    await this.closeArchive(path);
    if (!await this.saveStorage.delete(file.path)) return false;
    this.files.delete(path);
    this.autoPathTable = undefined;
    this.revision++;
    return true;
  }
  async write(name, bytes) {
    bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const path = this.getFullPath(name);
    // Archives and plugin media are read-only. Ordinary files require an
    // explicit save backend; the bundled HTTP manifest cannot persist writes.
    if (!this.saveStorage || this.findMedia(path) || path.includes('>')) {
      throw new Error(`Storage is read-only: ${name}`);
    }
    await this.closeArchive(path);
    await this.saveStorage.write(path, bytes.slice());
    this.files.set(path, { path, size: bytes.byteLength, saved: true });
    this.autoPathTable = undefined;
    this.revision++;
  }
}


function staticStream(bytes) {
  return { size: bytes.length, read: async (offset, length) => bytes.slice(offset, offset + length), close: async () => {} };
}

export function createTJS2Storage(storage) {
  const methods = {
    read: path => storage.readPlaced(String(path)),
    write: (path, bytes) => storage.write(String(path), bytes),
    listDirectory: path => storage.listDirectory(String(path)),
    stat: path => storage.stat(String(path)),
    exists: path => storage.exists(String(path)),
    deleteFile: path => storage.deletePlaced(String(path)),
  };
  const klass = defineNativeClass('TJS2Storage', { initialize() { throw new Error('TJS2Storage cannot be instantiated'); } });
  for (const [name, method] of Object.entries(methods)) klass.defineMember(name, method, { static: true });
  return { klass, ...methods };
}
