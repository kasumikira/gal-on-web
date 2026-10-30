// Message definitions from the reference engine, without platform localization.
#pragma once
#include "tjs.h"
using namespace TJS;
#define TVP_MSG_DECL(name, msg) inline constexpr tjs_char name[] = msg;
#define TVP_MSG_DECL_CONST(name, msg) inline constexpr tjs_char name[] = msg;
#include "MsgImpl.h"
#include "MsgIntfInc.h"
#undef TVP_MSG_DEFINE
#undef TVP_MSG_DECL
#undef TVP_MSG_DECL_CONST

[[noreturn]] void TVPThrowExceptionMessage(const tjs_char *message);
[[noreturn]] void TVPThrowExceptionMessage(const tjs_char *message, const ttstr &a);
[[noreturn]] void TVPThrowExceptionMessage(const tjs_char *message, const ttstr &a, const ttstr &b);
[[noreturn]] void TVPThrowExceptionMessage(const tjs_char *message, const ttstr &a, tjs_int b);
ttstr TVPFormatMessage(const tjs_char *message, const ttstr &a);
ttstr TVPFormatMessage(const tjs_char *message, const ttstr &a, const ttstr &b);
#define TVPThrowInternalError TVPThrowExceptionMessage(TVPInternalError)
