import { NativeProperty, nativeClass, nativeMethod, nativeMembers, retainScriptValue, disposeScriptValue, unimplemented, reportUnimplemented } from '#krkr/native';
import { Closure, truth, number, integer } from '#krkr/values';
import { MotionResourceManager } from './motion-resource.js';
import { decodeSource } from '../image-codecs/psb.js';
import { Image } from '../bitmap.js';
import { getGPU } from '../gpu.js';
import { mat2 } from 'gl-matrix';

// Motion::Player, ported from plugins/motionplayer. The reference implementation
// is a large C++ engine; this port implements the load/timeline/transform/draw
// core (PSB motion definition, two-slot keyframe ping-pong, inherited affine
// transform, quad rendering with the blend modes the game's logo/title motions
// use) and the scalar TJS surface. Mesh/Bezier deformation, particles, camera and
// the D3D/separate-layer adaptor render paths are not implemented and are
// reported as such rather than silently succeeding.
//
// Layout notes:
//  - A motion is `root.object[chara].motion[name]`; `layer` is the root layer
//    array, `priority` the ordered draw list, `lastTime`/`loopTime` the frame
//    range.
//  - Each layer's `frameList` is a list of {time,type,content}. type 0 ends the
//    node, 2 is a snap (no crossfade), 3 crossfades. Two slots ping-pong; the
//    active slot is the left endpoint and the other slot the right endpoint.
//  - `content.mask` selects which payload members exist (PlayerUpdateLayerEval.cpp
//    319-640): 0x1 ox/oy, 0x2 coord, 0x4/0x8 fx/fy, 0x10 angle, 0x20/0x40 zx/zy,
//    0x80/0x100 sx/sy, 0x200 color, 0x400 opa, 0x20000 bm, 0x40000 act,
//    0x4000000 ti.
//  - Transform order defaults to {Flip, Slant, Zoom, Angle} (Player.h
//    defaultTransformOrder {0,3,2,1}).

const FLAG_FORCE = 1, FLAG_CHAIN = 2, FLAG_ASCAN = 4, FLAG_JOIN = 8, FLAG_STEALTH = 16;
const ORDER_FLIP = 0, ORDER_ANGLE = 1, ORDER_ZOOM = 2, ORDER_SLANT = 3;
const defaultTransformOrder = [ORDER_FLIP, ORDER_SLANT, ORDER_ZOOM, ORDER_ANGLE];

const toArray = node => (node ? node.toArray() : []);
const getValue = (node, key) => {
  if (!node) return undefined;
  const child = node.get(key);
  return child === undefined ? undefined : child.toValue();
};
const getInt = (node, key, fallback = 0) => {
  const child = node ? node.get(key) : undefined;
  return child ? child.toInt() : fallback;
};
const getNumber = (node, key, fallback = 0) => {
  const child = node ? node.get(key) : undefined;
  return child ? child.toNumber() : fallback;
};
const getText = (node, key, fallback = '') => {
  const child = node ? node.get(key) : undefined;
  return child && child.category === 4 ? child.toText() : fallback;
};

