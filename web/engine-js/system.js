import { config } from './global.js';
// System class from cpp/core/base/SystemIntf.cpp and cpp/core/base/impl/SystemImpl.cpp.
// The browser supplies the platform values in place of the native platform layer.
import { v4 as uuidv4 } from 'uuid';
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
    getKeyState() { return 0; },
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
