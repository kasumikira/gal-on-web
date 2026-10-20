import { config } from './global.js';
// System class from cpp/core/base/SystemIntf.cpp and cpp/core/base/impl/SystemImpl.cpp.
// The browser supplies the platform values in place of the native platform layer.
import { v4 as uuidv4 } from 'uuid';
import { readScript, disposeScriptValue } from '#krkr/native';
import { TextStreamDecoder } from './text-stream.js';
import { queryKeyState } from './key-state.js';
const FRAME_INTERVAL_60_MS = 1000 / 60;
const FRAME_TIME_EPSILON_MS = 1e-6;

export function createSystem({ vm, enqueueEvent, storage }) {
  let title = 'kirikiriz';
  const { document, inform, arguments: args, continuousFrameRate, onTitleChange } = config;
  const view = document.defaultView;
  const screen = () => ({ width: view.innerWidth, height: view.innerHeight });
  const mutable = (initial, convert = value => value) => {
    let current = initial;
    return { get: () => current, set: value => { current = convert(value); } };
  };
  const eventDisabled = mutable(0, Number);
  const graphicCacheLimit = mutable(0, Number);
  const exitOnWindowClose = mutable(1, Number);
  const drawThreadNum = mutable(1, Number);
  const exitOnNoWindowStartup = mutable(1, Number);
  const messages = new Map();
  const registeredFonts = new Map();
  let handlers = [], framePending = false, active = true, frameId = null, inFlight = null;
  let lastFrameTimestamp = null, frameTimeRemainder = 0;
  // AffineSourceMotion enters this RAF-backed handler loop through
  // mainwindow.onFlipTimerInterval. Only gate callback delivery; scripts still
  // receive the current tick at dispatch, as in TVPDeliverContinuousEvent.
  const dispatchFrame = timestamp => {
    if (continuousFrameRate !== 60) return true;
    if (lastFrameTimestamp === null) {
      lastFrameTimestamp = timestamp;
      return true;
    }
    frameTimeRemainder += timestamp - lastFrameTimestamp;
    lastFrameTimestamp = timestamp;
    const frames = Math.floor((frameTimeRemainder + FRAME_TIME_EPSILON_MS) / FRAME_INTERVAL_60_MS);
    if (!frames) return false;
    frameTimeRemainder = Math.max(0, frameTimeRemainder - frames * FRAME_INTERVAL_60_MS);
    return true;
  };
  const equal = (a, b) => vm.sameReference(a, b);
  const schedule = () => {
    if (!active || framePending || !handlers.some(Boolean)) return;
    framePending = true;
    frameId = view.requestAnimationFrame(timestamp => {
      frameId = null;
      if (!active) { framePending = false; return; }
      if (!dispatchFrame(timestamp)) {
        framePending = false;
        schedule();
        return;
      }
      const work = enqueueEvent(async () => {
        if (!active || eventDisabled.get()) return;
        const tick = Math.trunc(performance.now());
        for (let i = 0; i < handlers.length; i++) {
          if (!active) break;
          const handler = handlers[i];
          if (!handler) continue;
          try { await vm.call(handler, null, [tick]); }
          catch (error) { handlers[i] = null; await vm.dispose(handler); throw error; }
        }
        handlers = handlers.filter(Boolean);
      });
      inFlight = work;
      work.catch(error => console.error(error)).finally(() => {
        if (inFlight === work) inFlight = null;
        if (!handlers.some(Boolean)) {
          lastFrameTimestamp = null;
          frameTimeRemainder = 0;
        }
        framePending = false;
        schedule();
      });
    });
  };
  // SystemImpl.cpp InitRegisterData / TVPReadRegValue: the registry is emulated
  // by RegisterData.tjs in the app data path (executed as an expression). Keys
  // split on '\' or '/' and walk nested dictionaries; a missing file or key
  // yields void, which is the browser's answer for "value not present".
  let registerData, registerDataLoaded = false;
  const readRegisterData = async () => {
    if (registerDataLoaded) return;
    const name = storage.normalize('/RegisterData.tjs');
    if (!await storage.exists(name)) {
      registerDataLoaded = true;
      return;
    }
    const decoder = new TextStreamDecoder();
    registerData = await vm.source(
      await decoder.read(await storage.read(name)), 'RegisterData.tjs', 0, undefined, true);
    registerDataLoaded = true;
  };
  const walkRegisterData = async path => {
    const parts = String(path).split(/[\\/]+/).filter(Boolean);
    if (!parts.length) return undefined;
    await readRegisterData();
    let node = registerData, owned = false;
    for (const part of parts) {
      if (node === null || node === undefined || typeof node !== 'object') {
        if (owned) await disposeScriptValue(node);
        return undefined;
      }
      const next = await readScript(node, part, { ignoreProperty: true, optional: true });
      if (owned) await disposeScriptValue(node);
      node = next;
      owned = true;
      if (node === undefined) return undefined;
    }
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') return node;
    if (owned) await disposeScriptValue(node);
    return undefined;
  };
  const api = {
    addContinuousHandler(handler) {
      if (!active) throw new Error('System is disposed');
      if (!arguments.length) throw new Error('System.addContinuousHandler requires a handler');
      if (!handlers.some(value => value && equal(value, handler))) handlers.push(vm.retain(handler));
      schedule();
    },
    async removeContinuousHandler(handler) {
      if (!arguments.length) throw new Error('System.removeContinuousHandler requires a handler');
      const index = handlers.findIndex(value => value && equal(value, handler));
      if (index >= 0) {
        const held = handlers[index];
        handlers[index] = null;
        await vm.dispose(held);
        if (!handlers.some(Boolean)) {
          lastFrameTimestamp = null;
          frameTimeRemainder = 0;
        }
      }
    },
    // TVPGetVersionString builds the version from the runtime version numbers.
    versionString: '2.32.2.426',
    versionInformation: 'Kirikiri2 Runtime Core version 2.32.2.426',
    platformName: 'Web',
    osName: 'Web',
    // Match the 32-bit Kirikiri game ABI used by plugin path selection.
    // Plugin behavior is supplied by JS, not by loading these native DLLs.
    exeBits: 32,
    osBits: 64,
    exePath: '/',
    personalPath: '/',
    appDataPath: '/',
    dataPath: '/',
    savedGamesPath: '/savedata/',
    exeName: 'galweb',
    get title() { return title; },
    // SystemImpl.cpp: the setter stores TVPAppTitle and calls Application->SetTitle.
    set title(value) { title = String(value); onTitleChange(title); },
    get screenWidth() { return screen().width; },
    get screenHeight() { return screen().height; },
    get desktopLeft() { return 0; },
    get desktopTop() { return 0; },
    get desktopWidth() { return screen().width; },
    get desktopHeight() { return screen().height; },
    get processorNum() { return navigator.hardwareConcurrency ?? 1; },
    touchDevice: 0,
    get eventDisabled() { return eventDisabled.get(); },
    set eventDisabled(value) { eventDisabled.set(value); },
    get graphicCacheLimit() { return graphicCacheLimit.get(); },
    set graphicCacheLimit(value) { graphicCacheLimit.set(value); },
    get exitOnWindowClose() { return exitOnWindowClose.get(); },
    set exitOnWindowClose(value) { exitOnWindowClose.set(value); },
    get drawThreadNum() { return drawThreadNum.get(); },
    set drawThreadNum(value) { drawThreadNum.set(value); },
    get exitOnNoWindowStartup() { return exitOnNoWindowStartup.get(); },
    set exitOnNoWindowStartup(value) { exitOnNoWindowStartup.set(value); },
    inform,
    getTickCount: () => Math.trunc(performance.now()),
    getArgument(...values) {
      if (!values.length) throw new Error('System.getArgument requires a name');
      return args[String(values[0])];
    },
    setArgument(...values) {
      if (values.length < 2) throw new Error('System.setArgument requires a name and value');
      args[String(values[0])] = String(values[1]);
    },
    // SystemImpl.cpp 785: one path argument; without RegisterData.tjs every
    // lookup is void.
    readRegValue(...values) {
      if (!values.length) throw new Error('System.readRegValue requires a path');
      return walkRegisterData(String(values[0]));
    },
    // SystemImpl.cpp createAppLock: single-process lock. The browser tab is
    // inherently single-instance per origin, so the lock always succeeds.
    createAppLock(...values) {
      if (!values.length) throw new Error('System.createAppLock requires a name');
      return 1;
    },
    createUUID() {
      return uuidv4();
    },
    async addFont(...values) {
      if (!values.length) throw new Error('System.addFont requires a font file name');
      if (!storage?.read || typeof view.FontFace !== 'function' || !document?.fonts?.add) return 0;
      const name = String(values[0]);
      const path = await storage.getPlacedPath(name);
      if (!path) return 0;
      if (registeredFonts.has(path)) return registeredFonts.get(path).count;
      const bytes = await storage.read(path);
      const family = `galweb-font-${registeredFonts.size}`;
      const face = new view.FontFace(family, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      try {
        await face.load();
      } catch (error) {
        throw new Error(`System.addFont failed to load ${name}: ${error.message}`);
      }
      document.fonts.add(face);
      const result = { count: 1, family };
      registeredFonts.set(path, result);
      return result.count;
    },
    assignMessage(...values) {
      if (values.length < 2) throw new Error('System.assignMessage requires a code and a message');
      messages.set(Number(values[0]),String(values[1]));
    },
    // SystemImpl.cpp 726: (code, getcurrent = true). The browser side keeps the
    // state in key-state.js, fed by the compositor's key/pointer handlers.
    getKeyState(...values) {
      if (!values.length) throw new Error('System.getKeyState requires a key code');
      return queryKeyState(Math.trunc(Number(values[0])), values.length < 2 ? true : !!values[1]);
    },
    toActualColor(value) { return Math.trunc(Number(value)); },
    clearGraphicCache() {},
    touchImages() { return {}; },
    doCompact() {},
    dumpHeap() {},
    nullpo() {},
    showVersion() {},
    terminate() {},
    exit() {},
  };
  const stop = () => {
    if (!active) return;
    active = false;
    if (frameId !== null) view.cancelAnimationFrame(frameId);
    frameId = null;
    framePending = false;
  };
  return {
    api,
    stop,
    async finalize() {
      if (inFlight) await inFlight;
      const held = handlers.filter(Boolean);
      handlers = [];
      for (const handler of held) await vm.dispose(handler);
    },
  };
}
