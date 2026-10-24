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
#include <vector>
class tTJSNI_MenuItem : public tTJSNativeInstance {
 iTJSDispatch2 *Owner = nullptr;
 tTJSVariant Window = tTJSVariant((iTJSDispatch2 *)nullptr);
 tTJSVariant ActionOwner, ChildrenArray, ArrayClearMethod;
 std::vector<tTJSNI_MenuItem *> Children;
 tTJSNI_MenuItem *Parent = nullptr;
 bool ChildrenArrayValid = false;
 ttstr Caption;
 bool IsChecked = false, IsEnabled = true, IsRadio = false, IsVisible = true;
 tjs_int GroupIndex = 0;
public:
 tjs_error Construct(tjs_int, tTJSVariant **, iTJSDispatch2 *) override;
 void Invalidate() override;
 static tTJSNI_MenuItem *CastFromVariant(const tTJSVariant &);
 void Add(tTJSNI_MenuItem *);
 void Insert(tTJSNI_MenuItem *, tjs_int);
 void Remove(tTJSNI_MenuItem *);
 void OnClick();
 tTJSVariantClosure GetActionOwnerNoAddRef() const { return ActionOwner.AsObjectClosureNoAddRef(); }
 iTJSDispatch2 *GetOwnerNoAddRef() const { return Owner; }
 tTJSNI_MenuItem *GetParent() const { return Parent; }
 tTJSNI_MenuItem *GetRootMenuItem() const;
 iTJSDispatch2 *GetWindow() const { return Window.AsObjectNoAddRef(); }
 iTJSDispatch2 *GetChildrenArrayNoAddRef();
 void GetCaption(ttstr &out) const { out = Caption; }
 void SetCaption(const ttstr &value) { Caption = value; }
 bool GetChecked() const { return IsChecked; }
 void SetChecked(bool);
 bool GetEnabled() const { return IsEnabled; }
 void SetEnabled(bool value) { IsEnabled = value; }
 bool GetRadio() const { return IsRadio; }
 void SetRadio(bool value) { IsRadio = value; }
 bool GetVisible() const { return IsVisible; }
 void SetVisible(bool value) { IsVisible = value; }
 tjs_int GetGroup() const { return GroupIndex; }
 void SetGroup(tjs_int value) { GroupIndex = value; }
 void GetShortcut(ttstr &out) const { out.Clear(); }
 void SetShortcut(const ttstr &) {}
 tjs_int GetIndex() const;
 void SetIndex(tjs_int) {}
 tjs_int TrackPopup(tjs_uint32, tjs_int, tjs_int) const;
};
using tTJSNI_BaseMenuItem = tTJSNI_MenuItem;
class tTJSNC_MenuItem : public tTJSNativeClass {
public:
 tTJSNC_MenuItem();
 static tjs_uint32 ClassID;
protected:
 tTJSNativeInstance *CreateNativeInstance() override { return new tTJSNI_MenuItem(); }
};
tTJSNativeClass *TVPCreateNativeClass_MenuItem();
void TVPRegisterWindowMenu(tTJSNativeClass *);
