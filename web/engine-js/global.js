// One active game per page. Host defaults belong in main.js; this module
// holds configuration only, never VM instances, shadows or ownership state.
export const config = {};

export function initializeGlobals(options) {
  const {
    entry, document, container, wasmURL, gameStorage, saveStorage,
    inform, message, arguments: args, unimplementedMode, continuousFrameRate, onTitleChange,
  } = options;
  if (typeof entry !== 'string' || !entry) throw new TypeError('entry must specify the XP3 path');
  if (typeof document?.createElement !== 'function' || !document.defaultView) throw new TypeError('document must provide a browser document');
  if (typeof container?.append !== 'function') throw new TypeError('container must be a DOM container');
  if (typeof wasmURL !== 'string' || !wasmURL) throw new TypeError('wasmURL must specify the WASM resource');
  for (const [name, callback] of Object.entries({ inform, message, onTitleChange })) {
    if (typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
  }
  if (typeof gameStorage?.list !== 'function' || typeof gameStorage?.read !== 'function') {
    throw new TypeError('gameStorage must provide list and read methods');
  }
  if (saveStorage !== null && (typeof saveStorage?.list !== 'function' ||
      typeof saveStorage?.read !== 'function' || typeof saveStorage?.write !== 'function' || typeof saveStorage?.delete !== 'function')) {
    throw new TypeError('saveStorage must be null or provide list, read, write and delete methods');
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('arguments must be an object');
  if (unimplementedMode !== 'error' && unimplementedMode !== 'log') throw new Error(`Invalid unimplementedMode: ${unimplementedMode}`);
  if (continuousFrameRate !== 60 && continuousFrameRate !== 'display') throw new Error(`Invalid continuousFrameRate: ${continuousFrameRate}`);
  Object.assign(config, options);
}
