#include "MenuItemIntf.h"
#include "runtime.h"
#include "runtime-layer.h"
#include "tjsNative.h"
#include "tjsArray.h"
#include "tjsDictionary.h"
#include "tjsObject.h"
#include <algorithm>
#include <emscripten/emscripten.h>
#include <cstdlib>
#include <cstring>
#include <stdexcept>
#include <array>
#include <memory>
#include <limits>
#include <cmath>

// clang-format off
// Dual-mode host entry under WebAssembly.Suspending: a non-thenable host
// result returns without suspending and invoke() ends the borrow on the same
// stack; a thenable result suspends the import and ends the borrow from JS
// before the caller resumes.
EM_JS(int, host_call, (Runtime * runtime, int callback, int operation, int receiver, int count, const int *args, int borrow), {
    try
    {
        const ids = Array.from(HEAPU32.subarray(args >>> 2, (args >>> 2) + count));
        let result;
        try
        {
            result = Module.hostDispatch(runtime, callback, operation, receiver, ids);
        }
        catch (error)
        {
            result = Promise.reject(error);
        }
        if (!(result && typeof result.then === 'function'))
            return result;
        // Closing starts at synchronous return. Await both paths so a throw
        // cannot leave native cleanup running after the caller has unwound.
        const settled = (async () => {
            const completed = await Promise.allSettled([ result, Module._tjs_borrow_end(runtime, borrow) ]);
            for (const item of completed)
                if (item.status === 'rejected')
                    throw item.reason;
            if (completed[1].value !== 1)
                throw new Error(Module.UTF16ToString(Module._tjs_runtime_error(runtime)) || 'Failed to release TJS borrowed values');
            return completed[0].value;
        })();
        return settled.catch(error =>
        { Module.hostError(runtime,String(error.message??error));return 0;
        });
    }
    catch (error)
    { Module.hostError(runtime,String(error.message??error));return 0;
    }
});
// clang-format on
// clang-format off
EM_JS(int, host_readonly_get, (Runtime * runtime, int callback, const tjs_char *name), {
    try
    {
        return Module.hostReadOnly(callback, UTF16ToString(name));
    }
    catch (error)
    { Module.hostError(runtime,String(error.message??error));return 0;
    }
});
// clang-format on
// Read-only packed values, corresponding to PSBValueDispatch. Reads remain
// synchronous so enumeration and native array/dictionary helpers can use them.
class HostReadOnly : public tTJSDispatch
{
    Runtime *r;
    int callback, length;
    std::vector<ttstr> keys;
    tjs_error missing(tjs_uint32 flag, tTJSVariant *result)
    {
        if (flag & TJS_MEMBERMUSTEXIST)
            return TJS_E_MEMBERNOTFOUND;
        if (result)
            result->Clear();
        return TJS_S_OK;
    }
    tjs_error read(const ttstr &name, tTJSVariant *result)
    {
        int id = host_readonly_get(r, callback, name.c_str());
        if (!id)
            throw eTJSError(r->error.c_str());
        if (result)
            *result = r->value(id);
        r->release(id);
        return TJS_S_OK;
    }

public:
    HostReadOnly(Runtime *r, int callback, int names, int length) : r(r), callback(callback), length(length)
    {
        if (length < 0)
        {
            auto array = r->value(names).AsObjectClosureNoAddRef();
            tTJSVariant count;
            array.PropGet(0, TJS_W("count"), nullptr, &count, nullptr);
            for (int i = 0; i < count.AsInteger(); ++i)
            {
                tTJSVariant name;
                array.PropGetByNum(0, i, &name, nullptr);
                keys.emplace_back(name);
            }
        }
        r->attachOwner(this);
    }
    ~HostReadOnly() override
    {
        r->forgetOwner(this);
        r->releaseHost(callback);
    }
    tjs_error PropSet(tjs_uint32, const tjs_char *, tjs_uint32 *, const tTJSVariant *, iTJSDispatch2 *) override { return TJS_E_NOTIMPL; }
    tjs_error PropSetByNum(tjs_uint32, tjs_int, const tTJSVariant *, iTJSDispatch2 *) override { return TJS_E_NOTIMPL; }
    tjs_error PropGet(tjs_uint32 flag, const tjs_char *name, tjs_uint32 *, tTJSVariant *result, iTJSDispatch2 *) override
    {
        if (!name)
            return TJS_E_NOTIMPL;
        if (length >= 0)
        {
            if (!TJS_strcmp(name, TJS_W("count")))
            {
                if (result)
                    *result = length;
                return TJS_S_OK;
            }
        }
        else
            for (const auto &key : keys)
                if (key == name)
                    return read(key, result);
        return missing(flag, result);
    }
    tjs_error PropGetByNum(tjs_uint32 flag, tjs_int index, tTJSVariant *result, iTJSDispatch2 *) override
    {
        if (length < 0)
            return TJS_E_MEMBERNOTFOUND;
        if (index < 0)
            index += length;
        return index < 0 || index >= length ? missing(flag, result) : read(ttstr(index), result);
    }
    tjs_error GetCount(tjs_int *result, const tjs_char *name, tjs_uint32 *, iTJSDispatch2 *) override
    {
        if (name || length < 0)
            return TJS_E_NOTIMPL;
        *result = length;
        return TJS_S_OK;
    }
    tjs_error IsInstanceOf(tjs_uint32, const tjs_char *name, tjs_uint32 *, const tjs_char *klass, iTJSDispatch2 *) override
    {
        if (name)
            return TJS_E_NOTIMPL;
        return !TJS_strcmp(klass, length >= 0 ? TJS_W("Array") : TJS_W("Dictionary")) ? TJS_S_TRUE : TJS_S_FALSE;
    }
    tjs_error EnumMembers(tjs_uint32 flag, tTJSVariantClosure *callback, iTJSDispatch2 *) override
    {
        const bool noValue = flag & TJS_ENUM_NO_VALUE;
        const int count = length >= 0 ? length : keys.size();
        tTJSVariant name, flags(0), value, result;
        tTJSVariant *args[] = {&name, &flags, &value};
        for (int i = 0; i < count; ++i)
        {
            const ttstr key = length >= 0 ? ttstr(i) : keys[i];
            name = key;
            if (!noValue)
                read(key, &value);
            callback->FuncCall(0, nullptr, nullptr, &result, noValue ? 2 : 3, args, this);
        }
        return TJS_S_OK;
    }
};
class HostDataInstance : public tTJSNativeInstance
{
    Runtime *r;
    int owner = 0, handle;

public:
    HostDataInstance(Runtime *r, int handle) : r(r), handle(handle) {}
    void attach(iTJSDispatch2 *value)
    {
        owner = (int)(uintptr_t)value;
        r->attachOwner(value);
    }
    ~HostDataInstance() override
    {
        r->forgetOwner(reinterpret_cast<iTJSDispatch2 *>((uintptr_t)owner));
        if (handle)
            r->releaseHost(handle);
    }
    void Invalidate() override
    {
        if (handle)
        {
            r->releaseHost(handle);
            handle = 0;
        }
    }
};
tjs_error invoke(Runtime *r, int callback, int operation, iTJSDispatch2 *receiver,
                        tTJSVariant *result, int count, tTJSVariant **args)
{
    const int borrow = r->beginBorrow();
    int owner = r->borrowValue(borrow, receiver ? tTJSVariant(receiver, receiver) : tTJSVariant());
    std::vector<int> handles;
    for (int i = 0; i < count; i++)
        handles.push_back(r->borrowValue(borrow, *args[i]));
    try
    {
        int returned = host_call(r, callback, operation, owner, count, handles.data(), borrow);
        // The host reports failures with 0; the message is in the error slot.
        if (!returned)
            throw eTJSError(r->error.c_str());
        if (result)
            *result = r->value(returned);
        r->release(returned);
    }
    catch (...)
    {
        r->endBorrow(borrow);
        throw;
    }
    r->endBorrow(borrow);
    return TJS_S_OK;
}

