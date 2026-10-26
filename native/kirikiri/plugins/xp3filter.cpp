// Adapted from Kirikiroid2 plugins/xp3filter.cpp and BinaryAccessor.cpp.
// JS owns archive IO; this module owns filter closures, contexts and TJS buffers.
#include "ncbind.hpp"
#include "runtime.h"
#include "xp3filter.h"
#include "tjsDebug.h"
#include <vector>
#define NCB_MODULE_NAME TJS_W("xp3filter.dll")

namespace {
const char ExtractionFilterKey = 0, ContentFilterKey = 0;

class XP3FilterRegister : public tTJSDispatch {
    typedef tTJSDispatch inherited;

protected:
    bool ContentFilter = false;

public:
    XP3FilterRegister() {
        if(TJSObjectHashMapEnabled())
            TJSAddObjectHashRecord(this);
    }
    ~XP3FilterRegister() {
        if(TJSObjectHashMapEnabled())
            TJSRemoveObjectHashRecord(this);
    }

    tjs_error IsInstanceOf(tjs_uint32 flag, const tjs_char *membername,
                           tjs_uint32 *hint, const tjs_char *classname,
                           iTJSDispatch2 *objthis) {
        if(membername == nullptr) {
            if(!TJS_strcmp(classname, TJS_W("Function")))
                return TJS_S_TRUE;
        }

        return inherited::IsInstanceOf(flag, membername, hint, classname,
                                       objthis);
    }
    tjs_error FuncCall(tjs_uint32 flag, const tjs_char *membername,
                       tjs_uint32 *hint, tTJSVariant *result, tjs_int numparams,
                       tTJSVariant **param, iTJSDispatch2 *objthis) {
        if(membername)
            return inherited::FuncCall(flag, membername, hint, result,
                                       numparams, param, objthis);
        if(!objthis)
            return TJS_E_NATIVECLASSCRASH;

        if(result)
            result->Clear();

        if(numparams < 1)
            return TJS_E_BADPARAMCOUNT;
        const auto callback = param[0]->AsObjectClosureNoAddRef();
        TVPPluginValue(ContentFilter ? &ContentFilterKey : &ExtractionFilterKey) =
            tTJSVariant(callback.Object, callback.ObjThis);
        return TJS_S_OK;
    }
};

class XP3ContentFilterRegister : public XP3FilterRegister {
    typedef XP3FilterRegister inherited;

public:
    XP3ContentFilterRegister() { ContentFilter = true; }
};

class XP3FilterStream final : public tTJSDispatch {
    ttstr FileName;
    tTJSVariant FilterContext;
    tjs_int Mode = 0;
public:
    XP3FilterStream(const ttstr &filepath, const ttstr &archivename, tjs_int64 filesize)
        : FileName(filepath) {
        const auto filter = TVPPluginValue(&ContentFilterKey);
        if(filter.Type() == tvtVoid || !filter.AsObjectClosureNoAddRef().Object) return;
        tTJSVariant FilePath(filepath), ArcName(archivename), FileSize(filesize), result;
        tTJSVariant *vars[] = { &FilePath, &ArcName, &FileSize };
        success(filter.AsObjectClosureNoAddRef().FuncCall(0, nullptr, nullptr, &result, 3, vars, nullptr));
        if(result.Type() == tvtObject) {
            ncbPropAccessor a(result.AsObjectNoAddRef());
            // Mode 1 requires the JS archive layer to materialize and filter
            // the complete entry before serving random stream reads.
            Mode = a.GetValue(0, ncbTypedefs::Tag<tjs_int>());
            FilterContext = a.GetValue(1, ncbTypedefs::Tag<tTJSVariant>());
        }
    }
    tjs_error PropGet(tjs_uint32 flag, const tjs_char *membername,
                      tjs_uint32 *hint, tTJSVariant *result,
                      iTJSDispatch2 *objthis) override {
        if(membername && !TJS_strcmp(membername, TJS_W("mode"))) {
            if(result) *result = Mode;
            return TJS_S_OK;
        }
        return tTJSDispatch::PropGet(flag, membername, hint, result, objthis);
    }
    tjs_error FuncCall(tjs_uint32, const tjs_char *membername, tjs_uint32 *,
                       tTJSVariant *result, tjs_int numparams, tTJSVariant **param,
                       iTJSDispatch2 *) override {
        if(!membername || TJS_strcmp(membername, TJS_W("apply"))) return TJS_E_MEMBERNOTFOUND;
        if(numparams < 3) return TJS_E_BADPARAMCOUNT;
        const auto *input = param[2]->AsOctetNoAddRef();
        std::vector<unsigned char> bytes(input->GetData(), input->GetData() + input->GetLength());
        const auto decoder = TVPPluginValue(&ExtractionFilterKey);
        if(decoder.Type() != tvtVoid && decoder.AsObjectClosureNoAddRef().Object) {
            tTJSVariant FileHash(param[0]->AsInteger()), Offset(param[1]->AsInteger());
            auto *buf = new CBinaryAccessor(bytes.data(), bytes.size());
            tTJSVariant Buffer(buf);
            buf->Release();
            // Invalidate before the borrowed bytes leave scope, including on exceptions.
            struct BufferScope {
                CBinaryAccessor *Buffer;
                ~BufferScope() { Buffer->Invalidate(0, nullptr, nullptr, nullptr); }
            } scope{buf};
            tTJSVariant BufferSize(static_cast<tjs_int64>(bytes.size())), Name(FileName);
            tTJSVariant *vars[] = { &FileHash, &Offset, &Buffer, &BufferSize, &Name, &FilterContext };
            success(decoder.AsObjectClosureNoAddRef().FuncCall(0, nullptr, nullptr, nullptr, 6, vars, nullptr));
        }
        if(result) *result = tTJSVariant(bytes.data(), bytes.size());
        return TJS_S_OK;
    }
};

static void RegisterFilterMethods() {
    tTJSVariant storages;
    success(activeRuntime->engine->GetGlobalNoAddRef()->PropGet(0, TJS_W("Storages"), nullptr, &storages, nullptr));
    auto *cls = static_cast<tTJSNativeClass *>(storages.AsObjectNoAddRef());
    TJSNativeClassRegisterNCM(cls, TJS_W("setXP3ArchiveExtractionFilter"),
                              new XP3FilterRegister(), cls->GetClassName().c_str(),
                              nitMethod, TJS_STATICMEMBER);
    TJSNativeClassRegisterNCM(cls, TJS_W("setXP3ArchiveContentFilter"),
                              new XP3ContentFilterRegister(), cls->GetClassName().c_str(),
                              nitMethod, TJS_STATICMEMBER);
}

class XP3FilterHost final : public tTJSDispatch {
public:
    tjs_error FuncCall(tjs_uint32, const tjs_char *membername, tjs_uint32 *,
                       tTJSVariant *result, tjs_int numparams, tTJSVariant **param,
                       iTJSDispatch2 *) override {
        if(!membername) return TJS_E_MEMBERNOTFOUND;
        if(!TJS_strcmp(membername, TJS_W("initialize"))) {
            RegisterFilterMethods();
            if(result) result->Clear();
            return TJS_S_OK;
        }
        if(!TJS_strcmp(membername, TJS_W("open"))) {
            if(numparams < 3) return TJS_E_BADPARAMCOUNT;
            auto *stream = new XP3FilterStream(ttstr(*param[0]), ttstr(*param[1]), param[2]->AsInteger());
            tTJSVariant held(stream, stream);
            stream->Release();
            if(result) *result = held;
            return TJS_S_OK;
        }
        return TJS_E_MEMBERNOTFOUND;
    }
};
static void PostRegistCallback() {
    tTJSVariant storages;
    success(activeRuntime->engine->GetGlobalNoAddRef()->PropGet(0, TJS_W("Storages"), nullptr, &storages, nullptr));
    auto *host = new XP3FilterHost();
    tTJSVariant value(host, host);
    host->Release();
    success(storages.AsObjectClosureNoAddRef().PropSet(TJS_MEMBERENSURE | TJS_HIDDENMEMBER | TJS_STATICMEMBER,
        TJS_W("_xp3Filter"), nullptr, &value, nullptr));
}
}
NCB_POST_REGIST_CALLBACK(PostRegistCallback);
