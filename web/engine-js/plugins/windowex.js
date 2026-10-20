import { aboutString } from './getabout.js';
import { disposeScriptValue } from '#krkr/native';

// windowEx.cpp: the Win32 monitor, cursor, metrics and window-message layer.
// Only the System-level entry points are supplied here. Kirikiroid2 itself
// implements them as platform stubs (windowEx.cpp 1421-1526): scripts test
// `typeof System.getMonitorInfo` and fall back when a call leaves the result
// void, which is exactly what the reference build does on a platform without
// Win32. The Window/MenuItem/Pad extensions need native window messages and stay
// unimplemented.
export function registerWindowEx({ get, registerMembers, readScript }) {
  const System = get('System');
  registerMembers(System, {
    // System::getDoubleClickTime returns -1 (no Win32 double-click time).
    getDoubleClickTime: () => -1,
    getDisplayMonitors() {},
    getMonitorInfo() {},
    getCursorPos() {},
    setCursorPos(left, top) {
      if (arguments.length < 2) throw new Error('TJS System.setCursorPos requires 2 arguments');
    },
    async getSystemMetrics(name) {
      if (!arguments.length) throw new Error('TJS System.getSystemMetrics requires a name');
      if (typeof name !== 'string' || !name) throw new Error('TJS invalid parameter');
      // windowEx.cpp reads the game's System.metrics dictionary; an unknown key
      // is TJS_E_INVALIDPARAM, and a known key still leaves the result void.
      const key = name.toUpperCase();
      let metrics, value;
      try {
        metrics = await readScript(System, 'metrics', { optional: true });
        value = metrics === undefined ? undefined : await readScript(metrics, key, { optional: true });
        if (!(Number(value) >= 0)) throw new Error('TJS invalid parameter');
      } finally {
        try { await disposeScriptValue(value); }
        finally { await disposeScriptValue(metrics); }
      }
    },
    readEnvValue(name) {
      if (!arguments.length) throw new Error('TJS System.readEnvValue requires a name');
      if (typeof name !== 'string' || !name) throw new Error('TJS invalid parameter');
    },
    expandEnvString(value) {
      if (!arguments.length) throw new Error('TJS System.expandEnvString requires a value');
    },
    setApplicationIcon() {},
    // System::setIconicPreview answers true.
    setIconicPreview() { return 1; },
    getAboutString: () => aboutString(System),
    // TVPGetCPUType returns a feature bitmask; the browser uses no native CPU
    // feature paths, so no bits are reported.
    getCPUType: () => 0,
    // TVPBreathe pumps the platform message queue; the browser delivers events
    // through its own event loop, so there is nothing to pump.
    breathe() {},
    isBreathing: () => 0,
  });
}
