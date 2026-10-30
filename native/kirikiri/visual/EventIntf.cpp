// Script events and continuous hooks follow the reference event queue semantics.
#include "EventIntf.h"
#include "TickCount.h"
#include "runtime.h"
#include "tjsDictionary.h"
#include <algorithm>
#include <memory>
#include <emscripten.h>

bool TVPEventDisabled = false;
static bool TVPEventInterrupting = false;
static bool TVPExclusiveEventPosted = false;
tjs_uint64 TVPEventSequenceNumber = 0;
bool TVPGetSystemEventDisabledState() { return activeRuntime->system.eventDisabled; }
void TVPSetSystemEventDisabledState(bool value) { activeRuntime->system.eventDisabled = value; }
void TVPInvokeEvents() {
    if(activeRuntime->visualService.Type() == tvtVoid)
        TVPThrowExceptionMessage(TJS_W("Native visual event service is not configured"));
    success(activeRuntime->visualService.AsObjectClosureNoAddRef().FuncCall(
        0, TJS_W("schedule"), nullptr, nullptr, 0, nullptr, nullptr));
}
class tTVPEvent {
    iTJSDispatch2 *Target;
    iTJSDispatch2 *Source;
    ttstr EventName;
    tjs_uint32 Tag;
    tjs_uint NumArgs;
    tTJSVariant *Args;
    tjs_uint32 Flags;
    tjs_uint64 Sequence;

public:
    tTVPEvent(iTJSDispatch2 *target, iTJSDispatch2 *source, ttstr &eventname,
              tjs_uint32 tag, tjs_uint numargs, tTJSVariant *args,
              tjs_uint32 flags) {
        // constructor

        // eventname is not a const object but this object only touch
        // to eventname.GetHint()

        Args = nullptr;
        Target = nullptr;
        Source = nullptr;

        Sequence = TVPEventSequenceNumber;
        EventName = eventname;
        NumArgs = numargs;
        Args = new tTJSVariant[NumArgs];
        for(tjs_uint i = 0; i < NumArgs; i++)
            Args[i] = args[i];
        Target = target;
        Source = source;
        Tag = tag;
        Flags = flags;
        if(Target)
            Target->AddRef();
        if(Source)
            Source->AddRef();
    }

    tTVPEvent(const tTVPEvent &ref) {
        // copy constructor
        Args = nullptr;
        Target = nullptr;
        Source = nullptr;

        EventName = ref.EventName;
        NumArgs = ref.NumArgs;
        Args = new tTJSVariant[NumArgs];
        for(tjs_uint i = 0; i < NumArgs; i++)
            Args[i] = ref.Args[i];
        Target = ref.Target;
        Source = ref.Source;
        Tag = ref.Tag;
        if(Target)
            Target->AddRef();
        if(Source)
            Source->AddRef();
    }

    ~tTVPEvent() {
        if(Args)
            delete[] Args;
        if(Target)
            Target->Release();
        if(Source)
            Source->Release();
    }

    void Deliver() {
        if(!TJSIsObjectValid(Target->IsValid(0, nullptr, nullptr, Target)))
            return; // The target had been invalidated
        tTJSVariant **ArgsPtr = new tTJSVariant *[NumArgs];
        for(tjs_uint i = 0; i < NumArgs; i++)
            ArgsPtr[i] = Args + i;
        try {
            Target->FuncCall(0, EventName.c_str(), EventName.GetHint(), nullptr,
                             NumArgs, ArgsPtr, Target);
        } catch(...) {
            delete[] ArgsPtr;
            throw;
        }
        delete[] ArgsPtr;
    }

    iTJSDispatch2 *GetTargetNoAddRef() const { return Target; }

    iTJSDispatch2 *GetSourceNoAddRef() const { return Source; }

    ttstr &GetEventName() { return EventName; }

    tjs_uint32 GetTag() const { return Tag; }

    tjs_uint32 GetFlags() const { return Flags; }

    tjs_uint64 GetSequence() const;
};

//---------------------------------------------------------------------------
tjs_uint64 tTVPEvent::GetSequence() const { return Sequence; }
//---------------------------------------------------------------------------


