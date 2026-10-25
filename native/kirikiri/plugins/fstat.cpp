// Adapted from Kirikiroid2 cpp/plugins/fstat/main.cpp.
// Native retains TJS semantics; file IO uses the shared JS storage service.
#include "ncbind.hpp"
#include "local-files.h"
#include "md5.h"
#include <memory>
#define NCB_MODULE_NAME TJS_W("fstat.dll")

namespace {
ttstr LocalName(const ttstr &name) {
    ttstr path = TVPNormalizeStorageName(name);
    TVPGetLocalName(path);
    return path;
}
tTJSVariant Stat(const ttstr &path) { return TVPStorageCall(TJS_W("stat"), path); }
bool Exists(const tTJSVariant &info) { return info.AsObjectNoAddRef() != nullptr; }
void Set(iTJSDispatch2 *object, const tjs_char *name, const tTJSVariant &value) {
    success(object->PropSet(TJS_MEMBERENSURE, name, nullptr, &value, object));
}
tTJSVariant Dictionary() {
    auto *object = TJSCreateDictionaryObject();
    tTJSVariant value(object, object);
    object->Release();
    return value;
}
[[noreturn]] void Unsupported(const tjs_char *operation) {
    TVPThrowExceptionMessage(TJS_W("Storage backend does not support %1"), ttstr(operation));
}
}

