import { PSBFile, PSBNode } from './psb.js';

// psbfile.dll's PSBMedia (PSBMedia.cpp): the "psb://<container>/<path>"
// storage media.  The container is a separate storage name that the ordinary
// auto paths still search, and the components after its first slash walk the
// PSB dictionaries; the resource the last key points at is the content.
export function registerPSBMedia(storage) {
  // PSBMedia::EnsureContainer keeps a single container file in memory and
  // re-reads it whenever the container name changes.
  let cached = null;
  const container = async local => {
    const slash = local.indexOf('/');
    const placed = await storage.getPlacedPath(slash<0?local:local.slice(0,slash));
    if (!placed) return null;
    if (cached && cached.placed===placed && cached.revision===storage.revision) return cached.file;
    const file = new PSBFile(await storage.read(placed));
    cached = { placed, revision:storage.revision, file };
    return file;
  };
  // PSBMedia.cpp Container + PSBMedia::Resolve: the container name is taken
  // up to the first '/', and every remaining component must be a dictionary
  // key.  A name without a slash has no path and never exists.
  const resolve = async local => {
    const slash = local.indexOf('/');
    if (slash<0) return null;
    const file = await container(local);
    if (!file) return null;
    let node = file.root;
    for (const key of local.slice(slash+1).split('/')) {
      const nameIndex = file.findNameIndex(key);
      if (nameIndex<0) return null;
      const relative = node.category===7?file.findDictionaryValueOffset(node.offset+1,nameIndex):-1;
      if (relative<0) return null;
      node = new PSBNode(file,node.offset+1+relative);
    }
    return node;
  };
  storage.registerMedia('psb://', {
    async isExistent(local) { return (await resolve(local))!==null; },
    async read(local) {
      const node = await resolve(local);
      if (!node) throw new Error(`Storage not found: psb://${local}`);
      // Resources are copied out so the cached container stays immutable for
      // the caller and a decode cannot pin the whole PSB file alive.
      const bytes = node.toResource();
      if (bytes===null) throw new Error(`PSB storage entry is not a resource: psb://${local}`);
      return bytes.slice();
    },
  });
}
