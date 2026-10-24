//---------------------------------------------------------------------------
/*
        TVP2 ( T Visual Presenter 2 )  A script authoring tool
        Copyright (C) 2000-2007 W.Dee <dee@kikyou.info> and
   contributors

        See details of license at "license.txt"
*/
//---------------------------------------------------------------------------
// Menu tree, script binding and radio-group behavior follow Kirikiroid2
// MenuItemIntf.cpp / impl/MenuItemImpl.cpp; browser Window remains a host class.
#include "MenuItemIntf.h"
#include "runtime.h"
#include "tjsArray.h"
#include "tjsDictionary.h"
#include <algorithm>

tjs_error tTJSNI_MenuItem::Construct(tjs_int count, tTJSVariant **args, iTJSDispatch2 *owner) {
 if (count < 1) return TJS_E_BADPARAMCOUNT;
 // The action target is an object closure in the original native interface.
 args[0]->AsObjectClosureNoAddRef();
 ActionOwner = *args[0]; Owner = owner;
 if (count >= 2) {
  if (args[1]->Type() == tvtObject) {
   auto object = args[1]->AsObjectNoAddRef();
   if (!object || object->IsInstanceOf(0, nullptr, nullptr, TJS_W("Window"), object) != TJS_S_TRUE)
    TVPThrowExceptionMessage(TJS_W("Please specify Window class object."));
   Window = tTJSVariant(object, object);
  } else Caption = *args[1];
 }
 return TJS_S_OK;
}
void tTJSNI_MenuItem::Invalidate() {
 if (Parent) Parent->Remove(this);
 while (!Children.empty()) {
  auto *child = Children.front();
  Children.erase(Children.begin()); child->Parent = nullptr;
  auto *owner = child->Owner;
  if (owner) {
   tTJSVariant held(owner, owner);
   owner->Release();
   owner->Invalidate(0, nullptr, nullptr, owner);
  }
 }
 ChildrenArray.Clear(); ArrayClearMethod.Clear();
 ActionOwner.Clear(); Window.Clear(); Owner = nullptr;
}
tTJSNI_MenuItem *tTJSNI_MenuItem::CastFromVariant(const tTJSVariant &value) {
 iTJSNativeInstance *instance = nullptr;
 auto *object = value.AsObjectNoAddRef();
 if (!object || TJS_FAILED(object->NativeInstanceSupport(TJS_NIS_GETINSTANCE, tTJSNC_MenuItem::ClassID, &instance)))
  TVPThrowExceptionMessage(TJS_W("Please specify MenuItem class object."));
 return static_cast<tTJSNI_MenuItem *>(instance);
}
void tTJSNI_MenuItem::Add(tTJSNI_MenuItem *item) { Insert(item, Children.size()); }
void tTJSNI_MenuItem::Insert(tTJSNI_MenuItem *item, tjs_int index) {
 if (index < 0 || index > static_cast<tjs_int>(Children.size()))
  TVPThrowExceptionMessage(TJS_W("MenuItem index out of range"));
 if (std::find(Children.begin(), Children.end(), item) != Children.end()) return;
 Children.insert(Children.begin() + index, item); ChildrenArrayValid = false;
 if (item->Owner) item->Owner->AddRef();
 item->Parent = this;
}
void tTJSNI_MenuItem::Remove(tTJSNI_MenuItem *item) {
 auto found = std::find(Children.begin(), Children.end(), item);
 if (found == Children.end()) return;
 Children.erase(found); ChildrenArrayValid = false; item->Parent = nullptr;
 if (item->Owner) item->Owner->Release();
}
tTJSNI_MenuItem *tTJSNI_MenuItem::GetRootMenuItem() const {
 auto *root = const_cast<tTJSNI_MenuItem *>(this);
 while (root->Parent) root = root->Parent;
 return root;
}
tjs_int tTJSNI_MenuItem::GetIndex() const {
 if (!Parent) return 0;
 auto found = std::find(Parent->Children.begin(), Parent->Children.end(), this);
 return found == Parent->Children.end() ? 0 : found - Parent->Children.begin();
}
void tTJSNI_MenuItem::SetChecked(bool value) {
 if (value && IsRadio && Parent)
  for (auto *item : Parent->Children)
   if (item->IsRadio && item->GroupIndex == GroupIndex) item->IsChecked = false;
 IsChecked = value;
}
iTJSDispatch2 *tTJSNI_MenuItem::GetChildrenArrayNoAddRef() {
 if (ChildrenArray.Type() == tvtVoid) {
  iTJSDispatch2 *klass;
  auto *array = TJSCreateArrayObject(&klass);
  ChildrenArray = tTJSVariant(array, array); array->Release();
  tTJSVariant held(klass, nullptr); klass->Release();
  success(klass->PropGet(0, TJS_W("clear"), nullptr, &ArrayClearMethod, klass));
 }
 auto *array = ChildrenArray.AsObjectNoAddRef();
 if (!ChildrenArrayValid) {
  success(ArrayClearMethod.AsObjectNoAddRef()->FuncCall(0, nullptr, nullptr, nullptr, 0, nullptr, array));
  tjs_int index = 0;
  for (auto *child : Children) {
   tTJSVariant value(child->Owner, child->Owner);
   success(array->PropSetByNum(TJS_MEMBERENSURE, index++, &value, array));
  }
  ChildrenArrayValid = true;
 }
 return array;
}
void tTJSNI_MenuItem::OnClick() {
 for (auto *item = this; item; item = item->Parent) if (!item->IsEnabled) return;
 auto *window = GetRootMenuItem()->GetWindow();
 if (!window) return;
 tTJSVariant visible, enabled;
 success(window->PropGet(0, TJS_W("visible"), nullptr, &visible, window));
 success(window->PropGet(0, TJS_W("enabled"), nullptr, &enabled, window));
 if (!visible.operator bool() || !enabled.operator bool()) return;
 success(Owner->FuncCall(0, TJS_W("onClick"), nullptr, nullptr, 0, nullptr, Owner));
}
tjs_int tTJSNI_MenuItem::TrackPopup(tjs_uint32, tjs_int, tjs_int) const {
 TVPThrowExceptionMessage(TJS_W("MenuItem.popup rendering is not implemented yet"));
}

