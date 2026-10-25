#include "runtime.h"
#include "ScriptMgnIntf.h"
#include "tjsNative.h"
#include <algorithm>
#include <emscripten/emscripten.h>

Runtime::Runtime()
{ engine->SetConsoleOutput(this); }

void Runtime::Print(const tjs_char *message)
{
    diagnostic += message;
    diagnostic += u'\n';
}

void Runtime::ExceptionPrint(const tjs_char *message)
{ Print(message); }

int Runtime::keep(const tTJSVariant &v, int parent, int owner)
{
    // A reentrant API call may complete after its input borrow has ended.
    // Only a still-live borrow can constrain a derived synchronous value.
    const auto source = values.find(parent);
    const int borrow = source != values.end() && source->second.borrow > 0 ? source->second.borrow : 0;
    const int id = next++;
    values.emplace(id, Value{v, borrow, owner});
    valuesByOwner[owner].insert(id);
    if (borrow)
        borrows.at(borrow).push_back(id);
    return id;
}

tTJSVariant &Runtime::value(int id)
{
    auto found = values.find(id);
    if (found == values.end())
        throw eTJSError(TJS_W("TJS shadow reference has expired"));
    return found->second.value;
}

int Runtime::beginBorrow()
{
    int id = next++;
    borrows.emplace(id, std::vector<int>());
    return id;
}

int Runtime::borrowValue(int borrow, const tTJSVariant &v)
{
    int id = keep(v);
    values.at(id).borrow = borrow;
    borrows.at(borrow).push_back(id);
    return id;
}

void Runtime::endBorrow(int id)
{
    auto frame = borrows.extract(id);
    if (frame.empty())
        return;
    std::exception_ptr failure;
    // Extract before Release: finalizers may reenter the bridge.
    for (int handle : frame.mapped())
    {
        auto held = extractValue(handle);
        if (held.empty())
            continue;
        try
        {
            held.mapped().value.Clear();
        }
        catch (...)
        {
            if (!failure)
                failure = std::current_exception();
        }
    }
    if (failure)
        std::rethrow_exception(failure);
}

void Runtime::release(int id)
{
    auto found = values.find(id);
    if (found != values.end() && found->second.borrow == 0)
    {
        auto held = extractValue(id);
        held.mapped().value.Clear();
    }
}

std::map<int, Runtime::Value>::node_type Runtime::extractValue(int id)
{
    auto held = values.extract(id);
    if (!held.empty()) {
        auto index = valuesByOwner.find(held.mapped().owner);
        index->second.erase(id);
        if (index->second.empty()) valuesByOwner.erase(index);
    }
    return held;
}

int Runtime::ownerReference(int id)
{
    if (ownerReferences.contains(id))
        return id;
    tTJSVariant target = copy(id);
    auto found = owners.find(target.AsObjectNoAddRef());
    if (found == owners.end())
        throw eTJSError(TJS_W("Native TJS owner is unavailable"));
    return found->second.reference;
}

void Runtime::bindOwner(int id, int owner)
{
    auto value = values.find(id);
    if (value == values.end())
        throw eTJSError(TJS_W("TJS shadow reference has expired"));
    if (value->second.borrow != 0)
        throw eTJSError(TJS_W("A borrowed TJS reference cannot be stored by a native owner"));
    const int reference = ownerReference(owner);
    if (value->second.owner && value->second.owner != reference)
        throw eTJSError(TJS_W("TJS reference already belongs to another native owner"));
    if (value->second.owner != reference) {
        auto index = valuesByOwner.find(value->second.owner);
        index->second.erase(id);
        if (index->second.empty()) valuesByOwner.erase(index);
        value->second.owner = reference;
        valuesByOwner[reference].insert(id);
    }
}

int Runtime::retainForOwner(int id, int owner)
{
    return keep(value(id), 0, ownerReference(owner));
}

void Runtime::releaseOwnerValues(iTJSDispatch2 *owner)
{
    auto ownerInfo = owners.find(owner);
    if (ownerInfo == owners.end())
        return;
    const int reference = ownerInfo->second.reference;
    std::exception_ptr failure;
    for (;;)
    {
        auto index = valuesByOwner.find(reference);
        if (index == valuesByOwner.end())
            break;
        auto held = extractValue(*index->second.begin());
        try
        {
            held.mapped().value.Clear();
        }
        catch (...)
        {
            if (!failure)
                failure = std::current_exception();
        }
    }
    if (failure)
        std::rethrow_exception(failure);
}

