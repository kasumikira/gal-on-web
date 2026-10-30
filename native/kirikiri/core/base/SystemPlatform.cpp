// Browser platform adapter for the original SystemIntf.cpp.
#include "SystemPlatform.h"
#include "StorageIntf.h"
#include "../../visual/FontImpl.h"
#include "tjsDictionary.h"
#include "tjsObject.h"
#include "TickCount.h"
#include <algorithm>
#include <emscripten.h>

namespace {
tTJSVariant host(const tjs_char *name, std::initializer_list<tTJSVariant> values = {}) {
    std::vector<tTJSVariant> args(values);
    std::vector<tTJSVariant *> pointers;
    for(auto &value : args) pointers.push_back(&value);
    tTJSVariant result;
    success(activeRuntime->system.service.AsObjectClosureNoAddRef().FuncCall(
        0, name, nullptr, &result, pointers.size(), pointers.data(), nullptr));
    return result;
}
void readRegistry(tTJSVariant *result, const ttstr &path) {
    auto &state = activeRuntime->system;
    if(!state.registerDataLoaded) {
        const ttstr file(TJS_W("/RegisterData.tjs"));
        if(TVPIsExistentStorageNoSearch(file))
            TVPExecuteStorage(file, nullptr, &state.registerData, true, TJS_W(""));
        state.registerDataLoaded = true;
    }
    tTJSVariant node = state.registerData;
    const tjs_char *cursor = path.c_str();
    while(*cursor) {
        while(*cursor == '/' || *cursor == 0x5c) ++cursor;
        if(!*cursor) break;
        const tjs_char *begin = cursor;
        while(*cursor && *cursor != '/' && *cursor != 0x5c) ++cursor;
        if(node.Type() != tvtObject || !node.AsObjectNoAddRef()) { node.Clear(); break; }
        auto closure = node.AsObjectClosureNoAddRef();
        tTJSVariant value;
        auto error = closure.PropGet(TJS_MEMBERMUSTEXIST | TJS_IGNOREPROP,
            ttstr(begin, cursor - begin).c_str(), nullptr, &value, nullptr);
        if(error == TJS_E_MEMBERNOTFOUND) { node.Clear(); break; }
        success(error);
        node = value;
    }
    if(path.IsEmpty() || node.Type() == tvtObject) node.Clear();
    if(result) *result = node;
}
}

void TVPInitializeSystem(const tTJSVariant &service) {
    auto &state = activeRuntime->system;
    state.service = service;
    state.limitContinuous60 = host(TJS_W("limitContinuous60")).operator bool();
    auto source = host(TJS_W("arguments"));
    auto *dictionary = TJSCreateDictionaryObject();
    state.arguments = tTJSVariant(dictionary, dictionary);
    dictionary->Release();
    tTJSDictionaryNI *instance = nullptr;
    success(dictionary->NativeInstanceSupport(TJS_NIS_GETINSTANCE, TJSGetDictionaryClassID(),
        reinterpret_cast<iTJSNativeInstance **>(&instance)));
    instance->Assign(source.AsObjectNoAddRef());
}
void TVPMaintainSystem(bool start) {
    auto &state = activeRuntime->system;
    const auto tick = TVPGetTickCount();
    if(start) { state.maintenanceStarted = true; state.lastCompact = tick; }
    if(!state.maintenanceStarted || TVPHasContinuousEvents()) return;
    if(tick - state.lastCompact > 4000) {
        state.lastCompact = tick;
        TVPDeliverCompactEvent(5);
    }
    if(tick - state.lastRehash > 1500) {
        state.lastRehash = tick;
        TJSDoRehash();
    }
}
void TVPDeliverCompactEvent(tjs_int level) {
    if(level >= TVP_COMPACT_LEVEL_IDLE) activeRuntime->engine->DoGarbageCollection();
    compactRuntime(level);
}
void TVPTerminateAsync(int code) { host(TJS_W("terminate"), {code}); }
void TVPTerminateSync(int code) { host(TJS_W("exit"), {code}); }
ttstr TVPGetVersionString() { return TJS_W("2.32.2.426"); }
ttstr TVPGetVersionInformation() { return TJS_W("Kirikiri2 Runtime Core version 2.32.2.426"); }
ttstr TVPGetPlatformName() { return TJS_W("Web"); }
ttstr TVPGetOSName() { return TJS_W("Web"); }
tjs_int TVPGetOSBits() { return 64; }
tjs_int TVPSystemProcessorNum() { return host(TJS_W("processorNum")).AsInteger(); }
EM_JS(void, system_random_bits, (unsigned char *data), {
    crypto.getRandomValues(HEAPU8.subarray(data, data + 16));
});
void TVPGetRandomBits128(tjs_uint8 *data) { system_random_bits(data); }
int TVPShowSimpleInputBox(ttstr &value, const ttstr &caption, const ttstr &prompt, const std::vector<ttstr> &) {
    auto answer = host(TJS_W("inputString"), {caption, prompt, value});
    if(answer.Type() == tvtVoid) return 1;
    value = answer;
    return 0;
}