class StoragesFstat {
    static tjs_error _getTime(tTJSVariant *result, tTJSVariant const *param, bool chksize) {
        const auto info = Stat(LocalName(ttstr(*param)));
        if (!Exists(info)) TVPThrowExceptionMessage(TJS_W("Storage not found: %1"), ttstr(*param));
        if (result) {
            auto dict = Dictionary();
            if (chksize && !LocalField(info, TJS_W("directory")).operator bool())
                Set(dict.AsObjectNoAddRef(), TJS_W("size"), LocalField(info, TJS_W("size")));
            // Like reference VLFS, byte backends supply no file times.
            for (auto name : {TJS_W("mtime"), TJS_W("ctime"), TJS_W("atime")})
                Set(dict.AsObjectNoAddRef(), name, tTJSVariant());
            *result = dict;
        }
        return TJS_S_OK;
    }
    static bool _copyFile(const ttstr &from, const ttstr &to) {
        if (from.IsEmpty() || to.IsEmpty() || from == to) return false;
        const auto bytes = TVPStorageCall(TJS_W("read"), from);
        TVPStorageCall(TJS_W("write"), to, &bytes);
        TVPClearStorageCaches();
        return true;
    }
    static void _dirtree(const ttstr &path, const ttstr &subdir,
                         iTJSDispatch2 *array, tjs_int &count, bool dironly) {
        const auto listing = TVPListLocalDirectory(path);
        if (!LocalField(listing, TJS_W("exists")).operator bool()) return;
        const auto entries = LocalField(listing, TJS_W("entries"));
        const auto size = TJSGetArrayElementCount(entries.AsObjectNoAddRef());
        for (tjs_int index = 0; index < size; ++index) {
            tTJSVariant entry;
            success(entries.AsObjectClosureNoAddRef().PropGetByNum(0, index, &entry, nullptr));
            const ttstr name(LocalField(entry, TJS_W("displayName")));
            const bool directory = LocalField(entry, TJS_W("directory")).operator bool();
            if (directory || !dironly) {
                tTJSVariant fullName(subdir + name + (directory ? TJS_W("/") : TJS_W("")));
                success(array->PropSetByNum(0, count++, &fullName, array));
            }
            if (directory) _dirtree(path + name + TJS_W("/"), subdir + name + TJS_W("/"), array, count, dironly);
        }
    }
public:
    static void clearStorageCaches() { TVPClearStorageCaches(); }
    static tjs_error fstat(tTJSVariant *result, tjs_int numparams,
                           tTJSVariant **param, iTJSDispatch2 *) {
        if (numparams < 1) return TJS_E_BADPARAMCOUNT;
        const auto filename = TVPGetPlacedPath(*param[0]);
        if (!filename.IsEmpty() && TVPGetLocallyAccessibleName(filename).IsEmpty()) {
            std::unique_ptr<tTJSBinaryStream> in(TJSCreateBinaryStreamForRead(filename, TJS_W("")));
            if (result) {
                auto dict = Dictionary();
                Set(dict.AsObjectNoAddRef(), TJS_W("size"), tTJSVariant(static_cast<tjs_int64>(in->GetSize())));
                *result = dict;
            }
            return TJS_S_OK;
        }
        return _getTime(result, param[0], true);
    }
    static tjs_error getTime(tTJSVariant *result, tjs_int numparams,
                             tTJSVariant **param, iTJSDispatch2 *) {
        if (numparams < 1) return TJS_E_BADPARAMCOUNT;
        return _getTime(result, param[0], false);
    }
    static tjs_int64 getLastModifiedFileTime(ttstr target) {
        Stat(LocalName(target));
        return 0; // No timestamp is supplied by current byte backends.
    }
    static void exportFile(ttstr filename, ttstr storename) {
        const auto placed = TVPGetPlacedPath(filename);
        if (placed.IsEmpty()) TVPThrowExceptionMessage(TJS_W("cannot open readfile: %1"), filename);
        const auto bytes = TVPStorageCall(TJS_W("read"), placed);
        TVPStorageCall(TJS_W("write"), TVPNormalizeStorageName(storename), &bytes);
    }
    static bool deleteFile(const tjs_char *file) { return TVPDeleteLocalFile(file); }
    static tTJSVariant dirlist(tjs_char const *dir) { return LocalDirectoryNames(dir, true, true); }
    static tjs_error dirtree(tTJSVariant *result, tjs_int numparams,
                             tTJSVariant **param, iTJSDispatch2 *) {
        if (numparams < 1) return TJS_E_BADPARAMCOUNT;
        const bool dironly = numparams > 1 ? param[1]->operator bool() : false;
        const auto path = LocalName(ttstr(*param[0]) + TJS_W("/"));
        auto *array = TJSCreateArrayObject();
        tTJSVariant ret(array, array);
        array->Release();
        tjs_int count = 0;
        _dirtree(path, TJS_W(""), array, count, dironly);
        if (result) *result = ret;
        return TJS_S_OK;
    }
    static int isExistentDirectory(ttstr dir) { return TVPIsLocalDirectory(dir); }
    static bool copyFile(const tjs_char *from, const tjs_char *to) {
        const auto fromFile = TVPGetLocallyAccessibleName(TVPGetPlacedPath(from));
        const auto toFile = TVPGetLocallyAccessibleName(TVPNormalizeStorageName(to));
        return _copyFile(fromFile, toFile);
    }
    static bool copyFileNoNormalize(const tjs_char *from, const tjs_char *to, bool failIfExist) {
        const auto fromFile = TVPGetLocallyAccessibleName(TVPGetPlacedPath(from));
        ttstr toFile(to);
        if (toFile.IsEmpty()) return false;
        TVPGetLocalName(toFile);
        // The reference accepts failIfExist but does not use it.
        return _copyFile(fromFile, toFile);
    }
    static bool isExistentStorageNoSearchNoNormalize(ttstr filename) {
        return TVPStorageCall(TJS_W("exists"), filename).operator bool();
    }
    static ttstr getDisplayName(ttstr filename) {
        const auto info = Stat(LocalName(filename));
        return Exists(info) ? ttstr(LocalField(info, TJS_W("displayName"))) : ttstr();
    }
    static tjs_error getMD5HashString(tTJSVariant *result, tjs_int numparams,
                                      tTJSVariant **param, iTJSDispatch2 *) {
        if (numparams < 1) return TJS_E_BADPARAMCOUNT;
        const auto filename = TVPGetPlacedPath(*param[0]);
        if (filename.IsEmpty()) TVPThrowExceptionMessage(TJS_W("cannot open: %1"), ttstr(*param[0]));
        std::unique_ptr<tTJSBinaryStream> in(TJSCreateBinaryStreamForRead(filename, TJS_W("")));
        md5_state_t st;
        md5_init(&st);
        tjs_uint8 buffer[1024];
        tjs_uint size;
        while ((size = in->Read(buffer, sizeof buffer)) > 0) md5_append(&st, buffer, size);
        md5_finish(&st, buffer);
        tjs_char ret[33]{};
        static constexpr tjs_char hex[] = TJS_W("0123456789abcdef");
        for (tjs_int i = 0; i < 16; ++i) {
            ret[i * 2] = hex[buffer[i] >> 4 & 0xf];
            ret[i * 2 + 1] = hex[buffer[i] & 0xf];
        }
        if (result) *result = ret;
        return TJS_S_OK;
    }
    static ttstr getCurrentPath() { return TVPNormalizeStorageName(TJS_W("/")); }
    static void setCurrentPath(ttstr path) { changeDirectory(path); }
    static bool setLastModifiedFileTime(ttstr, tjs_int64) { Unsupported(TJS_W("setLastModifiedFileTime")); }
    static bool moveFile(const tjs_char *from, const tjs_char *to) {
        const auto fromFile = TVPGetLocallyAccessibleName(from);
        const auto toFile = TVPGetLocallyAccessibleName(to);
        if (fromFile.IsEmpty() || toFile.IsEmpty()) return false;
        const auto info = Stat(fromFile);
        if (!Exists(info) || LocalField(info, TJS_W("directory")).operator bool() ||
            !LocalField(info, TJS_W("writable")).operator bool()) return false;
        if (!_copyFile(fromFile, toFile)) return false;
        const bool removed = TVPStorageCall(TJS_W("deleteFile"), fromFile).operator bool();
        if (removed) TVPClearStorageCaches();
        return removed;
    }
    static tTJSVariant dirlistEx(const tjs_char *) { Unsupported(TJS_W("dirlistEx")); }
    static bool removeDirectory(ttstr) { Unsupported(TJS_W("removeDirectory")); }
    static bool createDirectory(ttstr) { Unsupported(TJS_W("createDirectory")); }
    static bool createDirectoryNoNormalize(ttstr) { Unsupported(TJS_W("createDirectoryNoNormalize")); }
    static bool changeDirectory(ttstr) { Unsupported(TJS_W("changeDirectory")); }
    static bool setFileAttributes(ttstr, tjs_uint32) { Unsupported(TJS_W("setFileAttributes")); }
    static bool resetFileAttributes(ttstr, tjs_uint32) { Unsupported(TJS_W("resetFileAttributes")); }
    static tjs_uint32 getFileAttributes(ttstr) { Unsupported(TJS_W("getFileAttributes")); }
    static ttstr getTemporaryName() { Unsupported(TJS_W("getTemporaryName")); }
    static bool truncateFile(const tjs_char *, tjs_int) { Unsupported(TJS_W("truncateFile")); }
    static tjs_error setTime(tTJSVariant *, tjs_int numparams, tTJSVariant **, iTJSDispatch2 *) {
        if (numparams < 2) return TJS_E_BADPARAMCOUNT;
        Unsupported(TJS_W("setTime"));
    }
    static tjs_error selectDirectory(tTJSVariant *, tjs_int numparams, tTJSVariant **, iTJSDispatch2 *) {
        if (numparams < 1) return TJS_E_BADPARAMCOUNT;
        Unsupported(TJS_W("selectDirectory"));
    }
    static tjs_error searchPath(tTJSVariant *, tjs_int numparams, tTJSVariant **, iTJSDispatch2 *) {
        if (numparams < 1) return TJS_E_BADPARAMCOUNT;
        Unsupported(TJS_W("searchPath"));
    }
};

