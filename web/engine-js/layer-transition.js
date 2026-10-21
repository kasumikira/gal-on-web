// Layer transition snapshots and lifecycle, matching LayerIntf.cpp
// StartTransition / StopTransition and the built-in crossfade handler.
import { Image } from './bitmap.js';
import { getGPU } from './gpu.js';
import { findTransition } from './layer-transition-effects.js';
import { exchangeLayers } from './layer-tree.js';
import { number, truth } from '#krkr/values';
import { reportUnimplemented, script, nativeOwner, retainScriptValue, disposeScriptValue } from '#krkr/native';

export function createLayerTransitions(document, {
  getLayer,
  instanceOf,
  updateTree,
  enqueueEvent,
  onTransitionError,
  onTransitionUnknown,
  ltOpaque,
  loadGraphic,
}) {
  const view = document.defaultView;
  let scheduling = true;
  // LayerManager/DrawDevice composites the transition's Src1/Src2 from the
  // completed layer tree, not just the node's main image. With children the
  // subtree is flattened; without children only the node's main image is used
  // (LayerIntf.cpp 7925 passes GetWidth() or MainImage->GetWidth() accordingly).
  function renderTreeImage(node, withchildren, result = null) {
    const image = node.image;
    if (!withchildren) return image ? image.clone() : null;
    const gpu = getGPU();
    const width = node.width, height = node.height;
    if (!width || !height) return image ? image.clone() : null;
    if (!result || result.width !== width || result.height !== height) {
      result = new Image(width, height, { defer: true });
    } else {
      gpu.fill(result, { left: 0, top: 0, right: width, bottom: height }, [0, 0, 0, 0]);
    }
    const commands = [];
    const paint = (current, offsetX, offsetY, parentOpacity, parentClip) => {
      const left = Math.max(parentClip.left, offsetX + current.left);
      const top = Math.max(parentClip.top, offsetY + current.top);
      const right = Math.min(parentClip.right, offsetX + current.left + current.width);
      const bottom = Math.min(parentClip.bottom, offsetY + current.top + current.height);
      if (left >= right || top >= bottom) return;
      const opacity = current === node ? 255 : parentOpacity * current.opacity / 255;
      const img = current.image;
      if (img && img.width && img.height) {
        commands.push({ source: img, options: {
          matrix: [1, 0, 0, 1, offsetX + current.left + current.imageLeft, offsetY + current.top + current.imageTop],
          clip: { left, top, right, bottom },
          mode: 0,
          motion: true,
          opacity,
          opaque: current.type === ltOpaque,
        } });
      }
      for (const child of current.children) {
        if (!child.visible) continue;
        paint(child, offsetX + current.left, offsetY + current.top, opacity, { left, top, right, bottom });
      }
    };
    paint(node, -node.left, -node.top, 255, { left: 0, top: 0, right: width, bottom: height });
    gpu.compositeOffscreen(result, commands);
    return result;
  }

  // LayerIntf.cpp attaches a tTVPScanLineProviderForBaseBitmap to MainImage,
  // so a transition reads the *live* layer bitmaps. The childless form is
  // therefore used directly, and only the flattened subtree form is memoised,
  // keyed on the revisions the compositor also uses to invalidate uploads (plus
  // the layout and child identity the flatten result depends on). Rebuilding it
  // every frame cost 12..68ms per source at 1920x1080.
  const nodeIds = new WeakMap();
  let nextNodeId = 1;
  const nodeId = node => {
    let id = nodeIds.get(node);
    if (id === undefined) nodeIds.set(node, id = nextNodeId++);
    return id;
  };
  const snapshotStamp = node => {
    let stamp = node.imageRevision >>> 0;
    for (const value of [node.left, node.top, node.width, node.height, node.opacity, node.type, node.imageLeft, node.imageTop]) {
      stamp = (stamp * 31 + (value | 0)) >>> 0;
    }
    stamp = (stamp * 31 + (node.visible ? 1 : 0)) >>> 0;
    for (const child of node.children) stamp = (stamp * 31 + snapshotStamp(child) * 31 + nodeId(child)) >>> 0;
    return stamp;
  };
  const snapshots = new WeakMap();
  function transitionSource(node, withchildren) {
    if (!withchildren) return node.image ?? null;
    const stamp = snapshotStamp(node);
    const cached = snapshots.get(node);
    if (cached && cached.stamp === stamp && !hasExternallyWritableImage(node, true)) return cached.image;
    // LayerIntf.cpp reuses CacheBitmap for completion. Repaint that storage
    // instead of allocating a full-sized GPU target on every revision.
    const image = renderTreeImage(node, withchildren, cached?.image);
    snapshots.set(node, { stamp, image });
    return image;
  }
  function transitionSourceRevision(node, withchildren) {
    return withchildren ? snapshots.get(node)?.stamp : node.imageRevision;
  }
  function hasExternallyWritableImage(node, withchildren) {
    if (node.image?.externallyWritable) return true;
    return withchildren && node.children.some(child => hasExternallyWritableImage(child, true));
  }

  // LayerIntf.cpp StartTransition and TransIntf.cpp handler providers.
  async function beginTransition(name, withchildren, transsrc, options) {
    const Layer = getLayer();
    if (!arguments.length) throw new Error('TJS Layer.beginTransition requires a name');
    const node = instanceOf(this);
    if (node.transition) throw new Error('TJS current transition must be stopping');
    const srcOwner = nativeOwner(transsrc);
    const srcNode = srcOwner && Layer.state(srcOwner) ? instanceOf(srcOwner) : null;
    if (!srcNode) throw new Error('TJS specify layer');
    if (srcNode.transition?.src === node) throw new Error('TJS transition mutual source');
    const heldOptions = options == null ? options : retainScriptValue(options);
    const owner = nativeOwner(this);
    const children = withchildren === undefined || truth(withchildren);
    const option = async (key, defaultValue) => {
      if (heldOptions == null) return defaultValue;
      let value;
      try { value = await script(heldOptions)[key]; }
      catch (error) {
        if (!error.message.startsWith('TJS member not found: ')) throw error;
      }
      return value === undefined ? defaultValue : value;
    };
    const required = async key => {
      const value = await option(key);
      if (value === undefined) throw new Error('TJS specify option ' + key);
      return value;
    };
    try {
    const time = Math.max(2, Math.trunc(number(await required('time'))));
    const handlerName = String(name);
    let provider = findTransition(handlerName), handler = handlerName;
    if (!provider) {
      // TVPFindTransHandlerProvider's documented unknown-provider fallback.
      reportUnimplemented('Layer.beginTransition("' + handlerName + '"): transition handler not registered');
      if (onTransitionUnknown) onTransitionUnknown(handlerName);
      provider = findTransition('crossfade'); handler = 'crossfade';
    }
    const src1 = transitionSource(node, children), src2 = transitionSource(srcNode, children);
    if (!src1 || !src2) throw new Error('TJS transition source and destination must have image');
    const src1Revision = transitionSourceRevision(node, children);
    const src2Revision = transitionSourceRevision(srcNode, children);
    if (src1.width !== src2.width || src1.height !== src2.height) {
      throw new Error('TJS transition layer size mismatch ' + src2.width + 'x' + src2.height + ' vs ' + src1.width + 'x' + src1.height);
    }
    const effect = await provider({ option, required, loadGraphic, width: src1.width, height: src1.height, type: node.displayType, time });
    const selfupdate = truth(await option('selfupdate', false));
    const callback = await option('callback');
    node.transition = {
      name: handlerName, handler, withchildren: children, effect, callback, selfupdate,
      src: srcNode, srcOwner, start: callback === undefined ? performance.now() : 0, time,
      src1, src2, src1Revision, src2Revision, phase: 0, frame: src1.copyReference(), revision: 0,
    };
    const reportTransition = error => { if (onTransitionError) onTransitionError(error); else console.error(error); };
    const step = () => {
      if (!scheduling) return;
      const heldOwner = retainScriptValue(owner);
      const advance = () => heldOwner.invalid ? undefined : advanceTransition(heldOwner);
      const release = () => disposeScriptValue(heldOwner);
      const queued = enqueueEvent ? enqueueEvent(advance, release) : Promise.resolve().then(advance).finally(release);
      Promise.resolve(queued).then(() => {
        if (scheduling && node.transition && !node.transition.selfupdate) node.transition.raf = view.requestAnimationFrame(step);
      }).catch(reportTransition);
    };
    if (scheduling && !selfupdate) node.transition.raf = view.requestAnimationFrame(step);
    updateTree(node);
    } finally {
      await disposeScriptValue(heldOptions);
    }
  }

  async function advanceTransition(owner) {
    const Layer = getLayer(), node = instanceOf(owner), t = node.transition;
    if (!t) return;
    const tick = t.callback === undefined ? performance.now() : number(await script(t.callback)());
    // A script tick callback may stop or replace this transition.
    if (node.transition !== t) return;
    let visible = true;
    for (let walk = node; walk; walk = walk.parent) if (!walk.visible) { visible = false; break; }
    if (!visible) { await stopTransition.call(owner); return; }
    const phase = Math.min(t.effect.maxPhase, Math.trunc((tick - t.start) * t.effect.maxPhase / t.time));
    const src1 = transitionSource(node, t.withchildren);
    const src2 = transitionSource(t.src, t.withchildren);
    const src1Revision = transitionSourceRevision(node, t.withchildren);
    const src2Revision = transitionSourceRevision(t.src, t.withchildren);
    const unchanged = phase === t.phase && src1 === t.src1 && src2 === t.src2 &&
      src1Revision === t.src1Revision && src2Revision === t.src2Revision;
    t.src1 = src1;
    t.src2 = src2;
    if (unchanged && phase < t.effect.maxPhase &&
      !hasExternallyWritableImage(node, t.withchildren) && !hasExternallyWritableImage(t.src, t.withchildren)) return;
    if (phase === 0) t.frame.assign(t.src1);
    else if (phase >= t.effect.maxPhase) t.frame.assign(t.src2);
    else t.effect.render(t.frame, t.src1, t.src2, phase);
    t.phase = phase;
    t.src1Revision = src1Revision;
    t.src2Revision = src2Revision;
    t.revision++;
    if (!t.selfupdate) updateTree(node);
    if (phase >= t.effect.maxPhase) await stopTransition.call(owner);
  }

  async function stopTransition() {
    const Layer = getLayer();
    const owner = nativeOwner(this);
    const node = instanceOf(owner);
    const t = node.transition;
    if (!t) return;
    // LayerIntf.cpp 8112: InTransition clears first, so onTransitionCompleted
    // may start a new transition.
    node.transition = null;
    view.cancelAnimationFrame(t.raf);
    const srcNode = t.src;
    exchangeLayers(node, srcNode, !t.withchildren);
    updateTree(node);
    updateTree(srcNode);
    // LayerIntf.cpp 8165: onTransitionCompleted(dest, src) on the owner.
    const srcOwner = t.srcOwner;
    try {
      if (srcOwner) await script(owner).onTransitionCompleted(owner, srcOwner);
    } finally { await disposeScriptValue(t.callback); }
  }

  return {
    renderTreeImage,
    transitionSource,
    advanceTransition,
    beginTransition,
    stopTransition,
    stopScheduling(node) {
      scheduling = false;
      if (node?.transition?.raf) view.cancelAnimationFrame(node.transition.raf);
      if (node?.transition) node.transition.raf = 0;
    },
  };
}
