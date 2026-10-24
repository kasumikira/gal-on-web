//---------------------------------------------------------------------------
/*
        TVP2 ( T Visual Presenter 2 )  A script authoring tool
        Copyright (C) 2000-2007 W.Dee <dee@kikyou.info> and
   contributors

        See details of license at "license.txt"
*/
//---------------------------------------------------------------------------
#pragma once
#include "Platform.h"
#include "tjsNative.h"
// Kirikiroid2 disables the platform editor; PadIntf uses only constant properties.
class tTJSNI_BasePad : public tTJSNativeInstance {
public:
 tjs_error Construct(tjs_int, tTJSVariant **, iTJSDispatch2 *) override;
 void Invalidate() override;
};
class tTJSNI_Pad : public tTJSNI_BasePad {};
class tTJSNC_Pad : public tTJSNativeClass {
public:
 tTJSNC_Pad();
 static tjs_uint32 ClassID;
protected:
 tTJSNativeInstance *CreateNativeInstance() override;
};
tTJSNativeClass *TVPCreateNativeClass_Pad();
