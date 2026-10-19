import { config } from './global.js';
import { nativeClass, nativeMethod, nativeEvent, nativeProperty, unimplemented, script, readScript, constructNative, nativeOwner, retainScriptValue, disposeScriptValue, windowObjects } from '#krkr/native';
import { number, truth } from '#krkr/values';

// WindowIntf.cpp / WindowImpl.cpp, with the native form represented by a
// browser canvas. Layer rendering attaches to this form separately (the
// compositor lives in layer-composite.js and is wired through attachCompositor).
export function createBasicDrawDeviceClass() {
  let nextHandle = 1;
  @nativeClass('BasicDrawDevice')
  class Device {
    static initialize() { return {handle:nextHandle++,preferredDrawer:1}; }

    @nativeMethod BasicDrawDevice(){}
    // BasicDrawDevice.cpp disables the native recreate implementation.
    @nativeMethod recreate(){}

    @nativeProperty get interface() { return this.handle; }
    @nativeProperty get preferredDrawer() { return this.preferredDrawer; }
    @nativeProperty set preferredDrawer(value) { this.preferredDrawer = Math.trunc(number(value)); }
    @nativeProperty get drawer() { return 1; }
  }
  for (const [index,name] of ['dtNone','dtDrawDib','dtDBGDI','dtDBDD','dtDBD3D'].entries()) Device.defineProperty(name, () => index);
  return Device;
}

