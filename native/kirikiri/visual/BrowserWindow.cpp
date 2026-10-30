#include "BrowserWindow.h"
#include "LayerManager.h"
#include "LayerImpl.h"
#include "EventIntf.h"
#include "NativeTexture.h"
#include "runtime.h"
#include <memory>

namespace {
tjs_uint32 WindowOwnerClass() { return TJSRegisterNativeClass(TJS_W("BrowserLayerTreeOwner")); }
tjs_error TreeOwner(tTJSVariant *result, iTJSDispatch2 *owner) {
    if(result) *result = reinterpret_cast<tjs_int64>(static_cast<iTVPLayerTreeOwner *>(tTVPBrowserWindow::From(owner)));
    return TJS_S_OK;
}
tjs_error Primary(tTJSVariant *result, iTJSDispatch2 *owner) {
    auto *layer = tTVPBrowserWindow::From(owner)->GetPrimaryLayer();
    if(!layer) TVPThrowExceptionMessage(TVPWindowHasNoLayer);
    if(result) *result = tTJSVariant(layer->GetOwnerNoAddRef(), layer->GetOwnerNoAddRef());
    return TJS_S_OK;
}
tjs_error Focused(tTJSVariant *result, iTJSDispatch2 *owner) {
    auto *layer = tTVPBrowserWindow::From(owner)->GetFocusedLayer();
    auto *object = layer ? layer->GetOwnerNoAddRef() : nullptr;
    if(result) *result = tTJSVariant(object, object);
    return TJS_S_OK;
}
tjs_error Focus(const tTJSVariant *value, iTJSDispatch2 *owner) {
    tTVPBrowserWindow::From(owner)->SetFocusedLayer(tTJSNI_Layer::FromVariant(*value));
    return TJS_S_OK;
}
}

tTVPBrowserWindow::tTVPBrowserWindow(iTJSDispatch2 *owner, const tTJSVariant &service)
    : Owner(owner), Service(service) {}

tTVPBrowserWindow *tTVPBrowserWindow::From(iTJSDispatch2 *owner) {
    iTJSNativeInstance *instance = nullptr;
    success(owner->NativeInstanceSupport(TJS_NIS_GETINSTANCE, WindowOwnerClass(), &instance));
    if(!instance) TVPThrowExceptionMessage(TJS_W("Browser window is not attached"));
    return static_cast<tTVPBrowserWindow *>(instance);
}

void tTVPBrowserWindow::Attach(iTJSDispatch2 *owner, const tTJSVariant &service) {
    auto instance = std::make_unique<tTVPBrowserWindow>(owner, service);
    iTJSNativeInstance *pointer = instance.get();
    success(owner->NativeInstanceSupport(TJS_NIS_REGISTER, WindowOwnerClass(), &pointer));
    instance.release();
}

void tTVPBrowserWindow::Register(tTJSNativeClass *klass) {
    klass->RegisterNCM(TJS_W("layerTreeOwnerInterface"), TJSCreateNativeClassProperty(TreeOwner, nullptr), TJS_W("Window"), nitProperty);
    klass->RegisterNCM(TJS_W("primaryLayer"), TJSCreateNativeClassProperty(Primary, nullptr), TJS_W("Window"), nitProperty);
    klass->RegisterNCM(TJS_W("focusedLayer"), TJSCreateNativeClassProperty(Focused, Focus), TJS_W("Window"), nitProperty);
}

void tTVPBrowserWindow::Notify(const tjs_char *name, std::initializer_list<tTJSVariant> args) {
    std::vector<tTJSVariant> values(args);
    std::vector<tTJSVariant *> pointers;
    for(auto &value : values) pointers.push_back(&value);
    success(Service.AsObjectClosureNoAddRef().FuncCall(0, name, nullptr, nullptr,
        pointers.size(), pointers.data(), nullptr));
}