class HostMethod : public tTJSNativeClassMethod
{
    Runtime *r;
    int callback;

public:
    HostMethod(Runtime *r, int cb) : tTJSNativeClassMethod(nullptr), r(r), callback(cb) {}
    ~HostMethod() override
    {
        r->forgetDispatch(this);
        r->releaseHost(callback);
    }
    tjs_error FuncCall(tjs_uint32, const tjs_char *name, tjs_uint32 *, tTJSVariant *result, tjs_int count, tTJSVariant **args, iTJSDispatch2 *owner) override
    {
        if (name)
            return TJS_E_MEMBERNOTFOUND;
        return invoke(r, callback, 0, owner, result, count, args);
    }
};
class HostProperty : public tTJSDispatch
{
    Runtime *r;
    int callback;

public:
    HostProperty(Runtime *r, int cb) : r(r), callback(cb) {}
    ~HostProperty() override
    {
        r->forgetDispatch(this);
        r->releaseHost(callback);
    }
    tjs_error PropGet(tjs_uint32, const tjs_char *name, tjs_uint32 *, tTJSVariant *result, iTJSDispatch2 *owner) override
    {
        if (name)
            return TJS_E_MEMBERNOTFOUND;
        return invoke(r, callback, 1, owner, result, 0, nullptr);
    }
    tjs_error PropSet(tjs_uint32, const tjs_char *name, tjs_uint32 *, const tTJSVariant *value, iTJSDispatch2 *owner) override
    {
        if (name)
            return TJS_E_MEMBERNOTFOUND;
        tTJSVariant *arg = const_cast<tTJSVariant *>(value);
        return invoke(r, callback, 2, owner, nullptr, 1, &arg);
    }
};
class HostInstance : public tTJSNativeInstance
{
    Runtime *r;
    int owner = 0, initialize, stateHandle = 0, classId, reference = 0;

public:
    std::unique_ptr<NativeLayerState> layer;
    HostInstance(Runtime *r, int initialize, int classId, bool isLayer) : r(r), initialize(initialize ? host_retain(r, initialize) : 0), classId(classId) {
        if (isLayer) layer = std::make_unique<NativeLayerState>(r);
        r->alive++;
    }
    void attach(iTJSDispatch2 *value, int state = 0)
    {
        owner = (int)(uintptr_t)value;
        stateHandle = state;
        r->attachOwner(value);
        reference = r->owners.at(value).reference;
        if (layer) layer->owner = value;
        r->nativeInstances[classId][reference] = this;
    }
    int state() const { return stateHandle; }
    void setState(int handle)
    {
        if (handle == stateHandle)
            return;
        if (stateHandle)
            r->releaseHost(stateHandle);
        stateHandle = handle;
    }
    ~HostInstance() override
    {
        r->alive--;
        if (reference)
        {
            auto &instances = r->nativeInstances.at(classId);
            instances.erase(reference);
            if (instances.empty()) r->nativeInstances.erase(classId);
        }
        r->forgetOwner(reinterpret_cast<iTJSDispatch2 *>((uintptr_t)owner));
        if (stateHandle)
            r->releaseHost(stateHandle);
        if (initialize)
            r->releaseHost(initialize);
    }
    void Invalidate() override
    {
        std::exception_ptr failure;
        auto *ownerObject = reinterpret_cast<iTJSDispatch2 *>(static_cast<uintptr_t>(owner));
        if (owner && initialize && stateHandle)
        {
            try
            {
                invoke(r, initialize, 4, ownerObject, nullptr, 0, nullptr);
            }
            catch (...)
            {
                failure = std::current_exception();
            }
        }
        if (layer) {
            try { layer->invalidateFont(); }
            catch (...) { if (!failure) failure = std::current_exception(); }
            try { layer->childrenArray.Clear(); layer->childrenClear.Clear(); }
            catch (...) { if (!failure) failure = std::current_exception(); }
        }
        try
        {
            r->releaseOwnerValues(ownerObject);
        }
        catch (...)
        {
            if (!failure)
                failure = std::current_exception();
        }
        r->invalidations++;
        if (initialize)
        {
            r->releaseHost(initialize);
            initialize = 0;
        }
        if (stateHandle)
        {
            r->releaseHost(stateHandle);
            stateHandle = 0;
        }
        if (failure)
            std::rethrow_exception(failure);
    }
};
static HostInstance *hostInstance(Runtime *r, int reference, int classId)
{
    auto classes = r->nativeInstances.find(classId);
    if (classes == r->nativeInstances.end()) throw std::runtime_error("Layer/Font native instance not found");
    auto instance = classes->second.find(reference);
    if (instance == classes->second.end()) instance = classes->second.find(r->ownerReference(reference));
    if (instance == classes->second.end() || !instance->second->state())
        throw std::runtime_error("Layer/Font native instance not found");
    return instance->second;
}
static NativeLayerState &layerInstance(Runtime *r, int reference, int classId) {
    auto *host = hostInstance(r, reference, classId);
    if (!host->layer) throw std::runtime_error("Layer native instance not found");
    return *host->layer;
}
// Script-facing adapters retain TJS conversion, while JS owns all state.
class LayerProperty : public HostProperty {
    int classId, field;
public:
    LayerProperty(Runtime *r, int callback, int classId, int field)
        : HostProperty(r, callback), classId(classId), field(field) {}
    tjs_error PropGet(tjs_uint32 flag, const tjs_char *name, tjs_uint32 *hint, tTJSVariant *result, iTJSDispatch2 *owner) override {
        if (name) return TJS_E_MEMBERNOTFOUND;
        if (field != lrFont && field != lrChildren)
            return HostProperty::PropGet(flag, name, hint, result, owner);
        iTJSNativeInstance *instance = nullptr;
        if (!owner || TJS_FAILED(owner->NativeInstanceSupport(TJS_NIS_GETINSTANCE, classId, &instance)) || !instance)
            return TJS_E_NATIVECLASSCRASH;
        auto *host = static_cast<HostInstance *>(instance);
        if (!host->state() || !host->layer) return TJS_E_NATIVECLASSCRASH;
        iTJSDispatch2 *object;
        if (field == lrFont) object = host->layer->getFont();
        else {
            tTJSVariant snapshot;
            success(HostProperty::PropGet(flag, name, hint, &snapshot, owner));
            object = host->layer->getChildren(snapshot);
        }
        if (result) *result = tTJSVariant(object, object);
        return TJS_S_OK;
    }
    tjs_error PropSet(tjs_uint32 flag, const tjs_char *name, tjs_uint32 *hint, const tTJSVariant *value, iTJSDispatch2 *owner) override {
        if (name) return TJS_E_MEMBERNOTFOUND;
        tTJSVariant converted;
        switch (field) {
            case lfLeft: case lfTop: case lfImageLeft: case lfImageTop:
            case lfOpacity: case lfType: case lfFace: case lfDrawFace:
            case lfHitType: case lfHitThreshold: case lfCursor:
            case lrOrder: case lrAbsolute:
                converted = tjs_int(value->AsInteger()); break;
            case lfHoldAlpha: converted = tjs_int(tjs_int(value->AsInteger()) != 0); break;
            default: return HostProperty::PropSet(flag, name, hint, value, owner);
        }
        return HostProperty::PropSet(flag, name, hint, &converted, owner);
    }
};
class LayerMethod : public HostMethod {
    int method;
public:
    LayerMethod(Runtime *r, int, int method, int callback) : HostMethod(r, callback), method(method) {}
    tjs_error FuncCall(tjs_uint32 flag, const tjs_char *name, tjs_uint32 *hint, tTJSVariant *result, tjs_int count, tTJSVariant **args, iTJSDispatch2 *owner) override {
        // SetPos resizes only for exactly four non-void parameters.
        const int coordinates = method == 0 && count == 4 && args[2]->Type() != tvtVoid && args[3]->Type() != tvtVoid ? 4 : 2;
        if (count < 2) return HostMethod::FuncCall(flag, name, hint, result, count, args, owner);
        std::vector<tTJSVariant> values;
        for (int i = 0; i < count; ++i) values.push_back(i < coordinates ? tTJSVariant(tjs_int(args[i]->AsInteger())) : *args[i]);
        std::vector<tTJSVariant *> converted;
        for (auto &value : values) converted.push_back(&value);
        return HostMethod::FuncCall(flag, name, hint, result, count, converted.data(), owner);
    }
};
class FontProperty : public HostProperty {
    int field;
public:
    FontProperty(Runtime *r, int callback, int field) : HostProperty(r, callback), field(field) {}
    tjs_error PropSet(tjs_uint32 flag, const tjs_char *name, tjs_uint32 *hint, const tTJSVariant *value, iTJSDispatch2 *owner) override {
        if (field > 1) return HostProperty::PropSet(flag, name, hint, value, owner);
        tTJSVariant converted(tjs_int(value->AsInteger()));
        return HostProperty::PropSet(flag, name, hint, &converted, owner);
    }
};

