import { XP3Archive } from './xp3.js';
import { normalizeTextEncoding } from './text-stream.js';
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
    this.textEncoding = null;
    this.textDecoder = null;
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
    if (!prefix.endsWith('://')) throw new Error('TJS storage media prefix requires ://');
    if (typeof media?.isExistent!=='function' || typeof media?.read!=='function') throw new Error('TJS storage media requires isExistent and read');
    this.mediaTable.set(prefix,media);
  }
  findMedia(name) {
    const path = String(name).toLowerCase();
    const split = splitMediaName(path);
    if (!split) return null;
    const media = this.mediaTable.get(split.prefix);
    return media?{ ...split, media }:null;
  }
  setTextEncoding(encoding) {
    this.textEncoding = normalizeTextEncoding(encoding);
    if (this.textDecoder) this.textDecoder.encoding = this.textEncoding;
  }
  attachTextDecoder(decoder) { this.textDecoder = decoder; }
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
  getLocalName(name) {
    if (!arguments.length) throw new Error('Storages.getLocalName requires a name');
    name = String(name);
    if (!name || splitMediaName(name.replaceAll('\\', '/')))
      throw new Error(`Cannot get local name from ${name}`);
    const path = this.getFullPath(name);
    // StorageIntf.cpp TVPGetLocalName: archive entries have no local name.
    // Our local filesystem is the virtual namespace shared with fstat/saves;
    // conversion does not test existence or perform an auto-path lookup.
    if (path.includes('>')) throw new Error(`Cannot get local name from ${name}`);
    return path;
  }
  extractStorageName(name) { return String(name).replaceAll('\\','/').split(/[\/>]/).at(-1); }
  extractStoragePath(name) { const path = String(name).replaceAll('\\','/'); return path.slice(0,Math.max(path.lastIndexOf('/'),path.lastIndexOf('>'))+1); }
  extractStorageExt(name) { const base = this.extractStorageName(name); const dot = base.lastIndexOf('.'); return dot<0?'':base.slice(dot); }
  chopStorageExt(name) { return String(name).slice(0,String(name).length-this.extractStorageExt(name).length); }
  async archive(name) {
    const path = this.normalize(name);
    if (this.archives.has(path)) return this.archives.get(path);
    const file = this.files.get(path);
    if (!file) throw new Error(`Archive not found: ${path}`);
    const backend = file.saved ? this.saveStorage : this.gameStorage;
    const archive = await new XP3Archive(
      { read: (offset, length) => backend.read(file.path, offset, length) },
      this.extractionFilter?.apply,
    ).open();
    this.archives.set(path,archive); return archive;
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
    if (!/[\/>\\]$/.test(name)) throw new Error('TJS auto path requires a trailing delimiter');
    const path = this.getFullPath(name);
    if (!this.autoPaths.includes(path)) this.autoPaths.push(path);
    this.autoPathTable = undefined;
  }
  removeAutoPath(name) {
    if (!/[\/>\\]$/.test(name)) throw new Error('TJS auto path requires a trailing delimiter');
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
    const base = this.extractStorageName(path), directory = this.autoPathTable.get(base);
    return directory===undefined?'':directory+base;
  }
  async isExistentStorage(name) { return Number((await this.getPlacedPath(name))!==''); }
  async read(name) {
    const path = await this.getPlacedPath(name);
    if (!path) throw new Error(`Storage not found: ${name}`);
    const found = this.findMedia(path);
    if (found) return found.media.read(found.local);
    const sharp = path.indexOf('>');
    if (sharp>=0) return (await this.archive(path.slice(0,sharp))).read(path.slice(sharp+1));
    const file = this.files.get(path);
    return (file.saved ? this.saveStorage : this.gameStorage).read(file.path, 0, file.size);
  }
  async delete(name) {
    const path = await this.getPlacedPath(name);
    if (!path || this.findMedia(path) || path.includes('>')) return false;
    const file = this.files.get(path);
    if (!file?.saved || !this.saveStorage) return false;
    if (!await this.saveStorage.delete(file.path)) return false;
    this.files.delete(path);
    this.archives.delete(path);
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
    await this.saveStorage.write(path, bytes.slice());
    this.files.set(path, { path, size: bytes.byteLength, saved: true });
    this.archives.delete(path);
    this.autoPathTable = undefined;
    this.revision++;
  }
}