static std::vector<tTVPEvent *> TVPEventQueue;
void TVPPostEvent(iTJSDispatch2 *source, iTJSDispatch2 *target,
                  ttstr &eventname, tjs_uint32 tag, tjs_uint32 flag,
                  tjs_uint numargs, tTJSVariant *args) {
    bool evdisabled = TVPEventDisabled || TVPGetSystemEventDisabledState();

    if((flag & TVP_EPT_DISCARDABLE) && (TVPEventInterrupting || evdisabled))
        return;

    tjs_int method = flag & TVP_EPT_METHOD_MASK;

    if(method == TVP_EPT_IMMEDIATE) {
        // the event is delivered immediately

        if(evdisabled)
            return;

        try {
            try {
                tTVPEvent(target, source, eventname, tag, numargs, args, flag)
                    .Deliver();
            }
            catch(const std::exception &error) { throw eTJSError(ttstr(error.what())); }
        }
        catch(const eTJSSilent &) {}
        catch(const eTJS &error) { activeRuntime->ExceptionPrint(error.GetMessage().c_str()); }

        return;
    }

    if(method == TVP_EPT_REMOVE_POST) {
        // events in queue that have same target/source/name/tag are
        // to be removed
        std::vector<tTVPEvent *>::iterator i;
        i = TVPEventQueue.begin();
        while(/*TVPEventQueue.size() &&*/ i != TVPEventQueue.end()) {
            if(source == (*i)->GetSourceNoAddRef() &&
               target == (*i)->GetTargetNoAddRef() &&
               eventname == (*i)->GetEventName() &&
               ((tag == 0) ? true : (tag == (*i)->GetTag()))) {
                tTVPEvent *ev = *i;
                TVPEventQueue.erase(i);
                i = TVPEventQueue.begin();
                delete ev;
            } else {
                i++;
            }
        }
    }

    // put into queue
    TVPEventQueue.push_back(
        new tTVPEvent(target, source, eventname, tag, numargs, args, flag));

    // is exclusive?
    if((flag & TVP_EPT_PRIO_MASK) == TVP_EPT_EXCLUSIVE)
        TVPExclusiveEventPosted = true;

    // make sure that the event is to be delivered.
    TVPInvokeEvents();
}
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------
// TVPCancelEvents
//---------------------------------------------------------------------------
tjs_int TVPCancelEvents(iTJSDispatch2 *source, iTJSDispatch2 *target,
                        const ttstr &eventname, tjs_uint32 tag) {
    tjs_int count = 0;
    std::vector<tTVPEvent *>::iterator i;
    i = TVPEventQueue.begin();
    while(/*TVPEventQueue.size() &&*/ i != TVPEventQueue.end()) {
        if(source == (*i)->GetSourceNoAddRef() &&
           target == (*i)->GetTargetNoAddRef() &&
           eventname == (*i)->GetEventName() &&
           ((tag == 0) ? true : (tag == (*i)->GetTag()))) {
            tTVPEvent *ev = *i;
            TVPEventQueue.erase(i);
            i = TVPEventQueue.begin();
            delete ev;
            count++;
        } else {
            i++;
        }
    }
    return count;
}
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------
// TVPAreEventsInQueue
//---------------------------------------------------------------------------
bool TVPAreEventsInQueue(iTJSDispatch2 *source, iTJSDispatch2 *target,
                         const ttstr &eventname, tjs_uint32 tag) {
    std::vector<tTVPEvent *>::iterator i;
    i = TVPEventQueue.begin();
    while(/*TVPEventQueue.size() &&*/ i != TVPEventQueue.end()) {
        if(source == (*i)->GetSourceNoAddRef() &&
           target == (*i)->GetTargetNoAddRef() &&
           eventname == (*i)->GetEventName() &&
           ((tag == 0) ? true : (tag == (*i)->GetTag())))
            return true;
        i++;
    }
    return false;
}
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------
// TVPCountEventsInQueue
//---------------------------------------------------------------------------
tjs_int TVPCountEventsInQueue(iTJSDispatch2 *source, iTJSDispatch2 *target,
                              const ttstr &eventname, tjs_uint32 tag) {
    tjs_int count = 0;
    std::vector<tTVPEvent *>::iterator i;
    i = TVPEventQueue.begin();
    while(/*TVPEventQueue.size() &&*/ i != TVPEventQueue.end()) {
        if(source == (*i)->GetSourceNoAddRef() &&
           target == (*i)->GetTargetNoAddRef() &&
           eventname == (*i)->GetEventName() &&
           ((tag == 0) ? true : (tag == (*i)->GetTag())))
            count++;
        i++;
    }
    return count;
}
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------
// TVPCancelEventByTag
//---------------------------------------------------------------------------
void TVPCancelEventsByTag(iTJSDispatch2 *source, iTJSDispatch2 *target,
                          tjs_uint32 tag) {
    std::vector<tTVPEvent *>::iterator i;
    i = TVPEventQueue.begin();
    while(/*TVPEventQueue.size() &&*/ i != TVPEventQueue.end()) {
        if(source == (*i)->GetSourceNoAddRef() &&
           target == (*i)->GetTargetNoAddRef() &&
           ((tag == 0) ? true : (tag == (*i)->GetTag()))) {
            tTVPEvent *ev = *i;
            TVPEventQueue.erase(i);
            i = TVPEventQueue.begin();
            delete ev;
        } else {
            i++;
        }
    }
}
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------
// TVPCancelSourceEvent
//---------------------------------------------------------------------------
void TVPCancelSourceEvents(iTJSDispatch2 *source) {
    std::vector<tTVPEvent *>::iterator i;
    i = TVPEventQueue.begin();
    while(/*TVPEventQueue.size() &&*/ i != TVPEventQueue.end()) {
        if(source == (*i)->GetSourceNoAddRef()) {
            tTVPEvent *ev = *i;
            TVPEventQueue.erase(i);
            i = TVPEventQueue.begin();
            delete ev;
        } else {
            i++;
        }
    }
}
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------