class HostClass : public tTJSNativeClass
{
    Runtime *r;
    int initialize;
    bool isLayer;

protected:
    iTJSNativeInstance *CreateNativeInstance() override { return new HostInstance(r, initialize, _ClassID, isLayer); }

public:
    ~HostClass() override
    {
        r->forgetDispatch(this);
        if (initialize)
            r->releaseHost(initialize);
    }
    void attachInstance(iTJSDispatch2 *owner, int stateHandle)
    {
        const auto status = tTJSNativeClass::FuncCall(0, nullptr, nullptr, nullptr, 0, nullptr, owner);
        if (TJS_FAILED(status))
            TJS_eTJSError(status);
        iTJSNativeInstance *instance = nullptr;
        if (TJS_FAILED(owner->NativeInstanceSupport(TJS_NIS_GETINSTANCE, _ClassID, &instance)))
            TJS_eTJSError(TJS_E_NATIVECLASSCRASH);
        static_cast<HostInstance *>(instance)->attach(owner, stateHandle);
    }
    HostClass(Runtime *r, const tjs_char *name, int initialize) : tTJSNativeClass(name), r(r), initialize(initialize), isLayer(!TJS_strcmp(name, TJS_W("Layer")))
    {
        SetClassID(TJSRegisterNativeClass(name));
        if (!TJS_strcmp(name, TJS_W("Window"))) TVPRegisterWindowMenu(this);
        // tjsNative.h: TJS_DECL_EMPTY_FINALIZE_METHOD has no instance lookup.
        RegisterNCM(TJS_W("finalize"), TJSCreateNativeClassMethod([](tTJSVariant *, tjs_int, tTJSVariant **, iTJSDispatch2 *) -> tjs_error
                                                                  { return TJS_S_OK; }),
                    name, nitMethod);
    }
    tjs_error FuncCall(tjs_uint32 flag, const tjs_char *name, tjs_uint32 *hint, tTJSVariant *result, tjs_int count, tTJSVariant **args, iTJSDispatch2 *owner) override
    {
        const auto status = tTJSNativeClass::FuncCall(flag, name, hint, result, count, args, owner);
        if (!name && owner && TJS_SUCCEEDED(status))
        {
            iTJSNativeInstance *instance = nullptr;
            HostInstance *hostInstance = nullptr;
            if (TJS_SUCCEEDED(owner->NativeInstanceSupport(TJS_NIS_GETINSTANCE, _ClassID, &instance)) && instance)
            {
                hostInstance = static_cast<HostInstance *>(instance);
                hostInstance->attach(owner);
            }
            if (initialize)
            {
                invoke(r, initialize, 3, owner, nullptr, 0, nullptr);
            }
        }
        return status;
    }
};

