// LayerManager input and focus bindings which depend on the completed layer
// tree.  Kept separate from layer.js so the basic drawing class can be
// constructed first and these bindings can replace its capability stubs.
import { NativeProperty, nativeEvent, script, nativeOwner } from '#krkr/native';
import { number, truth } from '#krkr/values';
import { focusNeighbor } from './layer-tree.js';
import { findLayerAt } from './layer-composite.js';

const ownerOf = nativeOwner;
const closureOf = node => node?.owner ?? null;

export function installLayerInput(Layer, {
  instanceOf,
  updateTree,
  dispatchAction,
  Window,
} = {}) {
  if (!instanceOf || !dispatchAction) throw new Error('installLayerInput requires instanceOf and dispatchAction');
  const change = node => { if (updateTree) updateTree(node); };
  const stateOf = owner => instanceOf(owner);
  const invokeMember = (owner, name, args = []) => script(owner)[name](...args);
  const actionEvent = (owner, name, fields = {}) => dispatchAction(owner, name, fields);

  function rootOf(node) {
    let root = node;
    while (root.parent) root = root.parent;
    return root;
  }
  function allNodes(root, result = []) {
    if (!root) return result;
    result.push(root);
    for (const child of root.children) allNodes(child, result);
    return result;
  }
  function modalAllows(node) {
    const modal = node.window?.modalLayers?.at(-1);
    if (!modal) return true;
    for (let walk = node; walk; walk = walk.parent) if (walk === modal) return true;
    return false;
  }
  function nodeEnabled(node) {
    for (let walk = node; walk; walk = walk.parent) {
      if (!walk.enabled) return false;
    }
    return modalAllows(node);
  }
  function nodeFocusable(node) {
    if (!node || node.invalid || !node.focusable || !nodeEnabled(node)) return false;
    for (let walk = node; walk; walk = walk.parent) if (!walk.visible) return false;
    return true;
  }
  function isInTree(root, node) {
    for (let walk = node; walk; walk = walk.parent) if (walk === root) return true;
    return false;
  }
  function saveEnabledWork(window, fallback) {
    const root = window?.primaryLayer ?? fallback;
    if (!root) return null;
    for (const node of allNodes(root)) node.enabledWork = nodeEnabled(node);
    return root;
  }
  async function notifyEnabledState(root) {
    if (!root) return;
    const changed = allNodes(root).map(node => [node, nodeEnabled(node)])
      .filter(([node, enabled]) => node.enabledWork !== enabled);
    for (const [node, enabled] of changed)
      await invokeMember(node.owner, enabled ? 'onNodeEnabled' : 'onNodeDisabled', []);
  }
  function firstFocusable(root, ignoreJoin = false) {
    if (!root) return null;
    if (nodeFocusable(root) && (ignoreJoin || root.joinFocusChain !== false)) return root;
    for (const child of root.children) {
      const result = firstFocusable(child, ignoreJoin);
      if (result) return result;
    }
    return null;
  }
  function neighbor(node, direction) { return focusNeighbor(node, direction); }

  async function searchFocusable(node, direction) {
    const candidate = neighbor(node, direction);
    node.focusWork = candidate;
    await invokeMember(node.owner, direction < 0 ? 'onSearchPrevFocusable' : 'onSearchNextFocusable', [closureOf(candidate)]);
    return node.focusWork;
  }

  function attentionPoint(node) {
    for (let target = node; target; target = target.parent) {
      if (!target.useAttention) continue;
      let x = Number(target.attentionLeft) || 0;
      let y = Number(target.attentionTop) || 0;
      for (let walk = target; walk.parent; walk = walk.parent) {
        x += walk.left;
        y += walk.top;
      }
      return { node: target, x: Math.trunc(x), y: Math.trunc(y) };
    }
    return null;
  }
  function notifyAttention(node) {
    const window = node.window;
    if (!window || window.focusedLayer !== node) return;
    const point = attentionPoint(node);
    if (point) window.setAttentionPoint?.(point.node, point.x, point.y);
    else window.disableAttentionPoint?.();
  }
  function notifyIme(node) {
    const window = node.window;
    if (window?.focusedLayer === node) window.setImeMode?.(node.imeMode);
  }

  async function setFocus(node, direction = true, ownerWindow = null, shuttingDown = null) {
    const target = node;
    const window = target?.window ?? ownerWindow;
    if (!window) return 0;
    if (target && !nodeFocusable(target)) return 0;
    let next = target;
    if (next) {
      next.focusWork = next;
      await invokeMember(next.owner, 'onBeforeFocus', [closureOf(next), closureOf(window.focusedLayer), Number(truth(direction))]);
      next = next.focusWork;
      if (next && !nodeFocusable(next)) return 0;
    }
    if (window.focusedLayer === next) return 0;
    if (window.focusChangeLock) throw new Error('TJS cannot change focus in processing focus');
    window.focusChangeLock = true;
    const previous = window.focusedLayer;
    window.focusedLayer = next;
    try {
      if (previous && previous !== shuttingDown && !previous.invalid) await invokeMember(previous.owner, 'onBlur', [closureOf(next)]);
      if (window.focusedLayer && !window.focusedLayer.invalid) {
        await invokeMember(window.focusedLayer.owner, 'onFocus', [closureOf(previous), Number(truth(direction))]);
      }
    } finally {
      window.focusChangeLock = false;
    }
    if (window.focusedLayer) {
      const focused = window.focusedLayer;
      window.setImeMode?.(focused.imeMode);
      const point = attentionPoint(focused);
      if (point) window.setAttentionPoint?.(point.node, point.x, point.y);
      else window.disableAttentionPoint?.();
    } else {
      window.resetImeMode?.();
      window.disableAttentionPoint?.();
    }
    return 1;
  }

  async function blurTree(root, shuttingDown = null) {
    const window = root.window;
    if (!window) return;
    // BlurTree first removes modal layers in this branch. This makes the
    // subsequent focus search use the same modal state as the native manager.
    if (Array.isArray(window.modalLayers)) {
      window.modalLayers = window.modalLayers.filter(modal => !isInTree(root, modal));
    }
    await window.leaveMouseFromTree?.(root, shuttingDown);
    if (!window.focusedLayer || !isInTree(root, window.focusedLayer)) return;
    const next = root === shuttingDown ? neighbor(root, 1) : await searchFocusable(root, 1);
    await setFocus(next === window.focusedLayer ? null : next, true, window, shuttingDown);
  }

  // LayerIntf.cpp forwards every native input callback through the action
  // owner.  The original JS methods were empty, which made default layer
  // callbacks silently lose those actions.
  const eventFields = {
    onClick: ['x', 'y'], onDoubleClick: ['x', 'y'],
    onMouseDown: ['x', 'y', 'button', 'shift'], onMouseUp: ['x', 'y', 'button', 'shift'],
    onMouseMove: ['x', 'y', 'shift'], onMouseEnter: [], onMouseLeave: [],
    onTouchDown: ['x', 'y', 'cx', 'cy', 'id'], onTouchUp: ['x', 'y', 'cx', 'cy', 'id'],
    onTouchMove: ['x', 'y', 'cx', 'cy', 'id'],
    onTouchScaling: ['startdistance', 'currentdistance', 'cx', 'cy', 'flag'],
    onTouchRotate: ['startangle', 'currentangle', 'distance', 'cx', 'cy', 'flag'],
    onMultiTouch: [], onBlur: ['focused'], onFocus: ['blurred', 'direction'],
    onNodeEnabled: [], onNodeDisabled: [],
    onKeyDown: ['key', 'shift', 'process'], onKeyUp: ['key', 'shift', 'process'],
    onKeyPress: ['key', 'process'], onMouseWheel: ['shift', 'delta', 'x', 'y'],
    onSearchPrevFocusable: ['layer'], onSearchNextFocusable: ['layer'],
    onPaint: [], onTransitionCompleted: ['dest', 'src'],
    onFileDrop: [], onCloseQuery: [], onPopupHide: [],
  };
  for (const [name, fields] of Object.entries(eventFields)) {
    if (name === 'onSearchPrevFocusable' || name === 'onSearchNextFocusable') continue;
    Layer.members.set(name, nativeEvent(function(...args) {
      const node = stateOf(this);
      const values = Object.fromEntries(fields.map((field, index) => [field, args[index]]));
      return actionEvent(this, name, values);
    }, { kind: 'method', name }));
  }
  const applySearchResult = async (owner, event) => {
    const value = event?.members?.get('layer');
    const resultOwner = ownerOf(value);
    stateOf(owner).focusWork = resultOwner == null ? null : instanceOf(resultOwner);
  };
  async function defaultKeyDown(node, key, shift) {
    if (!node.window) return;
    const noShift = !(shift & 1) && !(shift & 2) && !(shift & 4);
    if ((key === 9 || key === 39 || key === 40) && noShift) {
      const candidate = node.window.focusedLayer
        ? await searchFocusable(node.window.focusedLayer, 1)
        : firstFocusable(rootOf(node), false);
      if (candidate) await setFocus(candidate, true);
    } else if ((key === 9 && (shift & 1) && !(shift & 2) && !(shift & 4)) || key === 37 || key === 38) {
      const candidate = node.window.focusedLayer
        ? await searchFocusable(node.window.focusedLayer, -1)
        : firstFocusable(rootOf(node), false);
      if (candidate) await setFocus(candidate, false);
    } else if ((key === 13 || key === 27) && noShift && node.parent && nodeEnabled(node.parent)) {
      await invokeMember(node.parent.owner, 'onKeyDown', [key, shift, 1]);
    }
  }
  async function defaultKeyUp(node, key, shift) {
    if (!node.window || (shift & 1) || (shift & 2) || (shift & 4)) return;
    if ((key === 13 || key === 27) && node.parent && nodeEnabled(node.parent)) {
      await invokeMember(node.parent.owner, 'onKeyUp', [key, shift, 1]);
    }
  }
  async function defaultKeyPress(node, key) {
    if (!node.window || (key !== 13 && key !== 27) || !node.parent || !nodeEnabled(node.parent)) return;
    await invokeMember(node.parent.owner, 'onKeyPress', [key, 1]);
  }
  Layer.members.set('onKeyDown', async function(key, shift, process) {
    const event = await actionEvent(this, 'onKeyDown', { key, shift, process });
    if (truth(process)) await defaultKeyDown(stateOf(this), key, shift);
    return event;
  });
  Layer.members.set('onKeyUp', async function(key, shift, process) {
    const event = await actionEvent(this, 'onKeyUp', { key, shift, process });
    if (truth(process)) await defaultKeyUp(stateOf(this), key, shift);
    return event;
  });
  Layer.members.set('onKeyPress', async function(key, process) {
    const event = await actionEvent(this, 'onKeyPress', { key, process });
    if (truth(process)) await defaultKeyPress(stateOf(this), key);
    return event;
  });
  Layer.members.set('onSearchPrevFocusable', async function(layer) {
    await applySearchResult(this, await actionEvent(this, 'onSearchPrevFocusable', { layer }));
  });
  Layer.members.set('onSearchNextFocusable', async function(layer) {
    await applySearchResult(this, await actionEvent(this, 'onSearchNextFocusable', { layer }));
  });
  Layer.members.set('onHitTest', function(x, y, hit) {
    const node = stateOf(this);
    node.hitTestWork = truth(hit);
  });
  Layer.members.set('onBeforeFocus', async function(layer, blurred, direction) {
    const event = await actionEvent(this, 'onBeforeFocus', { layer, blurred, direction });
    const value = event?.members?.get('layer');
    const owner = ownerOf(value);
    stateOf(this).focusWork = owner == null ? null : instanceOf(owner);
  });

  Layer.members.set('releaseTouchCapture', function(id) {
    const node = stateOf(this);
    const window = node.window;
    if (!window) return;
    if (arguments.length) window.releaseTouchCapture?.(Number(id) >>> 0, false);
    else window.releaseTouchCapture?.(0, true);
  });
  Layer.members.set('focus', function(direction = true) {
    return setFocus(stateOf(this), direction);
  });
  Layer.members.set('focusPrev', async function() {
    const node = stateOf(this), window = node.window;
    if (!window) return null;
    const candidate = window.focusedLayer ? await searchFocusable(window.focusedLayer, -1) : firstFocusable(rootOf(node), false);
    if (candidate) await setFocus(candidate, false);
    return closureOf(candidate);
  });
  Layer.members.set('focusNext', async function() {
    const node = stateOf(this), window = node.window;
    if (!window) return null;
    const candidate = window.focusedLayer ? await searchFocusable(window.focusedLayer, 1) : firstFocusable(rootOf(node), false);
    if (candidate) await setFocus(candidate, true);
    return closureOf(candidate);
  });
  Layer.members.set('setAttentionPos', function(x, y) {
    if (arguments.length < 2) throw new Error('TJS Layer.setAttentionPos requires 2 arguments');
    const node = stateOf(this);
    node.attentionLeft = Math.trunc(number(x));
    node.attentionTop = Math.trunc(number(y));
    notifyAttention(node);
  });
  Layer.members.set('getLayerAt', async function(x, y, excludeSelf = false, getDisabled = false) {
    if (arguments.length < 2) throw new Error('TJS Layer.getLayerAt requires 2 arguments');
    const node = stateOf(this);
    // LayerIntf::GetMostFrontChildAt converts this layer's point into primary
    // coordinates, then asks the manager for the hit across the whole tree.
    // Starting at `node` would incorrectly exclude its siblings and ancestors.
    const root = node.window?.primaryLayer ?? rootOf(node);
    let px = number(x), py = number(y);
    for (let walk = node; walk.parent; walk = walk.parent) {
      px += walk.left;
      py += walk.top;
    }
    const result = await findLayerAt(root, px, py, {
      state: node.window,
      except: truth(excludeSelf) ? node : null,
      getDisabled: truth(getDisabled),
      test: async (target, lx, ly) => {
        target.hitTestWork = true;
        await script(target.owner).onHitTest(lx, ly, 1);
        return target.hitTestWork;
      },
    });
    return closureOf(result);
  });

  // LayerIntf::SetVisible/SetEnabled also maintain focus, modal and effective
  // enabled state. The drawing properties are installed earlier by layer.js,
  // so replace their setters here once the input helpers are available.
  Layer.members.set('visible', new NativeProperty(
    owner => Number(!!stateOf(owner).visible),
    async (owner, value) => {
      const node = stateOf(owner), visible = !!truth(value);
      if (node.visible === visible) return;
      if (node.isPrimary && !visible) throw new Error('TJS cannot set primary layer invisible');
      const root = !visible && node.window ? saveEnabledWork(node.window) : null;
      if (!visible) change(node); // native Update() occurs before hiding
      node.visible = visible;
      try {
        if (!visible) await blurTree(node);
      } catch (error) {
        if (root) await notifyEnabledState(root);
        throw error;
      }
      await notifyEnabledState(root);
      change(node);
    },
  ));
  Layer.members.set('enabled', new NativeProperty(
    owner => Number(!!stateOf(owner).enabled),
    async (owner, value) => {
      const node = stateOf(owner), enabled = !!truth(value);
      if (node.enabled === enabled) return;
      const window = node.window;
      const root = saveEnabledWork(window, node);
      node.enabled = enabled;
      try {
        if (!enabled) await blurTree(node);
      } catch (error) {
        // SetEnabled notifies even when focus/modal callbacks throw.
        await notifyEnabledState(root);
        throw error;
      }
      await notifyEnabledState(root);
      change(node);
    },
  ));

  // Modal stack changes also alter GetNodeEnabled for every layer outside the
  // active modal tree. Keep the existing setMode/removeMode implementations,
  // but surround them with the LayerManager Save/NotifyEnabledWork phase.
  const setMode = Layer.members.get('setMode');
  if (typeof setMode === 'function') {
    Layer.members.set('setMode', async function(...args) {
      const node = stateOf(this), root = node.window ? saveEnabledWork(node.window) : null;
      let result;
      try {
        result = await setMode.apply(this, args);
      } catch (error) {
        await notifyEnabledState(root);
        throw error;
      }
      await notifyEnabledState(root);
      return result;
    });
  }
  const removeMode = Layer.members.get('removeMode');
  if (typeof removeMode === 'function') {
    Layer.members.set('removeMode', async function(...args) {
      const node = stateOf(this), root = node.window ? saveEnabledWork(node.window) : null;
      let result;
      try {
        result = await removeMode.apply(this, args);
      } catch (error) {
        await notifyEnabledState(root);
        throw error;
      }
      await notifyEnabledState(root);
      return result;
    });
  }

  Layer.members.set('cached', new NativeProperty(
    owner => Number(!!stateOf(owner).cached),
    (owner, value) => { const node = stateOf(owner); node.cached = !!truth(value); change(node); },
  ));
  Layer.members.set('hint', new NativeProperty(
    owner => stateOf(owner).hint ?? '',
    (owner, value) => {
      const node = stateOf(owner);
      node.showParentHint = false;
      node.ignoreHintSensing = false;
      node.hint = String(value);
      if (node.window?.hoverLayer === node || node.window?.captureLayer === node) {
        node.window.setHint?.(node.owner, node.hint);
      }
    },
  ));
  Layer.members.set('showParentHint', new NativeProperty(
    owner => Number(stateOf(owner).showParentHint ?? true),
    (owner, value) => { stateOf(owner).showParentHint = !!truth(value); },
  ));
  Layer.members.set('ignoreHintSensing', new NativeProperty(
    owner => Number(!!stateOf(owner).ignoreHintSensing),
    (owner, value) => { stateOf(owner).ignoreHintSensing = !!truth(value); },
  ));
  Layer.members.set('prevFocusable', new NativeProperty(async owner => closureOf(await searchFocusable(stateOf(owner), -1))));
  Layer.members.set('nextFocusable', new NativeProperty(async owner => closureOf(await searchFocusable(stateOf(owner), 1))));
  Layer.members.set('joinFocusChain', new NativeProperty(
    owner => Number(stateOf(owner).joinFocusChain !== false),
    (owner, value) => { stateOf(owner).joinFocusChain = !!truth(value); },
  ));
  Layer.members.set('nodeFocusable', new NativeProperty(owner => Number(nodeFocusable(stateOf(owner)))));
  Layer.members.set('attentionLeft', new NativeProperty(
    owner => Number(stateOf(owner).attentionLeft ?? 0),
    (owner, value) => { const node = stateOf(owner); node.attentionLeft = Math.trunc(number(value)); notifyAttention(node); },
  ));
  Layer.members.set('attentionTop', new NativeProperty(
    owner => Number(stateOf(owner).attentionTop ?? 0),
    (owner, value) => { const node = stateOf(owner); node.attentionTop = Math.trunc(number(value)); notifyAttention(node); },
  ));
  Layer.members.set('useAttention', new NativeProperty(
    owner => Number(!!stateOf(owner).useAttention),
    (owner, value) => { const node = stateOf(owner); node.useAttention = !!truth(value); notifyAttention(node); },
  ));
  Layer.members.set('imeMode', new NativeProperty(
    owner => Number(stateOf(owner).imeMode ?? 0),
    (owner, value) => { const node = stateOf(owner); node.imeMode = Math.trunc(number(value)); notifyIme(node); },
  ));

  if (Window?.members) {
    Window.members.set('focusedLayer', new NativeProperty(
      owner => {
        const focused = Window.state(owner).focusedLayer;
        return closureOf(focused);
      },
      async (owner, value) => {
        const state = Window.state(owner);
        const targetOwner = ownerOf(value);
        const target = targetOwner == null ? null : instanceOf(targetOwner);
        if (target && target.window !== state) return;
        await setFocus(target, false, state);
      },
    ));
  }

  // Expose the state helpers for compositor/window integration without making
  // them part of the TJS-visible Layer API.
  Layer.input = { nodeFocusable, setFocus, attentionPoint, searchFocusable, blurTree };
  for (const name of [...Object.keys(eventFields), 'onHitTest', 'onBeforeFocus']) {
    const member = Layer.members.get(name);
    if (typeof member === 'function') nativeEvent(member, { kind: 'method', name });
  }
  return Layer;
}
