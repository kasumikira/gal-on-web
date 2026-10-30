#pragma once
#include "tjs.h"
#include "tjsError.h"
#include "MsgIntf.h"
using namespace TJS;
struct tTVPCompactEventCallbackIntf
{
    virtual void OnCompact(tjs_int level) = 0;
    virtual ~tTVPCompactEventCallbackIntf() = default;
};
inline constexpr tjs_int TVP_COMPACT_LEVEL_IDLE = 5;
inline constexpr tjs_int TVP_COMPACT_LEVEL_DEACTIVATE = 10;
inline constexpr tjs_int TVP_COMPACT_LEVEL_MINIMIZE = 15;
inline constexpr tjs_int TVP_COMPACT_LEVEL_MAX = 100;
void TVPAddCompactEventHook(tTVPCompactEventCallbackIntf *callback);
void TVPRemoveCompactEventHook(tTVPCompactEventCallbackIntf *callback);
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

ttstr TVPGetPlacedPath(const ttstr &name);
