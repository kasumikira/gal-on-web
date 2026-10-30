#pragma once
#include "SystemIntf.h"
#include "runtime.h"
#include "ScriptMgnIntf.h"
#include "GraphicsLoaderIntf.h"
#include "EventIntf.h"
#include "LayerImpl.h"
#define TVPStartupSuccess true
#define TVPTerminateOnWindowClose (activeRuntime->system.terminateOnWindowClose)
#define TVPTerminateOnNoWindowStartup (activeRuntime->system.terminateOnNoWindowStartup)
void TVPTerminateAsync(int code);
void TVPTerminateSync(int code);
ttstr TVPGetVersionString();
ttstr TVPGetVersionInformation();
void TVPGetRandomBits128(tjs_uint8 *data);
int TVPShowSimpleInputBox(ttstr &value, const ttstr &caption, const ttstr &prompt, const std::vector<ttstr> &buttons);
tjs_int TVPSystemProcessorNum();
