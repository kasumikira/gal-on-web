// tTJSNC_Timer from cpp/core/utils/TimerIntf.cpp. Timers fire the "onTimer"
// action through the action owner closure (TVP_ACTION_INVOKE).
import { nativeClass, nativeMethod, nativeEvent, nativeProperty, nativeDictionary, nativeOwner, script, retainScriptValue, disposeScriptValue } from '#krkr/native';
import { truth, number } from '#krkr/values';

async function action(state, owner, type) {
  if (state.actionOwner == null) return;
  const event = nativeDictionary(owner, [['type', type], ['target', owner]]);
  try {
    const result = state.actionName
      ? await script(state.actionOwner)[state.actionName](event)
      : await script(state.actionOwner)(event);
    await disposeScriptValue(result);
  } finally { await disposeScriptValue(event); }
}

export function createTimerClass({ invokeAction }) {
  let scheduling = true;
  const state = owner => Timer.state(owner);

  @nativeClass('Timer')
  class Timer {
    static initialize() {
      return {
        interval: 1000, enabled: false, capacity: 6, mode: 0,
        actionName: 'action', actionOwner: null, timerId: null, pending: new Set(),
      };
    }

    @nativeMethod Timer(actionOwner, actionName = 'action') {
      if (!arguments.length) throw new Error('TJS Timer requires an action owner');
      this.actionOwner = retainScriptValue(actionOwner, this);
      this.actionName = actionName;
    }
    @nativeEvent onTimer() { return action(this, this, 'onTimer'); }

    @nativeProperty get interval() { return this.interval; }
    @nativeProperty set interval(value) {
      const s = this;
      s.interval = Math.trunc(number(value));
      if (s.enabled) { stopTimer(s); startTimer(s, this); }
    }
    @nativeProperty get enabled() { return Number(this.enabled); }
    @nativeProperty set enabled(value) {
      const s = this;
      const on = !!truth(value);
      if (on === s.enabled) return;
      s.enabled = on;
      if (on) startTimer(s, this); else stopTimer(s);
    }
    @nativeProperty get capacity() { return this.capacity; }
    @nativeProperty set capacity(value) { this.capacity = Math.max(0, Math.trunc(number(value))); }
    @nativeProperty get mode() { return this.mode; }
    @nativeProperty set mode(value) { this.mode = Math.trunc(number(value)); }
    @nativeProperty get actionName() { return this.actionName; }
    @nativeProperty set actionName(value) { this.actionName = String(value ?? ''); }
  }

  function startTimer(s, owner) {
    stopTimer(s);
    if (!scheduling) return;
    owner = nativeOwner(owner);
    const generation = s.generation;
    s.timerId = setInterval(async () => {
      if (!s.enabled) { stopTimer(s); return; }
      // TimerIntf.cpp Fire bounds queued onTimer events per timer.
      if (s.pending.size >= (s.capacity === 0 ? 65535 : s.capacity)) return;
      const token = {};
      s.pending.add(token);
      try {
        await invokeAction(owner, 'onTimer', [], undefined, () => s.pending.delete(token) && s.enabled && s.generation === generation);
      } catch (e) { stopTimer(s); console.error(e); }
      finally { s.pending.delete(token); }
    }, Math.max(1, s.interval));
  }
  function stopTimer(s) {
    s.generation = (s.generation ?? 0) + 1;
    s.pending.clear();
    if (s.timerId !== null) { clearInterval(s.timerId); s.timerId = null; }
  }
  Timer.invalidate = async owner => {
    const s = state(owner);
    stopTimer(s);
    s.enabled = false;
    if (s.actionOwner) await disposeScriptValue(s.actionOwner);
    s.actionOwner = null;
  };
  Timer.stop = () => {
    scheduling = false;
    if (!Timer.instances.vm) return;
    for (const s of Timer.instances.values()) stopTimer(s);
  };
  return Timer;
}

// tTJSNC_AsyncTrigger from cpp/core/base/EventIntf.cpp: posts an "onFire"
// event asynchronously (atmNormal/atmExclusive/atmAtIdle modes).
export function createAsyncTriggerClass({ invokeAction }) {
  @nativeClass('AsyncTrigger')
  class AsyncTrigger {
    static initialize() {
      return { cached: true, mode: 0, actionOwner: null, actionName: 'action', pending: new Set() };
    }

    @nativeMethod AsyncTrigger(actionOwner, actionName = 'action') {
      if (!arguments.length) throw new Error('TJS AsyncTrigger requires an action owner');
      this.actionOwner = retainScriptValue(actionOwner, this);
      this.actionName = actionName;
    }
    @nativeMethod trigger() {
      const s = this;
      const owner = nativeOwner(this);
      if (s.cached) s.pending.clear();
      const token = {};
      s.pending.add(token);
      invokeAction(owner, 'onFire', [], undefined, () => s.pending.delete(token)).catch(error => console.error(error));
    }
    @nativeMethod cancel() {
      const s = this;
      s.pending.clear();
    }
    @nativeEvent onFire() { return action(this, this, 'onFire'); }

    @nativeProperty get cached() { return Number(this.cached); }
    @nativeProperty set cached(value) {
      const s = this;
      const v = !!truth(value);
      if (s.cached !== v) { s.cached = v; s.pending.clear(); }
    }
    @nativeProperty get mode() { return this.mode; }
    @nativeProperty set mode(value) {
      const s = this;
      const m = Math.trunc(number(value));
      if (s.mode !== m) { s.mode = m; s.pending.clear(); }
    }
  }
  AsyncTrigger.invalidate = async owner => {
    const s = AsyncTrigger.state(owner);
    s.pending.clear();
    if (s.actionOwner) await disposeScriptValue(s.actionOwner);
    s.actionOwner = null;
  };
  return AsyncTrigger;
}
