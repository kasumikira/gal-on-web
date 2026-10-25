// Script-facing Storages interface from Kirikiroid2 StorageIntf.cpp.
// Copyright (C) 2000 W.Dee and contributors; see reference license.txt.
// Native owns the TJS interface; shared JS storage resolves resource names.
#include "StoragesIntf.h"
#include "TextStream.h"
#include "runtime.h"
#include "tjsArray.h"
#include <algorithm>

using Path = std::u16string;
static tTJSVariant Backend(int operation, const tTJSVariant &argument = tTJSVariant()) {
 if (!activeRuntime->storage) TVPThrowExceptionMessage(TJS_W("TJS storage is not attached"));
 tTJSVariant input(argument), result;
 tTJSVariant *args[] = { &input };
 success(invoke(activeRuntime, activeRuntime->storage, operation, nullptr, &result, 1, args));
 return result;
}
static Path String(const tTJSVariant &value) { return ttstr(value).c_str(); }
static Path Parts(const Path &value) {
 std::vector<Path> parts;
 for (size_t start = 0; start <= value.size();) {
  const auto end = value.find(u'/', start);
  auto part = value.substr(start, end == Path::npos ? end : end - start);
  if (!part.empty() && part.find_first_not_of(u'.') == Path::npos) {
   for (size_t dots = 1; dots < part.size(); ++dots) {
    if (parts.empty()) TVPThrowExceptionMessage(TJS_W("Invalid path name: %1"), ttstr(value.c_str()));
    parts.pop_back();
   }
  } else if (!part.empty()) parts.push_back(part);
  if (end == Path::npos) break;
  start = end + 1;
 }
 Path result;
 for (const auto &part : parts) { if (!result.empty()) result += u'/'; result += part; }
 const auto last = value.substr(value.find_last_of(u'/') == Path::npos ? 0 : value.find_last_of(u'/') + 1);
 if (!result.empty() && (value.back() == u'/' || (!last.empty() && last.find_first_not_of(u'.') == Path::npos))) result += u'/';
 return result;
}
static Path Normalize(Path value) {
 std::replace(value.begin(), value.end(), u'\\', u'/');
 ttstr lower(value.c_str()); lower.ToLowerCase(); value = lower.c_str();
 const auto scheme = value.find(u"://");
 if (scheme != Path::npos) return value.substr(0, scheme + 3) + Parts(value.substr(scheme + 3));
 const auto archive = value.find(u'>');
 if (archive != Path::npos) return u"/" + Parts(value.substr(0, archive)) + u">" + Parts(value.substr(archive + 1));
 return u"/" + Parts(value);
}
static Path FullPath(Path name, const Path &directory) {
 if (name.empty()) return name;
 std::replace(name.begin(), name.end(), u'\\', u'/');
 if (name.find(u"://") != Path::npos || (!name.empty() && name.front() == u'/')) return Normalize(name);
 return Normalize(directory + name);
}
ttstr TVPNativeFullPath(const ttstr &name) {
 return ttstr(FullPath(name.c_str(), String(Backend(15))).c_str());
}
ttstr TVPNativePlacedPath(const ttstr &name) {
 return ttstr(Backend(19, tTJSVariant(TVPNativeFullPath(name))));
}
ttstr TVPNormalizeStorageName(const ttstr &name) { return TVPNativeFullPath(name); }
static void CheckPathDelimiter(const ttstr &name) {
 const auto last = name.GetLastChar();
 if (last != TJS_W('/') && last != TJS_W('\\') && last != TJS_W('>'))
  TVPThrowExceptionMessage(TJS_W("Missing path delimiter at last"));
}
void TVPAddAutoPath(const ttstr &name) {
 CheckPathDelimiter(name);
 Backend(17, tTJSVariant(TVPNativeFullPath(name)));
}
void TVPRemoveAutoPath(const ttstr &name) {
 CheckPathDelimiter(name);
 Backend(18, tTJSVariant(TVPNativeFullPath(name)));
}
bool TVPIsExistentStorage(const ttstr &name) { return !TVPNativePlacedPath(name).IsEmpty(); }
void TVPClearArchiveCache() { Backend(14); }
ttstr TVPGetLocallyAccessibleName(const ttstr &name) {
 const Path path(name.c_str());
 return path.find(u'>') != Path::npos || path.find(u"://") != Path::npos ? ttstr() : name;
}
void TVPGetLocalName(ttstr &name) {
 const auto local = TVPGetLocallyAccessibleName(name);
 if (local.IsEmpty()) TVPThrowExceptionMessage(TJS_W("Cannot get local name: %1"), name);
 name = local;
}
ttstr TVPExtractStorageExt(const ttstr &name) {
    // extract an extension from name.
    // returned string will contain extension delimiter ( '.' ),
    // except for missing extension of the input string. ( returns
    // nullptr string when input string does not have an extension )

    const tjs_char *s = name.c_str();
    tjs_int slen = name.GetLen();
    const tjs_char *p = s + slen;
    p--;
    while(p >= s) {
        if(*p == TJS_W('\\'))
            break;
        if(*p == TJS_W('/'))
            break;
        if(*p == TJS_W('>'))
            break;
        if(*p == TJS_W('.')) {
            // found extension delimiter
            size_t extlen = (slen - (p - s));
            return { p, extlen };
        }

        p--;
    }

    // not found
    return {};
}
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------
// TVPExtractStoragePath
//---------------------------------------------------------------------------
ttstr TVPExtractStoragePath(const ttstr &name) {
    // extract "name"'s path ( including last delimiter ) and return
    // it.
    const tjs_char *s = name.c_str();
    tjs_int slen = name.GetLen();
    const tjs_char *p = s + slen;
    p--;
    while(p >= s) {
        if(*p == TJS_W('\\'))
            break;
        if(*p == TJS_W('/'))
            break;
        if(*p == TJS_W('>'))
            break;

        p--;
    }

    p++;
    return { s, (size_t)(p - s) };
}
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------
// TVPChopStorageExt
//---------------------------------------------------------------------------
extern ttstr TVPChopStorageExt(const ttstr &name) {
    // chop storage's extension and return it.
    const tjs_char *s = name.c_str();
    tjs_int slen = name.GetLen();
    const tjs_char *p = s + slen;
    p--;
    while(p >= s) {
        if(*p == TJS_W('\\'))
            break;
        if(*p == TJS_W('/'))
            break;
        if(*p == TJS_W('>'))
            break;
        if(*p == TJS_W('.')) {
            // found extension delimiter
            return { s, (size_t)(p - s) };
        }

        p--;
    }

    // not found
    return name;
}
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------
class CurrentDirectoryProperty final : public tTJSDispatch {
public:
 tjs_error PropGet(tjs_uint32, const tjs_char *member, tjs_uint32 *, tTJSVariant *result, iTJSDispatch2 *) override {
  if (member) return TJS_E_MEMBERNOTFOUND;
  if (result) *result = Backend(15); return TJS_S_OK;
 }
 tjs_error PropSet(tjs_uint32, const tjs_char *member, tjs_uint32 *, const tTJSVariant *value, iTJSDispatch2 *) override {
  if (member) return TJS_E_MEMBERNOTFOUND;
  const ttstr path(*value);
  CheckPathDelimiter(path);
  const auto normalized = TVPNativeFullPath(path);
  Backend(16, tTJSVariant(normalized)); return TJS_S_OK;
 }
};
tjs_uint32 tTJSNC_Storages::ClassID = -1;

