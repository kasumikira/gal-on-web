// Copyright (C) 2000 W.Dee and contributors; see reference license.txt.
#include "TimerIntf.h"
#include "runtime.h"
#include "tjsDictionary.h"
#include <algorithm>
#include <cmath>
#include <emscripten/emscripten.h>

static tjs_error InvokeTimerAction(tTJSVariantClosure action, const ttstr &name,
 const tjs_char *type, iTJSDispatch2 *owner, tTJSVariant *result) {
 auto *event = TJSCreateDictionaryObject();
 tTJSVariant held(event, event), eventType(type), target(owner, owner);
 event->Release();
 success(event->PropSet(TJS_MEMBERENSURE | TJS_IGNOREPROP, TJS_W("type"), nullptr, &eventType, event));
 success(event->PropSet(TJS_MEMBERENSURE | TJS_IGNOREPROP, TJS_W("target"), nullptr, &target, event));
 tTJSVariant *args[] = { &held };
 // The original action macro does not turn a missing action into an error.
 action.FuncCall(0, name.IsEmpty() ? nullptr : name.c_str(), nullptr, result, 1, args, nullptr);
 return TJS_S_OK;
}

std::uint64_t TimerScheduler::Now() { return static_cast<std::uint64_t>(emscripten_get_now()) << 16; }
void TimerScheduler::Add(tTJSNI_Timer *timer) { Timers.push_back(timer); }
void TimerScheduler::Remove(tTJSNI_Timer *timer) {
 Timers.erase(std::remove(Timers.begin(), Timers.end(), timer), Timers.end());
 Cancel(timer);
}
void TimerScheduler::Cancel(TimerAction *source) {
 // Unlink queue entries before releasing targets, which can run finalizers.
 std::list<Event> removed;
 for (auto it = Events.begin(); it != Events.end();) {
  auto entry = it++;
  if (entry->source == source) removed.splice(removed.end(), Events, entry);
 }
 removed.clear();
 Schedule();
}
void TimerScheduler::Post(TimerAction *source, const tjs_char *name, tjs_int mode) {
 Events.push_back({source, tTJSVariant(source->Owner, source->Owner), mode == 1 || mode == 2 ? mode : 0, Sequence++, name});
}
void TimerScheduler::Schedule() {
 if (Service.Type() == tvtVoid) return;
 double delay = -1;
 if (!Events.empty()) delay = 0;
 else {
  const auto now = Now();
  for (auto *timer : Timers) {
   if (!timer->Enabled || timer->Interval == 0) continue;
   const auto remaining = timer->NextTick > now ? timer->NextTick - now : 0;
   const double next = std::max(3.0, std::ceil(remaining / 65536.0));
   if (delay < 0 || next < delay) delay = next;
  }
 }
 tTJSVariant value(delay); tTJSVariant *args[] = { &value };
 success(Service.AsObjectClosureNoAddRef().FuncCall(0, TJS_W("schedule"), nullptr, nullptr, 1, args, nullptr));
}
void TimerScheduler::Dispatch(bool idle) {
 const auto now = Now();
 for (auto *timer : Timers) {
  if (!timer->Enabled || timer->Interval == 0 || timer->NextTick >= now) continue;
  auto n = (now - timer->NextTick) / timer->Interval + 1;
  if (n > 40) { n = 1; timer->NextTick = now + timer->Interval; }
  else timer->NextTick += n * timer->Interval;
  const tjs_int cap = LimitCapacity ? 1 : timer->Capacity == 0 ? 65535 : timer->Capacity;
  const auto count = std::count_if(Events.begin(), Events.end(), [timer](const Event &event) { return event.source == timer; });
  const auto available = static_cast<std::int64_t>(cap) - count;
  if (available > 0)
   for (auto i = std::min<std::uint64_t>(n, available); i; --i) Post(timer, TJS_W("onTimer"), timer->Mode);
 }
 // Events posted by a callback belong to the following delivery sequence.
 const auto boundary = Sequence;
 for (const tjs_int priority : {1, 0, 2}) {
  if (priority == 2) {
   // Normal callbacks may have queued more browser work in the meantime.
   if (Service.Type() != tvtVoid) {
    tTJSVariant state;
    success(Service.AsObjectClosureNoAddRef().FuncCall(0, TJS_W("isIdle"), nullptr, &state, 0, nullptr, nullptr));
    idle = state.operator bool();
   }
   if (!idle) break;
  }
  for (;;) {
   const auto found = std::find_if(Events.begin(), Events.end(), [&](const Event &event) { return event.sequence < boundary && event.mode == priority; });
   if (found == Events.end()) break;
   Event event = std::move(*found); Events.erase(found);
   auto target = event.target.AsObjectClosureNoAddRef();
   try { success(target.FuncCall(0, event.name, nullptr, nullptr, 0, nullptr, nullptr)); }
   catch (...) { Schedule(); throw; }
   // Exclusive work posted during a callback takes precedence next turn.
   if (std::any_of(Events.begin(), Events.end(), [boundary](const Event &event) { return event.sequence >= boundary && event.mode == 1; })) { Schedule(); return; }
  }
 }
 Schedule();
}
tjs_error TimerScheduler::FuncCall(tjs_uint32, const tjs_char *name, tjs_uint32 *, tTJSVariant *, tjs_int count, tTJSVariant **args, iTJSDispatch2 *) {
 if (name && !TJS_strcmp(name, TJS_W("configure"))) {
  if (count < 1) return TJS_E_BADPARAMCOUNT;
  Service = *args[0]; LimitCapacity = count >= 2 && args[1]->operator bool(); Schedule(); return TJS_S_OK;
 }
 if (name && !TJS_strcmp(name, TJS_W("dispatch"))) {
  if (count < 1) return TJS_E_BADPARAMCOUNT;
  Dispatch(args[0]->operator bool()); return TJS_S_OK;
 }
 return TJS_E_MEMBERNOTFOUND;
}
tjs_error TimerAction::Construct(tjs_int count, tTJSVariant **args, iTJSDispatch2 *owner) {
 if (count < 1) return TJS_E_BADPARAMCOUNT;
 args[0]->AsObjectClosureNoAddRef(); ActionOwner = *args[0]; Owner = owner;
 if (count >= 2 && args[1]->Type() != tvtVoid) ActionName = *args[1];
 Scheduler = static_cast<TimerScheduler *>(activeRuntime->timerScheduler.AsObjectNoAddRef());
 return TJS_S_OK;
}
void TimerAction::Invalidate() {
 if (Scheduler) { auto *scheduler = Scheduler; Scheduler = nullptr; scheduler->Cancel(this); }
 Owner = nullptr; ActionOwner.Clear();
}
tjs_error tTJSNI_Timer::Construct(tjs_int count, tTJSVariant **args, iTJSDispatch2 *owner) {
 auto status = TimerAction::Construct(count, args, owner);
 if (TJS_FAILED(status)) return status;
 Scheduler->Add(this); return TJS_S_OK;
}
void tTJSNI_Timer::Invalidate() {
 if (Scheduler) Scheduler->Remove(this);
 Enabled = false; TimerAction::Invalidate();
}
void tTJSNI_Timer::SetEnabled(bool value) {
 Enabled = value;
 if (value) NextTick = TimerScheduler::Now() + Interval;
 else Scheduler->Cancel(this);
 Scheduler->Schedule();
}
void tTJSNI_Timer::SetInterval(std::uint64_t value) {
 Interval = value;
 if (Enabled) { Scheduler->Cancel(this); NextTick = TimerScheduler::Now() + Interval; }
 Scheduler->Schedule();
}
void tTJSNI_AsyncTrigger::Trigger() {
 if (Cached) Scheduler->Cancel(this);
 Scheduler->Post(this, TJS_W("onFire"), Mode); Scheduler->Schedule();
}
void tTJSNI_AsyncTrigger::Cancel() { Scheduler->Cancel(this); }
void tTJSNI_AsyncTrigger::SetCached(bool value) { if (Cached != value) { Cached = value; Cancel(); } }
void tTJSNI_AsyncTrigger::SetMode(tjs_int value) { if (Mode != value) { Mode = value; Cancel(); } }

