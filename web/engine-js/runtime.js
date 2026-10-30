import { config, initializeGlobals } from './global.js';
import { initializeCodecs } from './codecs/wasm.js';
import { TJSInterop } from './wasm-vm.js';
import { Storages } from './storage.js';
import { createXP3Filter } from './xp3.js';
import { createWindowClass, createBasicDrawDeviceClass, attachNativeCompositor } from './window.js';
import { createWaveSoundBufferClass } from './sound.js';
import { createVideoOverlayClass } from './video.js';
import { Plugins } from './plugins.js';
import { initializeConstants } from './constants.js';
import { createDebugClass } from './debug.js';
import { createSystem } from './system.js';
import { createTimerScheduler } from './timer.js';
import { defineNativeClass, installNativeStubs, unimplemented, retainScriptValue, disposeScriptValue } from '#krkr/native';
import { nativeGlobals } from '#krkr/native-api';

export async function createRuntime(options) {
  await initializeCodecs();
  initializeGlobals(options);
  const { entry, gameStorage, saveStorage, wasmURL, document, canvas, inform, message } = config;
  const storage = new Storages(gameStorage, saveStorage, entry + '>');
  await storage.initialize();
  // Native FreeType uses the same shared storage interface for packaged font
  // assets and game files. No native filesystem or archive state is added.
  const defaultFontURL = new URL('../assets/fonts/default.ttf', import.meta.url);
  storage.registerMedia('engine-resource://', {
    isExistent: path => path === 'fonts/default.ttf',
    async read(path) {
      if (path !== 'fonts/default.ttf') throw new Error(`Engine resource does not exist: ${path}`);
      const response = await fetch(defaultFontURL);
      if (!response.ok) throw new Error(`Unable to load default font: HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  });
  if (!await storage.exists(storage.normalize(entry))) {
    await storage.finalize();
    throw new Error(`Game entry not found: ${entry}`);
  }
  storage.addAutoPath('/');
  storage.extractionFilter = await createXP3Filter(storage, wasmURL, message);
  const global = Object.create(null);
  let vm;
  try {
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: false, depth: false,
      stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: true,
      powerPreference: 'high-performance' });
    if (!gl) throw new Error('Unable to create WebGL2 context');
    vm = await new TJSInterop(wasmURL).init(global, { canvas, gl });
  } catch (error) {
    await storage.finalize();
    await storage.extractionFilter?.finalize();
    throw error;
  }
  const register = (name, value) => {
    if (value && ["object", "function"].includes(typeof value)) installNativeStubs(value, name);
    return vm.registerGlobal(name, value);
  };
  for (const [name, value] of Object.entries(initializeConstants())) register(name, value);
  let plugins;
  plugins = new Plugins({
    nativePlugins: (operation, name) => vm.nativePlugins(operation, name),
    presentAlphaMovieFrame: (target, frame, left, top) => vm.visualMovieFrame(target, frame, left, top),
    global,
    storage,
    registerGlobal: register,
    registerMembers: (target, members, options) => vm.registerMembers(target, members, options),
    callScript: (object, name, args = [], { receiver = object, ignoreMissing = false } = {}) =>
      vm.callMember(object, name, receiver, args, ignoreMissing),
    readScript: async (object, name, { ignoreProperty = false, optional = false } = {}) => {
      try { return await vm.get(object, name, ignoreProperty); }
      catch (error) {
        if (optional && error.message === `TJS member not found: ${name}`) return undefined;
        throw error;
      }
    },
    // PackinOne-style loaders link their sub-plugins through the registry.
    link: name => plugins.link(name),
    get(name) {
      const value = global[name];
      if (value === undefined) throw new Error(`Plugin service is not available: ${name}`);
      return value;
    },
  });
  register('Plugins', plugins);
  register('BasicDrawDevice', createBasicDrawDeviceClass());
  register('Window', createWindowClass(global.BasicDrawDevice));
  vm.attachStorage(storage);
  // SysInitImpl.cpp sets the graphic cache ceiling from physical memory
  // (physmem / 10, at most 512MB).  navigator.deviceMemory is the browser's
  // coarse equivalent; the native side clamps the value and keeps its own
  // platform default when the host does not provide one.
  vm.setGraphicCacheSystemLimit?.(
    Math.floor((Number(document.defaultView?.navigator?.deviceMemory) || 1) *
      1024 * 1024 * 1024 / 10));
  await vm.initializeVisual();
  const Layer = global.Layer;
  // The event queue is created before the compositor so browser input events
  // enter the same serial dispatcher as Timer, AsyncTrigger and continuous
  // callbacks (EventIntf.cpp TVPPostEvent).
  let releaseEvents;
  let acceptingEvents = true;
  let pendingEvents = 0;
  let eventQueue = new Promise(resolve => { releaseEvents = resolve; });
  const enqueueEvent = (callback, cleanup) => {
    pendingEvents++;
    const delivery = eventQueue.then(async () => {
      try {
        if (!acceptingEvents) return;
        await system.maintain();
        return await callback();
      }
      finally {
        await cleanup?.();
        if (acceptingEvents) await system.maintain();
      }
    })
      .finally(() => { pendingEvents--; });
    // The caller reports failures; later events must still be dispatched.
    eventQueue = delivery.catch(() => {});
    return delivery;
  };
  // Wasm linear memory never returns freed pages to the OS, so the boot-time
  // peak stays resident; compacting after startup and while the page is hidden
  // frees dead TJS objects for reuse before later growth.
  let lastCompact = 0;
  const compactNativeHeap = () => enqueueEvent(() => vm.compact(10));
  const onVisibilityChange = () => {
    if (!document.hidden || disposePromise || Date.now() - lastCompact < 30000) return;
    lastCompact = Date.now();
    compactNativeHeap().catch(inform);
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
  const compositor = await attachNativeCompositor(global.Window, vm, document, { canvas, enqueueEvent, reportError: inform });
  // Window instance hooks: update/resize/add repaint the compositor; input
  // events go through the compositor's dispatcher.
  const originalWindowInit = global.Window.initialize;
  global.Window.initialize = async function(owner, vm) {
    const state = await originalWindowInit.call(this, owner, vm);
    state.onUpdate = () => compositor.requestPaint(state);
    state.onSizeChanged = () => {
      compositor.requestPaint(state);
      // WindowFormUnit.cpp posts a resize input event before OnResize
      // dispatches the script callback; keep it in the serial event queue.
      const owner = retainScriptValue(state.owner);
      enqueueEvent(() => owner.invalid ? undefined : state.onResize(), () => disposeScriptValue(owner)).catch(inform);
    };
    await compositor.wire(state);
    return state;
  };
  const timerScheduler = await createTimerScheduler({
    vm, enqueueEvent, isIdle: () => pendingEvents === 1, reportError: inform,
    laxTimer: config.arguments['-laxtimer'] === 'yes',
  });
  let audioContext;
  const getAudioContext = () => audioContext ??= new document.defaultView.AudioContext();
  register('WaveSoundBuffer', createWaveSoundBufferClass(storage, getAudioContext, { enqueueEvent }));
  // PhaseVocoder is a global native class in the reference, in addition to the
  // linked WaveSoundBuffer.PhaseVocoder member.
  if (global.WaveSoundBuffer?.PhaseVocoder) register('PhaseVocoder', global.WaveSoundBuffer.PhaseVocoder);
  // VideoOverlay decodes with libav/WebCodecs and renders through layer1/layer2
  // (KRMovieLayer's vomLayer path).
  register('VideoOverlay', createVideoOverlayClass({
    Window: global.Window, storage, getAudioContext, enqueueEvent,
    presentLayerFrame: (target, frame) => vm.visualMovieFrame(target, frame, 0, 0, true),
  }));
  register('Debug', Object.assign(createDebugClass((important,value)=>message(important?`! ${value}`:value)),{
    // The JS plugin registry does not search native debug DLL directories.
    dllSearchForDebug:0,
  }));
  const system = await createSystem({vm,storage});
  for (const name of nativeGlobals) {
    if (!global[name]) register(name, defineNativeClass(name, { initialize: unimplemented(`${name}: 原生类尚未实现`) }));
  }
  const diagnostics = () => {
    if (disposePromise) throw new Error('Runtime is disposed');
    return { pendingEvents, rendering: compositor.diagnostics(), conductors: vm.kagParsers(),
      memory: { wasm: { capacityBytes: vm.module.HEAPU8.byteLength,
        allocatedBytes: vm.module._tjs_memory_allocated_bytes(),
        allocatorFreeBytes: vm.module._tjs_memory_free_bytes() } } };
  };
  let startPromise, disposePromise;
  const start = () => {
    if (disposePromise) throw new Error('Runtime is disposed');
    if (startPromise) return startPromise;
    startPromise = (async () => {
      try {
        // TVPExecuteStartupScript: external patch, startup, then external after-patch.
        for (const path of ['/patch.tjs', 'startup.tjs', '/AfterStartup.tjs']) {
          if (path !== 'startup.tjs' && !await storage.exists(storage.normalize(path))) continue;
          const result = await vm.source(`Scripts.execStorage(${JSON.stringify(path)});`, path);
          await disposeScriptValue(result);
        }
        // Startup compiled every script; compact once the boot peak has
        // passed. The queue opens in the finally below, so this runs after
        // startup-script events have drained.
        lastCompact = Date.now();
        compactNativeHeap().catch(inform);
        await system.startMaintenance();
      } catch (error) {
        acceptingEvents = false;
        throw error;
      } finally {
        releaseEvents();
      }
    })();
    return startPromise;
  };
  // stop cancels browser work synchronously; finalize may enter the VM and
  // therefore runs serially after startup and event delivery have drained.
  const resources = [timerScheduler, system, global.VideoOverlay, compositor, global.WaveSoundBuffer];
  const dispose = () => {
    if (disposePromise) return disposePromise;
    acceptingEvents = false;
    releaseEvents();
    for (const resource of resources) resource.stop();
    disposePromise = (async () => {
      if (startPromise) {
        try { await startPromise; } catch { /* Preserve the start rejection for its caller while still cleaning up. */ }
      }
      await eventQueue;
      // Storage callbacks are awaited by startup and event delivery, so their
      // writes have also completed before native finalization begins.
      try {
        for (const resource of resources) await resource.finalize?.();
        await vm.dispose();
      } finally {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        await storage.finalize();
        await storage.extractionFilter?.finalize();
        compositor.releaseDevice();
        if (audioContext) {
          await audioContext.close();
          audioContext = null;
        }
      }
    })();
    return disposePromise;
  };
  return { start, dispose, diagnostics };
}
