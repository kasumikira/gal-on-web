// Browser wakeups only. Native TimerScheduler owns timer state and script events.
export async function createTimerScheduler({ vm, enqueueEvent, isIdle, reportError, laxTimer = false }) {
  const scheduler = await vm.get(vm.global.Timer, '_scheduler');
  let timerId = null, stopped = false, queued = false;
  const clear = () => {
    if (timerId !== null) clearTimeout(timerId);
    timerId = null;
  };
  const service = {
    isIdle,
    schedule(delay) {
      clear();
      if (stopped || delay < 0) return;
      timerId = setTimeout(() => {
        timerId = null;
        if (stopped || queued) return;
        queued = true;
        enqueueEvent(async () => {
          if (stopped) return;
          const result = await vm.callMember(scheduler, 'dispatch', scheduler, [isIdle()]);
          await vm.dispose(result);
        }).catch(reportError).finally(() => { queued = false; });
      }, delay);
    },
  };
  try {
    await vm.dispose(await vm.callMember(scheduler, 'configure', scheduler, [service, laxTimer]));
  } catch (error) {
    stopped = true;
    clear();
    await vm.dispose(scheduler);
    throw error;
  }
  return {
    stop() { stopped = true; clear(); },
    async finalize() {
      await vm.dispose(await vm.callMember(scheduler, 'configure', scheduler, [undefined]));
      await vm.dispose(scheduler);
    },
  };
}