// PlayerUpdateLayerEval.cpp resetClipSlot_guess + mergeNodeFrameContent_guess.
function emptySlot() {
  return {
    frameIndex: -1, clipStartTime: 0, ti: 0, contentMask: 0, done: true, crossfading: false, merged: false,
    iconValue: '', srcValue: '', blendMode: 16, ox: 0, oy: 0,
    colors: [0xff808080, 0xff808080, 0xff808080, 0xff808080], opacity: 255,
    x: 0, y: 0, z: 0, flipX: false, flipY: false, angle: 0, scaleX: 1, scaleY: 1,
    slantX: 0, slantY: 0, curves: {}, actionValue: '',
  };
}
function parseFrame(slot, frames, index) {
  Object.assign(slot, emptySlot());
  slot.frameIndex = index;
  if (index < 0 || index >= frames.length) return slot;
  const frame = frames[index];
  slot.clipStartTime = getNumber(frame, 'time');
  const type = getInt(frame, 'type');
  if (type === 0) { slot.done = true; return slot; }
  slot.done = false;
  slot.crossfading = type === 3;
  const content = frame ? frame.get('content') : undefined;
  if (!content) { slot.merged = true; return slot; }
  slot.contentMask = getInt(content, 'mask');
  if (slot.contentMask & 0x40000) slot.actionValue = getText(content, 'act');
  slot.merged = false;
  return slot;
}
function mergeContent(slot, nodeType, frames) {
  if (slot.merged) return;
  slot.merged = true;
  if (slot.done) return;
  const frame = frames[slot.frameIndex];
  const content = frame ? frame.get('content') : undefined;
  if (!content) return;
  const mask = slot.contentMask;
  // Every node type in these motions is an object/shape/layout/motion node.
  if (((1 << nodeType) & 0x1849) !== 0) {
    if (content.get('src') !== undefined) slot.srcValue = getText(content, 'src');
    if (content.get('icon') !== undefined) slot.iconValue = getText(content, 'icon');
  }
  if (mask & 0x1) { slot.ox = getNumber(content, 'ox'); slot.oy = getNumber(content, 'oy'); }
  if (mask & 0x2) {
    const coord = toArray(content.get('coord'));
    slot.x = coord[0]?.toNumber() ?? 0; slot.y = coord[1]?.toNumber() ?? 0; slot.z = coord[2]?.toNumber() ?? 0;
  }
  if (mask & 0x20600) {
    if (mask & 0x20000) slot.blendMode = getInt(content, 'bm', 16);
    if (mask & 0x200) {
      const color = content.get('color');
      if (color && color.category === 6) {
        slot.colors = toArray(color).map(node => node.toInt());
        while (slot.colors.length < 4) slot.colors.push(0xff808080);
      } else if (color) {
        const packed = color.toInt() >>> 0;
        slot.colors = [packed, packed, packed, packed];
      }
    } else if ((slot.blendMode & 0xf0) === 0) slot.colors = [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff];
    if (mask & 0x400) slot.opacity = getInt(content, 'opa', 255);
  }
  if (mask & 0x1fc) {
    if (mask & 0xc) {
      slot.flipX = !!getValue(content, 'fx'); slot.flipY = !!getValue(content, 'fy');
    }
    if (mask & 0x10) slot.angle = getNumber(content, 'angle');
    if (mask & 0x60) { slot.scaleX = getNumber(content, 'zx', 1); slot.scaleY = getNumber(content, 'zy', 1); }
    if (mask & 0x180) { slot.slantX = getNumber(content, 'sx'); slot.slantY = getNumber(content, 'sy'); }
  }
  if (mask & 0x4000000) slot.ti = getInt(content, 'ti');
}
// interpolateScalarWithCurve_guess (PlayerUpdateLayerEval.cpp 84): linear with
// the optional variable-track easing.
function lerp(from, to, ratio) { return from === to ? from : to * ratio + from * (1 - ratio); }
// interpolateTimelinePayload_guess (PlayerUpdateLayerEval.cpp 175).
function interpolatePayload(a, b, accumulated) {
  accumulated.flipX = a.flipX; accumulated.flipY = a.flipY;
  let angle = a.angle, otherAngle = b.angle;
  if (angle !== otherAngle) {
    if (angle >= otherAngle) { if (angle - otherAngle > 180) otherAngle += 360; }
    else if (otherAngle - angle > 180) otherAngle -= 360;
    // The reference evaluates the curve for every unequal component; the
    // shipped motions leave the easing variants void so this is a linear lerp.
    angle = lerp(angle, otherAngle, accumulated.ratio);
    if (angle < 0) angle += 360; else if (angle >= 360) angle -= 360;
  }
  accumulated.angle = angle;
  accumulated.scaleX = lerp(a.scaleX, b.scaleX, accumulated.ratio);
  accumulated.scaleY = lerp(a.scaleY, b.scaleY, accumulated.ratio);
  accumulated.slantX = lerp(a.slantX, b.slantX, accumulated.ratio);
  accumulated.slantY = lerp(a.slantY, b.slantY, accumulated.ratio);
  accumulated.posX = lerp(a.x, b.x, accumulated.ratio);
  accumulated.posY = lerp(a.y, b.y, accumulated.ratio);
  accumulated.posZ = lerp(a.z, b.z, accumulated.ratio);
  accumulated.colors = a.colors;
  accumulated.opacity = Math.trunc(lerp(a.opacity, b.opacity, accumulated.ratio)) & 0xff;
}
// copyActiveTimelinePayload_guess (PlayerUpdateLayerEval.cpp 10).
function copyPayload(a, accumulated) {
  accumulated.flipX = a.flipX; accumulated.flipY = a.flipY;
  accumulated.angle = a.angle; accumulated.scaleX = a.scaleX; accumulated.scaleY = a.scaleY;
  accumulated.slantX = a.slantX; accumulated.slantY = a.slantY;
  accumulated.posX = a.x; accumulated.posY = a.y; accumulated.posZ = a.z;
  accumulated.colors = a.colors;
  accumulated.opacity = a.opacity;
}
// applyLocalTransform (PlayerUpdateLayersInternal.h 621): build the local 2x2 by
// left-multiplying Flip/Slant/Zoom/Angle in the node's transform order.
function localMatrix(flipX, flipY, angle, scaleX, scaleY, slantX, slantY, order) {
  // Column-major [m11, m21, m12, m22]. Plain arrays retain JS double precision.
  const matrix = [1, 0, 0, 1];
  for (let step = 0; step < 4; step++) {
    switch (order[step]) {
      case ORDER_FLIP:
        if (flipX || flipY) mat2.multiply(matrix, mat2.fromScaling([], [flipX ? -1 : 1, flipY ? -1 : 1]), matrix);
        break;
      case ORDER_ANGLE:
        if (angle !== 0) mat2.multiply(matrix, mat2.fromRotation([], (angle * Math.PI * 2) / 360), matrix);
        break;
      case ORDER_ZOOM:
        if (scaleX !== 1 || scaleY !== 1) mat2.multiply(matrix, mat2.fromScaling([], [scaleX, scaleY]), matrix);
        break;
      case ORDER_SLANT:
        if (slantX !== 0 || slantY !== 0) mat2.multiply(matrix, [1, slantY, slantX, 1], matrix);
        break;
    }
  }
  return { m11: matrix[0], m12: matrix[2], m21: matrix[1], m22: matrix[3] };
}
// multiplyOpacityWordsDivide255_guess: (a*b)/255 with rounding.
const multiplyOpacity = (a, b) => ((a * b) + 127) / 255 | 0;

class MotionNodeState {
  constructor() {
    this.parentIndex = 0;
    this.layerName = '';
    this.nodeType = 0;
    this.shapeType = 0;
    this.stencilType = 0;
    this.meshType = 0;
    this.transformOrder = [...defaultTransformOrder];
    this.inheritFlags = 0;
    this.coordinateMode = 0;
    this.frameList = [];
    this.slots = [emptySlot(), emptySlot()];
    this.activeSlotIndex = 0;
    this.accumulated = { dirty: true, visible: true, flipX: false, flipY: false, posX: 0, posY: 0, posZ: 0, angle: 0, scaleX: 1, scaleY: 1, slantX: 0, slantY: 0, opacity: 255, colors: [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff], ratio: 0 };
    this.matrix = { m11: 1, m12: 0, m21: 0, m22: 1 };
    this.source = null;
    this.priority = 0;
    this.done = false;
    this.children = [];
  }
  get active() { return this.slots[this.activeSlotIndex]; }
  get other() { return this.slots[this.activeSlotIndex ^ 1]; }
}

