import { createRuntime } from './engine-js/runtime.js';
import wasmURL from './engine-js/tjs-runtime/tjs-runtime.wasm?url';

const status = document.getElementById('status');
const GAME_RANGE_CACHE_MAX_BYTES = 24 * 1024 * 1024;
let runtime;
let sampler;

try {
  const params = new URLSearchParams(location.search);
  const manifest = params.get('manifest') ?? '/api/game';
  const response = await fetch(manifest);
  if (!response.ok) throw new Error(`游戏清单读取失败：${response.status}`);
  const game = await response.json();
  document.title = game.title;
  runtime = await createRuntime({
    gameStorage: createHTTPGameStorage(game.files),
    // Save storage: the dev server keeps saves in SQLite (tests/savedata.sqlite);
    // ?save=memory keeps the session-only backend for comparison.
    saveStorage: params.get('save') === 'memory' ? createMemoryStorage() : createHTTPSaveStorage(),
    entry: game.entry,
    arguments: {},
    document,
    canvas: document.createElement('canvas'),
    wasmURL,
    container: document.body,
    inform(value) {
      const text = String(value?.message ?? value);
      if ((params.get('inform') ?? 'alert') === 'console') console.log('[inform]', text);
      else document.defaultView.alert(text);
    },
    message(value) { console.log(value); },
    unimplementedMode: params.get('unimplemented') ?? 'log',
    continuousFrameRate: params.get('continuousFrameRate') === '60' ? 60 : params.get('continuousFrameRate') ?? 'display',
    onTitleChange(title) { document.title = title; },
  });
  if (params.get('diagnostics') === '1') {
    const started = performance.now();
    let samples = 0;
    sampler = setInterval(() => {
      console.log('[runtime diagnostics]', JSON.stringify({
        elapsedMs: Math.round(performance.now() - started),
        starting: status.isConnected,
        heapBytes: performance.memory?.usedJSHeapSize,
        ...runtime.diagnostics(),
      }));
      if (++samples === 12) clearInterval(sampler);
    }, 5000);
  }
  window.addEventListener('pagehide', () => {
    clearInterval(sampler);
    runtime.dispose().catch(error => console.error('Runtime disposal failed', error));
  }, { once: true });
  await runtime.start();
  status.remove();
} catch (error) {
  clearInterval(sampler);
  if (runtime) {
    try { await runtime.dispose(); }
    catch (disposeError) { console.error('Runtime disposal failed', disposeError); }
  }
  status.textContent = `游戏启动失败：${error.stack ?? error.message}`;
  console.error(error);
}

// Backends return owned Uint8Array ranges; paths retain the spelling from list().
function createHTTPGameStorage(entries) {
  const files = new Map(entries.map(file => [file.path, file]));
  const cache = createRangeCache(GAME_RANGE_CACHE_MAX_BYTES);
  const versions = new Map();
  async function version(file) {
    const url = new URL(file.url ?? file.URL, location.href).href;
    if (!versions.has(url)) versions.set(url, (async () => {
      const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
      if (!response.ok) throw new Error(`Game resource HEAD failed: ${response.status} ${url}`);
      const revision = response.headers.get('ETag') ?? response.headers.get('Last-Modified');
      if (!revision) throw new Error(`Game resource has no cache validator: ${url}`);
      return [url, file.size, revision];
    })());
    return versions.get(url);
  }
  return {
    async list() { return entries.map(({ path, size }) => ({ path, size })); },
    async read(path, offset, length) {
      if (!length) return new Uint8Array();
      const file = files.get(path);
      // Oversized reads bypass the cache without evicting all smaller entries.
      const key = length <= cache.maxBytes ? JSON.stringify([await version(file), offset, length]) : undefined;
      if (key !== undefined) {
        const cached = await cache.get(key);
        if (cached !== undefined) return cached;
      }
      const end = offset + length - 1;
      const response = await fetch(file.url ?? file.URL, { headers: { Range: `bytes=${offset}-${end}` } });
      if (response.status !== 206 || response.headers.get('Content-Range') !== `bytes ${offset}-${end}/${file.size}`)
        throw new Error(`Invalid range response: ${path} at ${offset}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== length) throw new Error('Truncated range response');
      if (key !== undefined) await cache.put(key, bytes);
      return bytes;
    },
  };
}

// Keep ranges only for this page session, evicting least recently used data at the byte limit.
function createRangeCache(maxBytes) {
  const data = new Map();
  let cachedBytes = 0;
  return {
    maxBytes,
    get(key) {
      const bytes = data.get(key);
      if (bytes === undefined) return undefined;
      data.delete(key);
      data.set(key, bytes);
      return bytes.slice();
    },
    put(key, bytes) {
      if (bytes.byteLength > maxBytes) return;
      const previous = data.get(key);
      if (previous !== undefined) {
        cachedBytes -= previous.byteLength;
        data.delete(key);
      }
      const copy = bytes.slice();
      data.set(key, copy);
      cachedBytes += copy.byteLength;
      while (cachedBytes > maxBytes) {
        const [oldestKey, oldestBytes] = data.entries().next().value;
        data.delete(oldestKey);
        cachedBytes -= oldestBytes.byteLength;
      }
    },
  };
}

// Save backend served by the Go dev server: each save file is one SQLite row,
// read with the same Range contract as game resources.
function createHTTPSaveStorage(base = '/api/saves') {
  const url = path => `${base}/${String(path).split('/').filter(Boolean).map(encodeURIComponent).join('/')}`;
  return {
    async list() {
      const response = await fetch(base);
      if (!response.ok) throw new Error(`Save list failed: ${response.status} ${await response.text()}`);
      return response.json();
    },
    async read(path, offset, length) {
      if (!length) return new Uint8Array();
      const end = offset + length - 1;
      const response = await fetch(url(path), { headers: { Range: `bytes=${offset}-${end}` } });
      if (response.status !== 206 || !(response.headers.get('Content-Range') ?? '').startsWith(`bytes ${offset}-${end}/`))
        throw new Error(`Invalid save range response: ${path} at ${offset}+${length}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== length) throw new Error(`Truncated save range response: ${path}`);
      return bytes;
    },
    async delete(path) {
      const response = await fetch(url(path), { method: 'DELETE' });
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`Save delete failed (${path}): ${response.status} ${await response.text()}`);
      return true;
    },
    async write(path, bytes) {
      const response = await fetch(url(path), { method: 'PUT', body: bytes });
      if (!response.ok) throw new Error(`Save write failed (${path}): ${response.status} ${await response.text()}`);
      return response.json();
    },
  };
}

// Temporary session-only backend for debugging. A reload discards the saves.
function createMemoryStorage() {
  const files = new Map();
  return {
    async list() {
      return [...files].map(([path, bytes]) => ({ path, size: bytes.byteLength }));
    },
    async read(path, offset, length) {
      const bytes = files.get(path);
      if (!bytes) throw new Error(`Save file not found: ${path}`);
      return bytes.slice(offset, offset + length);
    },
    async write(path, bytes) { files.set(path, bytes.slice()); },
    async delete(path) { return files.delete(path); },
  };
}