tjs_uint32 tTJSNC_Timer::ClassID = -1;

tTJSNC_Timer::tTJSNC_Timer() : inherited(TJS_W("Timer")) {
    // registration of native members

    TJS_BEGIN_NATIVE_MEMBERS(Timer) // constructor
    TJS_DECL_EMPTY_FINALIZE_METHOD
    //----------------------------------------------------------------------
    TJS_BEGIN_NATIVE_CONSTRUCTOR_DECL(/*var.name*/ _this,
                                      /*var.type*/ tTJSNI_Timer,
                                      /*TJS class name*/ Timer) {
        return TJS_S_OK;
    }
    TJS_END_NATIVE_CONSTRUCTOR_DECL(/*TJS class name*/ Timer)
    //----------------------------------------------------------------------

    //-- methods

    //----------------------------------------------------------------------
    //----------------------------------------------------------------------

    //-- events

    //----------------------------------------------------------------------
    TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ onTimer) {
        TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                                /*var. type*/ tTJSNI_Timer);

        tTJSVariantClosure obj = _this->GetActionOwnerNoAddRef();
        if(obj.Object) {
            ttstr &actionname = _this->GetActionName();
            return InvokeTimerAction(obj, actionname, TJS_W("onTimer"), objthis, result);
        }

        return TJS_S_OK;
    }
    TJS_END_NATIVE_METHOD_DECL(/*func. name*/ onTimer)
    //----------------------------------------------------------------------

    //--properties

    //----------------------------------------------------------------------
    TJS_BEGIN_NATIVE_PROP_DECL(interval){
        TJS_BEGIN_NATIVE_PROP_GETTER{ TJS_GET_NATIVE_INSTANCE(
            /*var. name*/ _this, /*var. type*/ tTJSNI_Timer);
    /*
        bcc 5.5.1 has an inliner bug which cannot treat 64bit integer
       return value properly in some occasions. OK : tjs_uint64
       interval = _this->GetInterval(); *result = (tjs_int64)interval;
       NG : *result = (tjs_int64)interval;
    */
    double interval =
        _this->GetInterval() * (1.0 / (1 << 16));
    *result = interval;
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_BEGIN_NATIVE_PROP_SETTER {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_Timer);
    double interval = (double)*param * (1 << 16);
    _this->SetInterval((tjs_int64)(interval + 0.5));
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(interval)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(enabled){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_Timer);
*result = _this->GetEnabled();
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_BEGIN_NATIVE_PROP_SETTER {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_Timer);
    _this->SetEnabled(*param);
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(enabled)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(capacity){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_Timer);
*result = _this->GetCapacity();
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_BEGIN_NATIVE_PROP_SETTER {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_Timer);
    _this->SetCapacity(*param);
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(capacity)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(mode){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_Timer);
*result = (tjs_int)_this->GetMode();
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_BEGIN_NATIVE_PROP_SETTER {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_Timer);
    _this->SetMode((tjs_int)*param);
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(mode)
//----------------------------------------------------------------------

TJS_END_NATIVE_MEMBERS

}
tjs_uint32 tTJSNC_AsyncTrigger::ClassID = -1;

tTJSNC_AsyncTrigger::tTJSNC_AsyncTrigger() :
    inherited(TJS_W("AsyncTrigger")){
        // registration of native members

        TJS_BEGIN_NATIVE_MEMBERS(AsyncTrigger) // constructor
        TJS_DECL_EMPTY_FINALIZE_METHOD
            //----------------------------------------------------------------------
            TJS_BEGIN_NATIVE_CONSTRUCTOR_DECL(
                /*var.name*/ _this, /*var.type*/ tTJSNI_AsyncTrigger,
                /*TJS class name*/ AsyncTrigger){ return TJS_S_OK;
}
TJS_END_NATIVE_CONSTRUCTOR_DECL(/*TJS class name*/ AsyncTrigger)
//----------------------------------------------------------------------

//-- methods

//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ trigger) {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_AsyncTrigger);
    _this->Trigger();
    return TJS_S_OK;
}
TJS_END_NATIVE_METHOD_DECL(/*func. name*/ trigger)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ cancel) {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_AsyncTrigger);
    _this->Cancel();
    return TJS_S_OK;
}
TJS_END_NATIVE_METHOD_DECL(/*func. name*/ cancel)
//----------------------------------------------------------------------

