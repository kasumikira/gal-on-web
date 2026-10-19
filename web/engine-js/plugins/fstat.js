
// Local file and directory operations from fstat/main.cpp. Archive members are not
// OS directory entries and are deliberately excluded from this interface.
export function registerFstat({ storage, registerGlobal, registerMembers }) {
  const constants = {
    FILE_ATTRIBUTE_READONLY:1,FILE_ATTRIBUTE_HIDDEN:2,FILE_ATTRIBUTE_SYSTEM:4,
    FILE_ATTRIBUTE_DIRECTORY:16,FILE_ATTRIBUTE_ARCHIVE:32,
    FILE_ATTRIBUTE_NORMAL:128,FILE_ATTRIBUTE_TEMPORARY:256,
  };
  for (const [name, value] of Object.entries(constants)) registerGlobal(name, value);
  const directory=name=>{
    const path=storage.getFullPath(name);
    if(!path.endsWith('/'))throw new Error("'/' must be specified at the end of given directory name.");
    if(path.includes('>'))throw new Error('Archive storage cannot be accessed as a local directory');
    return path;
  };
  const exists=path=>path==='/'||Array.from(storage.files.keys()).some(name=>name.startsWith(path));
  const isExistentDirectory=function(name) {
    if(!arguments.length)throw new Error('Storages.isExistentDirectory requires a name');
    return Number(exists(directory(name)));
  };
  const dirlist=function(name) {
    if(!arguments.length)throw new Error('Storages.dirlist requires a name');
    const path=directory(name);
    if(!exists(path))throw new Error('Directory not found.');
    const result=[],seen=new Set();
    for(const [key,file] of storage.files) {
      if(!key.startsWith(path))continue;
      const basename=file.path.replaceAll('\\','/').slice(path.length).split('/')[0];
      const normalized=basename.toLowerCase();
      if(basename&&!seen.has(normalized)){seen.add(normalized);result.push(basename);}
    }
    return result;
  };
  const clearStorageCaches=()=>{
    storage.archives.clear();storage.autoPathTable=undefined;
  };
  registerMembers(storage, {
    isExistentDirectory, dirlist, clearStorageCaches,
    async deleteFile(name) {
      if (!arguments.length) throw new Error('Storages.deleteFile requires a name');
      return Number(await storage.delete(name));
    },
  });
}
