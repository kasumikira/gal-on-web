// tTJSNI_BaseLayer / tTJSNC_Layer (LayerIntf.cpp): layer state and TJS bindings.
import { nativeClass, nativeMethod, nativeProperty, nativeMembers, nativeGlobals, nativeConstructor, nativeOwner, nativeDictionary, callScript, retainScriptValue, disposeScriptValue, registerLayerFields, registerLayerMethods, nativeLayerFont } from '#krkr/native';
import { Image, toActualColor, clamp255, copy9Patch, flipImage } from './bitmap.js';
import { FontState, createTextRenderer } from './font.js';
import { setAbsoluteOrderMode, joinLayer, setLayerOrder, detachLayerTree, isAncestorOrSelf, isNodeEnabled, layerOffset } from './layer-tree.js';
import { createLayerTransitions } from './layer-transition.js';
import { createLayerDrawing } from './layer-drawing.js';
import { installLayerInput } from './layer-input.js';
import { installLayerStorage } from './layer-storage.js';
import { number, truth, string } from '#krkr/values';
export const ltBinder = 0,
  ltOpaque = 1,
  ltTransparent = 2,
  ltAlpha = 2,
  ltAdditive = 3,
  ltSubtractive = 4,
  ltMultiplicative = 5,
  ltEffect = 6,
  ltFilter = 7,
  ltDodge = 8,
  ltDarken = 9,
  ltLighten = 10,
  ltScreen = 11,
  ltAddAlpha = 12;
export const dfBoth = 0,
  dfAlpha = dfBoth,
  dfMain = 1,
  dfMask = 2,
  dfProvince = 3,
  dfAuto = 128;
export const htMask = 0,
  htProvince = 1;