tTJSVariant Runtime::copy(int id)
{
    auto owner = ownerReferences.find(id);
    return owner != ownerReferences.end() ? tTJSVariant(owner->second, owner->second) : value(id);
}

int Runtime::copyHandle(int id)
{
    tTJSVariant v = copy(id);
    return keep(v, values.contains(id) ? id : 0);
}

void Runtime::attachOwner(iTJSDispatch2 *owner)
{
    if (owners.contains(owner))
        return;
    int reference = next++;
    ownerReferences.emplace(reference, owner);
    owners.emplace(owner, Owner{reference});
}

void Runtime::shutdown()
{
    if (stopped)
        return;
    // Closing a browser engine closes its native windows before removing
    // the script globals used by their finalize callbacks.
    {
        std::vector<std::pair<int, tTJSVariant>> windows;
        const int classId = TJSRegisterNativeClass(TJS_W("Window"));
        for (const auto &[owner, info] : owners) {
            iTJSNativeInstance *instance = nullptr;
            if (TJS_SUCCEEDED(owner->NativeInstanceSupport(TJS_NIS_GETINSTANCE, classId, &instance)) && instance)
                windows.emplace_back(info.reference, tTJSVariant(owner, owner));
        }
        std::sort(windows.begin(), windows.end(), [](const auto &a, const auto &b) { return a.first < b.first; });
        for (auto &[reference, value] : windows) {
            auto object = value.AsObjectClosureNoAddRef();
            const auto status = object.Invalidate(0, nullptr, nullptr, object.ObjThis);
            if (TJS_FAILED(status)) TJS_eTJSError(status);
        }
    }
    // Drop bridge roots that are not held by a native instance first.
    // Owner-held values stay available while their owning objects run
    // their original TJS finalization callbacks.
    borrows.clear();
    for (;;)
    {
        auto index = valuesByOwner.find(0);
        if (index == valuesByOwner.end())
            break;
        auto held = extractValue(*index->second.begin());
        held.mapped().value.Clear();
    }
    engine->Shutdown();
    timerScheduler.Clear();
    pluginValues.clear();
    pluginClasses.clear();
    loadedPlugins.clear();
    // Native Invalidate callbacks must have released every owner-held
    // value. Do not guess an order for any handle left after finalization.
    if (!values.empty())
        throw eTJSError(TJS_W("TJS bridge references remain after engine finalization"));
    TVPClearScnearioCache();
    stopped = true;
}

Runtime::~Runtime()
{
    shutdown();
    engine->Release();
}

Runtime *activeRuntime = nullptr;
// clang-format off
EM_JS(void, host_release, (Runtime * runtime, int handle), {
    Module.hostRelease?.(runtime, handle);
});
EM_JS(int, host_retain, (Runtime * runtime, int handle), {
    return Module.hostRetain(runtime, handle);
});
EM_JS(int, host_owner, (int id), { return Module.hostOwner(id); });
// clang-format on
void Runtime::releaseHost(int handle)
{
    removeExport(handle);
    host_release(this, handle);
}
void Runtime::bindExport(int handle, int identity, const tTJSVariantClosure &value)
{
    removeExport(handle);
    exports.emplace(handle, Export{value.Object, value.ObjThis, identity});
    exportsByIdentity[identity].insert(handle);
    exportsByObject[value.Object].insert(handle);
}
void Runtime::removeExport(int handle)
{
    auto held = exports.extract(handle);
    if (held.empty()) return;
    auto identity = exportsByIdentity.find(held.mapped().identity);
    identity->second.erase(handle);
    if (identity->second.empty()) exportsByIdentity.erase(identity);
    auto object = exportsByObject.find(held.mapped().object);
    object->second.erase(handle);
    if (object->second.empty()) exportsByObject.erase(object);
}
void Runtime::forgetDispatch(iTJSDispatch2 *object)
{
    for (;;) {
        auto index = exportsByObject.find(object);
        if (index == exportsByObject.end()) break;
        releaseHost(*index->second.begin());
    }
}
void Runtime::forgetOwner(iTJSDispatch2 *owner)
{
    forgetDispatch(owner);
    auto found = owners.find(owner);
    if (found == owners.end())
        return;
    auto ownerInfo = std::move(found->second);
    owners.erase(found);
    ownerReferences.erase(ownerInfo.reference);
    if (ownerInfo.host)
        releaseHost(ownerInfo.host);
}
int Runtime::ownerHost(int id)
{
    auto found = owners.find(copy(id).AsObjectNoAddRef());
    if (found == owners.end())
        return -1;
    if (!found->second.host)
        found->second.host = host_owner(found->second.reference);
    return found->second.host;
}