void tTVPBrowserWindow::Invalidate() {
    // Keep native owners alive across callbacks, as Window's registered-object
    // list does. Invalidating the primary detaches its children, so collect the
    // complete manager tree before starting that operation.
    while(!Managers.empty()) {
        auto *manager = static_cast<tTVPLayerManager *>(Managers.back());
        tTJSRefHolder<tTVPLayerManager> held(manager);
        std::vector<tTJSVariant> objects;
        for(auto *layer : manager->GetAllNodes())
            objects.emplace_back(layer->GetOwnerNoAddRef(), layer->GetOwnerNoAddRef());
        for(auto &object : objects) {
            auto closure = object.AsObjectClosureNoAddRef();
            success(closure.Invalidate(0, nullptr, nullptr, closure.ObjThis));
        }
        manager->SetLayerTreeOwner(nullptr);
        if(std::find(Managers.begin(), Managers.end(), manager) != Managers.end())
            UnregisterLayerManager(manager);
    }
    Service.Clear();
    Owner = nullptr;
}

bool TVPWindowUpdateEventsDelivering = false;
void tTVPBrowserWindow::Render() {
    struct DeliveryGuard {
        bool previous = TVPWindowUpdateEventsDelivering;
        DeliveryGuard() { TVPWindowUpdateEventsDelivering = true; }
        ~DeliveryGuard() { TVPWindowUpdateEventsDelivering = previous; }
    } deliveryGuard;
    PaintRequested = false;
    auto *manager = GetLayerManagerAt(PrimaryLayerManagerIndex);
    if(!manager) return;
    tTJSRefHolder<iTVPLayerManager> held(manager);
    manager->UpdateToDrawDevice();
    if(manager != GetLayerManagerAt(PrimaryLayerManagerIndex)) return;
    auto *buffer = manager->GetDrawBuffer();
    if(!buffer) return;
    tjs_int width, height;
    if(!manager->GetPrimaryLayerSize(width, height)) return;
    static_cast<tTVPGLESTexture *>(buffer->GetTexture())->GetSurface().Present(width, height);
    iTVPTexture2D::RecycleProcess();
}

void tTVPBrowserWindow::NotifyLayerImageChange(iTVPLayerManager *manager) {
    // WindowImpl/DrawDevice request an update here. The generic bitmap tree
    // owner completes immediately instead, which would render each mutation.
    if(manager == GetLayerManagerAt(PrimaryLayerManagerIndex) && !PaintRequested) {
        PaintRequested = true;
        OnChangeLayerImage();
    }
}

void tTVPBrowserWindow::Resize(tjs_int width, tjs_int height) {
    // DestRect describes the browser window's client area (the destination
    // the layer is scaled into), not the primary layer.  It is the reference
    // origin for pointer coordinate transforms in TransformToPrimaryLayerManager.
    gal::render::Device::Get().Resize(width, height);
    DestRect.set_size(width, height);
}

void tTVPBrowserWindow::NotifyLayerResize(iTVPLayerManager *manager) {
    auto *primary = GetLayerManagerAt(PrimaryLayerManagerIndex);
    if(primary != manager) return;
    tjs_int width = 0, height = 0;
    GetPrimaryLayerSize(width, height);
    OnResizeLayer(width, height);
    // The base implementation stores the layer size in DestRect because the
    // native window resizes itself to follow its primary layer.  The browser
    // window keeps its own client size and Present() scales the layer into
    // it, so refresh DestRect from the device instead; JS may still choose to
    // follow the layer size and call Resize() on the next frame.
    DestRect.set_size(gal::render::Device::Get().Width(),
                      gal::render::Device::Get().Height());
}

void tTVPBrowserWindow::NotifyBitmapCompleted(iTVPLayerManager *, tjs_int, tjs_int,
    tTVPBaseTexture *, const tTVPRect &, tTVPLayerType, tjs_int) {
    TVPThrowExceptionMessage(TJS_W("GLES LayerManager must complete into its native draw buffer"));
}