// Layer tree node. Rect is {left, top, right, bottom} like tTVPRect; width is
// right-left (Rect.get_width()).
class Node {
  constructor(owner) {
    this.owner = owner;
    this.parent = null;
    this.children = [];
    this.orderIndex = 0;
    this.manager = null;
    this.visible = false;
    this.opacity = 255;
    this.left = 0;
    this.top = 0;
    this.width = 32;
    this.height = 32;
    this.imageLeft = 0;
    this.imageTop = 0;
    this.type = ltAlpha;
    this.displayType = ltAlpha;
    this.neutralColor = 0x00ffffff;
    this.transparentColor = 0x00ffffff;
    this.face = dfAuto;
    this.drawFace = dfAlpha;
    this.holdAlpha = false;
    this.clip = null;
    this.image = new Image(32, 32);
    this.province = null;
    this.imageRevision = 0;
    this.imageDirtyFull = true;
    this.imageDirtyRect = null;
    this.imageModified = true;
    this.hitType = htMask;
    this.hitThreshold = 16;
    this.font = new FontState();
    this.callOnPaint = false;
    this.enabled = true;
    this.enabledWork = true;
    this.focusable = false;
    this.joinFocusChain = true;
    this.focusWork = null;
    this.absoluteOrderMode = false;
    this.absoluteOrderIndex = 0;
    this.transition = null;
    this.window = null;
    this.isPrimary = false;
    this.cursor = 0;
    this.cursorX = 0;
    this.cursorY = 0;
    this.hint = '';
    this.cached = false;
    this.showParentHint = true;
    this.ignoreHintSensing = false;
    this.attentionLeft = 0;
    this.attentionTop = 0;
    this.useAttention = false;
    this.imeMode = 3;
    this.name = 'Layer';
    this.actionOwner = owner; // TJS action closure object
  }
  get invalid() { return nativeOwner(this.owner).invalid; }
  get right() {
    return this.left + this.width;
  }
  get bottom() {
    return this.top + this.height;
  }
  get imageModified() {
    return this._imageModified;
  }
  set imageModified(value) {
    this._imageModified = value;
    if (value) this.markImageModified();
  }
  markImageModified(rect) {
    this._imageModified = true;
    this.imageRevision++;
    if (!rect) {
      this.imageDirtyFull = true;
      this.imageDirtyRect = null;
      return;
    }
    if (this.imageDirtyFull) return;
    const dirty = this.imageDirtyRect;
    this.imageDirtyRect = dirty ? {
      left: Math.min(dirty.left, rect.left), top: Math.min(dirty.top, rect.top),
      right: Math.max(dirty.right, rect.right), bottom: Math.max(dirty.bottom, rect.bottom),
    } : { ...rect };
  }
}
export function createLayerClass(document, {
  onLayerChange,
  loadGraphic,
  Window,
  Bitmap,
  storage,
  enqueueEvent,
  onTransitionError,
  onTransitionUnknown
}) {
  const drawText = createTextRenderer(document);
  const updateTree = node => {
    if (onLayerChange) onLayerChange();
  };
  const instanceOf = owner => {
    const state = Layer.state(owner);
    if (!state.node) {
      state.node = new Node(owner);
    }
    return state.node;
  };
  // Peek without creating: compositor and input dispatch read-only access.
  const peekNode = owner => {
    const state = Layer.state?.(owner);
    return state?.node ?? null;
  };
  // LayerIntf.cpp ImageLayerSizeChanged: a layer may be smaller than its
  // bitmap, but growing its rect grows existing image planes with fill.
  const resizeLayer = (node, width, height) => {
    node.width = width;
    node.height = height;
    if (node.image) {
      const w = Math.max(width, node.image.width),
        h = Math.max(height, node.image.height);
      if (w !== node.image.width || h !== node.image.height) {
        node.image = node.image.resize(w, h, node.neutralColor);
        if (node.province) node.province = node.province.resized(w, h);
        node.clip = null;
        node.imageModified = true;
      }
      if (node.image.width + node.imageLeft < width) node.imageLeft = width - node.image.width;
      if (node.image.height + node.imageTop < height) node.imageTop = height - node.image.height;
    }
    updateTree(node);
  };
  if (Window) Window.getLayerNode = instanceOf;
  const adjustImageRect = node => {
    const {
      width,
      height
    } = node.image;
    if (width < node.width) {
      node.width = width;
      node.imageLeft = 0;
    }
    if (height < node.height) {
      node.height = height;
      node.imageTop = 0;
    }
    if (width + node.imageLeft < node.width) node.imageLeft = node.width - width;
    if (height + node.imageTop < node.height) node.imageTop = node.height - height;
  };
  // LayerIntf.cpp AssignImages assigns each source plane into the destination
  // plane. tTVPNativeBaseBitmap::Assign only references the source texture
  // (unconditionally, including a different size); a plane that has no
  // destination yet is constructed as a new wrapper around the same texture
  // (tTVPNativeBaseBitmap copy constructor).
  const assignPlane = (target, source) => {
    if (!source) return null;
    return target ? target.assign(source) : source.copyReference();
  };
  const samePlane = (target, source) => !!target && !!source &&
    (target === source || target._storage === source._storage);
  const drawingRect = (node, x, y, w, h) => {
    const clip = node.clip ?? {
      left: 0,
      top: 0,
      right: node.image.width,
      bottom: node.image.height
    };
    return {
      left: Math.max(x, clip.left),
      top: Math.max(y, clip.top),
      right: Math.min(x + w, clip.right),
      bottom: Math.min(y + h, clip.bottom)
    };
  };
  const copyRegion = (node, dx, dy, sx, sy, sw, sh) => {
    const rect = drawingRect(node, dx, dy, sw, sh);
    return {
      dx: rect.left,
      dy: rect.top,
      rect: {
        left: sx + rect.left - dx,
        top: sy + rect.top - dy,
        right: sx + rect.right - dx,
        bottom: sy + rect.bottom - dy
      }
    };
  };
  const fillProvince = (node, rect, value) => {
    if (rect.right <= rect.left || rect.bottom <= rect.top) return;
    if (value) node.province ??= new Image(node.image.width, node.image.height, {
      gray: true
    });
    if (!node.province) return;
    if (!value && rect.left === 0 && rect.top === 0 && rect.right === node.province.width && rect.bottom === node.province.height) node.province = null;else node.province.fill(rect, value);
  };
  // LayerIntf.cpp ChangeImageSize: resize both existing planes with
  // SetSizeWithFill, reset the clip rectangle, and mark the layer modified.
  // The caller schedules the layer update after adjusting its geometry.
  const changeImageSize = (node, width, height) => {
    if (width <= 0 || height <= 0) throw new Error('TJS cannot create empty layer image');
    if (node.image) node.image.resize(width, height, node.neutralColor);
    if (node.province) node.province.resize(width, height, 0);
    if (node.image) node.clip = null;
    node.imageModified = true;
  };
  // LayerIntf.cpp InternalSetImageSize: shrink the display rectangle first,
  // adjust the image offset, then resize the image planes to the new size.
  const internalSetImageSize = (node, width, height) => {
    if (width < node.width) {
      node.imageLeft = 0;
      resizeLayer(node, width, node.height);
    }
    if (width + node.imageLeft < node.width) node.imageLeft = node.width - width;
    if (height < node.height) {
      node.imageTop = 0;
      resizeLayer(node, node.width, height);
    }
    if (height + node.imageTop < node.height) node.imageTop = node.height - height;
    changeImageSize(node, width, height);
  };
  // LayerIntf.cpp SetImageSize: identical dimensions are a no-op before
  // InternalSetImageSize runs.
  const resizeImage = (node, width, height) => {
    if (!node.image) throw new Error('TJS layer has no image');
    if (width === node.image.width && height === node.image.height) return;
    internalSetImageSize(node, width, height);
    updateTree(node);
  };
  const dispatchAction = async (owner, type, fields = {}) => {
    const node = instanceOf(owner);
    const event = nativeDictionary(owner, [['type', type], ['target', owner], ...Object.entries(fields)]);
    if (node.actionOwner != null) {
      const result = await callScript(node.actionOwner, 'action', [event], {
        receiver: owner,
        ignoreMissing: true,
      });
      await disposeScriptValue(result);
    }
    return event;
  };
  const {
    renderTreeImage,
    advanceTransition,
    stopScheduling: stopTransitionScheduling,
    ...transitionMethods
  } = createLayerTransitions(document, {
    getLayer: () => Layer,
    instanceOf,
    updateTree,
    enqueueEvent,
    onTransitionError,
    onTransitionUnknown,
    ltOpaque,
    loadGraphic
  });
  // The member table keeps its spread (transition methods, drawing
  // operations) and is annotated as a whole; the VM mount scans it and
  // registers every annotated function as a native member.
  @nativeClass('Layer')
  @nativeMembers({
    ...transitionMethods
  })
  class Layer {
    constructor() { this.node = new Node(this); }
    @nativeConstructor
    initialize(windowOrOwner, parent) {
      if (arguments.length < 2) throw new Error('TJS Layer requires a window and parent');
      const node = this.node = instanceOf(this);
      const windowOwner = nativeOwner(windowOrOwner);
      node.window = Window.state(windowOwner);
      // LayerIntf.cpp Construct: parent given -> same manager; else this
      // becomes a primary layer attached to a fresh manager.
      if (parent !== undefined && parent !== null && parent !== void 0) {
        const parentOwner = nativeOwner(parent);
        const parentNode = Layer.state(parentOwner) && instanceOf(parentOwner);
        if (parentNode) {
          joinLayer(node, parentNode);
          node.window = parentNode.window;
        }
      } else {
        node.isPrimary = true;
        node.type = node.displayType = ltOpaque;
        node.drawFace = dfMain;
        node.neutralColor = 0xffffffff;
        node.hitThreshold = 0;
        node.window.primaryLayer ??= node;
        node.window.layers.push(nativeOwner(this));
        // LayerManager.cpp 203: attaching the primary layer makes it visible.
        node.visible = true;
        if (!node.image || node.image.width !== node.width || node.image.height !== node.height) {
          node.image = new Image(node.width, node.height);
          node.image.fill({
            left: 0,
            top: 0,
            right: node.width,
            bottom: node.height
          }, node.neutralColor);
        }
      }
      // ActionOwner = param[0] (the layer itself in the native form).
      node.manager ??= {};
      node.actionOwner = retainScriptValue(windowOrOwner, this);
      node.vmGlobal = nativeGlobals(this);
    }
    @nativeMethod
    setPos(x, y, w, h) {
      const node = this.node;
      if (arguments.length < 2) throw new Error('TJS Layer.setPos requires left and top');
      if (node.isPrimary && (node.left !== Math.trunc(number(x)) || node.top !== Math.trunc(number(y)))) throw new Error('TJS cannot move primary layer');
      if (arguments.length === 4 && w !== undefined && h !== undefined) {
        node.left = Math.trunc(number(x));
        node.top = Math.trunc(number(y));
        resizeLayer(node, Math.trunc(number(w)), Math.trunc(number(h)));
      } else {
        node.left = Math.trunc(number(x));
        node.top = Math.trunc(number(y));
      }
      updateTree(node);
    }
    @nativeMethod
    setSize(w, h) {
      if (arguments.length < 2) throw new Error('TJS Layer.setSize requires width and height');
      const node = this.node;
      resizeLayer(node, Math.trunc(number(w)), Math.trunc(number(h)));
    }
    @nativeMethod
    setSizeToImageSize() {
      const node = this.node;
      if (node.image) {
        node.width = node.image.width;
        node.height = node.image.height;
      }
      updateTree(node);
    }
    @nativeMethod
    setImagePos(x, y) {
      if (arguments.length < 2) throw new Error('TJS Layer.setImagePos requires left and top');
      const node = this.node;
      node.imageLeft = Math.trunc(number(x));
      node.imageTop = Math.trunc(number(y));
      updateTree(node);
    }
    @nativeMethod
    setImageSize(w, h) {
      if (arguments.length < 2) throw new Error('TJS Layer.setImageSize requires width and height');
      const node = this.node;
      resizeImage(node, Math.trunc(number(w)), Math.trunc(number(h)));
    }
    @nativeMethod
    independMainImage(copy = true) {
      const node = this.node;
      if (node.image) node.image.detach(arguments.length ? truth(copy) : true);
    }
    @nativeMethod
    independProvinceImage(copy = true) {
      const node = this.node;
      if (node.province) node.province.detach(arguments.length ? truth(copy) : true);
    }
    @nativeMethod
    setClip(x, y, w, h) {
      const node = this.node;
      if (!arguments.length) {
        node.clip = null;
        return;
      }
      if (arguments.length < 4) throw new Error('TJS Layer.setClip requires 4 arguments');
      node.setClipImpl(Math.trunc(number(x)), Math.trunc(number(y)), Math.trunc(number(w)), Math.trunc(number(h)));
    }
    @nativeMethod
    fillRect(x, y, w, h, color) {
      if (arguments.length < 5) throw new Error('TJS Layer.fillRect requires 5 arguments');
      const node = this.node;
      const left = Math.trunc(number(x)),
        top = Math.trunc(number(y));
      const rect = {
        left,
        top,
        right: left + Math.trunc(number(w)),
        bottom: top + Math.trunc(number(h))
      };
      if (node.clip) {
        rect.left = Math.max(rect.left, node.clip.left);
        rect.top = Math.max(rect.top, node.clip.top);
        rect.right = Math.min(rect.right, node.clip.right);
        rect.bottom = Math.min(rect.bottom, node.clip.bottom);
      }
      const argb = Math.trunc(number(color)) >>> 0;
      if (node.drawFace === dfProvince) {
        fillProvince(node, rect, argb & 255);
      } else if (node.drawFace === dfMask) {
        node.image.fill(rect, (argb & 255) << 24, true);
      } else if (node.drawFace === dfMain && node.holdAlpha) {
        node.image.fillColor(rect, argb, 255);
      } else {
        node.image.fill(rect, (argb & 0xff000000 | toActualColor(argb & 0xffffff) & 0xffffff) >>> 0);
      }
      node.imageModified = true;
      updateTree(node);
    }
    @nativeMethod
    colorRect(x, y, w, h, color, opa = 255) {
      if (arguments.length < 5) throw new Error('TJS Layer.colorRect requires 5 arguments');
      const node = this.node;
      const left = Math.trunc(number(x)),
        top = Math.trunc(number(y));
      const rect = drawingRect(node, left, top, Math.trunc(number(w)), Math.trunc(number(h)));
      opa = Math.trunc(number(opa));
      if (node.drawFace === dfProvince) {
        fillProvince(node, rect, Math.trunc(number(color)) & 255);
      } else if (node.drawFace === dfMask) {
        node.image.fill(rect, (Math.trunc(number(color)) & 255) << 24, true);
      } else if (node.drawFace === dfAlpha) {
        // tTJSNI_BaseLayer::ColorRect: FillColorOnAlpha, or RemoveConstOpacity.
        if (opa > 0) node.image.blendColor(rect, color, opa);
        else if (opa < 0) node.image.removeConstOpacity(rect, -opa);
      } else if (node.drawFace === 4) {
        if (opa < 0) throw new Error('TJS negative opacity not supported on additive alpha face');
        node.image.blendColor(rect, color, opa, true);
      } else {
        node.image.fillColor(rect, color, opa);
      }
      node.imageModified = true;
      updateTree(node);
    }
    @nativeMethod
    drawText(x, y, text, color, opa = 255, aa = true, shadowLevel = 0, shadowColor = 0, shadowWidth = 0, shadowOfsx = 0, shadowOfsy = 0) {
      if (arguments.length < 4) throw new Error('TJS Layer.drawText requires 4 arguments');
      const node = this.node;
      drawText(node, Math.trunc(number(x)), Math.trunc(number(y)), string(text), toActualColor(color), Math.trunc(number(opa)), truth(aa), Math.trunc(number(shadowLevel)), toActualColor(shadowColor), Math.trunc(number(shadowWidth)), Math.trunc(number(shadowOfsx)), Math.trunc(number(shadowOfsy)));
      updateTree(node);
    }
    @nativeMethod
    copyRect(dx, dy, src, sx, sy, sw, sh) {
      if (arguments.length < 7) throw new Error('TJS Layer.copyRect requires 7 arguments');
      const node = this.node;
      const srcOwner = nativeOwner(src);
      const srcNode = typeof srcOwner === 'object' && srcOwner && Layer.state(srcOwner) ? instanceOf(srcOwner) : null;
      const srcImage = srcNode ? srcNode.image : srcOwner;
      const region = copyRegion(node, ...[dx, dy, sx, sy, sw, sh].map(v => Math.trunc(number(v))));
      if (node.drawFace === dfProvince) {
        if (srcNode?.province) {
          node.province ??= new Image(node.image.width, node.image.height, {
            gray: true
          });
          node.province.copyRect(region.dx, region.dy, srcNode.province, region.rect);
        } else fillProvince(node, drawingRect(node, region.dx, region.dy, region.rect.right - region.rect.left, region.rect.bottom - region.rect.top), 0);
      } else {
        if (!(srcImage instanceof Image)) throw new Error('TJS source layer has no image');
        node.image.copyRect(region.dx, region.dy, srcImage, region.rect, {
          main: node.drawFace !== dfMask,
          mask: node.drawFace !== dfMain || !node.holdAlpha
        });
      }
      node.imageModified = true;
      updateTree(node);
    }
    @nativeMethod
    piledCopy(dx, dy, src, sx, sy, sw, sh) {
      if (arguments.length < 7) throw new Error('TJS Layer.piledCopy requires 7 arguments');
      const node = this.node,
        source = instanceOf(nativeOwner(src));
      if (!node.image || !source.image) throw new Error('TJS piledCopy requires source and destination images');
      const region = copyRegion(node, ...[dx, dy, sx, sy, sw, sh].map(v => Math.trunc(number(v))));
      const image = renderTreeImage(source, true);
      if (!image) throw new Error('TJS source layer has no image');
      node.image.copyRect(region.dx, region.dy, image, region.rect);
      node.imageModified = true;
      updateTree(node);
    }
    // LayerIntf.cpp Copy9Patch / LayerBitmapIntf.cpp Copy9Patch: 9-slice the
    // source across the destination, with the margins auto-detected from the
    // transparent border in the source's top row and left column.
    @nativeMethod
    copy9Patch(src) {
      if (!arguments.length) throw new Error('TJS Layer.copy9Patch requires a source layer');
      const node = this.node;
      const srcOwner = nativeOwner(src);
      const srcNode = Layer.state(srcOwner) ? instanceOf(srcOwner) : null;
      const source = srcNode ? srcNode.image : srcOwner;
      if (!source || !(source instanceof Image)) throw new Error('TJS specify layer');
      copy9Patch(node.image, source);
      node.imageModified = true;
      updateTree(node);
    }
    @nativeMethod
    doGrayScale() {
      const node = this.node;
      if (!node.image) return;
      node.image.transform({ left: 0, top: 0, right: node.image.width, bottom: node.image.height }, 'grayscale');
      node.imageModified = true;
      updateTree(node);
    }
    @nativeMethod
    flipLR() {
      const node = this.node;
      if (!node.image) return;
      node.image = flipImage(node.image, true);
      node.imageModified = true;
      updateTree(node);
    }
    @nativeMethod
    flipUD() {
      const node = this.node;
      if (!node.image) return;
      node.image = flipImage(node.image, false);
      node.imageModified = true;
      updateTree(node);
    }
    @nativeMethod
    convertType(fromType) {
      if (!arguments.length) throw new Error('TJS Layer.convertType requires a source draw face');
      const node = this.node,
        from = Math.trunc(number(fromType));
      const to = node.drawFace;
      if (!(to === 4 && from === dfAlpha || to === dfAlpha && from === 4)) throw new Error('TJS cannot convert layer type using given direction');
      const image = node.image;
      // TVPConvertAlphaToAdditiveAlpha (mulColor by alpha) and
      // TVPConvertAdditiveAlphaToAlpha (TVPDivTable, zero alpha stays zero).
      if (image) image.transform({ left: 0, top: 0, right: image.width, bottom: image.height }, to === 4 ? 'alphaToAdditive' : 'additiveToAlpha');
      node.imageModified = true;
      updateTree(node);
    }
    @nativeMethod
    update(l, t, w, h) {
      if (arguments.length && arguments.length < 4) throw new Error('TJS Layer.update requires zero or four arguments');
      const node = this.node;
      // BeforeCompletion consumes this flag at the compositor's frame boundary.
      // An update from onPaint requests the next frame, not another queue turn.
      node.callOnPaint = true;
      updateTree(node);
    }
    @nativeMethod
    setCursorPos(x, y) {
      const node = this.node;
      node.cursorX = Math.trunc(number(x));
      node.cursorY = Math.trunc(number(y));
    }
    @nativeMethod
    releaseCapture() {
      // LayerIntf.cpp releases its manager's capture regardless of which
      // layer owns it; it does not change the hovered layer.
      this.node.window?.releaseMouseCapture?.();
    }
    @nativeMethod
    async setMode() {
      const node = this.node,
        window = node.window;
      if (!window) return;
      // The native manager rejects a duplicate entry, but the script callback
      // can be resumed more than once while a show/hide transition completes.
      // Keep the modal stack set-like so a repeated completion callback does
      // not turn a valid active modal into a spurious failure.
      if (window.modalLayers.includes(node)) return;
      const current = window.modalLayers.at(-1);
      if (current && isAncestorOrSelf(current, node)) return;
      if (!node.visible) node.visible = true;
      for (let walk = node.parent; walk; walk = walk.parent) {
        if (!walk.visible || !walk.enabled) throw new Error('TJS cannot set mode to disabled or modal layer');
      }
      if (!node.enabled || node === current) throw new Error('TJS cannot set mode to disabled or modal layer');
      const firstFocusable = candidate => {
        if (candidate.focusable && isNodeEnabled(candidate) && candidate.visible) return candidate;
        for (const child of candidate.children) {
          const found = firstFocusable(child);
          if (found) return found;
        }
        return null;
      };
      const target = firstFocusable(node);
      if (target) await Layer.of(target.owner).focus(true);
      window.modalLayers.push(node);
      updateTree(node);
    }
    @nativeMethod
    removeMode() {
      const node = this.node,
        window = node.window;
      if (!window) return;
      const before = window.modalLayers.length;
      window.modalLayers = window.modalLayers.filter(modal => modal !== node);
      if (window.modalLayers.length !== before) updateTree(node);
    }
    @nativeMethod
    async loadImages(name, key = 0x1fffffff) {
      if (!arguments.length) throw new Error('TJS Layer.loadImages requires a name');
      const node = this.node;
      const {
        image,
        province,
        metainfo
      } = await loadGraphic(name, Math.trunc(number(key)));
      node.image = image;
      node.province = province ?? null;
      adjustImageRect(node);
      node.clip = null;
      node.imageModified = true;
      updateTree(node);
      return metainfo;
    }
    @nativeMethod
    async loadProvinceImage(name) {
      if (!arguments.length) throw new Error('TJS Layer.loadProvinceImage requires a name');
      const node = this.node;
      if (!node.image) throw new Error('TJS not drawable layer type');
      node.province = null;
      const {
        image
      } = await loadGraphic(name, 0, {
        province: true,
        width: node.image.width,
        height: node.image.height
      });
      if (image.width !== node.image.width || image.height !== node.image.height) throw new Error('TJS province size mismatch');
      node.province = image;
      node.imageModified = true;
    }
    @nativeMethod
    moveBefore(src) {
      const node = this.node,
        srcOwner = nativeOwner(src);
      const srcNode = Layer.state(srcOwner) ? instanceOf(srcOwner) : null;
      if (!node.parent || !srcNode) throw new Error('TJS cannot move primary or siblingless layer');
      if (srcNode === node || srcNode.parent !== node.parent) throw new Error('TJS cannot move next to self or non-sibling layer');
      const from = node.orderIndex, to = srcNode.orderIndex;
      setLayerOrder(node, from < to ? to : to + 1);
      updateTree(node);
    }
    @nativeMethod
    moveBehind(src) {
      const node = this.node,
        srcOwner = nativeOwner(src);
      const srcNode = Layer.state(srcOwner) ? instanceOf(srcOwner) : null;
      if (!node.parent || !srcNode) throw new Error('TJS cannot move primary or siblingless layer');
      if (srcNode === node || srcNode.parent !== node.parent) throw new Error('TJS cannot move next to self or non-sibling layer');
      const from = node.orderIndex, to = srcNode.orderIndex;
      setLayerOrder(node, from < to ? to - 1 : to);
      updateTree(node);
    }
    @nativeMethod
    bringToBack() {
      const node = this.node;
      if (!node.parent) throw new Error('TJS cannot move primary or siblingless layer');
      setLayerOrder(node, 0);
      updateTree(node);
    }
    @nativeMethod
    bringToFront() {
      const node = this.node;
      if (!node.parent) throw new Error('TJS cannot move primary or siblingless layer');
      setLayerOrder(node, node.parent.children.length - 1);
      updateTree(node);
    }
    @nativeMethod
    getMainPixel(x, y) {
      if (arguments.length < 2) throw new Error('TJS Layer.getMainPixel requires 2 arguments');
      const node = this.node;
      // Scripts scan images pixel by pixel. Synchronize once and retain both
      // valid copies instead of issuing a GPU readback for every coordinate.
      node.image.materialize();
      return node.image.point(Math.trunc(number(x)), Math.trunc(number(y))) & 0xffffff;
    }
    @nativeMethod
    setMainPixel(x, y, color) {
      if (arguments.length < 3) throw new Error('TJS Layer.setMainPixel requires 3 arguments');
      const node = this.node;
      node.image.setPoint(Math.trunc(number(x)), Math.trunc(number(y)), toActualColor(color));
      node.imageModified = true;
      updateTree(node);
    }
    @nativeMethod
    getMaskPixel(x, y) {
      if (arguments.length < 2) throw new Error('TJS Layer.getMaskPixel requires 2 arguments');
      const node = this.node;
      node.image.materialize();
      return node.image.point(Math.trunc(number(x)), Math.trunc(number(y))) >>> 24 & 0xff;
    }
    @nativeMethod
    setMaskPixel(x, y, value) {
      if (arguments.length < 3) throw new Error('TJS Layer.setMaskPixel requires 3 arguments');
      const node = this.node;
      const px = Math.trunc(number(x)), py = Math.trunc(number(y));
      node.image.fill({ left: px, top: py, right: px + 1, bottom: py + 1 },
        clamp255(Math.trunc(number(value))) << 24, true);
      node.imageModified = true;
      updateTree(node);
    }
    @nativeMethod
    getProvincePixel(x, y) {
      if (arguments.length < 2) throw new Error('TJS Layer.getProvincePixel requires 2 arguments');
      const node = this.node;
      return node.province ? node.province.pixels[node.province.index(Math.trunc(number(x)), Math.trunc(number(y)))] : 0;
    }
    @nativeMethod
    setProvincePixel(x, y, value) {
      if (arguments.length < 3) throw new Error('TJS Layer.setProvincePixel requires 3 arguments');
      const node = this.node;
      node.province ??= new Image(node.image.width, node.image.height, {
        gray: true
      });
      node.province.setPoint(Math.trunc(number(x)), Math.trunc(number(y)), Math.trunc(number(value)) & 0xff);
      node.imageModified = true;
      updateTree(node);
    }
    @nativeMethod
    assignImages(src) {
      const node = this.node,
        srcOwner = nativeOwner(src);
      const srcNode = Layer.state(srcOwner) ? instanceOf(srcOwner) : null;
      if (!srcNode) throw new Error('TJS specify layer');
      // LayerIntf.cpp AssignImages: assign the main plane first, then the
      // province plane. InternalSetImageSize and Update run only when the main
      // plane actually changed.
      let mainChanged = true;
      if (srcNode.image) {
        mainChanged = !samePlane(node.image, srcNode.image);
        node.image = assignPlane(node.image, srcNode.image);
      } else {
        // DeallocateImage also discards the province plane.
        node.image = null;
        node.province = null;
      }
      if (srcNode.province) {
        node.province = assignPlane(node.province, srcNode.province);
      } else {
        node.province = null;
      }
      if (mainChanged && node.image) {
        internalSetImageSize(node, node.image.width, node.image.height);
      }
      node.imageModified = true;
      if (node.image) node.clip = null;
      if (mainChanged) updateTree(node);
    }
    @nativeProperty
    get parent() {
      const node = this.node;
      return node.parent ? node.parent.owner : null;
    }
    @nativeProperty
    set parent(value) {
      const node = this.node;
      const parentOwner = nativeOwner(value);
      if (parentOwner && Layer.state(parentOwner)) {
        const parentNode = instanceOf(parentOwner);
        joinLayer(node, parentNode);
      } else joinLayer(node, null);
      updateTree(node);
    }
    @nativeProperty
    get children() {
      const node = this.node;
      const result = [];
      for (const child of node.children) result.push(child.owner);
      return result;
    }
    @nativeProperty
    get order() {
      const node = this.node;
      if (!node.parent) throw new Error('TJS primary layer has no order');
      return node.orderIndex;
    }
    @nativeProperty
    set order(value) {
      const node = this.node;
      if (!node.parent) throw new Error('TJS primary layer has no order');
      setLayerOrder(node, Math.trunc(number(value)));
      updateTree(node);
    }
    @nativeProperty
    get absolute() {
      const node = this.node;
      if (!node.parent) return 0;
      return node.parent.absoluteOrderMode ? node.absoluteOrderIndex : node.orderIndex;
    }
    @nativeProperty
    set absolute(value) {
      const node = this.node;
      setLayerOrder(node, Math.trunc(number(value)), true);
      updateTree(node);
    }
    @nativeProperty
    get absoluteOrderMode() {
      return Number(this.node.absoluteOrderMode);
    }
    @nativeProperty
    set absoluteOrderMode(value) {
      setAbsoluteOrderMode(this.node, !!truth(value));
    }
    @nativeProperty
    get visible() {
      return Number(this.node.visible);
    }
    @nativeProperty
    set visible(value) {
      this.node.visible = !!truth(value);
      updateTree(this.node);
    }
    @nativeProperty
    get inTransition() {
      return Number(!!this.node.transition);
    }
    @nativeProperty
    get nodeVisible() {
      const node = this.node;
      for (let walk = node; walk; walk = walk.parent) if (!walk.visible) return 0;
      return 1;
    }
    @nativeProperty
    get opacity() {
      return this.node.opacity;
    }
    @nativeProperty
    set opacity(value) {
      const opacity = Math.max(0, Math.min(255, Math.trunc(number(value))));
      if (this.node.isPrimary && opacity !== 255) throw new Error('TJS cannot set primary layer invisible');
      this.node.opacity = opacity;
      updateTree(this.node);
    }
    @nativeProperty
    get window() {
      const node = this.node;
      return node.window ? node.window.owner : null;
    }
    @nativeProperty
    get isPrimary() {
      return Number(this.node.isPrimary);
    }
    @nativeProperty
    get left() {
      return this.node.left;
    }
    @nativeProperty
    set left(value) {
      const node = this.node;
      if (node.isPrimary && Math.trunc(number(value)) !== 0) throw new Error('TJS cannot move primary layer');
      node.left = Math.trunc(number(value));
      updateTree(node);
    }
    @nativeProperty
    get top() {
      return this.node.top;
    }
    @nativeProperty
    set top(value) {
      const node = this.node;
      if (node.isPrimary && Math.trunc(number(value)) !== 0) throw new Error('TJS cannot move primary layer');
      node.top = Math.trunc(number(value));
      updateTree(node);
    }
    @nativeProperty
    get width() {
      return this.node.width;
    }
    @nativeProperty
    set width(value) {
      const node = this.node;
      resizeLayer(node, Math.trunc(number(value)), node.height);
    }
    @nativeProperty
    get height() {
      return this.node.height;
    }
    @nativeProperty
    set height(value) {
      const node = this.node;
      resizeLayer(node, node.width, Math.trunc(number(value)));
    }
    @nativeProperty
    get imageLeft() {
      return this.node.imageLeft;
    }
    @nativeProperty
    set imageLeft(value) {
      this.node.imageLeft = Math.trunc(number(value));
      updateTree(this.node);
    }
    @nativeProperty
    get imageTop() {
      return this.node.imageTop;
    }
    @nativeProperty
    set imageTop(value) {
      this.node.imageTop = Math.trunc(number(value));
      updateTree(this.node);
    }
    @nativeProperty
    get imageWidth() {
      return this.node.image?.width ?? 0;
    }
    @nativeProperty
    set imageWidth(value) {
      const node = this.node;
      resizeImage(node, Math.trunc(number(value)), node.image?.height ?? 0);
    }
    @nativeProperty
    get imageHeight() {
      return this.node.image?.height ?? 0;
    }
    @nativeProperty
    set imageHeight(value) {
      const node = this.node;
      resizeImage(node, node.image?.width ?? 0, Math.trunc(number(value)));
    }
    @nativeProperty
    get type() {
      return this.node.type;
    }
    @nativeProperty
    set type(value) {
      const node = this.node;
      node.type = node.displayType = Math.trunc(number(value));
      if (node.face === dfAuto) node.drawFace = node.type === ltOpaque ? dfMain : node.type === ltAddAlpha ? 4 : dfAlpha;
      updateTree(node);
    }
    @nativeProperty
    get face() {
      return this.node.face;
    }
    @nativeProperty
    set face(value) {
      const node = this.node;
      node.face = Math.trunc(number(value));
      node.drawFace = node.face === dfAuto ? node.type === ltOpaque ? dfMain : node.type === ltAddAlpha ? 4 : dfAlpha : node.face;
    }
    @nativeProperty
    get holdAlpha() {
      return this.node.holdAlpha;
    }
    @nativeProperty
    set holdAlpha(value) {
      this.node.holdAlpha = Math.trunc(number(value)) !== 0;
    }
    @nativeProperty
    get clipLeft() {
      return this.node.clip?.left ?? 0;
    }
    @nativeProperty
    set clipLeft(value) {
      const node = this.node;
      node.setClipImpl(Math.trunc(number(value)), node.clip?.top ?? 0, (node.clip?.right ?? node.image.width) - (node.clip?.left ?? 0), (node.clip?.bottom ?? node.image.height) - (node.clip?.top ?? 0));
    }
    @nativeProperty
    get clipTop() {
      return this.node.clip?.top ?? 0;
    }
    @nativeProperty
    set clipTop(value) {
      const node = this.node;
      node.setClipImpl(node.clip?.left ?? 0, Math.trunc(number(value)), (node.clip?.right ?? node.image.width) - (node.clip?.left ?? 0), (node.clip?.bottom ?? node.image.height) - (node.clip?.top ?? 0));
    }
    @nativeProperty
    get clipWidth() {
      const node = this.node;
      return (node.clip?.right ?? node.image.width) - (node.clip?.left ?? 0);
    }
    @nativeProperty
    set clipWidth(value) {
      const node = this.node;
      node.setClipImpl(node.clip?.left ?? 0, node.clip?.top ?? 0, Math.trunc(number(value)), (node.clip?.bottom ?? node.image.height) - (node.clip?.top ?? 0));
    }
    @nativeProperty
    get clipHeight() {
      const node = this.node;
      return (node.clip?.bottom ?? node.image.height) - (node.clip?.top ?? 0);
    }
    @nativeProperty
    set clipHeight(value) {
      const node = this.node;
      node.setClipImpl(node.clip?.left ?? 0, node.clip?.top ?? 0, (node.clip?.right ?? node.image.width) - (node.clip?.left ?? 0), Math.trunc(number(value)));
    }
    @nativeProperty
    get imageModified() {
      return Number(this.node.imageModified);
    }
    @nativeProperty
    set imageModified(value) {
      this.node.imageModified = !!truth(value);
    }
    @nativeProperty
    get hitType() {
      return this.node.hitType;
    }
    @nativeProperty
    set hitType(value) {
      this.node.hitType = Math.trunc(number(value));
    }
    @nativeProperty
    get hitThreshold() {
      return this.node.hitThreshold;
    }
    @nativeProperty
    set hitThreshold(value) {
      this.node.hitThreshold = Math.trunc(number(value));
    }
    @nativeProperty
    get cursor() {
      return this.node.cursor;
    }
    @nativeProperty
    set cursor(value) {
      this.node.cursor = Math.trunc(number(value));
    }
    @nativeProperty
    get cursorX() {
      const node = this.node;
      return node.window ? (node.window.mousePosition?.x ?? 0) - layerOffset(node).x : 0;
    }
    @nativeProperty
    get cursorY() {
      const node = this.node;
      return node.window ? (node.window.mousePosition?.y ?? 0) - layerOffset(node).y : 0;
    }
    @nativeProperty
    get hint() {
      return this.node.hint;
    }
    @nativeProperty
    set hint(value) {
      this.node.hint = string(value);
    }
    @nativeProperty
    get focusable() {
      return Number(this.node.focusable);
    }
    @nativeProperty
    set focusable(value) {
      this.node.focusable = !!truth(value);
    }
    @nativeProperty
    get nodeFocusable() {
      const node = this.node;
      if (!node.focusable) return 0;
      for (let walk = node; walk; walk = walk.parent) if (!walk.visible || !walk.enabled) return 0;
      return 1;
    }
    @nativeProperty
    get focused() {
      const node = this.node;
      return Number(node.window?.focusedLayer === node);
    }
    @nativeProperty
    get enabled() {
      return Number(this.node.enabled);
    }
    @nativeProperty
    set enabled(value) {
      this.node.enabled = !!truth(value);
    }
    @nativeProperty
    get nodeEnabled() {
      const node = this.node;
      return Number(isNodeEnabled(node));
    }
    @nativeProperty
    get callOnPaint() {
      return Number(this.node.callOnPaint);
    }
    @nativeProperty
    set callOnPaint(value) {
      this.node.callOnPaint = !!truth(value);
    }
    @nativeProperty
    get font() {
      const node = this.node;
      // TVPCreateFontObject: a Font native instance bound to this layer.
      return nativeLayerFont(this);
    }
    @nativeProperty
    get name() {
      return this.node.name;
    }
    @nativeProperty
    set name(value) {
      this.node.name = string(value);
    }
    @nativeProperty
    get neutralColor() {
      return this.node.neutralColor;
    }
    @nativeProperty
    set neutralColor(value) {
      this.node.neutralColor = Math.trunc(number(value));
    }
    @nativeProperty
    get hasImage() {
      return Number(!!this.node.image);
    }
    @nativeProperty
    set hasImage(value) {
      const node = this.node;
      if (truth(value)) {
        if ([ltBinder, ltEffect, ltFilter].includes(node.type)) throw new Error('TJS layer cannot have an image');
        if (!node.image) {
          node.imageLeft = node.imageTop = 0;
          node.image = new Image(node.width, node.height);
          node.image.fill({
            left: 0,
            top: 0,
            right: node.width,
            bottom: node.height
          }, node.neutralColor);
        }
        node.clip = null;
        if (node.province) node.province = new Image(node.image.width, node.image.height, {
          gray: true
        });
      } else node.image = node.province = null;
      node.imageModified = true;
      updateTree(node);
    }
    @nativeProperty
    get mainImageBuffer() {
      const node = this.node;
      const pixels = node.image.pixels;
      return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    }
    @nativeProperty
    get mainImageBufferForWrite() {
      const node = this.node;
      node.imageModified = true;
      const pixels = node.image.writablePixels;
      node.image.externallyWritable = true;
      return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    }
    @nativeProperty
    get mainImageBufferPitch() {
      return this.node.image.width * 4;
    }
    @nativeProperty
    get provinceImageBuffer() {
      const node = this.node;
      node.province ??= new Image(node.image.width, node.image.height, {
        gray: true
      });
      const pixels = node.province.pixels;
      return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    }
    @nativeProperty
    get provinceImageBufferForWrite() {
      const node = this.node;
      node.province ??= new Image(node.image.width, node.image.height, {
        gray: true
      });
      node.imageModified = true;
      const pixels = node.province.writablePixels;
      node.province.externallyWritable = true;
      return new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    }
    @nativeProperty
    get provinceImageBufferPitch() {
      const node = this.node;
      node.province ??= new Image(node.image.width, node.image.height, {
        gray: true
      });
      return node.province.width;
    }
  }
  Layer.invalidate = async owner => {
    const node = Layer.state(owner).node;
    if (!node) return;
    if (node.transition) await Layer.of(owner).stopTransition();
    // LayerManager::NotifyPart clears input references before severing the tree.
    await Layer.input.blurTree(node, node);
    node.window?.releaseCaptureFromTree?.(node);
    detachLayerTree(node);
    if (node.window) {
      if (node.window.primaryLayer === node) node.window.primaryLayer = null;
      if (node.window.focusedLayer === node) node.window.focusedLayer = null;
      node.window.modalLayers = node.window.modalLayers.filter(modal => modal !== node && !isAncestorOrSelf(node, modal));
      node.window.layers = node.window.layers.filter(layer => layer !== owner);
    }
    await nativeLayerFont(owner, true);
    if (node.actionOwner) await disposeScriptValue(node.actionOwner);
    node.image = node.province = null;
    node.actionOwner = null;
    updateTree(node);
  };
  // Properties (LayerIntf.cpp 10652-11642 + Font 12181+).

  Node.prototype.setClipImpl = function (left, top, width, height) {
    const l = Math.max(0, left),
      t = Math.max(0, top);
    this.clip = {
      left: l,
      top: t,
      right: Math.max(l, Math.min(this.image.width, left + width)),
      bottom: Math.max(t, Math.min(this.image.height, top + height))
    };
  };

  // Exposed for the compositor and the Window wiring.
  Layer.advanceTransition = advanceTransition;
  Layer.stop = () => {
    drawText.finalize();
    stopTransitionScheduling();
    if (!Layer.instances.vm) return;
    for (const state of Layer.instances.values()) stopTransitionScheduling(state.node);
  };
  Layer.peekNode = peekNode;
  // Layer::SetSize for host-side presenters (video pipeline): same path as the
  // script method, including province resize and the repaint request.
  Layer.resizeNode = resizeLayer;
  Layer.peekState = owner => {
    try {
      return Layer.state(owner);
    } catch {
      return null;
    }
  };
  const drawing = createLayerDrawing({
    getLayer: () => Layer,
    Bitmap,
    instanceOf,
    updateTree,
    ltOpaque,
    ltAlpha,
    dfAlpha,
    dfMain,
    dfAddAlpha: 4,
    omAuto: 128
  });
  for (const [name, method] of Object.entries(drawing)) Layer.defineMember(name, method);
  installLayerInput(Layer, {
    instanceOf,
    updateTree,
    dispatchAction,
    Window
  });
  installLayerStorage(Layer, {
    instanceOf,
    updateTree,
    storage,
    document,
    bitmapClass: Bitmap
  });
  registerLayerFields(Layer);
  // Native adapters convert TJS coordinates before invoking the JS methods.
  registerLayerMethods(Layer, { setPos: 0, setImagePos: 1 });
  return Layer;
}