export function createMotionPlayerClass({ ResourceManager, getLayerNode, report, document } = {}) {
  let defaultSyncActive = false;
  let defaultTransformOrderGlobal = [...defaultTransformOrder];
  // ResourceManager is a NativeClass; resolve the backing manager from the
  // constructor argument (a Closure or a bare native owner).
  const resourceManagerOf = value => ResourceManager?.resolve?.(value) ?? null;

  // Full timeline seek for one node (PlayerUpdateLayerEval.cpp
  // initializeNodeTimelineSlots_guess + the incremental walk).
  function initializeNode(node, currentTime) {
    const frames = node.frameList;
    const selection = currentTime;
    let index = 0;
    if (frames.length >= 1) {
      for (let i = 0; ; i++) {
        const time = getNumber(frames[i], 'time');
        if (selection === time) { index = i; break; }
        if (selection < time) { index = i - 1; break; }
        if (i + 1 >= frames.length) break;
      }
    }
    const upper = Math.max(0, frames.length - 2);
    if (index > upper) index = upper;
    if (index < 0) index = 0;
    parseFrame(node.slots[0], frames, index);
    mergeContent(node.slots[0], node.nodeType, frames);
    parseFrame(node.slots[1], frames, index + 1);
    mergeContent(node.slots[1], node.nodeType, frames);
    node.activeSlotIndex = 0;
    resolveSource(node);
  }
  // Incremental two-slot seek (seekNodeTimelineSlotsIncrementalPhase_guess).
  function seekNode(node, currentTime, fireAction) {
    const frames = node.frameList;
    const lastForward = frames.length - 2;
    let seeked = false;
    while (node.active.frameIndex < lastForward && currentTime >= node.other.clipStartTime) {
      if (fireAction && (node.other.contentMask & 0x40000)) fireAction(node.layerName, node.other.actionValue);
      node.activeSlotIndex ^= 1;
      const next = node.active.frameIndex + 1;
      parseFrame(node.other, frames, next);
      seeked = true;
    }
    while (currentTime < node.active.clipStartTime) {
      const previous = node.active.frameIndex - 1;
      node.activeSlotIndex ^= 1;
      parseFrame(node.active, frames, previous);
      if (fireAction && (node.active.contentMask & 0x40000)) fireAction(node.layerName, node.active.actionValue);
      seeked = true;
    }
    if (seeked) {
      if (!node.slots[0].merged) mergeContent(node.slots[0], node.nodeType, frames);
      if (!node.slots[1].merged) mergeContent(node.slots[1], node.nodeType, frames);
      resolveSource(node);
    }
    return seeked;
  }
  // evaluateTimeline_guess (PlayerUpdateLayerEval.cpp 1026).
  function evaluateTimeline(node, currentTime, dirty) {
    const active = node.active, other = node.other;
    if (active.done) return dirty;
    if (!active.crossfading || other.done) {
      copyPayload(active, node.accumulated);
      node.accumulated.dirty = !!dirty;
      return true;
    }
    let elapsed = currentTime - active.clipStartTime;
    if (active.ti !== 0) elapsed = active.ti * Math.trunc(elapsed / active.ti);
    const ratio = elapsed / (other.clipStartTime - active.clipStartTime);
    node.accumulated.ratio = ratio;
    if (Math.abs(ratio) < 1e-7) { copyPayload(active, node.accumulated); node.accumulated.dirty = !!dirty; return true; }
    interpolatePayload(active, other, node.accumulated);
    node.accumulated.dirty = !!dirty;
    return true;
  }
  // PlayerUpdateLayerEval.cpp findSourceForNode_guess via ResourceManager.
  function resolveSource(node) {
    const slot = node.active;
    const src = slot.srcValue;
    if (!src || src === 'blank') { node.source = null; return; }
    const manager = node.manager;
    if (!manager) { node.source = null; return; }
    const path = src.startsWith('src/') ? src : `src/${src}`;
    const descriptor = manager.findSource(node.motionContext, path);
    if (!descriptor) { node.source = null; return; }
    if (descriptor.blank) { node.source = { blank: true, width: descriptor.width, height: descriptor.height, originX: descriptor.originX, originY: descriptor.originY, pixels: null }; return; }
    const decoded = decodeSource(descriptor.node);
    if (!decoded) { node.source = null; return; }
    // The `icon` member, when present, selects a different icon within the group.
    let image = decoded;
    if (slot.iconValue) {
      const group = path.split('/')[1];
      const iconDescriptor = manager.findSource(node.motionContext, `src/${group}/${slot.iconValue}`);
      if (iconDescriptor && !iconDescriptor.blank) {
        const iconImage = decodeSource(iconDescriptor.node);
        if (iconImage) image = iconImage;
      }
    }
    node.source = { blank: false, ...image };
  }

  @nativeClass('Player')
  @nativeMembers({
    Player(...args) {
      if (!args.length) throw new Error('Motion.Player requires a resource manager argument');
      if (args.length === 1 && args[0] === undefined) { Player.instances.delete(this); return; }
      const state = this;
      // PlayerCore keeps rmDispatch in a Variant for the player's lifetime.
      state.resourceManager = retainScriptValue(args[0], this);
      state.resourceManagerInstance = resourceManagerOf(args[0]);
      state.motionContext = '';
    },
    // PlayerCore.cpp loadMotionResult_guess: findMotion(project,
    // "motion/<chara>/<motion>") through the resource manager, then build the
    // node tree from the returned motion definition.
    async loadMotion(chara, motion) { return loadMotionImpl(this, chara, motion); },
    play(label, flags = 0) {
      return playMotion(this, label, flags);
    },
    // PlayerFrameProgress.cpp progressCompatMethod: ms -> frames, then advance.
    progress(delta) {
      const state = this;
      progressFrames(state, (number(delta) * 60) / 1000);
      return undefined;
    },
    stop() {
      const state = this;
      state.allplaying = false; state.playing = false;
    },
    // PlayerTimeline.cpp skipToSync.
    skipToSync() {
      const state = this;
      if (state.allplaying && state.loopTime < 0) {
        state.frameTickCount = Math.max(0, Math.min(state.frameTickCount, state.lastTime));
        state.syncWaiting = false;
      }
    },
    setVariable(...args) {
      const state = this;
      if (args.length < 2) throw new Error('Motion.Player.setVariable requires a key and value');
      state.variables.set(String(args[0]), args[1]);
    },
    getVariable(...args) {
      const state = this;
      if (!args.length) throw new Error('Motion.Player.getVariable requires a key');
      return state.variables.get(String(args[0]));
    },
    modifyRoot: unimplemented('Motion.Player.modifyRoot'),
    getLayerNames() {
      const state = this;
      const result = [];
      for (const node of state.nodes.slice(1)) result.push(node.layerName);
      return result;
    },
    releaseSyncWait() { this.syncWaiting = false; },
    contains(x, y) {
      const state = this;
      const px = number(x), py = number(y);
      const bounds = calcBounds(state);
      return Number(px >= bounds.left && py >= bounds.top && px < bounds.right && py < bounds.bottom);
    },
    calcViewParam: unimplemented('Motion.Player.calcViewParam'),
    getCommandList: unimplemented('Motion.Player.getCommandList'),
    getLayerMotion: unimplemented('Motion.Player.getLayerMotion'),
    getLayerGetter: unimplemented('Motion.Player.getLayerGetter'),
    getLayerGetterList: unimplemented('Motion.Player.getLayerGetterList'),
    // PlayerDrawDispatch.cpp draw: route into the target Layer.
    draw(target) {
      const state = this;
      renderToTarget(state, target);
    },
    setDrawAffineTranslateMatrix(m11, m21, m12, m22, m14, m24) {
      const state = this;
      const matrix = { m11: number(m11), m21: number(m21), m12: number(m12), m22: number(m22), m14: number(m14), m24: number(m24) };
      matrix.nonIdentity = matrix.m11 !== 1 || matrix.m21 !== 0 || matrix.m12 !== 0 || matrix.m22 !== 1 || matrix.m14 !== 0 || matrix.m24 !== 0;
      state.drawAffine = matrix;
      return matrix.nonIdentity;
    },
    getCameraOffset: unimplemented('Motion.Player.getCameraOffset'),
    setCameraOffset: unimplemented('Motion.Player.setCameraOffset'),
    onAction() {}, onSync() {}, onGroundCorrection() {}, onFindMotion() {},
    initPhysics: unimplemented('Motion.Player.initPhysics'),
    setColor(...args) {
      const state = this;
      if (args.length >= 3) {
        const r = integer(args[0]) & 0xffffn, g = integer(args[1]) & 0xffffn, b = integer(args[2]) & 0xffffn;
        state.colorWeight = Number((0xff000000n | (r << 16n) | (g << 8n) | b) & 0xffffffffn) >>> 0;
      } else if (args.length) {
        state.colorWeight = Number(BigInt.asUintN(32, integer(args[0])));
      }
    },
  })
  class Player {
    static initialize() {
      return {
        resourceManager: null, motionContext: null, nodes: [], loaded: null, motionName: '',
        charaName: '', stealthChara: '', stealthMotion: '', motionKey: '', project: '',
        allplaying: false, playing: false, loopTime: -1, lastTime: 0,
        frameTickCount: 0, speed: 1, syncActive: Number(defaultSyncActive), syncWaiting: false,
        completionType: 0, colorWeight: 0xffffffff, variables: new Map(),
        useD3D: 0, preview: 0, priorDraw: 0, meshDivisionRatio: 1, outsideFactor: 1.5,
        transformOrder: [...defaultTransformOrderGlobal], coordinate: 0,
        drawAffine: { m11: 1, m12: 0, m21: 0, m22: 1, m14: 0, m24: 0, nonIdentity: false },
        rootDelta: { x: 0, y: 0, flipX: false, flipY: false, angle: 0, zoomX: 1, zoomY: 1, slantX: 0, slantY: 0, opacity: 255, visible: true },
        pendingActions: [], syncRequested: false, report,
      };
    }
  }

  function setTextProperty(owner, klass, key, value) {
    klass.state(owner)[key] = String(value);
    return klass.state(owner)[key];
  }

  // PlayerCore.cpp loadMotionResult_guess + playMotionImpl_guess: resolve
  // chara/motion through the manager, build the node tree, and reset the clock.
  async function loadMotionImpl(owner, chara, motion) {
    const state = Player.state(owner);
    const key = String(chara ?? state.charaName ?? '');
    const motionName = String(motion ?? state.motionName ?? '');
    const manager = state.resourceManagerInstance;
    if (!manager) throw new Error('Motion.Player has no resource manager');
    const found = manager.findMotion(state.motionKey ?? state.motionContext ?? undefined, `motion/${key}/${motionName}`);
    if (!found) throw new Error(`motion '${motionName}' not found for chara '${key}'`);
    const [motionNode, moduleKey] = found;
    state.charaName = key;
    state.motionName = motionName;
    state.motionContext = moduleKey;
    buildTree(state, motionNode, key);
    state.frameTickCount = 0;
    state.allplaying = true;
    state.playing = true;
    return true;
  }
  // Player::setChara (PlayerCore.cpp 417): an equal value is a no-op; otherwise
  // both live slots update and the loaded motion labels are cleared.
  function setChara(owner, value) {
    const state = Player.state(owner);
    if (state.charaName === value) return;
    state.charaName = value;
    state.stealthChara = value;
    state.motionName = '';
    state.motionKey = '';
    state.allplaying = false;
  }
  // Player::playMotion_guess (PlayerTimeline.cpp 74): Force/AsCan bypass the
  // label equality gate; AsCan also requires the player to be stopped.
  async function playMotion(owner, label, flags = 0) {
    const state = Player.state(owner);
    const requested = String(label ?? '');
    if ((flags & (FLAG_FORCE | FLAG_ASCAN)) === 0 && state.motionName === requested) return;
    if ((flags & FLAG_FORCE) === 0 && (flags & FLAG_ASCAN) !== 0 && state.allplaying) return;
    const chara = (flags & FLAG_STEALTH) ? state.stealthChara : state.charaName;
    await loadMotionImpl(owner, chara, requested);
    state.pendingActions.length = 0;
    // PlayFlagJoin rebuilds variable state from the incoming motion.
    if (flags & FLAG_JOIN) state.variables.clear();
    return true;
  }
  // PlayerMotionLoad.cpp buildNodeTree: flatten motion.layer into the node
  // deque and initialise each node's timeline/source state.
  function buildTree(state, motionNode, chara) {
    state.nodes = [];
    const root = new MotionNodeState();
    root.layerName = 'root';
    root.nodeType = -1;
    root.manager = state.resourceManagerInstance;
    state.nodes.push(root);
    const layers = toArray(motionNode.get('layer'));
    for (const layer of layers) appendNode(state, root, layer);
    state.loaded = motionNode;
    state.lastTime = getInt(motionNode, 'lastTime');
    state.loopTime = getInt(motionNode, 'loopTime', -1);
    // Variable-track labels are initialised after the tree (initVariables).
    state.variableLabels = toArray(motionNode.get('variable')).map(entry => ({
      label: getText(entry, 'label', ''), scope: getText(entry, 'scope', ''),
    }));
    const time = 0;
    for (let i = 1; i < state.nodes.length; i++) initializeNode(state.nodes[i], time);
  }
  function appendNode(state, parent, layer) {
    const node = new MotionNodeState();
    node.parentIndex = state.nodes.indexOf(parent);
    node.layerName = getText(layer, 'label');
    node.nodeType = getInt(layer, 'type');
    node.shapeType = getInt(layer, 'shape');
    node.stencilType = getInt(layer, 'stencilType');
    node.meshType = getInt(layer, 'meshTransform');
    node.coordinateMode = getInt(layer, 'coordinate');
    node.inheritFlags = getInt(layer, 'inheritMask');
    node.motionContext = state.motionContext;
    node.manager = state.resourceManagerInstance;
    node.frameList = toArray(layer.get('frameList'));
    const order = toArray(layer.get('transformOrder'));
    if (order.length === 4) node.transformOrder = order.map(entry => entry.toInt());
    state.nodes.push(node);
    parent.children.push(node);
    for (const child of toArray(layer.get('children'))) appendNode(state, node, child);
    return node;
  }

  // PlayerFrameProgress.cpp frameProgress: advance the clock, seek every node,
  // then update the transform tree.
  function progressFrames(state, frameDt) {
    if (!state.allplaying) return;
    const delta = state.speed * frameDt;
    let next = state.frameTickCount + delta;
    const total = state.lastTime;
    if (state.loopTime >= 0 && next >= total) next = state.loopTime;
    else if (state.loopTime < 0 && next >= total) { next = total; state.allplaying = false; state.playing = false; }
    state.frameTickCount = next;
    seekAll(state, next);
    updateLayers(state);
  }
  function seekAll(state, time) {
    for (let i = 1; i < state.nodes.length; i++) {
      const node = state.nodes[i];
      if (node.active.frameIndex < 0) initializeNode(node, time);
      else seekNode(node, time, (label, action) => { if (action) enqueueAction(state, label, action); });
    }
  }
  function enqueueAction(state, label, action) {
    state.pendingActions.push({ label, action });
  }
  // updateLayersPhase2_MainLoop (PlayerUpdateLayerEval.cpp 1386). Each node's
  // accumulated state starts from its evaluated payload, is combined with the
  // persistent delta (identity here: transform setters are not used by the
  // motions this port targets), transformed by the parent matrix and offset by
  // the parent's accumulated position.
  function updateLayers(state) {
    const root = state.nodes[0];
    const d = state.rootDelta;
    root.accumulated = {
      dirty: true, visible: d.visible, flipX: d.flipX, flipY: d.flipY,
      posX: d.x, posY: d.y, posZ: 0, angle: d.angle,
      scaleX: d.zoomX, scaleY: d.zoomY, slantX: d.slantX, slantY: d.slantY,
      opacity: d.opacity, colors: [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff], ratio: 0,
    };
    root.matrix = localMatrix(d.flipX, d.flipY, d.angle, d.zoomX, d.zoomY, d.slantX, d.slantY, root.transformOrder);
    for (let i = 1; i < state.nodes.length; i++) {
      const node = state.nodes[i];
      const parent = state.nodes[node.parentIndex];
      // A pass-through ancestor is skipped for parenting (inheritFlags 0x400000).
      let parentIndex = node.parentIndex;
      while ((state.nodes[parentIndex].inheritFlags & 0x400000) !== 0) parentIndex = state.nodes[parentIndex].parentIndex;
      const effectiveParent = state.nodes[parentIndex];
      const dirty = node.accumulated.dirty || effectiveParent.accumulated.dirty;
      evaluateTimeline(node, state.frameTickCount, dirty);
      if (node.active.done) {
        // A finished node copies the parent state (delta defaults are identity).
        node.accumulated = { ...effectiveParent.accumulated, dirty: !!effectiveParent.accumulated.dirty };
        node.accumulated.visible = node.accumulated.visible && (node.deltaVisible ?? true);
        node.matrix = { ...effectiveParent.matrix };
        continue;
      }
      const a = node.accumulated;
      const visible = (node.deltaVisible ?? true) ? effectiveParent.accumulated.visible : false;
      a.dirty = true;
      a.visible = visible;
      a.flipX = a.flipX !== effectiveParent.accumulated.flipX;
      a.flipY = a.flipY !== effectiveParent.accumulated.flipY;
      a.scaleX *= effectiveParent.accumulated.scaleX;
      a.scaleY *= effectiveParent.accumulated.scaleY;
      a.slantX += effectiveParent.accumulated.slantX;
      a.slantY += effectiveParent.accumulated.slantY;
      a.angle += effectiveParent.accumulated.angle;
      a.opacity = multiplyOpacity(a.opacity, effectiveParent.accumulated.opacity);
      // Local position is rotated/scaled by the parent matrix, then translated.
      const localX = a.posX, localY = a.posY;
      a.posX = effectiveParent.matrix.m11 * localX + effectiveParent.matrix.m12 * localY + effectiveParent.accumulated.posX;
      a.posY = effectiveParent.matrix.m21 * localX + effectiveParent.matrix.m22 * localY + effectiveParent.accumulated.posY;
      node.matrix = localMatrix(a.flipX, a.flipY, a.angle, a.scaleX, a.scaleY, a.slantX, a.slantY, node.transformOrder);
      a.dirty = false;
    }
  }
  function calcBounds(state) {
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (let i = 1; i < state.nodes.length; i++) {
      const node = state.nodes[i];
      const source = node.source;
      if (!source || !source.width) continue;
      for (const [x, y] of [[0, 0], [source.width, 0], [0, source.height], [source.width, source.height]]) {
        const sx = x - source.originX - node.active.ox;
        const sy = y - source.originY - node.active.oy;
        const px = node.matrix.m11 * sx + node.matrix.m12 * sy + node.accumulated.posX;
        const py = node.matrix.m21 * sx + node.matrix.m22 * sy + node.accumulated.posY;
        left = Math.min(left, px); top = Math.min(top, py);
        right = Math.max(right, px); bottom = Math.max(bottom, py);
      }
    }
    if (!Number.isFinite(left)) return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, isValid: false };
    return { left, top, right, bottom, width: right - left, height: bottom - top, isValid: true };
  }

  // prepareRenderItems/executeLayerRenderCommands: walk the tree back-to-front
  // and blend each node's quad into the target layer image. The composite stays
  // in a straight-RGBA GPU texture. Ordinary and special blend modes share the
  // same shader path; intermediate frames are never read back to JavaScript.
  // prepareLayerForRender (PlayerRenderInternal.cpp 716) sizes the target from
  // the layer's own width/height and clips to the whole area before the items
  // are blended on top.
  function renderToTarget(state, targetValue) {
    const targetOwner = targetValue instanceof Closure ? targetValue.object : targetValue;
    const node = getLayerNode ? getLayerNode(targetOwner) : null;
    if (!node) throw new Error('TJS Motion draw requires a Layer');
    const width = Math.trunc(node.width), height = Math.trunc(node.height);
    if (width <= 0 || height <= 0) return;
    if (!node.image || node.image.width !== width || node.image.height !== height) {
      node.image = new Image(width, height, { defer: true });
    }
    node.width = width; node.height = height;
    node.clip = { left: 0, top: 0, right: width, bottom: height };
    const gpu = getGPU();
    if (!gpu) throw new Error('Motion requires an initialized GPU renderer');
    // Preserve the back-to-front child walk and its invisible-subtree pruning.
    const drawChildren = parent => {
      for (const item of parent.children) {
        if (!item.accumulated.visible) continue;
        const source = item.source;
        if (source && source.width && source.pixels) {
          const { matrix, posX, posY } = itemTransform(item, state.drawAffine);
          gpu.draw(node.image, source, {
            matrix: [matrix[0], matrix[1], matrix[2], matrix[3], posX, posY],
            mode: item.active.blendMode & 0x0f,
            opacity: item.accumulated.opacity,
            motion: true,
          });
        }
        drawChildren(item);
      }
    };
    drawChildren(state.nodes[0]);
    node.imageModified = true;
  }
  function itemTransform(item, transform) {
    const s = item.source, local = item.matrix;
    const accumulated = item.accumulated, active = item.active;
    const matrix = mat2.multiply([], [transform.m11, transform.m21, transform.m12, transform.m22],
      [local.m11, local.m21, local.m12, local.m22]);
    const ox = s.originX + active.ox, oy = s.originY + active.oy;
    const originX = accumulated.posX - local.m11 * ox - local.m12 * oy;
    const originY = accumulated.posY - local.m21 * ox - local.m22 * oy;
    return { matrix,
      posX: transform.m11 * originX + transform.m12 * originY + transform.m14,
      posY: transform.m21 * originX + transform.m22 * originY + transform.m24 };
  }
  const state = owner => Player.state(owner);
  Player.members.set('defaultSyncActive', new NativeProperty(() => Number(defaultSyncActive), (owner, value) => { defaultSyncActive = truth(value); }));
  Player.members.set('defaultTransformOrder', new NativeProperty(() => {
    const result = [];
    for (const entry of defaultTransformOrderGlobal) result.push(entry);
    return result;
  }, (owner, value) => {
    const array = value instanceof Closure ? value.object : value;
    if (Array.isArray(array) && array.length === 4) defaultTransformOrderGlobal = array.map(entry => Math.trunc(number(entry)));
  }));
  Player.members.set('resourceManager', new NativeProperty(owner => state(owner).resourceManager));
  // chara/motion are typed properties (Player.h 143-147): the chara setter
  // updates the live slot and clears the loaded labels; the motion setter routes
  // through play().
  Player.members.set('chara', new NativeProperty(
    owner => state(owner).charaName,
    (owner, value) => setChara(owner, String(value ?? '')),
  ));
  Player.members.set('motion', new NativeProperty(
    owner => state(owner).motionName,
    (owner, value) => playMotion(owner, String(value ?? ''), 0),
  ));
  // motionKey/project are read/write aliases over one persistent Variant used as
  // the findMotion project key (Player.h 152-158).
  const motionKeyProp = new NativeProperty(
    owner => state(owner).motionKey,
    (owner, value) => { state(owner).motionKey = value; state(owner).project = value; },
  );
  Player.members.set('motionKey', motionKeyProp);
  Player.members.set('project', motionKeyProp);
  Player.members.set('stealthChara', new NativeProperty(
    owner => state(owner).stealthChara,
    (owner, value) => { state(owner).stealthChara = String(value ?? ''); },
  ));
  Player.members.set('stealthMotion', new NativeProperty(
    owner => state(owner).stealthMotion,
    (owner, value) => { state(owner).stealthMotion = String(value ?? ''); return playMotion(owner, state(owner).stealthMotion, FLAG_STEALTH); },
  ));
  Player.members.set('lastTime', new NativeProperty(owner => state(owner).lastTime));
  Player.members.set('loopTime', new NativeProperty(owner => state(owner).loopTime));
  Player.members.set('variableKeys', new NativeProperty(owner => {
    const result = [];
    result.push(...state(owner).variables.keys());
    return result;
  }));
  Player.members.set('tags', new NativeProperty(owner => {
    const result = [];
    return result;
  }));
  Player.members.set('playing', new NativeProperty(owner => Number(state(owner).allplaying)));
  Player.members.set('allplaying', new NativeProperty(owner => Number(state(owner).allplaying)));
  Player.members.set('syncWaiting', new NativeProperty(owner => Number(state(owner).syncWaiting)));
  Player.members.set('syncActive', new NativeProperty(
    owner => Number(state(owner).syncActive),
    (owner, value) => { state(owner).syncActive = truth(value); },
  ));
  Player.members.set('preview', new NativeProperty(
    owner => Number(state(owner).preview),
    (owner, value) => { state(owner).preview = truth(value); },
  ));
  Player.members.set('priorDraw', new NativeProperty(
    owner => Number(state(owner).priorDraw),
    (owner, value) => { state(owner).priorDraw = truth(value); },
  ));
  Player.members.set('completionType', new NativeProperty(
    owner => state(owner).completionType,
    (owner, value) => { state(owner).completionType = Number(BigInt.asIntN(32, integer(value))); },
  ));
  Player.members.set('speed', new NativeProperty(
    owner => state(owner).speed,
    (owner, value) => { state(owner).speed = number(value); },
  ));
  Player.members.set('tickCount', new NativeProperty(
    owner => Math.trunc(state(owner).frameTickCount * 1000 / 60),
    (owner, value) => { state(owner).frameTickCount = number(value) * 60 / 1000; },
  ));
  Player.members.set('frameTickCount', new NativeProperty(
    owner => state(owner).frameTickCount,
    (owner, value) => { state(owner).frameTickCount = number(value); },
  ));
  Player.members.set('frameLastTime', new NativeProperty(owner => state(owner).lastTime));
  Player.members.set('frameLoopTime', new NativeProperty(owner => state(owner).loopTime));
  Player.members.set('transformOrder', new NativeProperty(owner => {
    const result = [];
    for (const entry of state(owner).transformOrder) result.push(entry);
    return result;
  }, (owner, value) => {
    const array = value instanceof Closure ? value.object : value;
    if (Array.isArray(array) && array.length === 4) state(owner).transformOrder = array.map(entry => Math.trunc(number(entry)));
  }));
  Player.members.set('coordinate', new NativeProperty(
    owner => state(owner).coordinate,
    (owner, value) => { state(owner).coordinate = Math.trunc(number(value)); },
  ));
  Player.members.set('useD3D', new NativeProperty(
    owner => state(owner).useD3D,
    (owner, value) => { state(owner).useD3D = Number(truth(value)); },
  ));
  Player.members.set('pixelateDivision', new NativeProperty(
    owner => 100,
    () => reportUnimplemented('Motion.Player.pixelateDivision setter'),
  ));
  Player.members.set('maskMode', new NativeProperty(
    owner => 0,
    () => reportUnimplemented('Motion.Player.maskMode setter'),
  ));
  Player.members.set('colorWeight', new NativeProperty(
    owner => state(owner).colorWeight,
    (owner, value) => { state(owner).colorWeight = Number(BigInt.asUintN(32, integer(value))); },
  ));
  Player.members.set('outsideFactor', new NativeProperty(
    owner => state(owner).outsideFactor,
    (owner, value) => { state(owner).outsideFactor = number(value); },
  ));
  Player.members.set('meshDivisionRatio', new NativeProperty(
    owner => state(owner).meshDivisionRatio,
    (owner, value) => { state(owner).meshDivisionRatio = number(value); },
  ));
  // Root transform surface (PlayerCore.cpp): the properties drive the synthetic
  // root node consumed by the main transform loop.
  const rootProp = (key, convert = number) => new NativeProperty(
    owner => state(owner).rootDelta[key],
    (owner, value) => { state(owner).rootDelta[key] = convert(value); },
  );
  Player.members.set('x', new NativeProperty(
    owner => state(owner).rootDelta.x,
    (owner, value) => { state(owner).rootDelta.x = number(value); },
  ));
  Player.members.set('y', new NativeProperty(
    owner => state(owner).rootDelta.y,
    (owner, value) => { state(owner).rootDelta.y = number(value); },
  ));
  Player.members.set('left', Player.members.get('x'));
  Player.members.set('top', Player.members.get('y'));
  Player.members.set('flipX', rootProp('flipX', truth));
  Player.members.set('flipY', rootProp('flipY', truth));
  Player.members.set('angleDeg', new NativeProperty(
    owner => state(owner).rootDelta.angle,
    (owner, value) => { state(owner).rootDelta.angle = number(value); },
  ));
  Player.members.set('angleRad', new NativeProperty(
    owner => state(owner).rootDelta.angle * Math.PI / 180,
    (owner, value) => { state(owner).rootDelta.angle = number(value) * 180 / Math.PI; },
  ));
  Player.members.set('zoomX', new NativeProperty(
    owner => state(owner).rootDelta.zoomX,
    (owner, value) => { state(owner).rootDelta.zoomX = number(value); },
  ));
  Player.members.set('zoomY', new NativeProperty(
    owner => state(owner).rootDelta.zoomY,
    (owner, value) => { state(owner).rootDelta.zoomY = number(value); },
  ));
  Player.members.set('slantX', new NativeProperty(
    owner => state(owner).rootDelta.slantX,
    (owner, value) => { state(owner).rootDelta.slantX = number(value); },
  ));
  Player.members.set('slantY', new NativeProperty(
    owner => state(owner).rootDelta.slantY,
    (owner, value) => { state(owner).rootDelta.slantY = number(value); },
  ));
  Player.members.set('opacity', new NativeProperty(
    owner => state(owner).rootDelta.opacity,
    (owner, value) => { state(owner).rootDelta.opacity = Math.max(0, Math.min(255, Math.trunc(number(value)))); },
  ));
  Player.members.set('visible', new NativeProperty(
    owner => Number(state(owner).rootDelta.visible),
    (owner, value) => { state(owner).rootDelta.visible = truth(value); },
  ));
  for (const name of ['setCoord', 'setFlip', 'setOpacity', 'setVisible', 'setSlant', 'setZoom']) {
    Player.members.set(name, function (...args) {
      const s = this;
      if (name === 'setCoord') { s.rootDelta.x = number(args[0]); s.rootDelta.y = number(args[1]); }
      else if (name === 'setFlip') { s.rootDelta.flipX = truth(args[0]); s.rootDelta.flipY = truth(args[1]); }
      else if (name === 'setOpacity') s.rootDelta.opacity = Math.max(0, Math.min(255, Math.trunc(number(args[0]))));
      else if (name === 'setVisible') s.rootDelta.visible = truth(args[0]);
      else if (name === 'setSlant') { s.rootDelta.slantX = number(args[0]); s.rootDelta.slantY = number(args[1]); }
      else if (name === 'setZoom') { s.rootDelta.zoomX = number(args[0]); s.rootDelta.zoomY = number(args[1]); }
    });
  }
  Player.members.set('bounds', new NativeProperty(owner => {
    const bounds = calcBounds(state(owner));
    const result = new Map();
    for (const [key, value] of Object.entries(bounds)) result.set(key, value);
    return result;
  }));
  Player.members.set('hasCamera', new NativeProperty(() => 0));
  Player.members.set('cameraActive', new NativeProperty(() => 0, () => reportUnimplemented('Motion.Player.cameraActive setter')));
  Player.members.set('stereovisionActive', new NativeProperty(() => 0, () => reportUnimplemented('Motion.Player.stereovisionActive setter')));
  Player.members.set('cameraAlive', new NativeProperty(() => 0));
  Player.members.set('cameraTarget', new NativeProperty(() => null));
  Player.members.set('cameraPosition', new NativeProperty(() => null));
  Player.members.set('cameraFOV', new NativeProperty(() => 0));
  Player.members.set('independentLayerInherit', new NativeProperty(() => 0, () => reportUnimplemented('Motion.Player.independentLayerInherit setter')));
  Player.members.set('zFactor', new NativeProperty(() => 0, () => reportUnimplemented('Motion.Player.zFactor setter')));
  for (const name of ['outline', 'meshline']) {
    Player.members.set(name, new NativeProperty(owner => state(owner)[name] ?? null, (owner, value) => {
      const s = state(owner), previous = s[name];
      s[name] = retainScriptValue(value, owner);
      return disposeScriptValue(previous);
    }));
  }
  Player.members.set('processedMeshVerticesNum', new NativeProperty(() => 0));
  for (const name of ['isExistMotion', 'calcParam']) Player.members.set(name, () => 0);
  return Player;
}