tTJSNC_Storages::tTJSNC_Storages() :
    inherited(TJS_W("Storages")){
        // registration of native members

        TJS_BEGIN_NATIVE_MEMBERS(Storages) TJS_DECL_EMPTY_FINALIZE_METHOD
            //----------------------------------------------------------------------

            //-- methods

            //----------------------------------------------------------------------
            TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ addAutoPath){
                if(numparams < 1) return TJS_E_BADPARAMCOUNT;

ttstr path = *param[0];

TVPAddAutoPath(path);

if(result)
    result->Clear();

return TJS_S_OK;
}
TJS_END_NATIVE_STATIC_METHOD_DECL(/*func. name*/ addAutoPath)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ removeAutoPath) {
    if(numparams < 1)
        return TJS_E_BADPARAMCOUNT;

    ttstr path = *param[0];

    TVPRemoveAutoPath(path);

    if(result)
        result->Clear();

    return TJS_S_OK;
}
TJS_END_NATIVE_STATIC_METHOD_DECL(/*func. name*/ removeAutoPath)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ getFullPath) {
    if(numparams < 1)
        return TJS_E_BADPARAMCOUNT;

    ttstr path = *param[0];

    if(result)
        *result = TVPNormalizeStorageName(path);

    return TJS_S_OK;
}
TJS_END_NATIVE_STATIC_METHOD_DECL(/*func. name*/ getFullPath)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ getPlacedPath) {
    if(numparams < 1)
        return TJS_E_BADPARAMCOUNT;

    ttstr path = *param[0];

    if(result)
        *result = TVPGetPlacedPath(path);

    return TJS_S_OK;
}
TJS_END_NATIVE_STATIC_METHOD_DECL(/*func. name*/ getPlacedPath)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ isExistentStorage) {
    if(numparams < 1)
        return TJS_E_BADPARAMCOUNT;

    ttstr path = *param[0];

    if(result)
        *result = (tjs_int)TVPIsExistentStorage(path);

    return TJS_S_OK;
}
TJS_END_NATIVE_STATIC_METHOD_DECL(/*func. name*/ isExistentStorage)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ extractStorageExt) {
    if(numparams < 1)
        return TJS_E_BADPARAMCOUNT;

    ttstr path = *param[0];

    if(result)
        *result = TVPExtractStorageExt(path);

    return TJS_S_OK;
}
TJS_END_NATIVE_STATIC_METHOD_DECL(/*func. name*/ extractStorageExt)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ extractStorageName) {
    if(numparams < 1)
        return TJS_E_BADPARAMCOUNT;

    ttstr path = *param[0];

    if(result)
        *result = TVPExtractStorageName(path);

    return TJS_S_OK;
}
TJS_END_NATIVE_STATIC_METHOD_DECL(/*func. name*/ extractStorageName)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ extractStoragePath) {
    if(numparams < 1)
        return TJS_E_BADPARAMCOUNT;

    ttstr path = *param[0];

    if(result)
        *result = TVPExtractStoragePath(path);

    return TJS_S_OK;
}
TJS_END_NATIVE_STATIC_METHOD_DECL(/*func. name*/ extractStoragePath)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ chopStorageExt) {
    if(numparams < 1)
        return TJS_E_BADPARAMCOUNT;

    ttstr path = *param[0];

    if(result)
        *result = TVPChopStorageExt(path);

    return TJS_S_OK;
}
TJS_END_NATIVE_STATIC_METHOD_DECL(/*func. name*/ chopStorageExt)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ clearArchiveCache) {
    TVPClearArchiveCache();
    return TJS_S_OK;
}
TJS_END_NATIVE_STATIC_METHOD_DECL(/*func. name*/ clearArchiveCache)
//----------------------------------------------------------------------
// Existing browser-runtime extensions.
TJS_BEGIN_NATIVE_METHOD_DECL(getLocalName) {
    if(numparams < 1) return TJS_E_BADPARAMCOUNT;
    ttstr path = TVPNormalizeStorageName(*param[0]);
    TVPGetLocalName(path);
    if(result) *result = path;
    return TJS_S_OK;
}
TJS_END_NATIVE_STATIC_METHOD_DECL(getLocalName)
TJS_BEGIN_NATIVE_METHOD_DECL(setTextEncoding) {
    if(numparams < 1) return TJS_E_BADPARAMCOUNT;
    TVPSetDefaultReadEncoding(ttstr(*param[0]));
    if(result) result->Clear();
    return TJS_S_OK;
}
TJS_END_NATIVE_STATIC_METHOD_DECL(setTextEncoding)
RegisterNCM(TJS_W("currentDirectory"), new CurrentDirectoryProperty(), TJS_W("Storages"), nitProperty, TJS_STATICMEMBER);
TJS_END_NATIVE_MEMBERS
}