export function createWindowClass(BasicDrawDevice) {
  const { document, container } = config;
  const resize = (state,width,height) => {
    width = Math.trunc(Number(width)); height = Math.trunc(Number(height));
    if (state.width === width && state.height === height) return;
    state.width = width; state.height = height;
    state.canvas.width = state.width; state.canvas.height = state.height;
    if (state.onSizeChanged) state.onSizeChanged();
  };
  @nativeClass('Window')
  class Window {
    static initialize(owner) {
      const canvas = document.createElement('canvas');
      canvas.width = 0; canvas.height = 0; canvas.hidden = true;
      canvas.style.maxWidth = '100%'; canvas.style.maxHeight = '100%';
      canvas.style.touchAction = 'none';
      container.append(canvas);
      const state = {
        owner, canvas, handle: Array.from(Window.instances.values()).length + 1,
        width: 0, height: 0, visible: false, fullScreen: false, caption: '', enabled: true,
        layers: [], primaryLayer: null, focusedLayer: null, modalLayers: [],
        hint: '', hintSender: null, attentionPoint: null,
        defaultImeMode: 0, activeImeMode: null, touchCaptures: new Map(),
        messageHooks: new Set(), allMessageHooks: false,
      };
      // These callbacks model the layer-tree owner notifications used by the
      // native manager. A browser canvas has no Win32 caret/IME host, but the
      // state remains observable to the compositor and future host integration.
      state.setHint = (sender, text) => {
        state.hintSender = sender ?? null;
        state.hint = String(text ?? '');
        if (state.onHint) state.onHint(state.hint, state.hintSender);
      };
      state.setAttentionPoint = (layer, x, y) => {
        state.attentionPoint = { layer, x: Math.trunc(Number(x)), y: Math.trunc(Number(y)) };
        if (state.onSetAttentionPoint) state.onSetAttentionPoint(state.attentionPoint);
      };
      state.disableAttentionPoint = () => {
        state.attentionPoint = null;
        if (state.onDisableAttentionPoint) state.onDisableAttentionPoint();
      };
      state.setImeMode = mode => {
        state.activeImeMode = Math.trunc(Number(mode));
        if (state.onSetImeMode) state.onSetImeMode(state.activeImeMode);
      };
      state.resetImeMode = () => {
        state.activeImeMode = null;
        if (state.onResetImeMode) state.onResetImeMode();
      };
      state.releaseTouchCapture = (id, all = false) => {
        if (all) state.touchCaptures.clear();
        else state.touchCaptures.delete(Number(id) >>> 0);
      };
      return state;
    }

    @nativeMethod async Window(parent) {
      if (parent!==undefined && parent!==null) {
        const owner = nativeOwner(parent);
        Window.state(owner); // Native constructor requires a Window owner.
      }
      const drawDevice = await constructNative(this, BasicDrawDevice);
      try { this.drawDevice = retainScriptValue(drawDevice, this); }
      finally { await disposeScriptValue(drawDevice); }
    }
    @nativeMethod setSize(width,height) {
      if (arguments.length<2) throw new Error('TJS Window.setSize requires width and height');
      resize(this,width,height);
    }
    @nativeMethod setInnerSize(width,height) {
      if (arguments.length<2) throw new Error('TJS Window.setInnerSize requires width and height');
      resize(this,width,height);
    }
    @nativeMethod setPos(x,y){ if(arguments.length<2) throw new Error('TJS Window.setPos requires 2 arguments'); }
    @nativeMethod setLayerPos(x,y){ if(arguments.length<2) throw new Error('TJS Window.setLayerPos requires 2 arguments'); }
    @nativeMethod add(layer){
      if(!arguments.length) throw new Error('TJS Window.add requires a layer');
      return windowObjects(this, layer, 0);
    }
    @nativeMethod remove(layer){
      if(!arguments.length) throw new Error('TJS Window.remove requires a layer');
      return windowObjects(this, layer, 1);
    }
    @nativeMethod update(type=0){ const s=this; if (s.onUpdate) s.onUpdate(); }
    @nativeMethod close(){ return unimplemented('Window.close').apply(this, arguments); }
    @nativeMethod showModal(){ return unimplemented('Window.showModal').apply(this, arguments); }
    @nativeMethod beginMove(){ return unimplemented('Window.beginMove').apply(this, arguments); }
    @nativeMethod bringToFront() {
      // WindowIntf.cpp raises the native form; canvas order represents the
      // browser window stack, without changing its layer ordering.
      container.append(this.canvas);
    }
    @nativeMethod setMaskRegion(){ return unimplemented('Window.setMaskRegion').apply(this, arguments); }
    @nativeMethod removeMaskRegion(){ return unimplemented('Window.removeMaskRegion').apply(this, arguments); }
    @nativeMethod setMinSize(w,h){ if(arguments.length<2) throw new Error('TJS Window.setMinSize requires 2 arguments'); }
    @nativeMethod setMaxSize(w,h){ if(arguments.length<2) throw new Error('TJS Window.setMaxSize requires 2 arguments'); }
    @nativeMethod setZoom(numer,denom){ if(arguments.length<2) throw new Error('TJS Window.setZoom requires 2 arguments'); }
    @nativeMethod hideMouseCursor(){ return unimplemented('Window.hideMouseCursor').apply(this, arguments); }
    @nativeMethod async postInputEvent(name,params){
      if(!arguments.length) throw new Error('TJS Window.postInputEvent requires an event name');
      if (!['onKeyDown', 'onKeyUp', 'onKeyPress'].includes(name)) throw new Error(`Unknown input event: ${name}`);
      const held = retainScriptValue(params);
      try {
        const key = number(await readScript(held, 'key'));
        const shift = name === 'onKeyPress' ? 0 : number(await readScript(held, 'shift'));
        this.postKeyEvent(name, key, shift);
      } finally { await disposeScriptValue(held); }
    }
    // Event handler stubs: the native engine invokes these on the window
    // object itself; subclasses override them.
    @nativeEvent onResize(){}
    @nativeEvent onMouseEnter(){}
    @nativeEvent onMouseLeave(){}
    @nativeEvent onClick(x,y){}
    @nativeEvent onDoubleClick(x,y){}
    @nativeEvent onMouseDown(x,y,button,shift){}
    @nativeEvent onMouseUp(x,y,button,shift){}
    @nativeEvent onMouseMove(x,y,shift){}
    @nativeEvent onMouseWheel(shift,delta,x,y){}
    @nativeEvent onTouchDown(x,y,cx,cy,id){}
    @nativeEvent onTouchUp(x,y,cx,cy,id){}
    @nativeEvent onTouchMove(x,y,cx,cy,id){}
    @nativeEvent onTouchScaling(startdistance,currentdistance,cx,cy,flag){}
    @nativeEvent onTouchRotate(startangle,currentangle,distance,cx,cy,flag){}
    @nativeEvent onMultiTouch(){}
    @nativeEvent onKeyDown(key,shift){}
    @nativeEvent onKeyUp(key,shift){}
    @nativeEvent onKeyPress(key){}
    @nativeEvent onFileDrop(){}
    @nativeEvent onCloseQuery(){}
    @nativeEvent onPopupHide(){}
    @nativeEvent onActivate(){}
    @nativeEvent onDeactivate(){}
    @nativeEvent onDisplayRotate(){}
    @nativeMethod getNotificationNum(name){
      if(!arguments.length) throw new Error('TJS Window.getNotificationNum requires a name');
      const value = notifications[String(name)];
      if (value === undefined || typeof value === 'string') return -1;
      return value;
    }
    @nativeMethod getNotificationName(num){
      if(!arguments.length) throw new Error('TJS Window.getNotificationName requires a number');
      return notifications[Math.trunc(Number(num))] ?? '';
    }
    @nativeMethod setMessageHook(on,name){
      if(!arguments.length) throw new Error('TJS Window.setMessageHook requires arguments');
      if (arguments.length === 1) this.allMessageHooks = truth(on);
      else {
        const num = typeof name === 'string' ? notifications[name] : Math.trunc(number(name));
        if (!(num >= 0 && num < 0x400)) throw new Error('Invalid window notification');
        if (truth(on)) this.messageHooks.add(num);
        else this.messageHooks.delete(num);
      }
      return Number(this.allMessageHooks || this.messageHooks.size > 0);
    }

    // The original getter exposes the native Window instance as an opaque identity.
    @nativeProperty get HWND() { return this.handle; }
    // Static mainWindow (WindowIntf.cpp 1738): the first created window
    // becomes the main window (WindowIntf.cpp 39-42).
    @nativeProperty static get mainWindow() {
      const first = Array.from(Window.instances.values())[0];
      return first?.owner ?? null;
    }
    @nativeProperty get drawDevice() { return this.drawDevice; }
    @nativeProperty set drawDevice(value) {
      const s = this;
      const owner = nativeOwner(value);
      BasicDrawDevice.state(owner);
      const previous = s.drawDevice;
      s.drawDevice = retainScriptValue(value, this);
      return disposeScriptValue(previous);
    }
    @nativeProperty get width() { return this.width; }
    @nativeProperty set width(value) { resize(this,value,this.height); }
    @nativeProperty get height() { return this.height; }
    @nativeProperty set height(value) { resize(this,this.width,value); }
    @nativeProperty get innerWidth() { return this.width; }
    @nativeProperty set innerWidth(value) { resize(this,value,this.height); }
    @nativeProperty get innerHeight() { return this.height; }
    @nativeProperty set innerHeight(value) { resize(this,this.width,value); }
    @nativeProperty get caption() { return this.caption; }
    @nativeProperty set caption(value) { this.caption = String(value); document.title = this.caption; }
    @nativeProperty get visible() { return Number(this.visible); }
    @nativeProperty set visible(value) { this.visible=!!truth(value); this.canvas.hidden=!this.visible; }
    @nativeProperty get left() { return 0; }
    @nativeProperty set left(value) {}
    @nativeProperty get top() { return 0; }
    @nativeProperty set top(value) {}
    @nativeProperty get focusable() { return 1; }
    @nativeProperty set focusable(value) {}
    @nativeProperty get layerLeft() { return 0; }
    @nativeProperty set layerLeft(value) {}
    @nativeProperty get layerTop() { return 0; }
    @nativeProperty set layerTop(value) {}
    @nativeProperty get innerSunken() { return 0; }
    @nativeProperty set innerSunken(value) {}
    @nativeProperty get zoomNumer() { return 1; }
    @nativeProperty set zoomNumer(value) {}
    @nativeProperty get zoomDenom() { return 1; }
    @nativeProperty set zoomDenom(value) {}
    @nativeProperty get borderStyle() { return 0; }
    @nativeProperty set borderStyle(value) {}
    @nativeProperty get stayOnTop() { return 0; }
    @nativeProperty set stayOnTop(value) {}
    @nativeProperty get showScrollBars() { return 0; }
    @nativeProperty set showScrollBars(value) {}
    @nativeProperty get useMouseKey() { return 0; }
    @nativeProperty set useMouseKey(value) {}
    @nativeProperty get trapKey() { return 0; }
    @nativeProperty set trapKey(value) {}
    @nativeProperty get imeMode() { return this.defaultImeMode; }
    @nativeProperty set imeMode(value) { this.defaultImeMode = Math.trunc(number(value)); }
    @nativeProperty get mouseCursorState() { return 0; }
    @nativeProperty set mouseCursorState(value) {}
    // The browser owns the display mode; retain the engine's window state so
    // KAG's screen-mode switch and completion callbacks can run normally.
    @nativeProperty get fullScreen() { return Number(this.fullScreen); }
    @nativeProperty set fullScreen(value) { this.fullScreen = !!truth(value); }
    @nativeProperty get waitVSync() { return 0; }
    @nativeProperty set waitVSync(value) {}
    @nativeProperty get layerTreeOwnerInterface() { return this.owner; }
    @nativeProperty get primaryLayer() {
      const s = this;
      // WindowIntf.cpp primaryLayer getter throws when no layer is attached.
      if(!s.primaryLayer) throw new Error('TJS window has no layer');
      return s.primaryLayer.owner;
    }
    @nativeProperty get focusedLayer() {
      const s = this;
      return s.focusedLayer?.owner ?? null;
    }
    // WindowIntf.cpp delegates to LayerManager::SetFocusTo(layer, false).
    @nativeProperty set focusedLayer(value) {
      const s = this;
      const resolve = value => {
        const owner = nativeOwner(value);
        if (owner == null) return null;
        return Window.getLayerNode(owner);
      };
      const ref = node => node?.owner ?? null;
      const focusable = async node => !node || truth(await script(node.owner).nodeFocusable);
      return (async () => {
        let node = resolve(value);
        if (!await focusable(node)) return;
        if (node) {
          node.focusWork = node;
          await script(node.owner).onBeforeFocus(ref(node),ref(s.focusedLayer),0);
          node = node.focusWork;
        }
        if (!await focusable(node) || s.focusedLayer === node) return;
        if (s.focusChangeLock) throw new Error('TJS cannot change focus while processing focus');
        s.focusChangeLock = true;
        const previous = s.focusedLayer;
        s.focusedLayer = node;
        try {
          if (previous) await script(previous.owner).onBlur(ref(node));
          if (s.focusedLayer) await script(s.focusedLayer.owner).onFocus(ref(previous),0);
        } finally { s.focusChangeLock = false; }
      })();
    }
  }
  Window.invalidate = async owner => {
    const state = Window.state(owner);
    await windowObjects(owner, undefined, 2);
    await disposeScriptValue(state.drawDevice);
    state.drawDevice = null;
    state.canvas.remove();
  };
  // windowEx.cpp message hooks: notification ids mirror the win32 WM values
  // the game hooks (mouse clicks, menus, CANCELMODE). Hook registration is
  // accepted; delivery follows the compositor's own input path.
  const notifications = {
    WM_NULL:0x0000, WM_CREATE:0x0001, WM_DESTROY:0x0002, WM_MOVE:0x0003, WM_SIZE:0x0005,
    WM_ACTIVATE:0x0006, WM_SETFOCUS:0x0007, WM_KILLFOCUS:0x0008, WM_CLOSE:0x0010, WM_QUIT:0x0012,
    WM_CANCELMODE:0x001F, WM_SETCURSOR:0x0020, WM_PAINT:0x000F,
    WM_COMMAND:0x0111, WM_SYSCOMMAND:0x0112, WM_TIMER:0x0113, WM_HSCROLL:0x0114, WM_VSCROLL:0x0115,
    WM_INITMENU:0x0116, WM_INITMENUPOPUP:0x0117, WM_MENUSELECT:0x011F, WM_MENUCHAR:0x0120, WM_ENTERIDLE:0x0121, WM_MENURBUTTONUP:0x0122, WM_MENUCOMMAND:0x0126,
    WM_MOUSEMOVE:0x0200, WM_LBUTTONDOWN:0x0201, WM_LBUTTONUP:0x0202, WM_LBUTTONDBLCLK:0x0203,
    WM_RBUTTONDOWN:0x0204, WM_RBUTTONUP:0x0205, WM_RBUTTONDBLCLK:0x0206,
    WM_MBUTTONDOWN:0x0207, WM_MBUTTONUP:0x0208, WM_MBUTTONDBLCLK:0x0209,
    WM_MOUSEWHEEL:0x020A, WM_MOUSEHWHEEL:0x020E,
    WM_KEYDOWN:0x0100, WM_KEYUP:0x0101, WM_CHAR:0x0102, WM_SYSKEYDOWN:0x0104, WM_SYSKEYUP:0x0105,
  };
  for (const [name,value] of Object.entries(notifications)) notifications[value] = name;
  return Window;
}
