#pragma once
#include "tjs.h"
#include "tjsError.h"
using namespace TJS;
inline constexpr auto TVPInternalError = TJS_W("Internal error at %1 line %2");
struct tTVPCompactEventCallbackIntf
{
    virtual void OnCompact(tjs_int level) = 0;
    virtual ~tTVPCompactEventCallbackIntf() = default;
};
inline constexpr tjs_int TVP_COMPACT_LEVEL_DEACTIVATE = 10;
void TVPAddCompactEventHook(tTVPCompactEventCallbackIntf *callback);
iTJSTextReadStream *TVPCreateTextStreamForRead(const ttstr &name, const ttstr &mode);
void TVPExecuteExpression(const ttstr &expression, iTJSDispatch2 *context, tTJSVariant *result);
void TVPAddLog(const ttstr &text);
ttstr TVPExtractStorageName(const ttstr &name);
[[noreturn]] void TVPThrowExceptionMessage(const tjs_char *message);
[[noreturn]] void TVPThrowExceptionMessage(const tjs_char *message, const ttstr &a);
[[noreturn]] void TVPThrowExceptionMessage(const tjs_char *message, const ttstr &a, const ttstr &b);
[[noreturn]] void TVPThrowExceptionMessage(const tjs_char *message, const ttstr &a, tjs_int b);

void TVPRegisterKAGParser(iTJSDispatch2 *owner);
void TVPUnregisterKAGParser(iTJSDispatch2 *owner);
void TVPClearScnearioCache();

// Plugins rebuilt into the runtime; each installs its TJS globals once at startup.
void TVPRegisterCSVParser();
void TVPRegisterSaveStruct();
