#pragma once
#include "Platform.h"
#include "tjsNative.h"
tTJSNativeClass *TVPCreateNativeClass_Storages();

ttstr TVPNativeFullPath(const ttstr &);
ttstr TVPNativePlacedPath(const ttstr &);
ttstr TVPSearchPlacedPath(const ttstr &);

tTJSVariant TVPListLocalDirectory(const ttstr &);
tjs_int TVPIsLocalDirectory(const ttstr &);
bool TVPDeleteLocalFile(const ttstr &);
void TVPClearStorageCaches();

class tTJSNC_Storages : public tTJSNativeClass {
 typedef tTJSNativeClass inherited;
public:
 tTJSNC_Storages();
 static tjs_uint32 ClassID;
protected:
 tTJSNativeInstance *CreateNativeInstance() override;
};

ttstr TVPNormalizeStorageName(const ttstr &);
ttstr TVPExtractStorageExt(const ttstr &);
ttstr TVPExtractStoragePath(const ttstr &);
ttstr TVPChopStorageExt(const ttstr &);
ttstr TVPGetLocallyAccessibleName(const ttstr &);
void TVPGetLocalName(ttstr &);
void TVPAddAutoPath(const ttstr &);
void TVPRemoveAutoPath(const ttstr &);
bool TVPIsExistentStorage(const ttstr &);
bool TVPIsExistentStorageNoSearch(const ttstr &);
void TVPClearArchiveCache();
tTJSVariant TVPStorageCall(const tjs_char *, const ttstr &, const tTJSVariant *value = nullptr);