NCB_ATTACH_CLASS(StoragesFstat, Storages) {
    NCB_METHOD(clearStorageCaches);
    RawCallback("fstat", &Class::fstat, TJS_STATICMEMBER);
    RawCallback("getTime", &Class::getTime, TJS_STATICMEMBER);
    RawCallback("setTime", &Class::setTime, TJS_STATICMEMBER);
    NCB_METHOD(getLastModifiedFileTime);
    NCB_METHOD(setLastModifiedFileTime);
    NCB_METHOD(exportFile);
    NCB_METHOD(deleteFile);
    NCB_METHOD(truncateFile);
    NCB_METHOD(moveFile);
    NCB_METHOD(dirlist);
    NCB_METHOD(dirlistEx);
    RawCallback("dirtree", &Class::dirtree, TJS_STATICMEMBER);
    NCB_METHOD(removeDirectory);
    NCB_METHOD(createDirectory);
    NCB_METHOD(createDirectoryNoNormalize);
    NCB_METHOD(changeDirectory);
    NCB_METHOD(setFileAttributes);
    NCB_METHOD(resetFileAttributes);
    NCB_METHOD(getFileAttributes);
    RawCallback("selectDirectory", &Class::selectDirectory, TJS_STATICMEMBER);
    NCB_METHOD(isExistentDirectory);
    NCB_METHOD(copyFile);
    NCB_METHOD(copyFileNoNormalize);
    NCB_METHOD(isExistentStorageNoSearchNoNormalize);
    NCB_METHOD(getDisplayName);
    RawCallback("getMD5HashString", &Class::getMD5HashString, TJS_STATICMEMBER);
    RawCallback("searchPath", &Class::searchPath, TJS_STATICMEMBER);
    Property("currentPath", &Class::getCurrentPath, &Class::setCurrentPath);
    NCB_METHOD(getTemporaryName);
};


// Reference TemporaryFiles checks accessibility, without owning the paths.
class TemporaryFiles {
    static bool _entry(const ttstr &name, bool folder = false) {
        const auto path = LocalName(name);
        const auto info = Stat(path);
        if (!Exists(info)) return false;
        if (LocalField(info, TJS_W("directory")).operator bool() != folder) return false;
        if (!folder) TVPStorageCall(TJS_W("read"), path);
        return true;
    }
public:
    bool entry(ttstr filename) { return _entry(filename); }
    bool entryFolder(ttstr filename) { return _entry(filename, true); }
};
NCB_REGISTER_CLASS(TemporaryFiles) {
    Constructor();
    NCB_METHOD(entry);
    NCB_METHOD(entryFolder);
}

static void registerConstants() {
 const std::pair<const tjs_char *, tjs_int> constants[] = {
  {TJS_W("FILE_ATTRIBUTE_READONLY"),1}, {TJS_W("FILE_ATTRIBUTE_HIDDEN"),2},
  {TJS_W("FILE_ATTRIBUTE_SYSTEM"),4}, {TJS_W("FILE_ATTRIBUTE_DIRECTORY"),16},
  {TJS_W("FILE_ATTRIBUTE_ARCHIVE"),32}, {TJS_W("FILE_ATTRIBUTE_NORMAL"),128},
  {TJS_W("FILE_ATTRIBUTE_TEMPORARY"),256},
 };
 auto *global = TVPGetScriptEngine()->GetGlobalNoAddRef();
 for (const auto &[name, number] : constants) {
  tTJSVariant value(number);
  success(global->PropSet(TJS_MEMBERENSURE, name, nullptr, &value, global));
 }
}
NCB_PRE_REGIST_CALLBACK(registerConstants);