tjs_uint32 tTJSNC_MenuItem::ClassID = -1;
tTJSNC_MenuItem::tTJSNC_MenuItem() :
    tTJSNativeClass(TJS_W("MenuItem")){
        // registration of native members

        TJS_BEGIN_NATIVE_MEMBERS(MenuItem) // constructor
        TJS_DECL_EMPTY_FINALIZE_METHOD
            //----------------------------------------------------------------------
            TJS_BEGIN_NATIVE_CONSTRUCTOR_DECL(
                /*var.name*/ _this, /*var.type*/ tTJSNI_MenuItem,
                /*TJS class name*/ MenuItem){ return TJS_S_OK;
}
TJS_END_NATIVE_CONSTRUCTOR_DECL(/*TJS class name*/ MenuItem)
//----------------------------------------------------------------------

//-- methods

//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ add) {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
    if(numparams < 1)
        return TJS_E_BADPARAMCOUNT;
    tTJSNI_MenuItem *item = tTJSNI_BaseMenuItem::CastFromVariant(*param[0]);
    _this->Add(item);
    return TJS_S_OK;
}
TJS_END_NATIVE_METHOD_DECL(/*func. name*/ add)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ insert) {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
    if(numparams < 2)
        return TJS_E_BADPARAMCOUNT;
    tTJSNI_MenuItem *item = tTJSNI_BaseMenuItem::CastFromVariant(*param[0]);
    tjs_int index = *param[1];
    _this->Insert(item, index);
    return TJS_S_OK;
}
TJS_END_NATIVE_METHOD_DECL(/*func. name*/ insert)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ remove) {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
    if(numparams < 1)
        return TJS_E_BADPARAMCOUNT;
    tTJSNI_MenuItem *item = tTJSNI_BaseMenuItem::CastFromVariant(*param[0]);
    _this->Remove(item);
    return TJS_S_OK;
}
TJS_END_NATIVE_METHOD_DECL(/*func. name*/ remove)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ popup) // not trackPopup
{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
    if(numparams < 3)
        return TJS_E_BADPARAMCOUNT;
    tjs_uint32 flags = (tTVInteger)*param[0];
    tjs_int x = *param[1];
    tjs_int y = *param[2];
    tjs_int rv = _this->TrackPopup(flags, x, y);
    if(result)
        *result = rv;
    return TJS_S_OK;
}
TJS_END_NATIVE_METHOD_DECL(/*func. name*/ popup) // not trackPopup
//---------------------------------------------------------------------------

//-- events

//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ onClick) {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);

    tTJSVariantClosure obj = _this->GetActionOwnerNoAddRef();
    if(obj.Object) {
        auto *event = TJSCreateDictionaryObject();
        tTJSVariant held(event, event), type(TJS_W("onClick")), target(objthis, objthis);
        event->Release();
        success(event->PropSet(TJS_MEMBERENSURE, TJS_W("type"), nullptr, &type, event));
        success(event->PropSet(TJS_MEMBERENSURE, TJS_W("target"), nullptr, &target, event));
        tTJSVariant *args[] = { &held };
        auto status = obj.FuncCall(0, TJS_W("action"), nullptr, result, 1, args, nullptr);
        if (status != TJS_E_MEMBERNOTFOUND) success(status);
    }

    return TJS_S_OK;
}
TJS_END_NATIVE_METHOD_DECL(/*func. name*/ onClick)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ fireClick) {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);

    _this->OnClick();
    return TJS_S_OK;
}
TJS_END_NATIVE_METHOD_DECL(/*func. name*/ fireClick)
//----------------------------------------------------------------------

