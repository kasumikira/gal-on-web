import { config, initializeGlobals } from './global.js';
import { initializeCodecs } from './codecs/wasm.js';
import { initializeGPU } from './gpu.js';
import { TJSInterop } from './wasm-vm.js';
import { Closure } from '#krkr/values';
import { Storages } from './storage.js';
import { createXP3Filter } from './xp3-filter.js';
import { createWindowClass, createBasicDrawDeviceClass } from './window.js';
import { createLayerClass } from './layer.js';
import { createFontClass, TEXT_BLEND } from './font.js';
import { createBitmapClass } from './bitmap-native.js';
import { attachCompositor } from './layer-composite.js';
import { createGraphicLoader } from './graphic.js';
import { createWaveSoundBufferClass } from './sound.js';
import { createVideoOverlayClass } from './video.js';
import { Plugins } from './plugins.js';
import { initializeConstants } from './constants.js';
import { createDebugClass } from './debug.js';
import { createSystem } from './system.js';
import { createTimerClass, createAsyncTriggerClass } from './timer.js';
import { nativeOwner, defineNativeClass, installNativeStubs, unimplemented, retainScriptValue, disposeScriptValue } from '#krkr/native';
import { nativeGlobals } from '#krkr/native-api';

export async function createRuntime(options) {
  await initializeCodecs();
  initializeGlobals(options);
  const { entry, gameStorage, saveStorage, wasmURL, document, inform, message } = config;
  const storage = new Storages(gameStorage, saveStorage, entry + '>');
  await storage.initialize();
  if (!await storage.exists(storage.normalize(entry))) {
    await storage.finalize();
    throw new Error(`Game entry not found: ${entry}`);
  }
  storage.addAutoPath('/');
  storage.extractionFilter = await createXP3Filter(storage, wasmURL, message);
  const gpu = initializeGPU(document, TEXT_BLEND);
  const global = Object.create(null);
  let vm;
  try {
    vm = await new TJSInterop(wasmURL).init(global);
  } catch (error) {
    await storage.finalize();
    await storage.extractionFilter?.finalize();
    gpu.finalize();
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
  const paintAll = () => compositor.requestPaintAll();
  // TVPFindGraphicLoadHandler (GraphicsLoaderIntf.cpp 1583): extension-less
  // graphic names try each registered graphic extension until a storage
  // exists, and _m/_p sibling lookups follow the same rule.
  const graphicExtensions = ['.tlg', '.png', '.jpg', '.jpeg', '.bmp', '.webp'];
  const resolveGraphicName = async name => {
    if (await storage.isExistentStorage(name)) return name;
    if (!/[.][A-Za-z0-9]+$/.test(name)) {
      for (const ext of graphicExtensions) {
        if (await storage.isExistentStorage(name + ext)) return name + ext;
      }
    }
    return name;
  };
  const graphicCache = createGraphicLoader(storage);
  const loadGraphic = graphicCache.load;
  const loadLayerGraphic = async (name, key, opts) => loadGraphic(await resolveGraphicName(name), key, opts);
  register('Bitmap', createBitmapClass({ storage, loadGraphic: loadLayerGraphic }));
  const Layer = createLayerClass(document, {
    Window: global.Window,
    Bitmap: global.Bitmap,
    storage,
    enqueueEvent: (callback, cleanup) => enqueueEvent(callback, cleanup),
    onLayerChange: paintAll,
    loadGraphic: loadLayerGraphic,
  });
  register('Layer', Layer);
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
      try { return acceptingEvents ? await callback() : undefined; }
      finally { await cleanup?.(); }
    })
      .finally(() => { pendingEvents--; });
    // The caller reports failures; later events must still be dispatched.
    eventQueue = delivery.catch(() => {});
    return delivery;
  };
  const compositor = attachCompositor(global.Window, Layer, document, { enqueueEvent });
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
    state.onLayerAdded = () => compositor.requestPaint(state);
    compositor.wire(state);
    return state;
  };
  register('Font', createFontClass(document, { storage, Rect: global.Rect }));
  Layer.attachFontClass(global.Font, Layer);
  const invokeAction = (owner, name, args, actionName, shouldDispatch) => {
    owner = retainScriptValue(owner);
    return enqueueEvent(async () => {
      if (owner.invalid) return;
      if (shouldDispatch && !shouldDispatch()) return;
      const key = actionName || name;
      const handler = await vm.get(owner, key, true);
      try {
        if (handler) {
          const result = await vm.call(handler, owner, args);
          await disposeScriptValue(result);
        }
      } finally { await disposeScriptValue(handler); }
      return undefined;
    }, () => disposeScriptValue(owner));
  };
  register('Timer', createTimerClass({ invokeAction }));
  register('AsyncTrigger', createAsyncTriggerClass({ invokeAction }));
  let audioContext;
  const getAudioContext = () => audioContext ??= new document.defaultView.AudioContext();
  register('WaveSoundBuffer', createWaveSoundBufferClass(storage, getAudioContext, { enqueueEvent }));
  // PhaseVocoder is a global native class in the reference, in addition to the
  // linked WaveSoundBuffer.PhaseVocoder member.
  if (global.WaveSoundBuffer?.PhaseVocoder) register('PhaseVocoder', global.WaveSoundBuffer.PhaseVocoder);
  // VideoOverlay decodes with libav/WebCodecs and renders through layer1/layer2
  // (KRMovieLayer's vomLayer path).
  register('VideoOverlay', createVideoOverlayClass({
    Window: global.Window, Layer, storage,
    getAudioContext, enqueueEvent,
  }));
  register('Storages', storage);
  vm.attachStorage(storage);
  register('Debug', Object.assign(createDebugClass((important,value)=>message(important?`! ${value}`:value)),{
    // The JS plugin registry does not search native debug DLL directories.
    dllSearchForDebug:0,
  }));
  const system = createSystem({vm,enqueueEvent,storage,graphicCache});
  register('System', system.api);
  for (const name of nativeGlobals) {
    if (!global[name]) register(name, defineNativeClass(name, { initialize: unimplemented(`${name}: 原生类尚未实现`) }));
  }
  const diagnostics = () => {
      if (disposePromise) throw new Error('Runtime is disposed');
      let layers = 0, pixelBytes = 0;
      const images = new Set(), nodes = new Set();
      const visit = node => {
        if (!node || node.invalid || nativeOwner(node.owner).invalid || nodes.has(node)) return;
        nodes.add(node);
        layers++;
        for (const image of [node.image, node.province]) if (image && !images.has(image)) {
          images.add(image);
          // Count CPU storage without forcing a GPU readback.
          pixelBytes += image._pixels?.byteLength ?? 0;
        }
        for (const child of node.children) visit(child);
      };
      for (const window of global.Window.instances.values()) {
        visit(window.primaryLayer);
      }
      for (const state of Layer.instances.values()) visit(state.node);
      const conductors = vm.kagParsers();
      const imageInfo = image => ({
        width: image?.width,
        height: image?.height,
        // GPU-only alpha remains unknown rather than forcing a readback.
        alpha: image ? (image.cpuValid ? image.pixels.some((value, index) => index % 4 === 3 && value > 0) : null) : undefined,
      });
      const graphics = [];
      for (const node of nodes) {
        if (!node.visible || !nativeOwner(node.owner).classNames.has('EnvGraphicLayer')) continue;
        let ancestor = node;
        while (ancestor?.visible) ancestor = ancestor.parent;
        if (ancestor) continue;
        const owner = nativeOwner(node.owner);
        const image = owner.members.get('_image');
        const source = image instanceof Closure ? image.object : image;
        const raw = source?.members.get('_image');
        const rawOwner = raw instanceof Closure ? raw.object : raw;
        const rawNode = Layer.instances.get(rawOwner)?.node;
        const srcLayer = source?.members.get('_srclayer');
        const srcOwner = srcLayer instanceof Closure ? srcLayer.object : srcLayer;
        const srcNode = Layer.instances.get(srcOwner)?.node;
        graphics.push({
          classes: [...(source?.classNames ?? [])],
          fields: Object.fromEntries([...(source?.members ?? [])].filter(([, value]) =>
            value == null || ['number', 'string'].includes(typeof value))),
          raw: rawNode ? imageInfo(rawNode.image) : null,
          dest: imageInfo(node.image),
          src: srcNode ? imageInfo(srcNode.image) : null,
        });
      }
      return { pendingEvents, layers, pixelBytes, rendering: compositor.diagnostics(), conductors, graphics };
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
  const resources = [global.Timer, system, global.VideoOverlay, Layer, compositor, global.WaveSoundBuffer];
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
        await storage.finalize();
        await storage.extractionFilter?.finalize();
        // Drop decoded images (and their resident GPU textures) before the
        // device tears itself down.
        graphicCache.clear();
        gpu.finalize();
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
