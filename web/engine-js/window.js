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
    // getNotificationNum / getNotificationName are static helpers (see below):
    // windowEx.cpp registers them through Method(), and their implementation
    // never touches the window instance, so games call Window.getNotificationNum.
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
  // windowEx.cpp: Window._Notifications maps notification names to Win32 message
  // ids and back. The names are the bare macro arguments (WN_SYSKEYDOWN becomes
  // "SYSKEYDOWN"), which is how scripts spell them.
  const notifications = {
    NULL:0x0000, CREATE:0x0001, DESTROY:0x0002, MOVE:0x0003, SIZE:0x0005,
    ACTIVATE:0x0006, SETFOCUS:0x0007, KILLFOCUS:0x0008, ENABLE:0x000A, SETREDRAW:0x000B,
    SETTEXT:0x000C, GETTEXT:0x000D, GETTEXTLENGTH:0x000E, PAINT:0x000F,
    CLOSE:0x0010, QUERYENDSESSION:0x0011, QUERYOPEN:0x0013, ENDSESSION:0x0016,
    QUIT:0x0012, ERASEBKGND:0x0014, SYSCOLORCHANGE:0x0015, SHOWWINDOW:0x0018,
    CTLCOLOR:0x0019, WININICHANGE:0x001A, SETTINGCHANGE:0x001A,
    DEVMODECHANGE:0x001B, ACTIVATEAPP:0x001C, FONTCHANGE:0x001D, TIMECHANGE:0x001E,
    CANCELMODE:0x001F, SETCURSOR:0x0020, MOUSEACTIVATE:0x0021, CHILDACTIVATE:0x0022,
    QUEUESYNC:0x0023, GETMINMAXINFO:0x0024, PAINTICON:0x0026, ICONERASEBKGND:0x0027,
    NEXTDLGCTL:0x0028, SPOOLERSTATUS:0x002A, DRAWITEM:0x002B, MEASUREITEM:0x002C,
    DELETEITEM:0x002D, VKEYTOITEM:0x002E, CHARTOITEM:0x002F, SETFONT:0x0030,
    GETFONT:0x0031, SETHOTKEY:0x0032, GETHOTKEY:0x0033, QUERYDRAGICON:0x0037,
    COMPAREITEM:0x0039, GETOBJECT:0x003D, COMPACTING:0x0041, COMMNOTIFY:0x0044,
    WINDOWPOSCHANGING:0x0046, WINDOWPOSCHANGED:0x0047, POWER:0x0048, COPYDATA:0x004A,
    CANCELJOURNAL:0x004B, NOTIFY:0x004E, INPUTLANGCHANGEREQUEST:0x0050, INPUTLANGCHANGE:0x0051,
    TCARD:0x0052, HELP:0x0053, USERCHANGED:0x0054, NOTIFYFORMAT:0x0055,
    CONTEXTMENU:0x007B, STYLECHANGING:0x007C, STYLECHANGED:0x007D, DISPLAYCHANGE:0x007E,
    GETICON:0x007F, SETICON:0x0080, NCCREATE:0x0081, NCDESTROY:0x0082,
    NCCALCSIZE:0x0083, NCHITTEST:0x0084, NCPAINT:0x0085, NCACTIVATE:0x0086,
    GETDLGCODE:0x0087, SYNCPAINT:0x0088, NCMOUSEMOVE:0x00A0, NCLBUTTONDOWN:0x00A1,
    NCLBUTTONUP:0x00A2, NCLBUTTONDBLCLK:0x00A3, NCRBUTTONDOWN:0x00A4, NCRBUTTONUP:0x00A5,
    NCRBUTTONDBLCLK:0x00A6, NCMBUTTONDOWN:0x00A7, NCMBUTTONUP:0x00A8, NCMBUTTONDBLCLK:0x00A9,
    NCXBUTTONDOWN:0x00AB, NCXBUTTONUP:0x00AC, NCXBUTTONDBLCLK:0x00AD,
    INPUT_DEVICE_CHANGE:0x00FE, INPUT:0x00FF,
    KEYFIRST:0x0100, KEYDOWN:0x0100, KEYUP:0x0101, CHAR:0x0102, DEADCHAR:0x0103,
    SYSKEYDOWN:0x0104, SYSKEYUP:0x0105, SYSCHAR:0x0106, SYSDEADCHAR:0x0107,
    UNICHAR:0x0109, KEYLAST:0x0109,
    IME_STARTCOMPOSITION:0x010D, IME_ENDCOMPOSITION:0x010E, IME_COMPOSITION:0x010F,
    IME_KEYLAST:0x010F, INITDIALOG:0x0110, COMMAND:0x0111, SYSCOMMAND:0x0112,
    TIMER:0x0113, HSCROLL:0x0114, VSCROLL:0x0115, INITMENU:0x0116, INITMENUPOPUP:0x0117,
    MENUSELECT:0x011F, MENUCHAR:0x0120, ENTERIDLE:0x0121, MENURBUTTONUP:0x0122,
    MENUDRAG:0x0123, MENUGETOBJECT:0x0124, UNINITMENUPOPUP:0x0125, MENUCOMMAND:0x0126,
    CHANGEUISTATE:0x0127, UPDATEUISTATE:0x0128, QUERYUISTATE:0x0129,
    CTLCOLORMSGBOX:0x0132, CTLCOLOREDIT:0x0133, CTLCOLORLISTBOX:0x0134, CTLCOLORBTN:0x0135,
    CTLCOLORDLG:0x0136, CTLCOLORSCROLLBAR:0x0137, CTLCOLORSTATIC:0x0138,
    MOUSEFIRST:0x0200, MOUSEMOVE:0x0200, LBUTTONDOWN:0x0201, LBUTTONUP:0x0202,
    LBUTTONDBLCLK:0x0203, RBUTTONDOWN:0x0204, RBUTTONUP:0x0205, RBUTTONDBLCLK:0x0206,
    MBUTTONDOWN:0x0207, MBUTTONUP:0x0208, MBUTTONDBLCLK:0x0209, MOUSEWHEEL:0x020A,
    XBUTTONDOWN:0x020B, XBUTTONUP:0x020C, XBUTTONDBLCLK:0x020D, MOUSEHWHEEL:0x020E,
    MOUSELAST:0x020E, PARENTNOTIFY:0x0210, ENTERMENULOOP:0x0211, EXITMENULOOP:0x0212,
    NEXTMENU:0x0213, SIZING:0x0214, CAPTURECHANGED:0x0215, MOVING:0x0216,
    POWERBROADCAST:0x0218, DEVICECHANGE:0x0219,
    MDICREATE:0x0220, MDIDESTROY:0x0221, MDIACTIVATE:0x0222, MDIRESTORE:0x0223,
    MDINEXT:0x0224, MDIMAXIMIZE:0x0225, MDITILE:0x0226, MDICASCADE:0x0227,
    MDIICONARRANGE:0x0228, MDIGETACTIVE:0x0229, MDISETMENU:0x0230,
    ENTERSIZEMOVE:0x0231, EXITSIZEMOVE:0x0232, DROPFILES:0x0233, MDIREFRESHMENU:0x0234,
    IME_SETCONTEXT:0x0281, IME_NOTIFY:0x0282, IME_CONTROL:0x0283, IME_COMPOSITIONFULL:0x0284,
    IME_SELECT:0x0285, IME_CHAR:0x0286, IME_REQUEST:0x0288, IME_KEYDOWN:0x0290, IME_KEYUP:0x0291,
    NCMOUSEHOVER:0x02A0, MOUSEHOVER:0x02A1, NCMOUSELEAVE:0x02A2, MOUSELEAVE:0x02A3,
    WTSSESSION_CHANGE:0x02B1, TABLET_FIRST:0x02C0, TABLET_LAST:0x02DF,
    CUT:0x0300, COPY:0x0301, PASTE:0x0302, CLEAR:0x0303, UNDO:0x0304,
    RENDERFORMAT:0x0305, RENDERALLFORMATS:0x0306, DESTROYCLIPBOARD:0x0307,
    DRAWCLIPBOARD:0x0308, PAINTCLIPBOARD:0x0309, VSCROLLCLIPBOARD:0x030A,
    SIZECLIPBOARD:0x030B, ASKCBFORMATNAME:0x030C, CHANGECBCHAIN:0x030D,
    HSCROLLCLIPBOARD:0x030E, QUERYNEWPALETTE:0x030F, PALETTEISCHANGING:0x0310,
    PALETTECHANGED:0x0311, HOTKEY:0x0312, PRINT:0x0317, PRINTCLIENT:0x0318,
    APPCOMMAND:0x0319, THEMECHANGED:0x031A, CLIPBOARDUPDATE:0x031D,
    DWMCOMPOSITIONCHANGED:0x031E, DWMNCRENDERINGCHANGED:0x031F,
    DWMCOLORIZATIONCOLORCHANGED:0x0320, DWMWINDOWMAXIMIZEDCHANGE:0x0321,
    GETTITLEBARINFOEX:0x033F, HANDHELDFIRST:0x0358, HANDHELDLAST:0x035F,
    AFXFIRST:0x0360, AFXLAST:0x037F, PENWINFIRST:0x0380, PENWINLAST:0x038F,
  };
  for (const [name,value] of Object.entries(notifications)) notifications[value] = name;
  // windowEx.cpp 751/759: both are static (they read Window._Notifications only).
  Window.defineMember('getNotificationNum', function(name) {
    if (!arguments.length) throw new Error('TJS Window.getNotificationNum requires a name');
    const value = notifications[String(name)];
    return value === undefined || typeof value === 'string' ? -1 : value;
  }, { static: true });
  Window.defineMember('getNotificationName', function(num) {
    if (!arguments.length) throw new Error('TJS Window.getNotificationName requires a number');
    return notifications[Math.trunc(number(num))] ?? '';
  }, { static: true });
  return Window;
}
