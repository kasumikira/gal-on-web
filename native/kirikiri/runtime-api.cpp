#include "StoragesIntf.h"
#include "TimerIntf.h"
#include "RectItf.h"
#include "PadIntf.h"
#include "MenuItemIntf.h"
#include "runtime.h"
#include "ScriptMgnIntf.h"
#include "KAGParser.h"
#include "tjsNative.h"
#include "tjsArray.h"
#include "tjsDictionary.h"
#include "tjsObject.h"
#include <algorithm>
#include <emscripten/emscripten.h>
#include <spdlog/sinks/stdout_sinks.h>
#include <spdlog/spdlog.h>

class MemberNames : public tTJSDispatch
{
public:
    iTJSDispatch2 *array;
    int count = 0;
    explicit MemberNames(iTJSDispatch2 *array) : array(array) {}
    tjs_error FuncCall(tjs_uint32, const tjs_char *, tjs_uint32 *, tTJSVariant *result, tjs_int, tTJSVariant **args, iTJSDispatch2 *) override
    {
        if (!(args[1]->AsInteger() & TJS_HIDDENMEMBER))
            success(array->PropSetByNum(TJS_MEMBERENSURE, count++, args[0], array));
        if (result)
            *result = 1;
        return TJS_S_OK;
    }
};

