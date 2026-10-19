// Motion::ResourceManager, ported from plugins/motionplayer/ResourceManager.cpp.
// Owns the PSB module cache keyed by the placed path, the source lookup used by
// node source resolution, and the layer-id allocator.
import { PSBFile } from './psb.js';

const basename = path => String(path).replaceAll('\\', '/').split(/[\/>]/).at(-1);

export class MotionResourceManager {
  constructor(storage, { random } = {}) {
    this.storage = storage;
    this.randomGenerator = random ?? (() => Math.random());
    this.modules = new Map();        // placed path -> { file, spec }
    this.sourceCache = new Map();    // 'moduleKey\u0000path' -> ObjSource record
    this.spec = 0;
    this.usedLayerIds = new Set([0, 1, 2]);
    this.nextLayerId = 3;
    this.bufferLayer = null;
  }
  // ResourceManager.cpp load: place the path, parse the PSB, validate id/spec/
  // version, then cache.
  async load(path) {
    const placed = await this.storage.getPlacedPath(String(path));
    if (!placed) throw new Error(`Motion::ResourceManager: file not found '${path}'.`);
    const cached = this.modules.get(placed);
    if (cached) return cached;
    const bytes = await this.storage.read(placed);
    // .pbd / .mtn may be an mdf/zlib container; the PSB parser only handles the
    // raw form, so a mismatch is a real, reported failure rather than silence.
    const file = new PSBFile(bytes);
    const root = file.root;
    const id = root.get('id');
    if (!id || id.toText() !== 'motion') throw new Error(`this psb file is not motion file: ${placed}`);
    const specNode = root.get('spec');
    const spec = specNode ? specNode.toText() : null;
    let mode = 0;
    if (spec === 'krkr') mode = 1;
    else if (spec === 'win') mode = 2;
    if (!mode) throw new Error(`motion file '${root.get('label')?.toText() ?? placed}' has not adaptive spec. export psb again.`);
    const version = root.get('version') ? root.get('version').toNumber() : 0;
    if (version > 3.0300001) throw new Error(`motion file '${root.get('label')?.toText() ?? placed}' is too new.`);
    this.spec = mode;
    const record = { file, placed, spec: mode };
    this.modules.set(placed, record);
    return record;
  }
  async unload(path) {
    const placed = await this.storage.getPlacedPath(String(path));
    this.modules.delete(placed);
  }
  async isExistStorage(path) { return (await this.storage.isExistentStorage(String(path))) !== 0; }
  async placedPath(path) { return this.storage.getPlacedPath(String(path)); }
  unloadAll() { this.modules.clear(); }
  clearCache() { this.sourceCache.clear(); }
  // ResourceManager.cpp findSource: split "src/group/icon"; "blank:w:h:ox:oy"
  // returns a placeholder descriptor.
  findSource(moduleKey, path) {
    const pieces = String(path).split('/');
    if (!pieces[0]) return null;
    if (pieces[0] !== 'src') {
      if (pieces[0] !== 'blank') return null;
      const dims = String(pieces[1] ?? '').split(':');
      return { blank: true, width: Number(dims[0]) || 0, height: Number(dims[1]) || 0, originX: Number(dims[2]) || 0, originY: Number(dims[3]) || 0 };
    }
    const record = this.modules.get(moduleKey);
    if (!record) return null;
    const groupKey = pieces[1] ?? '', iconKey = pieces[2] ?? '';
    const source = record.file.root.get('source');
    if (!source) return null;
    const group = source.get(groupKey);
    if (!group) return null;
    const icon = group.get('icon');
    if (!icon) return null;
    const entry = icon.get(iconKey);
    if (!entry) return null;
    return { blank: false, node: entry, path };
  }
  // ResourceManager.cpp findMotion(projectKey, path): path is
  // "motion/<chara>/<motion>". Tries the project-keyed module first, then every
  // loaded module. Returns [motionNode, moduleKey] or null.
  findMotion(projectKey, path) {
    const pieces = String(path).split('/');
    const chara = pieces[1] ?? '', motionName = pieces[2] ?? '';
    const direct = projectKey === undefined || projectKey === null ? null : this.modules.get(String(projectKey));
    const candidates = direct ? [direct, ...this.modules.values()] : [...this.modules.values()];
    for (const record of candidates) {
      const motion = record.file.root.get('object')?.get(chara)?.get('motion')?.get(motionName);
      if (motion) return [motion, record.placed];
    }
    return null;
  }
  // ResourceManager.cpp isExistMotion(projectKey, path).
  isExistMotion(projectKey, path) {
    const pieces = String(path).split('/');
    const chara = pieces[1] ?? '', motionName = pieces[2] ?? '';
    const direct = projectKey === undefined || projectKey === null ? null : this.modules.get(String(projectKey));
    const candidates = direct ? [direct, ...this.modules.values()] : [...this.modules.values()];
    return candidates.some(record => record.file.root.get('object')?.get(chara)?.get('motion')?.get(motionName));
  }
  hasProject(projectKey) { return this.modules.has(String(projectKey)); }
  random() { return this.randomGenerator(); }
  requireLayerId() {
    while (this.usedLayerIds.has(this.nextLayerId)) this.nextLayerId = (this.nextLayerId + 1) >>> 0;
    this.usedLayerIds.add(this.nextLayerId);
    return this.nextLayerId++;
  }
  releaseLayerId(id) {
    const value = id >>> 0;
    if (!this.usedLayerIds.has(value)) return 0;
    for (const used of [...this.usedLayerIds]) if (used >= value) this.usedLayerIds.delete(used);
    return 1;
  }
}

export { basename };