void TVPDeliverAllEvents() {
    if(TVPEventDisabled || TVPGetSystemEventDisabledState()) return;
    const auto boundary = TVPEventSequenceNumber++;
    TVPExclusiveEventPosted = false;
    for(auto priority : {TVP_EPT_EXCLUSIVE, TVP_EPT_NORMAL, TVP_EPT_IDLE}) {
        for(;;) {
            if(priority != TVP_EPT_EXCLUSIVE && TVPExclusiveEventPosted) break;
            const auto found = std::find_if(TVPEventQueue.begin(), TVPEventQueue.end(),
                [&](const auto *event) { return event->GetSequence() <= boundary &&
                    (event->GetFlags() & TVP_EPT_PRIO_MASK) == priority; });
            if(found == TVPEventQueue.end()) break;
            std::unique_ptr<tTVPEvent> event(*found);
            TVPEventQueue.erase(found);
            event->Deliver();
        }
    }
    if(!TVPEventQueue.empty()) TVPInvokeEvents();
}

static std::vector<tTVPContinuousEventCallbackIntf *> ContinuousHooks;
void TVPBeginContinuousEvent() {
    if(activeRuntime->visualService.Type() == tvtVoid)
        TVPThrowExceptionMessage(TJS_W("Native visual event service is not configured"));
    tTJSVariant enabled(1); tTJSVariant *args[] = {&enabled};
    success(activeRuntime->visualService.AsObjectClosureNoAddRef().FuncCall(
        0, TJS_W("continuous"), nullptr, nullptr, 1, args, nullptr));
}
void TVPEndContinuousEvent() {
    tTJSVariant enabled(0); tTJSVariant *args[] = {&enabled};
    success(activeRuntime->visualService.AsObjectClosureNoAddRef().FuncCall(
        0, TJS_W("continuous"), nullptr, nullptr, 1, args, nullptr));
}
void TVPAddContinuousEventHook(tTVPContinuousEventCallbackIntf *callback) {
    TVPBeginContinuousEvent();
    ContinuousHooks.push_back(callback);
}
void TVPRemoveContinuousEventHook(tTVPContinuousEventCallbackIntf *callback) {
    for(auto &entry : ContinuousHooks) if(entry == callback) entry = nullptr;
}
bool TVPHasContinuousEvents() {
    const auto &handlers = activeRuntime->system.continuousHandlers;
    return std::any_of(ContinuousHooks.begin(), ContinuousHooks.end(), [](auto *hook) { return hook != nullptr; }) ||
        std::any_of(handlers.begin(), handlers.end(), [](const auto &handler) { return handler.Object != nullptr; });
}
void TVPAddContinuousHandler(tTJSVariantClosure closure) {
    auto &handlers = activeRuntime->system.continuousHandlers;
    if(std::find(handlers.begin(), handlers.end(), closure) == handlers.end()) {
        if(!std::any_of(handlers.begin(), handlers.end(), [](const auto &handler) { return handler.Object != nullptr; })) {
            activeRuntime->system.lastFrame = -1;
            activeRuntime->system.frameRemainder = 0;
        }
        TVPBeginContinuousEvent();
        closure.AddRef();
        handlers.push_back(closure);
    }
}
void TVPRemoveContinuousHandler(tTJSVariantClosure closure) {
    auto &handlers = activeRuntime->system.continuousHandlers;
    auto found = std::find(handlers.begin(), handlers.end(), closure);
    if(found != handlers.end()) {
        found->Release();
        found->Object = found->ObjThis = nullptr;
    }
}
void TVPDeliverContinuousEvent() {
    auto &state = activeRuntime->system;
    if(state.deliveringContinuous) return;
    struct Guard { bool &flag; Guard(bool &flag) : flag(flag) { flag = true; } ~Guard() { flag = false; } } guard(state.deliveringContinuous);
    const auto tick = TVPGetTickCount();
    bool tombstones = false;
    for(size_t i = 0; i < ContinuousHooks.size(); ++i) {
        if(ContinuousHooks[i]) ContinuousHooks[i]->OnContinuousCallback(tick);
        else tombstones = true;
        if(TVPExclusiveEventPosted) return;
    }
    if(tombstones) std::erase(ContinuousHooks, nullptr);
    auto &handlers = state.continuousHandlers;
    bool empty = false;
    tTJSVariant tickValue(static_cast<tjs_int64>(tick));
    tTJSVariant *args[] = {&tickValue};
    bool deliverHandlers = !TVPEventDisabled && !TVPGetSystemEventDisabledState();
    if(state.limitContinuous60) {
        const double now = emscripten_get_now();
        if(state.lastFrame >= 0) {
            constexpr double interval = 1000.0 / 60;
            state.frameRemainder += now - state.lastFrame;
            const auto frames = static_cast<int>((state.frameRemainder + 1e-6) / interval);
            deliverHandlers &= frames > 0;
            state.frameRemainder = std::max(0.0, state.frameRemainder - frames * interval);
        }
        state.lastFrame = now;
    }
    for(size_t i = 0; i < handlers.size(); ++i) {
        if(handlers[i].Object) {
            if(!deliverHandlers) continue;
            tjs_error error;
            try { error = handlers[i].FuncCall(0, nullptr, nullptr, nullptr, 1, args, nullptr); }
            catch(...) { handlers[i].Release(); handlers[i].Object = handlers[i].ObjThis = nullptr; throw; }
            if(TJS_FAILED(error)) {
                handlers[i].Release(); handlers[i].Object = handlers[i].ObjThis = nullptr;
                empty = true;
            }
            if(TVPExclusiveEventPosted) return;
        } else empty = true;
    }
    if(empty) std::erase_if(handlers, [](const auto &handler) { return handler.Object == nullptr; });
    if(ContinuousHooks.empty() && handlers.empty()) TVPEndContinuousEvent();
}
void TVPShutdownVisualEvents() {
    while(!TVPEventQueue.empty()) {
        std::unique_ptr<tTVPEvent> event(TVPEventQueue.back());
        TVPEventQueue.pop_back();
    }
    ContinuousHooks.clear();
    for(auto &handler : activeRuntime->system.continuousHandlers) handler.Release();
    activeRuntime->system.continuousHandlers.clear();
}

iTJSDispatch2 *TVPCreateEventObject(const tjs_char *type,
                                    iTJSDispatch2 *targthis,
                                    iTJSDispatch2 *targ) {
    // create a dictionary object for event dispatching ( to "action"
    // method )
    iTJSDispatch2 *object = TJSCreateDictionaryObject();

    static ttstr type_name(TJS_W("type"));
    static ttstr target_name(TJS_W("target"));

    {
        tTJSVariant val(type);
        if(TJS_FAILED(object->PropSet(TJS_MEMBERENSURE | TJS_IGNOREPROP,
                                      type_name.c_str(), type_name.GetHint(),
                                      &val, object)))
            TVPThrowInternalError;
    }

    {
        tTJSVariant val(targthis, targ);
        if(TJS_FAILED(object->PropSet(TJS_MEMBERENSURE | TJS_IGNOREPROP,
                                      target_name.c_str(),
                                      target_name.GetHint(), &val, object)))
            TVPThrowInternalError;
    }

    return object;
}
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------
ttstr TVPActionName(TJS_W("action"));
//---------------------------------------------------------------------------

//---------------------------------------------------------------------------