extern "C"
{
    EMSCRIPTEN_KEEPALIVE Runtime *tjs_runtime_create()
    {
        if (!spdlog::get("tjs2"))
            spdlog::stderr_logger_st("tjs2");
        initializeStorageCallbacks();
        auto *runtime = new Runtime();
        RuntimeScope scope(runtime);
        auto *klass = TVPCreateNativeClass_KAGParser();
        tTJSVariant value(klass, nullptr);
        klass->Release();
        runtime->engine->GetGlobalNoAddRef()->PropSet(TJS_MEMBERENSURE, TJS_W("KAGParser"), nullptr, &value, nullptr);
        auto *scripts = TVPCreateNativeClass_Scripts();
        tTJSVariant scriptsValue(scripts, nullptr);
        scripts->Release();
        runtime->engine->GetGlobalNoAddRef()->PropSet(TJS_MEMBERENSURE, TJS_W("Scripts"), nullptr, &scriptsValue, nullptr);
        TVPInitializeTimers();
        for (auto *coreClass : {TVPCreateNativeClass_Storages(), TVPCreateNativeClass_Timer(), TVPCreateNativeClass_AsyncTrigger(), TVPCreateNativeClass_Rect(), TVPCreateNativeClass_Pad(), TVPCreateNativeClass_MenuItem()}) {
            tTJSVariant held(coreClass, nullptr);
            coreClass->Release();
            success(runtime->engine->GetGlobalNoAddRef()->PropSet(TJS_MEMBERENSURE, coreClass->GetClassName().c_str(), nullptr, &held, nullptr));
        }
        TVPInitializePlugins();
        return runtime;
    }
    EMSCRIPTEN_KEEPALIVE int tjs_plugins(Runtime *r, int operation, const tjs_char *name)
    {
        return checked(r, [&] {
            if (operation == 0) return r->keep(tTJSVariant((tjs_int)TVPLinkNativePlugin(name)));
            if (operation == 1) return r->keep(TVPGetLoadedNativePlugins());
            throw eTJSError(TJS_W("Unknown plugin operation"));
        });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_kag_parsers(Runtime *r)
    {
        return checked(r, [&] {
            auto *array = TJSCreateArrayObject();
            tTJSVariant result(array, array);
            array->Release();
            int index = 0;
            for (const auto &[owner, identity] : r->owners)
            {
                iTJSNativeInstance *instance = nullptr;
                if (TJS_SUCCEEDED(owner->NativeInstanceSupport(TJS_NIS_GETINSTANCE,
                                                               TJSRegisterNativeClass(TJS_W("KAGParser")), &instance)))
                {
                    auto *parser = static_cast<tTJSNI_KAGParser *>(instance);
                    auto *dic = TJSCreateDictionaryObject();
                    tTJSVariant value(dic, dic);
                    dic->Release();
                    tTJSVariant storage(parser->GetStorageName()), line(parser->GetCurLine() + 1),
                        text(parser->GetCurLineStr());
                    success(dic->PropSet(TJS_MEMBERENSURE, TJS_W("storage"), nullptr, &storage, dic));
                    success(dic->PropSet(TJS_MEMBERENSURE, TJS_W("line"), nullptr, &line, dic));
                    success(dic->PropSet(TJS_MEMBERENSURE, TJS_W("text"), nullptr, &text, dic));
                    success(array->PropSetByNum(TJS_MEMBERENSURE, index++, &value, array));
                }
            }
            return r->keep(result);
        });
    }
    EMSCRIPTEN_KEEPALIVE void tjs_runtime_set_storage(Runtime *r, int callback)
    {
        if (r->storage)
            r->releaseHost(r->storage);
        r->storage = callback;
    }
    EMSCRIPTEN_KEEPALIVE void tjs_runtime_destroy(Runtime *r)
    {
        RuntimeScope scope(r);
        r->shutdown();
        if (r->storage)
        {
            r->releaseHost(r->storage);
            r->storage = 0;
        }
        delete r;
    }
    EMSCRIPTEN_KEEPALIVE const char16_t *tjs_runtime_error(Runtime *r) { return r->error.c_str(); }
    // JS-originated failures enter the same single error channel as checked():
    // the export returns 0 and the message lands in the runtime error slot.
    EMSCRIPTEN_KEEPALIVE void tjs_error_set(Runtime *r, const tjs_char *message) { r->error = message; }
    EMSCRIPTEN_KEEPALIVE const char16_t *tjs_runtime_diagnostic(Runtime *r) { return r->diagnostic.c_str(); }
    EMSCRIPTEN_KEEPALIVE int tjs_value_void(Runtime *r) { return r->keep(tTJSVariant()); }
    EMSCRIPTEN_KEEPALIVE int tjs_value_null(Runtime *r) { return r->keep(tTJSVariant((iTJSDispatch2 *)nullptr)); }
    EMSCRIPTEN_KEEPALIVE int tjs_value_octet(Runtime *r, const unsigned char *data, int size) { return r->keep(tTJSVariant(data, size)); }
    EMSCRIPTEN_KEEPALIVE const unsigned char *tjs_value_octet_data(Runtime *r, int id)
    {
        const auto *v = r->value(id).AsOctetNoAddRef();
        return v ? v->GetData() : nullptr;
    }
    EMSCRIPTEN_KEEPALIVE int tjs_value_octet_size(Runtime *r, int id)
    {
        const auto *v = r->value(id).AsOctetNoAddRef();
        return v ? v->GetLength() : 0;
    }
    EMSCRIPTEN_KEEPALIVE int tjs_value_real(Runtime *r, double n) { return r->keep(tTJSVariant(n)); }
    EMSCRIPTEN_KEEPALIVE int tjs_value_integer(Runtime *r, const tjs_char *n) { return r->keep(tTJSVariant((tjs_int64)std::stoll(ttstr(n).AsStdString()))); }
    EMSCRIPTEN_KEEPALIVE int tjs_value_string(Runtime *r, const tjs_char *s) { return r->keep(tTJSVariant(s)); }
    EMSCRIPTEN_KEEPALIVE int tjs_value_copy(Runtime *r, int id)
    {
        return checked(r, [&]
                       { return r->copyHandle(id); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_value_retain(Runtime *r, int id)
    {
        return checked(r, [&]
                       { return r->keep(r->value(id)); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_value_retain_for_owner(Runtime *r, int id, int owner)
    {
        return checked(r, [&]
                       { return r->retainForOwner(id, owner); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_value_bind_owner(Runtime *r, int id, int owner)
    {
        return checked(r, [&]
                       { r->bindOwner(id, owner); return 1; });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_value_pin(Runtime *r, int id)
    {
        return checked(r, [&]
                       {int pinned=r->keep(r->value(id));r->values.at(pinned).borrow=-1;return pinned; });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_value_release(Runtime *r, int id)
    {
        return checked(r, [&]
                       { r->release(id); return 1; }, false);
    }
    EMSCRIPTEN_KEEPALIVE int tjs_value_borrow(Runtime *r, int id)
    {
        return checked(r, [&]
                       {tTJSVariant value=r->value(id);return r->borrowValue(r->beginBorrow(),value); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_borrow_end(Runtime *r, int id)
    {
        return checked(r, [&]
                       { auto value = r->values.find(id); r->endBorrow(value != r->values.end() ? value->second.borrow : id); return 1; }, false);
    }
    EMSCRIPTEN_KEEPALIVE int tjs_host_bind(Runtime *r, int host, int id, int identity)
    {
        return checked(r, [&]
                       {r->bindExport(host,identity,r->value(id).AsObjectClosureNoAddRef());return 1; });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_host_reference(Runtime *r, int identity)
    {
        auto found = r->exportsByIdentity.find(identity);
        if (found == r->exportsByIdentity.end()) return 0;
        const auto value = r->exports.at(*found->second.begin());
        return r->keep(tTJSVariant(value.object, value.context));
    }
    EMSCRIPTEN_KEEPALIVE int tjs_value_bind(Runtime *r, int id, int context)
    {
        return checked(r, [&]
                       { return r->keep(tTJSVariant(r->value(id).AsObjectNoAddRef(), context ? r->value(context).AsObjectNoAddRef() : nullptr), id); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_value_context(Runtime *r, int id)
    {
        return checked(r, [&]
                       {auto value=r->copy(id);auto *context=value.AsObjectThisNoAddRef();return r->keep(tTJSVariant(context,context),r->values.contains(id)?id:0); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_value_equal(Runtime *r, int a, int b, int context)
    {
        return checked(r, [&]
                       {auto left=r->value(a).AsObjectClosureNoAddRef();auto right=r->value(b).AsObjectClosureNoAddRef();return 1+(left.Object==right.Object&&(!context||left.ObjThis==right.ObjThis)); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_value_is_null_context(Runtime *r, int id)
    {
        return checked(r, [&]
                       { return 1 + !r->value(id).AsObjectThisNoAddRef(); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_native_owner(Runtime *r, int id)
    {
        return checked(r, [&]
                       { return r->ownerHost(id); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_window_objects(Runtime *r, int window, int value, int operation)
    {
        return checked(r, [&] {
            auto *owner = r->ownerReferences.at(r->ownerReference(window));
            auto &state = r->owners.at(owner);
            if (operation == 2) {
                state.windowObjectsLocked = true;
                auto objects = std::move(state.windowObjects);
                if (state.windowMenu.Type() != tvtVoid) {
                    objects.push_back(state.windowMenu);
                    state.windowMenu.Clear();
                }
                std::exception_ptr failure;
                for (auto &entry : objects) {
                    try {
                        auto object = entry.AsObjectClosureNoAddRef();
                        // The original Window ignores the return status: an
                        // already-invalid registered object needs no work.
                        object.Invalidate(0, nullptr, nullptr, nullptr);
                    } catch (...) {
                        if (!failure) failure = std::current_exception();
                    }
                    try { entry.Clear(); }
                    catch (...) { if (!failure) failure = std::current_exception(); }
                }
                if (failure) std::rethrow_exception(failure);
                return 1;
            }
            if (state.windowObjectsLocked) return 1;
            tTJSVariant target = r->copy(value);
            const auto closure = target.AsObjectClosureNoAddRef();
            auto found = std::find_if(state.windowObjects.begin(), state.windowObjects.end(), [&](const auto &entry) {
                return entry.AsObjectClosureNoAddRef() == closure;
            });
            if (operation == 0) {
                if (found == state.windowObjects.end()) state.windowObjects.push_back(target);
            } else if (operation == 1) {
                if (found != state.windowObjects.end()) {
                    tTJSVariant removed = *found;
                    state.windowObjects.erase(found);
                    removed.Clear();
                }
            } else throw eTJSError(TJS_W("Unknown window object operation"));
            return 1;
        });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_value_type(Runtime *r, int id) { return r->copy(id).Type(); }
    EMSCRIPTEN_KEEPALIVE int tjs_value_convert(Runtime *r, int id, int kind)
    {
        return checked(r, [&]
                       {const auto &value=r->value(id);return r->keep(kind==0?tTJSVariant(value.AsReal()):kind==1?tTJSVariant(value.AsInteger()):kind==3?tTJSVariant(ttstr(value)):tTJSVariant((tjs_int)(bool)value),id); });
    }
    EMSCRIPTEN_KEEPALIVE double tjs_value_as_real(Runtime *r, int id) { return r->value(id).AsReal(); }
    EMSCRIPTEN_KEEPALIVE const tjs_char *tjs_value_as_string(Runtime *r, int id)
    {
        r->text = ttstr(r->value(id)).c_str();
        return r->text.c_str();
    }
    EMSCRIPTEN_KEEPALIVE int tjs_value_is_object(Runtime *r, int id)
    {
        auto value = r->copy(id);
        return value.Type() == tvtObject && value.AsObjectNoAddRef();
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_is_instance_of(Runtime *r, int id, const tjs_char *name)
    {
        auto value = r->copy(id);
        return value.AsObjectClosureNoAddRef().IsInstanceOf(0, nullptr, nullptr, name, nullptr) == TJS_S_TRUE;
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_is_valid(Runtime *r, int id)
    {
        return checked(r, [&]
                       {if(!r->values.contains(id)&&!r->ownerReferences.contains(id))return 1;auto value=r->copy(id);return 1+(value.AsObjectClosureNoAddRef().IsValid(0,nullptr,nullptr,nullptr)==TJS_S_TRUE); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_create(Runtime *r, int kind)
    {
        iTJSDispatch2 *object = kind == 1 ? TJSCreateArrayObject() : kind == 2 ? TJSCreateDictionaryObject()
                                                                               : new tTJSCustomObject();
        int id = r->keep(tTJSVariant(object, object));
        object->Release();
        return id;
    }
    EMSCRIPTEN_KEEPALIVE int tjs_runtime_handle_count(Runtime *r) { return r->values.size(); }
    EMSCRIPTEN_KEEPALIVE int tjs_runtime_instance_count(Runtime *r) { return r->alive; }
    EMSCRIPTEN_KEEPALIVE int tjs_runtime_invalidation_count(Runtime *r) { return r->invalidations; }
    EMSCRIPTEN_KEEPALIVE void tjs_runtime_collect(Runtime *r) { r->engine->DoGarbageCollection();
        compactRuntime(); }
    EMSCRIPTEN_KEEPALIVE int tjs_runtime_shutdown(Runtime *r)
    {
        return checked(r, [&]
                       { r->shutdown(); if (r->storage) { r->releaseHost(r->storage); r->storage = 0; } return 1; });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_runtime_global(Runtime *r)
    {
        auto *g = r->engine->GetGlobalNoAddRef();
        return r->keep(tTJSVariant(g, g));
    }
    EMSCRIPTEN_KEEPALIVE int tjs_execute_source(Runtime *r, const tjs_char *s, const tjs_char *name, int offset, int context, int expression)
    {
        return checked(r, [&]
                       {tTJSVariant v,heldContext=context?r->value(context):tTJSVariant();auto *owner=context?heldContext.AsObjectNoAddRef():nullptr;if(expression)r->engine->EvalExpression(s,&v,owner,name,offset);else r->engine->ExecScript(s,&v,owner,name,offset);return r->keep(v); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_execute_bytecode(Runtime *r, const unsigned char *data, int size, const tjs_char *name, int context)
    {
        return checked(r, [&]
                       {tTJSVariant v,heldContext=context?r->value(context):tTJSVariant();r->engine->LoadByteCode(data,size,&v,context?heldContext.AsObjectNoAddRef():nullptr,name);return r->keep(v); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_get(Runtime *r, int id, const tjs_char *name, int flags)
    {
        return checked(r, [&]
                       {tTJSVariant v;tTJSVariant target=r->value(id);auto c=target.AsObjectClosureNoAddRef();const auto status=c.PropGet(flags,name,nullptr,&v,nullptr);if(status==TJS_E_MEMBERNOTFOUND)throw eTJSError(ttstr(TJS_W("TJS member not found: "))+ttstr(name));success(status);return r->keep(v); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_set(Runtime *r, int id, const tjs_char *name, int value, int flags)
    {
        return checked(r, [&]
                       {tTJSVariant target=r->value(id);auto c=target.AsObjectClosureNoAddRef();tTJSVariant member=r->value(value);success(c.PropSet(flags,name,nullptr,&member,nullptr));return r->keep(tTJSVariant()); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_call(Runtime *r, int id, int receiver, int count, const int *args, const tjs_char *name, bool ignoreMissing)
    {
        return checked(r, [&]
                       {std::vector<tTJSVariant> arguments;for(int i=0;i<count;i++)arguments.push_back(r->value(args[i]));std::vector<tTJSVariant *> params;for(auto &argument:arguments)params.push_back(&argument);tTJSVariant v;tTJSVariant target=r->value(id);auto c=target.AsObjectClosureNoAddRef();tTJSVariant context=receiver?r->value(receiver):tTJSVariant();const auto status=c.FuncCall(0,name,nullptr,&v,count,params.data(),receiver?context.AsObjectNoAddRef():nullptr);if(status!=TJS_E_MEMBERNOTFOUND||!ignoreMissing)success(status);return r->keep(v); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_invalidate(Runtime *r, int id)
    {
        return checked(r, [&]
                       {tTJSVariant target=r->value(id);auto c=target.AsObjectClosureNoAddRef();success(c.Invalidate(0,nullptr,nullptr,nullptr));return r->keep(tTJSVariant()); });
    }
    // scriptsEx.cpp: only TJS_S_TRUE from clone replaces a non-collection value.
    EMSCRIPTEN_KEEPALIVE int tjs_object_clone(Runtime *r, int id)
    {
        return checked(r, [&]
                       {tTJSVariant result;tTJSVariant target=r->value(id);auto c=target.AsObjectClosureNoAddRef();const auto status=c.FuncCall(0,TJS_W("clone"),nullptr,&result,0,nullptr,nullptr);return r->keep(status==TJS_S_TRUE?result:target); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_delete(Runtime *r, int id, const tjs_char *name)
    {
        return checked(r, [&]
                       {auto status=r->value(id).AsObjectClosureNoAddRef().DeleteMember(0,name,nullptr,nullptr);if(status==TJS_E_MEMBERNOTFOUND)return 1;success(status);return 2; });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_class_names(Runtime *r, int id)
    {
        return checked(r, [&]
                       {auto *array=TJSCreateArrayObject();tTJSVariant names(array,array);array->Release();auto closure=r->value(id).AsObjectClosureNoAddRef();tTJSVariant name;for(int index=0;closure.Object->ClassInstanceInfo(TJS_CII_GET,index,&name)==TJS_S_OK;index++)success(array->PropSetByNum(TJS_MEMBERENSURE,index,&name,array));return r->keep(names,id); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_set_missing(Runtime *r, int id)
    {
        return checked(r, [&]
                       {tTJSVariant name(TJS_W("missing"));success(r->value(id).AsObjectNoAddRef()->ClassInstanceInfo(TJS_CII_SET_MISSING,0,&name));return r->keep(tTJSVariant()); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_count(Runtime *r, int id)
    {
        return checked(r, [&]
                       {tjs_int count;success(r->value(id).AsObjectClosureNoAddRef().GetCount(&count,nullptr,nullptr,nullptr));return r->keep(tTJSVariant(count)); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_construct(Runtime *r, int id, int count, const int *args)
    {
        return checked(r, [&]
                       {std::vector<tTJSVariant> arguments;for(int i=0;i<count;i++)arguments.push_back(r->value(args[i]));std::vector<tTJSVariant *> params;for(auto &argument:arguments)params.push_back(&argument);iTJSDispatch2 *object=nullptr;tTJSVariant target=r->value(id);success(target.AsObjectClosureNoAddRef().CreateNew(0,nullptr,nullptr,&object,count,params.data(),nullptr));int value=r->keep(tTJSVariant(object,object));object->Release();return value; });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_get_raw(Runtime *r, int id, const tjs_char *name)
    {
        return checked(r, [&]
                       {tTJSVariant value;auto status=r->value(id).AsObjectClosureNoAddRef().PropGet(TJS_IGNOREPROP,name,nullptr,&value,nullptr);if(status==TJS_E_MEMBERNOTFOUND)return r->keep(tTJSVariant());success(status);return r->keep(value,id); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_set_raw(Runtime *r, int id, const tjs_char *name, int value, int flags) { return tjs_object_set(r, id, name, value, flags); }
    EMSCRIPTEN_KEEPALIVE int tjs_value_release_async(Runtime *r, int id)
    {
        return checked(r, [&]
                       { r->release(id); return 1; }, false);
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_get_by_num_raw(Runtime *r, int id, int index)
    {
        return checked(r, [&]
                       {tTJSVariant value;auto status=r->value(id).AsObjectClosureNoAddRef().PropGetByNum(TJS_IGNOREPROP,index,&value,nullptr);if(status==TJS_E_MEMBERNOTFOUND)return r->keep(tTJSVariant());success(status);return r->keep(value,id); });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_object_keys(Runtime *r, int id)
    {
        return checked(r, [&]
                       {auto *array=TJSCreateArrayObject();MemberNames names(array);tTJSVariantClosure callback(&names,nullptr);try{success(r->value(id).AsObjectClosureNoAddRef().EnumMembers(TJS_IGNOREPROP,&callback,nullptr));int result=r->keep(tTJSVariant(array,array));array->Release();return result;}catch(...){array->Release();throw;} });
    }
    EMSCRIPTEN_KEEPALIVE int tjs_array_count(Runtime *r, int id)
    {
        auto *object = r->value(id).AsObjectNoAddRef();
        iTJSNativeInstance *instance = nullptr;
        if (TJS_SUCCEEDED(object->NativeInstanceSupport(TJS_NIS_GETINSTANCE,
                TJSGetArrayClassID(), &instance)))
            return static_cast<tTJSArrayNI *>(instance)->Items.size();
        // Read-only PSB arrays implement the dispatch count without Array NI.
        tjs_int count;
        success(object->GetCount(&count, nullptr, nullptr, nullptr));
        return count;
    }
}