void tTVPBrowserWindow::Input(int kind, double x, double y, int button, tjs_uint32 flags, double cx, double cy) {
    const tjs_char *names[] = {TJS_W("onMouseMove"), TJS_W("onMouseDown"), TJS_W("onMouseUp"),
        TJS_W("onClick"), TJS_W("onDoubleClick"), TJS_W("onMouseWheel"), TJS_W("onMouseLeave"),
        TJS_W("onKeyDown"), TJS_W("onKeyUp"), TJS_W("onKeyPress"), TJS_W("onTouchDown"),
        TJS_W("onTouchUp"), TJS_W("onTouchMove"), TJS_W("onMouseEnter")};
    if(kind < 0 || kind >= 14) TVPThrowExceptionMessage(TJS_W("Unknown browser layer input event"));
    tTJSVariant args[5];
    int count = 0;
    tjs_char character[2] = {static_cast<tjs_char>(button), 0};
    switch(kind) {
        case 0: args[0] = static_cast<tjs_int>(x); args[1] = static_cast<tjs_int>(y); args[2] = static_cast<tjs_int64>(flags); count = 3; break;
        case 1: case 2: args[0] = static_cast<tjs_int>(x); args[1] = static_cast<tjs_int>(y); args[2] = button; args[3] = static_cast<tjs_int64>(flags); count = 4; break;
        case 3: case 4: args[0] = static_cast<tjs_int>(x); args[1] = static_cast<tjs_int>(y); count = 2; break;
        case 5: args[0] = static_cast<tjs_int64>(flags); args[1] = button; args[2] = static_cast<tjs_int>(x); args[3] = static_cast<tjs_int>(y); count = 4; break;
        case 7: case 8: args[0] = button; args[1] = static_cast<tjs_int64>(flags); count = 2; break;
        case 9: args[0] = character; count = 1; break;
        case 10: case 11: case 12: args[0] = x; args[1] = y; args[2] = cx; args[3] = cy; args[4] = static_cast<tjs_int64>(static_cast<tjs_uint32>(button)); count = 5; break;
    }
    ttstr name(names[kind]);
    if(kind <= 5) { CursorX = x; CursorY = y; }
    TVPPostEvent(Owner, Owner, name, 0, TVP_EPT_IMMEDIATE | (kind == 0 ? TVP_EPT_DISCARDABLE : 0), count, args);
    switch(kind) {
        case 0: FireMouseMove(x, y, flags); break;
        case 1: FireMouseDown(x, y, static_cast<tTVPMouseButton>(button), flags); break;
        case 2: FireMouseUp(x, y, static_cast<tTVPMouseButton>(button), flags); break;
        case 3: FireClick(x, y); break;
        case 4: FireDoubleClick(x, y); break;
        case 5: FireMouseWheel(flags, button, x, y); break;
        case 6: FireMouseOutOfWindow(); break;
        case 7: FireKeyDown(button, flags); break;
        case 8: FireKeyUp(button, flags); break;
        case 9: FireKeyPress(button); break;
        case 10: FireTouchDown(x, y, cx, cy, button); break;
        case 11: FireTouchUp(x, y, cx, cy, button); break;
        case 12: FireTouchMove(x, y, cx, cy, button); break;
        case 13: break;
        default: TVPThrowExceptionMessage(TJS_W("Unknown browser layer input event"));
    }
}

void tTVPBrowserWindow::OnSetMouseCursor(tjs_int cursor) { Notify(TJS_W("cursor"), {cursor}); }
void tTVPBrowserWindow::OnGetCursorPos(tjs_int &x, tjs_int &y) { x = CursorX; y = CursorY; }
void tTVPBrowserWindow::OnSetCursorPos(tjs_int x, tjs_int y) { CursorX = x; CursorY = y; Notify(TJS_W("cursorPosition"), {x, y}); }
void tTVPBrowserWindow::OnReleaseMouseCapture() { Notify(TJS_W("releaseCapture")); }
void tTVPBrowserWindow::OnSetHintText(iTJSDispatch2 *sender, const ttstr &hint) { Notify(TJS_W("hint"), {tTJSVariant(sender, sender), hint}); }
void tTVPBrowserWindow::OnResizeLayer(tjs_int width, tjs_int height) { Notify(TJS_W("layerSize"), {width, height}); }
void tTVPBrowserWindow::OnChangeLayerImage() { Notify(TJS_W("paint")); }
void tTVPBrowserWindow::OnSetAttentionPoint(tTJSNI_BaseLayer *, tjs_int x, tjs_int y) { Notify(TJS_W("attention"), {x, y}); }
void tTVPBrowserWindow::OnDisableAttentionPoint() { Notify(TJS_W("disableAttention")); }
void tTVPBrowserWindow::OnSetImeMode(tjs_int mode) { Notify(TJS_W("ime"), {mode}); }
void tTVPBrowserWindow::OnResetImeMode() { Notify(TJS_W("resetIme")); }
