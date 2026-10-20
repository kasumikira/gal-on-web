import { nativeClass, nativeMethod, disposeScriptValue } from '#krkr/native';
import { truth } from '#krkr/values';

// win32dialog.cpp (Kirikiroid2): the plugin installs exactly one TJS class whose
// messageBox forwards to System.inform and negates its void result. The Windows
// distribution ships a much larger WIN32DialogEX; games that rely on it include
// their own win32dialog.tjs after linking (k2compat deletes the global class
// first), so only the reference surface is provided here.
export function registerWin32Dialog({ get, registerGlobal, callScript }) {
  const System = get('System');
  @nativeClass('WIN32Dialog')
  class WIN32Dialog {
    @nativeMethod async messageBox(message, caption, type) {
      const result = await callScript(System, 'inform', [message, caption, 2]);
      try { return !truth(result); }
      finally { await disposeScriptValue(result); }
    }
  }
  registerGlobal('WIN32Dialog', WIN32Dialog);
}
