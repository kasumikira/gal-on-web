#include "runtime.h"
#include "visual/LayerIntf.h"
#include "visual/BitmapIntf.h"
#include "visual/LayerBitmapIntf.h"
#include "visual/RenderManager.h"
#include "visual/EventIntf.h"
#include "visual/BrowserWindow.h"
#include <emscripten/emscripten.h>

extern "C" EMSCRIPTEN_KEEPALIVE int tjs_visual_movie_frame(Runtime *runtime,
    int object, int width, int height, int left, int top, const void *pixels, int video) {
    return checked(runtime, [&] {
        auto *target = runtime->value(object).AsObjectNoAddRef();
        tTJSNI_Layer *layer = nullptr;
        if (target) target->NativeInstanceSupport(TJS_NIS_GETINSTANCE, tTJSNC_Layer::ClassID,
            reinterpret_cast<iTJSNativeInstance **>(&layer));
        if (!layer) return 1;
        if (video && width > 0 && height > 0) layer->SetImageSize(width, height);
        layer->SetSize(width, height);
        if (width > 0 && height > 0) {
            tTVPRect rect(0, 0, width, height);
            layer->GetMainImage()->GetTextureForRender(false, &rect)->Update(
                pixels, TVPTextureFormat::RGBA, width * 4, rect);
        }
        if (!video) layer->SetPosition(left, top);
        layer->Update(false);
        return 1;
    });
}

// Browser-owned decoded media enters the same original Bitmap interface as
// native image loaders. No Layer state or tree is mirrored by the host.
extern "C" EMSCRIPTEN_KEEPALIVE int tjs_visual_bitmap(Runtime *runtime,
    int width, int height, const void *pixels) {
    return checked(runtime, [&] {
        auto *object = TVPCreateBitmapObject();
        tTJSVariant value(object, object);
        object->Release();
        tTJSNI_Bitmap *bitmap = nullptr;
        success(object->NativeInstanceSupport(TJS_NIS_GETINSTANCE, tTJSNC_Bitmap::ClassID,
                                             reinterpret_cast<iTJSNativeInstance **>(&bitmap)));
        bitmap->SetSize(width, height, false);
        tTVPRect rect(0, 0, width, height);
        bitmap->GetBitmap()->GetTextureForRender(false, &rect)->Update(
            pixels, TVPTextureFormat::RGBA, width * 4, rect);
        return runtime->keep(value);
    });
}

extern "C" EMSCRIPTEN_KEEPALIVE int tjs_visual_register(Runtime *runtime) {
    return checked(runtime, [&] {
        auto *global = runtime->engine->GetGlobalNoAddRef();
        for (auto *klass : {TVPCreateNativeClass_Layer(), TVPCreateNativeClass_Font(), TVPCreateNativeClass_Bitmap()}) {
            tTJSVariant value(klass, nullptr);
            klass->Release();
            success(global->PropSet(TJS_MEMBERENSURE, klass->GetClassName().c_str(), nullptr, &value, global));
        }
        return 1;
    });
}

extern "C" EMSCRIPTEN_KEEPALIVE int tjs_visual_window(Runtime *runtime, int operation,
    int object, int service, double x, double y, int kind, int button, tjs_uint32 flags, double cx, double cy) {
    return checked(runtime, [&] {
        auto *owner = runtime->value(object).AsObjectNoAddRef();
        if(operation == 0) tTVPBrowserWindow::Attach(owner, runtime->value(service));
        else if(operation == 1) tTVPBrowserWindow::From(owner)->Render();
        else if(operation == 2) tTVPBrowserWindow::From(owner)->Resize(x, y);
        else if(operation == 3) tTVPBrowserWindow::From(owner)->Input(kind, x, y, button, flags, cx, cy);
        else if(operation == 4) {
            auto *klass = dynamic_cast<tTJSNativeClass *>(owner);
            if(!klass) TVPThrowExceptionMessage(TJS_W("Browser window requires a native Window class"));
            tTVPBrowserWindow::Register(klass);
        } else throw eTJSError(TJS_W("Unknown browser window operation"));
        return 1;
    });
}

extern "C" EMSCRIPTEN_KEEPALIVE int tjs_visual_events(Runtime *runtime, int operation, int service) {
    return checked(runtime, [&] {
        if(operation == 0) runtime->visualService = runtime->value(service);
        else if(operation == 1) TVPDeliverAllEvents();
        else if(operation == 2) TVPDeliverContinuousEvent();
        else throw eTJSError(TJS_W("Unknown visual event operation"));
        return 1;
    });
}
