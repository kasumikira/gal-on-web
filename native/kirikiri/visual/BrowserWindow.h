#pragma once
#include "LayerTreeOwnerImpl.h"
#include "tjsNative.h"

// Browser platform owner; all layer/tree state remains in the reference manager.
class tTVPBrowserWindow : public tTJSNativeInstance, public tTVPLayerTreeOwner {
    iTJSDispatch2 *Owner;
    tTJSVariant Service;
    tjs_int CursorX = 0, CursorY = 0;
    bool PaintRequested = false;
    void Notify(const tjs_char *name, std::initializer_list<tTJSVariant> args = {});
public:
    tTVPBrowserWindow(iTJSDispatch2 *owner, const tTJSVariant &service);
    void Invalidate() override;
    iTJSDispatch2 *GetOwnerNoAddRef() const override { return Owner; }
    static tTVPBrowserWindow *From(iTJSDispatch2 *owner);
    static void Attach(iTJSDispatch2 *owner, const tTJSVariant &service);
    static void Register(tTJSNativeClass *klass);
    void Render();
    void NotifyLayerResize(iTVPLayerManager *manager) override;
    void NotifyLayerImageChange(iTVPLayerManager *manager) override;
    void Resize(tjs_int width, tjs_int height);
    void Input(int kind, double x, double y, int button, tjs_uint32 flags, double cx, double cy);
    void StartBitmapCompletion(iTVPLayerManager *) override {}
    void NotifyBitmapCompleted(iTVPLayerManager *, tjs_int, tjs_int, tTVPBaseTexture *,
                               const tTVPRect &, tTVPLayerType, tjs_int) override;
    void EndBitmapCompletion(iTVPLayerManager *) override {}
    void OnSetMouseCursor(tjs_int cursor) override;
    void OnGetCursorPos(tjs_int &x, tjs_int &y) override;
    void OnSetCursorPos(tjs_int x, tjs_int y) override;
    void OnReleaseMouseCapture() override;
    void OnSetHintText(iTJSDispatch2 *sender, const ttstr &hint) override;
    void OnResizeLayer(tjs_int width, tjs_int height) override;
    void OnChangeLayerImage() override;
    void OnSetAttentionPoint(tTJSNI_BaseLayer *, tjs_int x, tjs_int y) override;
    void OnDisableAttentionPoint() override;
    void OnSetImeMode(tjs_int mode) override;
    void OnResetImeMode() override;
};
