// Debug class from cpp/core/utils/DebugIntf.cpp. The browser console replaces
// the log file, and logging handlers are TJS closures held by the engine.
import { defineNativeClass, NativeProperty, reportUnimplemented } from '#krkr/native';
import { string, truth } from '#krkr/values';
const maxLines = 1000;
export function createDebugClass(write) {
  // DebugImpl.cpp exposes singleton class objects; its port disables both
  // native debug windows. Visibility always reads false, even after a write.
  const debugWindow = name => {
    // DebugImpl.cpp exposes singleton class objects with a runtime-only name.
    const klass = defineNativeClass(name, { members: { [name]() {} } });
    const visible = new NativeProperty(() => 0, (_owner, value) => { truth(value); });
    visible.static = true;
    klass.members.set('visible', visible);
    return klass;
  };
  const consoleClass = debugWindow('Console');
  const controllerClass = debugWindow('Controller');
  const lines = [];
  const handlers = [];
  const append = (text, important) => {
    if (lines.length >= maxLines) lines.splice(0, lines.length - maxLines + 1);
    lines.push(important ? `${new Date().toLocaleTimeString()} ! ${text}` : text);
    for (const handler of Array.from(handlers)) handler(text);
    write(important,text);
  };
  const format = values => {
    if (!values.length) throw new Error('TJS Debug method requires arguments');
    return values.map(string).join(', ');
  };
  return {
    get console() { return consoleClass; },
    get controller() { return controllerClass; },
    message(...values) { append(format(values),false); },
    notice(...values) { append(format(values),true); },
    startLogToFile() { reportUnimplemented('Debug.startLogToFile: 浏览器日志文件输出未实现'); },
    logAsError() { reportUnimplemented('Debug.logAsError'); },
    addLoggingHandler(handler) {
      if (!arguments.length) throw new Error('TJS Debug.addLoggingHandler requires a handler');
      handlers.push(handler);
    },
    removeLoggingHandler(handler) {
      if (!arguments.length) throw new Error('TJS Debug.removeLoggingHandler requires a handler');
      const index = handlers.indexOf(handler);
      if (index >= 0) handlers.splice(index,1);
    },
    getLastLog(count = maxLines + 100) { return lines.slice(Math.max(0,lines.length - Math.trunc(Number(count)))).join('\n'); },
    get logLocation() { return '/'; },
    set logLocation(value) { String(value); },
    get logToFileOnError() { return 0; },
    set logToFileOnError(value) { Boolean(value); },
    get clearLogFileOnError() { return 0; },
    set clearLogFileOnError(value) { Boolean(value); },
  };
}
