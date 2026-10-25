// Directory result conversion shared by dirlist and the implemented fstat subset.
#pragma once
#include "StoragesIntf.h"
#include "runtime.h"
#include "tjsArray.h"
inline tTJSVariant LocalField(const tTJSVariant &value, const tjs_char *name) {
 tTJSVariant result;
 success(value.AsObjectClosureNoAddRef().PropGet(0, name, nullptr, &result, nullptr));
 return result;
}
inline tTJSVariant LocalDirectoryNames(const ttstr &directory, bool displayNames, bool requireExisting) {
 const auto info = TVPListLocalDirectory(directory);
 if (requireExisting && !LocalField(info, TJS_W("exists")).operator bool())
  TVPThrowExceptionMessage(TJS_W("Directory not found."));
 const auto entries = LocalField(info, TJS_W("entries"));
 auto *array = TJSCreateArrayObject();
 tTJSVariant result(array, array); array->Release();
 const auto count = TJSGetArrayElementCount(entries.AsObjectNoAddRef());
 for (tjs_int index = 0; index < count; ++index) {
  tTJSVariant entry;
  success(entries.AsObjectClosureNoAddRef().PropGetByNum(0, index, &entry, nullptr));
  auto name = LocalField(entry, displayNames ? TJS_W("displayName") : TJS_W("name"));
  success(array->PropSetByNum(TJS_MEMBERENSURE, index, &name, array));
 }
 return result;
}
