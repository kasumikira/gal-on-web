import { Archive } from 'libarchive.js';
import ArchiveWorker from 'libarchive.js/src/webworker/browser-worker.js?worker';
import { LRUCache } from 'lru-cache';

const SEVEN_ZIP_CACHE_BYTES = 64 * 1024 * 1024;
const SEVEN_ZIP_CACHE_ENTRIES = 4096;

Archive.init({ getWorker: () => new ArchiveWorker() });

// Kirikiroid2's 7zArchive.cpp normalizes names just like XP3 entries. The
// extraction filter belongs to XP3 and must not run on 7z contents.
export async function openSevenZip(source, size) {
  const bytes = await source.read(0, size);
  const archive = await Archive.open(new File([bytes], 'archive.7z'));
  const entries = new Map();
  let opened = false;
  try {
    // Listing only builds the path index. CompressedFile.extract() delegates
    // to extractSingleFile() when that particular path is read.
    for (const { path, file } of await archive.getFilesArray()) {
      const name = (path + file.name).replaceAll('\\', '/').toLowerCase();
      entries.set(name, file);
    }
    const names = [...entries.keys()].sort();
    const cache = new LRUCache({
      max: SEVEN_ZIP_CACHE_ENTRIES,
      maxSize: SEVEN_ZIP_CACHE_BYTES,
      sizeCalculation: value => value.byteLength,
    });
    let operation = Promise.resolve();
    let closed = false;
    const serialize = task => {
      const result = operation.then(task);
      operation = result.catch(() => {});
      return result;
    };
    opened = true;
    return {
      entries,
      *namesStartingWith(prefix) {
        let low = 0, high = names.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (names[middle] < prefix) low = middle + 1;
          else high = middle;
        }
        for (let i = low; i < names.length && names[i].startsWith(prefix); i++) yield names[i];
      },
      read(name) {
        const key = name.replaceAll('\\', '/').toLowerCase();
        return serialize(async () => {
          if (closed) throw new Error('7z storage is closed');
          const file = entries.get(key);
          if (!file) throw new Error(`7z storage not found: ${name}`);
          let data = cache.get(key);
          if (data === undefined) {
            const extracted = await file.extract();
            data = new Uint8Array(await extracted.arrayBuffer());
            if (data.byteLength > 0 && data.byteLength <= SEVEN_ZIP_CACHE_BYTES) cache.set(key, data);
          }
          // Preserve the former read contract: each caller receives writable,
          // independently owned bytes rather than the cache's backing buffer.
          return data.slice();
        });
      },
      finalize() {
        return serialize(async () => {
          if (closed) return;
          closed = true;
          cache.clear();
          await archive.close();
        });
      },
    };
  } finally {
    if (!opened) await archive.close();
  }
}
