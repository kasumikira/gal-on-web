#pragma once
#include "Platform.h"
#include "tjsNative.h"
class tTJSNC_Scripts : public tTJSNativeClass
{
    typedef tTJSNativeClass inherited;

  public:
    tTJSNC_Scripts();

    static tjs_uint32 ClassID;

  protected:
    tTJSNativeInstance *CreateNativeInstance() override;
};

//---------------------------------------------------------------------------
extern tTJSNativeClass *TVPCreateNativeClass_Scripts();
void RegisterScriptsExtensions(tTJSNativeClass *klass);
tTJS *TVPGetScriptEngine();
void TVPExecuteStorage(const ttstr &, iTJSDispatch2 *, tTJSVariant *, bool, const tjs_char *);
void TVPCompileStorage(const ttstr &, bool, bool, bool, const ttstr &);
void TVPDumpScriptEngine();
const tjs_char *TVPGetDefaultReadEncoding();
void TVPSetDefaultReadEncoding(const ttstr &);
void TVPExecuteExpression(const ttstr &, const ttstr &, int, iTJSDispatch2 *, tTJSVariant *);
