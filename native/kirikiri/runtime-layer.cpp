#include "runtime-layer.h"
#include "runtime.h"
#include "tjsArray.h"
#include <vector>

// The JS getter supplies the current children in Z order. Hold all returned
// owners before clearing the canonical array, which may own their last refs.
iTJSDispatch2 *NativeLayerState::getChildren(const tTJSVariant &snapshot) {
    auto source = snapshot.AsObjectClosureNoAddRef();
    tTJSVariant count;
    success(source.PropGet(0, TJS_W("count"), nullptr, &count, nullptr));
    std::vector<tTJSVariant> owners(static_cast<size_t>(tjs_int(count)));
    for (size_t i = 0; i < owners.size(); ++i)
        success(source.PropGetByNum(0, tjs_int(i), &owners[i], nullptr));
    if (childrenArray.Type() != tvtObject) {
        iTJSDispatch2 *klass;
        auto *array = TJSCreateArrayObject(&klass);
        childrenArray = tTJSVariant(array, array); array->Release();
        try { success(klass->PropGet(0, TJS_W("clear"), nullptr, &childrenClear, klass)); }
        catch (...) { klass->Release(); throw; }
        klass->Release();
    }
    auto *array = childrenArray.AsObjectNoAddRef();
    success(childrenClear.AsObjectClosureNoAddRef().FuncCall(0, nullptr, nullptr, nullptr, 0, nullptr, array));
    for (size_t i = 0; i < owners.size(); ++i)
        success(array->PropSetByNum(TJS_MEMBERENSURE, tjs_int(i), &owners[i], array));
    return array;
}

iTJSDispatch2 *NativeLayerState::getFont() {
    if (fontObject.Type() != tvtObject) {
        auto *global = runtime->engine->GetGlobalNoAddRef();
        tTJSVariant klass;
        success(global->PropGet(0, TJS_W("Font"), nullptr, &klass, global));
        tTJSVariant layer(owner, owner); tTJSVariant *args[] = {&layer};
        iTJSDispatch2 *object = nullptr;
        auto closure = klass.AsObjectClosureNoAddRef();
        success(closure.Object->CreateNew(0, nullptr, nullptr, &object, 1, args, closure.ObjThis));
        fontObject = tTJSVariant(object, object); object->Release();
    }
    return fontObject.AsObjectNoAddRef();
}
void NativeLayerState::invalidateFont() {
    if (fontObject.Type() != tvtObject) return;
    auto *object = fontObject.AsObjectNoAddRef();
    try { success(object->Invalidate(0, nullptr, nullptr, object)); }
    catch (...) { fontObject.Clear(); throw; }
    fontObject.Clear();
}
