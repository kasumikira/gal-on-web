#pragma once
#include <vector>
//---------------------------------------------------------------------------
/*
        TVP2 ( T Visual Presenter 2 )  A script authoring tool
        Copyright (C) 2000 W.Dee <dee@kikyou.info> and contributors

        See details of license at "license.txt"
*/
//---------------------------------------------------------------------------
// "System" class interface
//---------------------------------------------------------------------------
#ifndef SystemIntfH
#define SystemIntfH

#include "tjsNative.h"

//---------------------------------------------------------------------------
// tTJSNC_System : TJS System class
//---------------------------------------------------------------------------
class tTJSNC_System : public tTJSNativeClass {
    typedef tTJSNativeClass inherited;

public:
    tTJSNC_System();

    static tjs_uint32 ClassID;

protected:
    tTJSNativeInstance *CreateNativeInstance() override;
};

//---------------------------------------------------------------------------
extern tTJSNativeClass *TVPCreateNativeClass_System();
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------
TJS_EXP_FUNC_DEF(ttstr, TVPGetPlatformName, ());
// retrieve platform name (eg. "Win32")
// implement in each platform.
TJS_EXP_FUNC_DEF(ttstr, TVPGetOSName, ());

// retrieve OS name
// implement in each platform.
extern void TVPFireOnApplicationActivateEvent(bool activate_or_deactivate);

extern tjs_int TVPGetOSBits();
//---------------------------------------------------------------------------
#endif

struct TVPSystemState {
    std::vector<tTJSVariantClosure> continuousHandlers;
    bool deliveringContinuous = false;
    bool eventDisabled = false;
    bool limitContinuous60 = false;
    double lastFrame = -1, frameRemainder = 0;
    tTJSVariant service, arguments, registerData;
    bool registerDataLoaded = false;
    bool terminateOnWindowClose = true, terminateOnNoWindowStartup = true;
    bool maintenanceStarted = false;
    tjs_uint64 lastRehash = 0, lastCompact = 0;
    ttstr title = TJS_W("kirikiriz");
};
void TVPInitializeSystem(const tTJSVariant &service);
void TVPMaintainSystem(bool start);
