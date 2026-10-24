#pragma once
#include "tjs.h"
#include "tjsNative.h"
using namespace TJS;

struct NativePluginClassInfo {
    bool initialized = false;
    const tjs_char *name = nullptr;
    tjs_int32 id = 0;
    tTJSNativeClassForPlugin *obj = nullptr;
    tTJSVariant root;
};

NativePluginClassInfo &TVPPluginClassInfo(const void *key);
tTJSVariant &TVPPluginValue(const void *key);
void TVPInitializePlugins();
bool TVPLinkNativePlugin(const ttstr &name);
tTJSVariant TVPGetLoadedNativePlugins();