//--properties

//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(caption){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
ttstr res;
_this->GetCaption(res);
*result = res;
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_BEGIN_NATIVE_PROP_SETTER {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
    _this->SetCaption(*param);
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(caption)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(checked){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
*result = _this->GetChecked();
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_BEGIN_NATIVE_PROP_SETTER {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
    _this->SetChecked(param->operator bool());
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(checked)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(enabled){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
*result = _this->GetEnabled();
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_BEGIN_NATIVE_PROP_SETTER {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
    _this->SetEnabled(param->operator bool());
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(enabled)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(group){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
*result = _this->GetGroup();
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_BEGIN_NATIVE_PROP_SETTER {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
    _this->SetGroup((tjs_int)*param);
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(group)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(radio){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
*result = _this->GetRadio();
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_BEGIN_NATIVE_PROP_SETTER {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
    _this->SetRadio(param->operator bool());
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(radio)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(shortcut){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
ttstr res;
_this->GetShortcut(res);
*result = res;
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_BEGIN_NATIVE_PROP_SETTER {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
    _this->SetShortcut(*param);
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(shortcut)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(visible){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
*result = _this->GetVisible();
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_BEGIN_NATIVE_PROP_SETTER {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
    _this->SetVisible(param->operator bool());
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(visible)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(parent){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
tTJSNI_BaseMenuItem *parent = _this->GetParent();
if(parent) {
    iTJSDispatch2 *dsp = parent->GetOwnerNoAddRef();
    *result = tTJSVariant(dsp, dsp);
} else {
    *result = tTJSVariant((iTJSDispatch2 *)nullptr);
}
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_DENY_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(parent)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(children){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
iTJSDispatch2 *dsp = _this->GetChildrenArrayNoAddRef();
*result = tTJSVariant(dsp, dsp);
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_DENY_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(children)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(root) // not rootMenuItem
{ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
tTJSNI_BaseMenuItem *root = _this->GetRootMenuItem();
if(root) {
    iTJSDispatch2 *dsp = root->GetOwnerNoAddRef();
    if(result)
        *result = tTJSVariant(dsp, dsp);
} else {
    if(result)
        *result = tTJSVariant((iTJSDispatch2 *)nullptr);
}
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_DENY_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(root) // not rootMenuItem
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(window){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
iTJSDispatch2 *window = _this->GetWindow();
if(window) {
    iTJSDispatch2 *dsp = window;
    if(result)
        *result = tTJSVariant(dsp, dsp);
} else {
    if(result)
        *result = tTJSVariant((iTJSDispatch2 *)nullptr);
}
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_DENY_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(window)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(index){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
if(result)
    *result = (tTVInteger)_this->GetIndex();
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_BEGIN_NATIVE_PROP_SETTER {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_MenuItem);
    _this->SetIndex((tjs_int)(*param));
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(index)
TJS_BEGIN_NATIVE_PROP_DECL(HMENU) {
 TJS_BEGIN_NATIVE_PROP_GETTER { *result = (tjs_int)0; return TJS_S_OK; }
 TJS_END_NATIVE_PROP_GETTER
 TJS_DENY_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(HMENU)

//----------------------------------------------------------------------

TJS_END_NATIVE_MEMBERS
}
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------

tTJSNativeClass *TVPCreateNativeClass_MenuItem() { return new tTJSNC_MenuItem(); }

static tjs_error windowMenu(tTJSVariant *result, iTJSDispatch2 *owner) {
 auto &state = activeRuntime->owners.at(owner);
 if (state.windowMenu.Type() == tvtVoid) {
  tTJSVariant klass;
  success(activeRuntime->engine->GetGlobalNoAddRef()->PropGet(0, TJS_W("MenuItem"), nullptr, &klass, nullptr));
  tTJSVariant window(owner, owner); tTJSVariant *args[] = { &window, &window };
  iTJSDispatch2 *menu;
  success(klass.AsObjectNoAddRef()->CreateNew(0, nullptr, nullptr, &menu, 2, args, klass.AsObjectNoAddRef()));
  state.windowMenu = tTJSVariant(menu, menu); menu->Release();
 }
 if (result) *result = state.windowMenu;
 return TJS_S_OK;
}
void TVPRegisterWindowMenu(tTJSNativeClass *klass) {
 klass->RegisterNCM(TJS_W("menu"), TJSCreateNativeClassProperty(windowMenu, nullptr), TJS_W("Window"), nitProperty);
}