// Motion::ResourceManager native class (ResourceManager.cpp). Constructed by the
// game's MotionResourceManager wrapper with (cacheSize). `resolve` maps an
// instance owner (or Closure) to the backing JS manager so Player can call it
// without going through the VM.
export function createMotionResourceManagerClass(storage) {
  @nativeClass('ResourceManager')
  class Manager {
    static initialize() { return new MotionResourceManager(storage); }
    @nativeMethod ResourceManager(...args) {}
  }
  const manager = owner => Manager.state(owner instanceof Closure ? owner.object : owner);
  Manager.resolve = owner => {
    const object = owner instanceof Closure ? owner.object : owner;
    return object == null ? null : Manager.instances.get(object) ?? null;
  };
  const method = name => function (...args) {
    const m = manager(this);
    switch (name) {
      case 'load': return m.load(args[0]);
      case 'unload': return m.unload(args[0]);
      case 'unloadAll': return m.unloadAll();
      case 'clearCache': return m.clearCache();
      case 'loadSource': return m.loadSource?.(...args);
      case 'isExistMotion': return Number(m.hasProject(String(args[0])));
      case 'findMotion': return m.findMotion(String(args[0]), { chara: String(args[1] ?? ''), motion: String(args[2] ?? '') });
      case 'findSource': return m.findSource(String(args[0]), String(args[1]));
      case 'random': return m.random();
      case 'requireLayerId': return m.requireLayerId();
      case 'releaseLayerId': return m.releaseLayerId(args[0]);
      default: return undefined;
    }
  };
  for (const name of ['load', 'unload', 'unloadAll', 'clearCache', 'loadSource', 'isExistMotion', 'findMotion', 'findSource', 'random', 'requireLayerId', 'releaseLayerId']) {
    Manager.members.set(name, method(name));
  }
  Manager.members.set('bufLayer', new NativeProperty(owner => manager(owner).bufferLayer));
  return Manager;
}
