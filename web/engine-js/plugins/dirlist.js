// dirlist.cpp: the plugin registers a global getDirList(directory) that returns
// the entries directly below a local directory (files and subdirectories).
// Archives have no local directory entries, matching TVPGetLocalFileListAt.
export function registerDirList({ storage, registerGlobal }) {
  registerGlobal('getDirList', function getDirList(name) {
    if (!arguments.length) throw new Error('getDirList requires a directory name');
    name = String(name);
    if (!name.endsWith('/'))
      throw new Error("'/' must be specified at the end of given directory name.");
    const path = storage.getFullPath(name);
    if (path.includes('>')) throw new Error('Archive storage cannot be accessed as a local directory');
    const result = [], seen = new Set();
    for (const key of storage.files.keys()) {
      if (!key.startsWith(path)) continue;
      // Manifest keys are normalized (lowercase) while archive members have no
      // local directory entries at all, so the key is the only stable source.
      const basename = key.slice(path.length).split('/')[0];
      if (!basename) continue;
      if (seen.has(basename)) continue;
      seen.add(basename);
      result.push(basename);
    }
    return result;
  });
}
