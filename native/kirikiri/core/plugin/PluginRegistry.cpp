#include "ncbind.hpp"
#include "runtime.h"

const ncbAutoRegister *ncbAutoRegister::_top[ncbAutoRegister::LINE_COUNT] = {};
std::map<std::u16string, ncbAutoRegister::INTERNAL_PLUGIN_LISTS> ncbAutoRegister::_internal_plugins;

void ncbAutoRegister::AllRegist() {
    static bool indexed = false;
    if (indexed) return;
    for (int line = 0; line < LINE_COUNT; ++line) {
        for (auto *item = _top[line]; item; item = item->_next) {
            ttstr name(item->modulename);
            name.ToLowerCase();
            _internal_plugins[name.c_str()].lists[line].push_back(item);
        }
    }
    indexed = true;
}

bool ncbAutoRegister::HasModule(const ttstr &value) {
    return _internal_plugins.contains(value.AsLowerCase().c_str());
}

bool ncbAutoRegister::LoadModule(const ttstr &value) {
    const std::u16string name(value.AsLowerCase().c_str());
    if (activeRuntime->loadedPlugins.contains(name)) return false;
    const auto found = _internal_plugins.find(name);
    if (found == _internal_plugins.end()) return false;
    for (const auto &stage : found->second.lists)
        for (auto *item : stage) item->Regist();
    activeRuntime->loadedPlugins.insert(name);
    return true;
}

NativePluginClassInfo &TVPPluginClassInfo(const void *key) {
    return activeRuntime->pluginClasses[key];
}
tTJSVariant &TVPPluginValue(const void *key) {
    return activeRuntime->pluginValues[key];
}
void TVPInitializePlugins() { ncbAutoRegister::AllRegist(); }
bool TVPLinkNativePlugin(const ttstr &name) {
    if (!ncbAutoRegister::HasModule(name)) return false;
    ncbAutoRegister::LoadModule(name);
    return true;
}
tTJSVariant TVPGetLoadedNativePlugins() {
    auto *array = TJSCreateArrayObject();
    tTJSVariant result(array, array);
    array->Release();
    tjs_int index = 0;
    for (const auto &name : activeRuntime->loadedPlugins) {
        tTJSVariant value(name.c_str());
        success(array->PropSetByNum(TJS_MEMBERENSURE, index++, &value, array));
    }
    return result;
}

iTJSDispatch2 *TVPGetScriptDispatch() {
    auto *global = activeRuntime->engine->GetGlobalNoAddRef();
    global->AddRef();
    return global;
}
void TVPExecuteExpression(const ttstr &text, tTJSVariant *result) {
    TVPExecuteExpression(text, nullptr, result);
}
