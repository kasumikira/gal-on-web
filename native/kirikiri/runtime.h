#pragma once
#include "tjs.h"
#include "tjsError.h"
#include "core/plugin/PluginRegistry.h"
#include <map>
#include <set>
#include <unordered_map>
#include <vector>
#include <string>
#include <exception>
using namespace TJS;
class HostInstance;
struct Runtime : iTJSConsoleOutput
{
    tTJS *engine = new tTJS();
    struct Value
    {
        tTJSVariant value;
        int borrow = 0;
        int owner = 0;
    };
    std::map<int, Value> values;
    // Ordered handles preserve the original release order across reentry.
    std::unordered_map<int, std::set<int>> valuesByOwner;
    std::map<int, std::vector<int>> borrows;
    struct Owner
    {
        int reference, host = 0;
        std::vector<tTJSVariant> windowObjects;
        tTJSVariant windowMenu;
        bool windowObjectsLocked = false;
    };
    std::map<iTJSDispatch2 *, Owner> owners;
    std::map<int, iTJSDispatch2 *> ownerReferences;
    std::map<int, std::map<int, HostInstance *>> nativeInstances;
    struct Export
    {
        iTJSDispatch2 *object, *context;
        int identity;
    };
    std::unordered_map<int, Export> exports;
    std::unordered_map<int, std::set<int>> exportsByIdentity;
    std::unordered_map<iTJSDispatch2 *, std::set<int>> exportsByObject;
    int next = 1, alive = 0, invalidations = 0, storage = 0;
    bool stopped = false;
    std::set<std::u16string> loadedPlugins;
    std::map<const void *, NativePluginClassInfo> pluginClasses;
    std::map<const void *, tTJSVariant> pluginValues;
    std::u16string error, text, diagnostic;
    Runtime();
    void Print(const tjs_char *message) override;
    void ExceptionPrint(const tjs_char *message) override;
    int keep(const tTJSVariant &v, int parent = 0, int owner = 0);
    tTJSVariant &value(int id);
    int beginBorrow();
    int borrowValue(int borrow, const tTJSVariant &v);
    void endBorrow(int id);
    void release(int id);
    std::map<int, Value>::node_type extractValue(int id);
    int ownerReference(int id);
    void bindOwner(int id, int owner);
    int retainForOwner(int id, int owner);
    void releaseOwnerValues(iTJSDispatch2 *owner);
    tTJSVariant copy(int id);
    int copyHandle(int id);
    void attachOwner(iTJSDispatch2 *owner);
    void releaseHost(int handle);
    void bindExport(int handle, int identity, const tTJSVariantClosure &value);
    void removeExport(int handle);
    void forgetDispatch(iTJSDispatch2 *object);
    void forgetOwner(iTJSDispatch2 *owner);
    int ownerHost(int id);
    void shutdown();
    ~Runtime();
};

extern Runtime *activeRuntime;
struct RuntimeScope
{
    Runtime *previous = activeRuntime;
    explicit RuntimeScope(Runtime *runtime) { activeRuntime = runtime; }
    ~RuntimeScope() { activeRuntime = previous; }
};

template <class F>
static int checked(Runtime *r, F f, bool resetError = true)
{
    RuntimeScope scope(r);
    if (resetError)
    {
        r->error.clear();
        r->diagnostic.clear();
    }
    try
    {
        return f();
    }
    catch (const eTJSScriptError &e)
    {
        ttstr detail = e.GetMessage();
        if (e.GetBlockName())
            detail += ttstr(TJS_W(" @ ")) + ttstr(e.GetBlockName());
        detail += ttstr(TJS_W(":")) + ttstr(std::to_string(e.GetSourceLine() + 1).c_str());
        if (!e.GetTrace().IsEmpty())
            detail += ttstr(TJS_W(" | ")) + e.GetTrace();
        r->error = detail.c_str();
    }
    catch (const eTJS &e)
    {
        r->error = e.GetMessage().c_str();
    }
    catch (const std::exception &e)
    {
        r->error = ttstr(e.what()).c_str();
    }
    catch (...)
    {
        r->error = TJS_W("Unknown native TJS error");
    }
    return 0;
}
static void success(tjs_error code)
{
    if (TJS_FAILED(code))
        TJS_eTJSError(code);
}

tjs_error invoke(Runtime *, int, int, iTJSDispatch2 *, tTJSVariant *, int, tTJSVariant **);
extern "C" int host_retain(Runtime *, int);
void initializeStorageCallbacks();
void compactRuntime();
