// Adapted from Kirikiroid2 TimerIntf/TimerImpl and EventIntf AsyncTrigger.
// Copyright (C) 2000 W.Dee and contributors; see reference license.txt.
#pragma once
#include "Platform.h"
#include "tjsNative.h"
#include <cstdint>
#include <list>
#include <vector>
class TimerScheduler;
class TimerAction : public tTJSNativeInstance {
protected:
 TimerScheduler *Scheduler = nullptr;
 iTJSDispatch2 *Owner = nullptr;
 tTJSVariant ActionOwner;
 ttstr ActionName = TJS_W("action");
 tjs_int Mode = 0;
public:
 tjs_error Construct(tjs_int, tTJSVariant **, iTJSDispatch2 *) override;
 void Invalidate() override;
 tTJSVariantClosure GetActionOwnerNoAddRef() const { return ActionOwner.AsObjectClosureNoAddRef(); }
 ttstr &GetActionName() { return ActionName; }
 tjs_int GetMode() const { return Mode; }
 friend class TimerScheduler;
};
class tTJSNI_Timer : public TimerAction {
 std::uint64_t Interval = 1000, NextTick = 0;
 bool Enabled = false;
 tjs_int Capacity = 6;
public:
 tjs_error Construct(tjs_int, tTJSVariant **, iTJSDispatch2 *) override;
 void Invalidate() override;
 void SetInterval(std::uint64_t);
 std::uint64_t GetInterval() const { return Interval; }
 void SetEnabled(bool);
 bool GetEnabled() const { return Enabled; }
 tjs_int GetCapacity() const { return Capacity; }
 void SetCapacity(tjs_int value) { Capacity = value; }
 void SetMode(tjs_int value) { Mode = value; }
 friend class TimerScheduler;
};
class tTJSNI_AsyncTrigger : public TimerAction {
 bool Cached = true;
public:
 void Trigger();
 void Cancel();
 bool GetCached() const { return Cached; }
 void SetCached(bool);
 void SetMode(tjs_int);
};
class tTJSNC_Timer : public tTJSNativeClass {
 using inherited = tTJSNativeClass;
public:
 tTJSNC_Timer();
 static tjs_uint32 ClassID;
protected:
 tTJSNativeInstance *CreateNativeInstance() override { return new tTJSNI_Timer(); }
};
class tTJSNC_AsyncTrigger : public tTJSNativeClass {
 using inherited = tTJSNativeClass;
public:
 tTJSNC_AsyncTrigger();
 static tjs_uint32 ClassID;
protected:
 tTJSNativeInstance *CreateNativeInstance() override { return new tTJSNI_AsyncTrigger(); }
};
class TimerScheduler : public tTJSDispatch {
 struct Event { TimerAction *source; tTJSVariant target; tjs_int mode; std::uint64_t sequence; const tjs_char *name; };
 std::vector<tTJSNI_Timer *> Timers;
 std::list<Event> Events;
 tTJSVariant Service;
 std::uint64_t Sequence = 0;
 bool LimitCapacity = false;
public:
 static std::uint64_t Now();
 void Schedule();
 void Add(tTJSNI_Timer *);
 void Remove(tTJSNI_Timer *);
 void Cancel(TimerAction *);
 void Post(TimerAction *, const tjs_char *, tjs_int mode);
 void Dispatch(bool idle);
 tjs_error FuncCall(tjs_uint32, const tjs_char *, tjs_uint32 *, tTJSVariant *, tjs_int, tTJSVariant **, iTJSDispatch2 *) override;
};
tTJSNativeClass *TVPCreateNativeClass_Timer();
tTJSNativeClass *TVPCreateNativeClass_AsyncTrigger();
void TVPInitializeTimers();