//---------------------------------------------------------------------------
tTJSNativeInstance *tTJSNC_Storages::CreateNativeInstance() {
    // this class cannot create an instance
    TVPThrowExceptionMessage(TJS_W("Cannot create Storages instance"));

    return nullptr;
}
//---------------------------------------------------------------------------

tTJSNativeClass *TVPCreateNativeClass_Storages() { return new tTJSNC_Storages(); }

tTJSVariant TVPStorageCall(const tjs_char *method, const ttstr &path, const tTJSVariant *value) {
 tTJSVariant klass, argument(path), result;
 success(activeRuntime->engine->GetGlobalNoAddRef()->PropGet(0, TJS_W("TJS2Storage"), nullptr, &klass, nullptr));
 tTJSVariant extra = value ? *value : tTJSVariant();
 tTJSVariant *args[] = { &argument, &extra };
 success(klass.AsObjectClosureNoAddRef().FuncCall(0, method, nullptr, &result, value ? 2 : 1, args, nullptr));
 return result;
}
static tTJSVariant Field(const tTJSVariant &object, const tjs_char *name) {
 tTJSVariant result;
 success(object.AsObjectClosureNoAddRef().PropGet(0, name, nullptr, &result, nullptr));
 return result;
}
static ttstr LocalDirectory(const ttstr &name) {
 if (name.GetLastChar() != TJS_W('/'))
  TVPThrowExceptionMessage(TJS_W("'/' must be specified at the end of given directory name."));
 const auto path = TVPNativeFullPath(name);
 const Path value(path.c_str());
 if (value.find(u'>') != Path::npos || value.find(u"://") != Path::npos)
  TVPThrowExceptionMessage(TJS_W("Archive or media storage cannot be accessed as a local directory"));
 return path;
}
tTJSVariant TVPListLocalDirectory(const ttstr &name) {
 return TVPStorageCall(TJS_W("listDirectory"), LocalDirectory(name));
}
tjs_int TVPIsLocalDirectory(const ttstr &name) {
 return static_cast<tjs_int>(Field(TVPListLocalDirectory(name), TJS_W("exists")).operator bool());
}
bool TVPDeleteLocalFile(const ttstr &name) {
 const auto path = TVPNativePlacedPath(name);
 if (TVPGetLocallyAccessibleName(path).IsEmpty()) return false;
 const bool removed = TVPStorageCall(TJS_W("deleteFile"), path).operator bool();
 if (removed) TVPClearStorageCaches();
 return removed;
}
void TVPClearStorageCaches() { Backend(14); }