extern "C"
{
    EMSCRIPTEN_KEEPALIVE int tjs_layer_font(Runtime *r, int reference, int classId, int invalidate) {
        return checked(r, [&] {
            auto &layer = layerInstance(r, reference, classId);
            if (invalidate) { layer.invalidateFont(); return r->keep(tTJSVariant()); }
            auto *font = layer.getFont(); return r->keep(tTJSVariant(font, font));
        });
    }
    // Class id for a name already registered by tjs_class_create. Lookup only:
    // registering here would turn a misspelled name into a silent empty class.
    EMSCRIPTEN_KEEPALIVE int tjs_class_id(Runtime *r, const tjs_char *name)
    {
        return TJSFindNativeClassID(name);
    }
    // JS caches the class id per VM, so this call carries no string. `id` is the
    // instance, `classId` selects the native slot.
    EMSCRIPTEN_KEEPALIVE int tjs_native_state(Runtime *r, int id, int classId, int handle)
    {
        return checked(r, [&]
                       {
        if(classId<0)return -1;
        auto value=r->copy(id);
        auto *owner=value.AsObjectNoAddRef();
        if(!r->owners.contains(owner))return -1;
        iTJSNativeInstance *instance=nullptr;
        if(TJS_FAILED(owner->NativeInstanceSupport(TJS_NIS_GETINSTANCE,classId,&instance)))return -1;
        auto *host=dynamic_cast<HostInstance *>(instance);
        if(!host)return -1;
        if(handle)host->setState(handle);
        return host->state(); });
    }
    // WindowIntf.cpp Add/Remove and the registered-object portion of Invalidate.
    EMSCRIPTEN_KEEPALIVE int tjs_native_states(Runtime *r, const tjs_char *name)
    {
        return checked(r, [&]
                       {
        auto *array=TJSCreateArrayObject();tTJSVariant result(array,array);array->Release();int index=0;
        const auto classId=TJSFindNativeClassID(name);
        const auto found=r->nativeInstances.find(classId);
        if(found!=r->nativeInstances.end())for(const auto &[identity,host]:found->second){
            if(host->state()){tTJSVariant value(host->state());success(array->PropSetByNum(TJS_MEMBERENSURE,index++,&value,array));}
        }
        return r->keep(result); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_create_host(Runtime *r, int kind, int hostHandle)
    {
        return checked(r, [&]
                       {
        // The name is a literal: resolve it once instead of once per object.
        static const tjs_int32 hostDataClass = TJSRegisterNativeClass(TJS_W("GalWebHostData"));
        iTJSDispatch2 *object=kind==1?TJSCreateArrayObject():kind==2?TJSCreateDictionaryObject():new tTJSCustomObject();auto *instance=new HostDataInstance(r,hostHandle);instance->attach(object);iTJSNativeInstance *native=instance;const auto status=object->NativeInstanceSupport(TJS_NIS_REGISTER,hostDataClass,&native);if(TJS_FAILED(status)){delete instance;object->Release();success(status);}int id=r->keep(tTJSVariant(object,object));object->Release();return id; });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_class_create(Runtime *r, const tjs_char *name, int initialize)
    {
        return checked(r, [&]
                       {auto *c=new HostClass(r,name,initialize);int id=r->keep(tTJSVariant(c,(iTJSDispatch2 *)nullptr));c->Release();return id; });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_class_instance(Runtime *r, int id, int stateHandle)
    {
        return checked(r, [&]
                       {tTJSVariant target=r->value(id);auto *klass=dynamic_cast<HostClass *>(target.AsObjectNoAddRef());if(!klass)throw eTJSError(TJS_W("TJS host class required"));auto *owner=new tTJSCustomObject();try{klass->attachInstance(owner,stateHandle);int result=r->keep(tTJSVariant(owner,owner));owner->Release();return result;}catch(...){owner->Release();throw;} });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_callback_create(Runtime *r, int callback, int property)
    {
        iTJSDispatch2 *object = property ? (iTJSDispatch2 *)new HostProperty(r, callback) : (iTJSDispatch2 *)new HostMethod(r, callback);
        int id = r->keep(tTJSVariant(object, nullptr));
        object->Release();
        return id;
    }
    EMSCRIPTEN_KEEPALIVE int tjs_readonly_create(Runtime *r, int callback, int keys, int length)
    {
        return checked(r, [&]
                       {auto *object=new HostReadOnly(r,callback,keys,length);int id=r->keep(tTJSVariant(object,object));object->Release();return id; });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_class_register_member(Runtime *r, int id, const tjs_char *name, int callback, int property)
    {
        return checked(r, [&]
                       {
        auto *c=dynamic_cast<HostClass *>(r->value(id).AsObjectNoAddRef());
        if(!c)throw std::runtime_error("not a host class");
        // Layer/Font adapters handle script semantics, never rendering state.
        const auto classId=TJSFindNativeClassID(c->GetClassName().c_str());
        iTJSDispatch2 *m = property >= 300
            ? static_cast<iTJSDispatch2 *>(new LayerMethod(r, classId, property - 300, callback))
            : property >= 100
            ? static_cast<iTJSDispatch2 *>(new FontProperty(r, callback, property - 100))
            : property >= 2
            ? static_cast<iTJSDispatch2 *>(new LayerProperty(r, callback, classId, property - 2))
            : property ? static_cast<iTJSDispatch2 *>(new HostProperty(r,callback)) : static_cast<iTJSDispatch2 *>(new HostMethod(r,callback));
        const bool isProperty = property == 1 || (property >= 2 && property < 200);
        c->RegisterNCM(name,m,c->GetClassName().c_str(),isProperty ? nitProperty : nitMethod);
        return r->keep(tTJSVariant()); });
    }}