//-- events

//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_METHOD_DECL(/*func. name*/ onFire) {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_AsyncTrigger);

    tTJSVariantClosure obj = _this->GetActionOwnerNoAddRef();
    if(obj.Object) {
        ttstr &actionname = _this->GetActionName();
        return InvokeTimerAction(obj, actionname, TJS_W("onFire"), objthis, result);
    }

    return TJS_S_OK;
}
TJS_END_NATIVE_METHOD_DECL(/*func. name*/ onFire)
//----------------------------------------------------------------------

//--properties

//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(cached){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_AsyncTrigger);
*result = _this->GetCached();
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_BEGIN_NATIVE_PROP_SETTER {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_AsyncTrigger);
    _this->SetCached(*param);
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(cached)
//----------------------------------------------------------------------
TJS_BEGIN_NATIVE_PROP_DECL(mode){ TJS_BEGIN_NATIVE_PROP_GETTER{
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_AsyncTrigger);
*result = (tjs_int)_this->GetMode();
return TJS_S_OK;
}
TJS_END_NATIVE_PROP_GETTER

TJS_BEGIN_NATIVE_PROP_SETTER {
    TJS_GET_NATIVE_INSTANCE(/*var. name*/ _this,
                            /*var. type*/ tTJSNI_AsyncTrigger);
    _this->SetMode((tjs_int)*param);
    return TJS_S_OK;
}
TJS_END_NATIVE_PROP_SETTER
}
TJS_END_NATIVE_PROP_DECL(mode)
//----------------------------------------------------------------------
TJS_END_NATIVE_MEMBERS
}

//---------------------------------------------------------------------------

tTJSNativeClass *TVPCreateNativeClass_Timer() {
 auto *klass = new tTJSNC_Timer();
 success(klass->PropSet(TJS_MEMBERENSURE | TJS_STATICMEMBER | TJS_HIDDENMEMBER, TJS_W("_scheduler"), nullptr, &activeRuntime->timerScheduler, klass));
 return klass;
}
tTJSNativeClass *TVPCreateNativeClass_AsyncTrigger() { return new tTJSNC_AsyncTrigger(); }
void TVPInitializeTimers() {
 auto *scheduler = new TimerScheduler();
 activeRuntime->timerScheduler = tTJSVariant(scheduler, nullptr); scheduler->Release();
}