tTJSNativeClass *TVPCreateNativeClass_System() {
    auto *cls = new tTJSNC_System();
#define METHOD(name, minimum, ...) \
    cls->RegisterNCM(TJS_W(#name), TJSCreateNativeClassMethod( \
        [](tTJSVariant *result, tjs_int count, tTJSVariant **args, iTJSDispatch2 *) -> tjs_error { \
            if(count < minimum) return TJS_E_BADPARAMCOUNT; \
            __VA_ARGS__; return TJS_S_OK; }), TJS_W("System"), nitMethod, TJS_STATICMEMBER)
#define PROPERTY(name, ...) \
    cls->RegisterNCM(TJS_W(#name), TJSCreateNativeClassProperty( \
        [](tTJSVariant *result, iTJSDispatch2 *) -> tjs_error { \
            *result = (__VA_ARGS__); return TJS_S_OK; }, nullptr), TJS_W("System"), nitProperty, TJS_STATICMEMBER)
    METHOD(inform, 1, host(TJS_W("inform"), {ttstr(*args[0]), count > 1 ? tTJSVariant(ttstr(*args[1])) : tTJSVariant(TJS_W(""))}));
    METHOD(getTickCount, 0, if(result) *result = static_cast<tjs_int64>(TVPGetTickCount()));
    METHOD(getKeyState, 1, auto value = host(TJS_W("getKeyState"), {args[0]->AsInteger(), count < 2 || args[1]->Type() == tvtVoid ? tTJSVariant(1) : tTJSVariant(static_cast<tjs_int>(args[1]->operator bool()))}); if(result) *result = value);
    METHOD(getArgument, 1, if(result) { result->Clear(); auto object = activeRuntime->system.arguments.AsObjectClosureNoAddRef(); auto error = object.PropGet(TJS_IGNOREPROP, ttstr(*args[0]).c_str(), nullptr, result, nullptr); if(error != TJS_E_MEMBERNOTFOUND) success(error); });
    METHOD(setArgument, 2, tTJSVariant value{ttstr(*args[1])}; success(activeRuntime->system.arguments.AsObjectClosureNoAddRef().PropSet(TJS_MEMBERENSURE | TJS_IGNOREPROP, ttstr(*args[0]).c_str(), nullptr, &value, nullptr)));
    METHOD(readRegValue, 1, readRegistry(result, ttstr(*args[0])));
    METHOD(createAppLock, 1, ttstr name(*args[0]); if(result) *result = 1);
    METHOD(addFont, 1, auto path = TVPGetPlacedPath(ttstr(*args[0])); if(path.length()) { const int count = TVPEnumFontsProc(path); if(result) *result = count; });
    METHOD(dumpHeap, 0, host(TJS_W("dumpHeap")));
    METHOD(nullpo, 0, host(TJS_W("nullpo")));
    METHOD(showVersion, 0, host(TJS_W("showVersion")));
    PROPERTY(exePath, TJS_W("/"));
    PROPERTY(personalPath, TJS_W("/"));
    PROPERTY(appDataPath, TJS_W("/"));
    PROPERTY(dataPath, TJS_W("/"));
    PROPERTY(savedGamesPath, TJS_W("/savedata/"));
    PROPERTY(exeName, TJS_W("galweb"));
    PROPERTY(screenWidth, host(TJS_W("screenWidth")));
    PROPERTY(screenHeight, host(TJS_W("screenHeight")));
    PROPERTY(desktopLeft, 0);
    PROPERTY(desktopTop, 0);
    PROPERTY(desktopWidth, host(TJS_W("screenWidth")));
    PROPERTY(desktopHeight, host(TJS_W("screenHeight")));
    PROPERTY(touchDevice, 0);
    cls->RegisterNCM(TJS_W("title"), TJSCreateNativeClassProperty(
        [](tTJSVariant *result, iTJSDispatch2 *) -> tjs_error { *result = activeRuntime->system.title; return TJS_S_OK; },
        [](const tTJSVariant *value, iTJSDispatch2 *) -> tjs_error {
            activeRuntime->system.title = *value;
            host(TJS_W("title"), {activeRuntime->system.title}); return TJS_S_OK;
        }), TJS_W("System"), nitProperty, TJS_STATICMEMBER);
#undef METHOD
#undef PROPERTY
    return cls;
}
