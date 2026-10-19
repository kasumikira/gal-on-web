import { config } from './global.js';
// Layer tree compositor: draws the primary layer tree into the window canvas
// and routes browser input through the engine's event protocol.
// The native engine routes this through tTVPDrawDevice/tTVPLayerManager
// (LayerManager.cpp); this module composites node images with 2D alpha and
// reproduces the LayerManager hit-test/capture/event order.
import { number } from '#krkr/values';
import { callScript, script, retainScriptValue, disposeScriptValue } from '#krkr/native';
import { Image } from './bitmap.js';
import { getGPU } from './gpu.js';

// LayerManager.cpp GetMostFrontChildAt: visible check, rect test in the
// parent's coordinates, then children from the front (Children is stored
// back-to-front, so the last element is the most front) before the node
// itself. Returns {node} on a hit, {blocked:true} when the hit node is
// disabled or under a modal layer (native sets *lay = nullptr and returns
// true), or null when nothing is hit.
async function hitTest(node, x, y, offX, offY, test = () => true, state, except = null, getDisabled = false) {
  if (!node.visible) return null;
  const lx = x - offX - node.left, ly = y - offY - node.top;
  if (lx < 0 || ly < 0 || lx >= node.width || ly >= node.height) return null;
  for (let i = node.children.length - 1; i >= 0; i--) {
    const hit = await hitTest(node.children[i], lx, ly, 0, 0, test, state, except, getDisabled);
    if (hit) return hit;
  }
  if (node === except || !hitTestPixel(node, lx, ly)) return null;
  if (!await test(node, lx, ly)) return null;
  // LayerIntf.cpp GetMostFrontChildAt: disabled or modal-suppressed nodes
  // still consume the hit but yield no target.
  return getDisabled || hitTestEnabled(node, state) ? { node } : { blocked: true };
}

// LayerIntf.cpp GetMostFrontChildAt (the public getLayerAt form) uses primary
// coordinates and shares the same z-order, pixel, modal, and onHitTest path
// as browser input.
export async function findLayerAt(root, x, y, {
  state,
  test = () => true,
  except = null,
  getDisabled = false,
} = {}) {
  const hit = await hitTest(root, x, y, 0, 0, test, state, except, getDisabled);
  return hit?.node ?? null;
}

// HitTestNoVisibleCheck via HitType/HitThreshold: the alpha plane of the main
// image (or the province plane) decides, in image coordinates.
function hitTestPixel(node, lx, ly) {
  const image = node.hitType === 1 ? node.province : node.image;
  if (!image || !image.width || !image.height) return node.hitType === 0 && node.hitThreshold <= 0;
  // The image is placed at (imageLeft, imageTop) relative to the layer rect.
  const ix = lx - node.imageLeft, iy = ly - node.imageTop;
  if (ix < 0 || iy < 0 || ix >= image.width || iy >= image.height) return false;
  if (image.gray) return image.pixels[image.index(ix, iy)] !== 0;
  if (node.hitType === 0 && node.hitThreshold <= 0) return true;
  return (image.point(ix, iy) >>> 24) >= node.hitThreshold;
}

function hitTestEnabled(node, state) {
  const modal = state?.modalLayers?.at(-1);
  if (modal) {
    const isModalTree = (() => {
      for (let walk = node; walk; walk = walk.parent) if (walk === modal) return true;
      return false;
    })();
    if (!isModalTree) return false;
  }
  for (let walk = node; walk; walk = walk.parent) if (!walk.enabled) return false;
  return true;
}

export function attachCompositor(Window, Layer, document, { enqueueEvent }) {
  const { inform: report } = config;
  const view = document.defaultView;
  const stats = { requests: 0, paints: 0, uploadedBytes: 0, paintMs: 0, textureBytes: 0 };
  const pendingPaint = new Set();
  const listeners = [];
  let paintAllPending = false;
  let paintFrameScheduled = false;
  let paintFrameId = null, disposed = false;
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    listeners.push(() => target.removeEventListener(type, handler, options));
  };
  function schedulePaint() {
    if (disposed || paintFrameScheduled) return;
    paintFrameScheduled = true;
    paintFrameId = view.requestAnimationFrame(() => {
      paintFrameId = null;
      paintFrameScheduled = false;
      if (disposed) return;
      if (paintAllPending) {
        paintAllPending = false;
        pendingPaint.clear();
        for (const state of Window.instances.values()) paint(state);
        return;
      }
      const states = [...pendingPaint];
      pendingPaint.clear();
      for (const state of states) paint(state);
    });
  }
  function requestPaint(state) {
    stats.requests++;
    pendingPaint.add(state);
    schedulePaint();
  }
  function requestPaintAll() {
    stats.requests++;
    paintAllPending = true;
    schedulePaint();
  }
  const frames = new WeakMap();
  function drawImage(gpu, target, node, offsetX, offsetY, parentOpacity, parentClip) {
    if (!node || node.width <= 0 || node.height <= 0 || node.opacity <= 0) return;
    const x = offsetX + node.left, y = offsetY + node.top;
    const clip = { left: Math.max(parentClip.left, x), top: Math.max(parentClip.top, y),
      right: Math.min(parentClip.right, x + node.width), bottom: Math.min(parentClip.bottom, y + node.height) };
    if (clip.left >= clip.right || clip.top >= clip.bottom) return;
    const opacity = parentOpacity * node.opacity / 255;
    const transition = node.transition, image = transition?.frame ?? node.image;
    if (image?.width && image.height) {
      gpu.draw(target, image, {
        matrix: [1, 0, 0, 1, x + (transition?.withchildren ? 0 : node.imageLeft), y + (transition?.withchildren ? 0 : node.imageTop)],
        clip, opacity, opaque: node.type === 1, mode: 0, motion: true,
      });
    }
    if (!transition?.withchildren) for (const child of node.children) {
      if (child.visible) drawImage(gpu, target, child, x, y, opacity, clip);
    }
  }
  function paint(state, force = false) {
    if (!state.canvas) return;
    if (state.pendingPaint) return;
    // Layers flagged for onPaint must have their script handler run before the
    // pixels are composited (LayerIntf.cpp BeforeCompletion). The handler
    // normally calls update() again to request the next frame, so the flag is
    // consumed here and the composite still runs in the same pass; otherwise
    // the always-pending flags would defer painting forever.
    const dirty = [];
    if (!force) {
      const collect = node => {
        if (!node || !node.visible) return;
        if (node.callOnPaint) dirty.push(node);
        for (const child of node.children) collect(child);
      };
      if (state.primaryLayer) collect(Layer.peekNode(state.primaryLayer.owner));
    }
    const selfUpdating = [];
    if (!force) {
      const collectSelfUpdating = node => {
        if (!node || !node.visible) return;
        if (node.transition?.selfupdate) selfUpdating.push(node);
        for (const child of node.children) collectSelfUpdating(child);
      };
      if (state.primaryLayer) collectSelfUpdating(Layer.peekNode(state.primaryLayer.owner));
    }
    if (dirty.length || selfUpdating.length) {
      // The scene may invalidate these layers before the queued pass runs.
      // Keep queryable TJS references until the pass completes or is cancelled.
      const pending = [...new Set([...dirty, ...selfUpdating])].map(node =>
        ({ node, owner: retainScriptValue(node.owner) }));
      state.pendingPaint = true;
      enqueueEvent(async () => {
        for (const { node, owner } of pending) {
          if (owner.invalid || !dirty.includes(node) || !node.callOnPaint) continue;
          node.callOnPaint = false;
          await script(owner).onPaint();
        }
        // LayerIntf.cpp advances self-updating transitions during the
        // completion pass. Do one advancement per paint request; the
        // transition hook is responsible for requesting its next frame.
        if (Layer.advanceTransition) {
          for (const { node, owner } of pending) {
            if (!owner.invalid && selfUpdating.includes(node) && node.transition?.selfupdate) await Layer.advanceTransition(owner);
          }
        }
      }, async () => {
        for (const { owner } of pending) await disposeScriptValue(owner);
      }).then(() => {
        state.pendingPaint = false;
        paint(state, true);
      }).catch(error => {
        state.pendingPaint = false;
        report(error);
      });
      return;
    }
    if (state.canvas.width !== state.width) state.canvas.width = Math.max(0, state.width);
    if (state.canvas.height !== state.height) state.canvas.height = Math.max(0, state.height);
    const gpu = getGPU();
    if (!gpu) throw new Error('Compositing requires an initialized GPU renderer');
    const started = performance.now();
    let frame = frames.get(state);
    if (!frame || frame.width !== state.width || frame.height !== state.height) {
      frame = new Image(state.width, state.height, { defer: true });
      frames.set(state, frame);
    }
    if (!frame.width || !frame.height) return;
    const clip = { left: 0, top: 0, right: frame.width, bottom: frame.height };
    gpu.fill(frame, clip, [0, 0, 0, 0]);
    if (state.primaryLayer) drawImage(gpu, frame, Layer.peekNode(state.primaryLayer.owner), 0, 0, 255, clip);
    gpu.present(frame, state.canvas);
    const rendering = gpu.diagnostics();
    stats.textureBytes = rendering.textureBytes;
    stats.uploadedBytes = rendering.uploadedBytes;
    stats.paints++;
    stats.paintMs += performance.now() - started;
  }

  // Sends one event to the action owner's member. A missing member means the
  // layer simply has no handler; every other failure is reported rather than
  // swallowed.
  function deliver(owner, name, args) {
    if (!owner) return Promise.resolve();
    return callScript(owner, name, args, { receiver: owner, ignoreMissing: true });
  }
  // Every input event enters the VM's serial queue (EventIntf.cpp posts
  // immediate events to the same dispatcher as Timer/AsyncTrigger), so a
  // browser event cannot re-enter an in-flight script.
  function invoke(owner, name, args) {
    owner = retainScriptValue(owner);
    const start = () => owner.invalid ? undefined : deliver(owner, name, args);
    const queued = enqueueEvent(start, () => disposeScriptValue(owner));
    return queued.then(value => {
      if (value instanceof Error) reportEventFailure(name, value);
      return value;
    }, error => { reportEventFailure(name, error); });
  }
  function reportEventFailure(name, error) {
    const message = `input event ${name} failed: ${error?.message ?? error}`;
    report(message);
  }

  // LayerManager.cpp capture state: PrimaryMouseDown records the layer that
  // received the down event and later move/up/click go to it until
  // ReleaseCapture (LayerManager.cpp 670).
  const capture = { node: null, hover: null };
  function releaseCapture() { capture.node = null; }

  // FromPrimaryCoordinates: translate a point in the primary layer's
  // coordinates into the target node's own coordinates.
  function toNodeCoords(node, x, y) {
    let walk = node;
    while (walk.parent) { x -= walk.left; y -= walk.top; walk = walk.parent; }
    return [x, y];
  }
  const eventArgs = (node, name, args) => {
    if (name === 'onMouseWheel') return [...args.slice(0, 2), ...toNodeCoords(node, args[2], args[3])];
    if (['onMouseDown','onMouseUp','onClick','onDoubleClick','onMouseMove'].includes(name)) return [...toNodeCoords(node, args[0], args[1]), ...args.slice(2)];
    return args;
  };
  const fire = (node, name, args) => invoke(node.owner, name, eventArgs(node, name, args));

  async function mostFront(state, x, y) {
    const node = state.primaryLayer && Layer.peekNode(state.primaryLayer.owner);
    if (!node) return null;
    const hit = await hitTest(node, x, y, 0, 0, async (target, lx, ly) => {
      target.hitTestWork = true;
      await deliver(target.owner, 'onHitTest', [lx, ly, 1]);
      return target.hitTestWork;
    }, state);
    return hit && hit.node ? hit.node : null;
  }

  function wire(state) {
    // WM_DEVICECHANGE / DBT_DEVNODES_CHANGED lets gamepad.dll users rescan
    // when the browser first exposes a controller after a physical button press.
    const deviceChange = () => {
      if (state.allMessageHooks || state.messageHooks.has(0x219))
        invoke(state.owner, 'onWindowsMessageHook', [0x219, 7, 0]);
    };
    listen(view, 'gamepadconnected', deviceChange);
    listen(view, 'gamepaddisconnected', deviceChange);
    listen(view, 'focus', () => invoke(state.owner, 'onActivate', []));
    listen(view, 'blur', () => invoke(state.owner, 'onDeactivate', []));
    state.releaseMouseCapture = () => {
      if (capture.node?.window === state) {
        releaseCapture();
        state.captureLayer = null;
      }
    };
    state.touchCaptures ??= new Map();
    state.touchCaptureReleaseMark = -1;
    state.releaseTouchCapture = (id, all = false) => {
      if (all) {
        state.touchCaptures.clear();
        state.touchCaptureReleaseMark = -1;
      }
      else {
        id = Number(id) >>> 0;
        state.touchCaptures.delete(id);
        if (state.touchCaptureReleaseMark === id) state.touchCaptureReleaseMark = -1;
      }
    };
    const shiftOf = e => (e.shiftKey ? 1 : 0) | (e.altKey ? 2 : 0) | (e.ctrlKey ? 4 : 0);
    const coords = e => {
      const rect = state.canvas.getBoundingClientRect();
      return [
        Math.round((e.clientX - rect.left) * state.canvas.width / rect.width),
        Math.round((e.clientY - rect.top) * state.canvas.height / rect.height),
      ];
    };

    const pointerEvent = (type, handler) => listen(state.canvas, type, e => {
      if (type === 'wheel') e.preventDefault();
      const action = () => handler(e);
      const result = enqueueEvent(action);
      result.catch(error => reportEventFailure(type, error));
    }, type === 'wheel' ? { passive: false } : undefined);
    const send = (node, name, args) => deliver(node.owner, name, eventArgs(node, name, args));
    const updateHint = target => {
      state.hoverLayer = target ?? null;
      if (!target || target.ignoreHintSensing) {
        state.setHint?.(null, '');
        return;
      }
      let hintNode = target;
      while (hintNode.showParentHint !== false && hintNode.parent) hintNode = hintNode.parent;
      state.setHint?.(target.owner, hintNode.hint ?? '');
    };
    const updateHover = async target => {
      if (target !== capture.hover) {
        if (capture.hover) await deliver(capture.hover.owner, 'onMouseLeave', []);
        capture.hover = target;
        if (target) await deliver(target.owner, 'onMouseEnter', []);
      }
      updateHint(target);
    };
    state.releaseCaptureFromTree = root => {
      const inside = node => {
        for (; node; node = node.parent) if (node === root) return true;
        return false;
      };
      if (inside(capture.node)) state.releaseMouseCapture();
      for (const [id, node] of state.touchCaptures) {
        if (inside(node)) state.releaseTouchCapture(id);
      }
    };
    state.leaveMouseFromTree = async (root, shuttingDown = null) => {
      const hovered = capture.hover;
      if (!hovered) return;
      let inside = false;
      for (let walk = hovered; walk; walk = walk.parent) {
        if (walk === root) { inside = true; break; }
      }
      if (!inside) return;
      // LayerManager::LeaveMouseFromTree clears its saved layer before firing
      // onMouseLeave, so reentrant input cannot deliver another leave.
      capture.hover = null;
      if (state.hoverLayer === hovered) state.hoverLayer = null;
      if (hovered !== shuttingDown) await deliver(hovered.owner, 'onMouseLeave', []);
      state.setHint?.(null, '');
    };
    const touchPoints = new Map();
    let touchStart = null;
    const touchContact = e => [Number(e.width ?? 0), Number(e.height ?? 0)];
    const touchGeometry = () => {
      if (touchPoints.size < 2) return null;
      const [a, b] = [...touchPoints.values()];
      const dx = b.x - a.x, dy = b.y - a.y;
      return {
        distance: Math.hypot(dx, dy),
        angle: Math.atan2(dy, dx),
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
      };
    };
    const touchArgs = (node, name, x, y, cx, cy, id) =>
      eventArgs(node, name, [x, y, cx, cy, id]);
    const touchDown = async e => {
      const [x, y] = coords(e), id = Number(e.pointerId) >>> 0;
      const target = await mostFront(state, x, y);
      touchPoints.set(id, { x, y });
      if (!target) return;
      state.touchCaptures.delete(id);
      state.touchCaptureReleaseMark = id;
      const [cx, cy] = touchContact(e);
      await deliver(target.owner, 'onTouchDown', touchArgs(target, 'onTouchDown', x, y, cx, cy, id));
      if (state.touchCaptureReleaseMark === id) state.touchCaptures.set(id, target);
      if (touchPoints.size === 2) touchStart = touchGeometry();
    };
    const touchMove = async e => {
      const [x, y] = coords(e), id = Number(e.pointerId) >>> 0;
      const point = touchPoints.get(id);
      if (point) { point.x = x; point.y = y; } else touchPoints.set(id, { x, y });
      const target = state.touchCaptures.get(id) ?? await mostFront(state, x, y);
      if (target) {
        const [cx, cy] = touchContact(e);
        await deliver(target.owner, 'onTouchMove', touchArgs(target, 'onTouchMove', x, y, cx, cy, id));
      }
      const geometry = touchGeometry();
      if (geometry && touchStart && state.focusedLayer) {
        const focused = state.focusedLayer;
        await deliver(focused.owner, 'onTouchScaling', [touchStart.distance, geometry.distance, geometry.x, geometry.y, 0]);
        await deliver(focused.owner, 'onTouchRotate', [touchStart.angle, geometry.angle, geometry.distance, geometry.x, geometry.y, 0]);
        await deliver(focused.owner, 'onMultiTouch', []);
      }
    };
    const touchUp = async e => {
      const [x, y] = coords(e), id = Number(e.pointerId) >>> 0;
      const target = state.touchCaptures.get(id) ?? await mostFront(state, x, y);
      if (target) {
        const [cx, cy] = touchContact(e);
        await deliver(target.owner, 'onTouchUp', touchArgs(target, 'onTouchUp', x, y, cx, cy, id));
      }
      state.releaseTouchCapture(id);
      touchPoints.delete(id);
      if (touchPoints.size < 2) touchStart = null;
    };
    // Pointer events replace the browser's compatibility mouse events here;
    // the primary touch must also drive ordinary mouse-based game buttons.
    pointerEvent('pointerdown', async e => {
      if (e.pointerType === 'touch') {
        await touchDown(e);
        if (!e.isPrimary) return;
      }
      const [x, y] = coords(e);
      const target = await mostFront(state, x, y);
      if (!target) { releaseCapture(); state.captureLayer = null; await updateHover(null); return; }
      await updateHover(target);
      capture.node = target;
      state.captureLayer = target;
      state.setHint?.(null, '');
      await send(target, 'onMouseDown', [x, y, e.button, shiftOf(e)]);
    });
    pointerEvent('pointerup', async e => {
      if (e.pointerType === 'touch') {
        await touchUp(e);
        if (!e.isPrimary) return;
      }
      const [x, y] = coords(e);
      const target = capture.node ?? await mostFront(state, x, y);
      if (!target) return;
      await send(target, 'onMouseUp', [x, y, e.button, shiftOf(e)]);
      // PrimaryClick delivers only to the layer that received the down.
      if (e.button === 0 && capture.node === target) await send(target, 'onClick', [x, y]);
      // PrimaryMouseUp releases capture once no button remains pressed, then
      // rechecks the layer under the cursor.
      if (!(e.buttons & 0xff)) {
        releaseCapture();
        state.captureLayer = null;
        const again = await mostFront(state, x, y);
        await updateHover(again);
        if (again) await send(again, 'onMouseMove', [x, y, shiftOf(e)]);
      }
    });
    pointerEvent('pointermove', async e => {
      if (e.pointerType === 'touch') {
        await touchMove(e);
        if (!e.isPrimary) return;
      }
      const [x, y] = coords(e);
      const target = capture.node ?? await mostFront(state, x, y);
      await updateHover(target);
      if (target) await send(target, 'onMouseMove', [x, y, shiftOf(e)]);
    });
    pointerEvent('pointercancel', async e => {
      if (e.pointerType === 'touch') {
        await touchUp(e);
        if (e.isPrimary) {
          const target = capture.node;
          releaseCapture();
          state.captureLayer = null;
          if (target) {
            const [x, y] = coords(e);
            await send(target, 'onMouseUp', [x, y, 0, shiftOf(e)]);
          }
        }
      }
    });
    pointerEvent('pointerleave', async () => {
      if (capture.hover) { await deliver(capture.hover.owner, 'onMouseLeave', []); capture.hover = null; }
      updateHint(null);
    });
    pointerEvent('dblclick', async e => {
      const [x, y] = coords(e);
      const target = capture.node ?? await mostFront(state, x, y);
      if (target) await send(target, 'onDoubleClick', [x, y]);
    });
    pointerEvent('wheel', async e => {
      const [x, y] = coords(e);
      const target = capture.node ?? await mostFront(state, x, y);
      // LayerIntf.cpp onMouseWheel: (shift, delta, x, y).
      if (target) await send(target, 'onMouseWheel', [shiftOf(e), e.deltaY, x, y]);
    });

    // LayerManager.cpp PrimaryKeyDown/PrimaryKeyUp/PrimaryKeyPress: the focused
    // layer receives the event, otherwise the primary layer's default handler
    // runs; the Window object also carries onKeyDown/onKeyUp/onKeyPress.
    const keyCode = e => ({ Enter: 13, Escape: 27, Space: 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Backspace: 8, Tab: 9 }[e.key]
      ?? (e.key.length === 1 ? e.key.toUpperCase().charCodeAt(0) : 0));
    const keyTarget = () => {
      if (state.focusedLayer) return state.focusedLayer;
      return state.primaryLayer ? Layer.peekNode(state.primaryLayer.owner) : null;
    };
    state.postKeyEvent = (name, key, shift) => {
      const node = keyTarget();
      if (node) fire(node, name, name === 'onKeyPress' ? [key, 1] : [key, shift, 1]);
      invoke(state.owner, name, name === 'onKeyPress' ? [key] : [key, shift]);
    };
    const dispatchKey = (name, e, process) => {
      const key = keyCode(e);
      if (!key) return;
      const shift = (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 4 : 0) | (e.altKey ? 2 : 0);
      const node = keyTarget();
      if (node) fire(node, name, [key, shift, process]);
      invoke(state.owner, name, [key, shift, process]);
    };
    listen(document, 'keydown', e => dispatchKey('onKeyDown', e, 1));
    listen(document, 'keyup', e => dispatchKey('onKeyUp', e, 1));
    listen(document, 'keypress', e => {
      const key = e.key.length === 1 ? e.key.charCodeAt(0) : keyCode(e);
      if (!key) return;
      const shift = (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 4 : 0) | (e.altKey ? 2 : 0);
      const node = keyTarget();
      // LayerIntf.cpp onKeyPress: (key, process).
      if (node) fire(node, 'onKeyPress', [key, 1]);
      invoke(state.owner, 'onKeyPress', [key, shift]);
    });
  }
  return {
    paint, requestPaint, requestPaintAll, diagnostics: () => ({ ...stats, gpu: getGPU()?.diagnostics() }), hitTest, findLayerAt, invoke, wire,
    stop() {
      if (disposed) return;
      disposed = true;
      if (paintFrameId !== null) view.cancelAnimationFrame(paintFrameId);
      paintFrameId = null;
      paintFrameScheduled = false;
      pendingPaint.clear();
      paintAllPending = false;
      for (const remove of listeners.splice(0)) remove();
    },
  };
}
