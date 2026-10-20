import { scriptBinding } from '#krkr/native';

// Script values are opaque handles. Context construction and queries run in TJS2.
export const SHADOW = Symbol('TJS shadow');
// Public value kinds returned by the WASM API, not JS typeof categories.
export const TJSValueType = Object.freeze({
  VOID: 0, OBJECT: 1, STRING: 2, OCTET: 3, INTEGER: 4, REAL: 5,
});
// Primitive conversions use TJS2's stateless Variant operations.
let primitiveRuntime;
export function setPrimitiveRuntime(vm) { primitiveRuntime = vm; }
export function clearPrimitiveRuntime(vm) {
  if (primitiveRuntime === vm) primitiveRuntime = undefined;
}
export class Closure {
  static [Symbol.hasInstance](value) { return !!value?.[SHADOW]; }
  constructor(object, context) {
    const vm = scriptBinding(context)?.vm ?? scriptBinding(object)?.vm;
    if (!vm) throw new Error('TJS context binding requires an attached runtime');
    return vm.bindContext(object, context);
  }
}
export const unwrap = value => value;
export const membersOf = value => {
  const object = unwrap(value);
  return object instanceof Map ? object : object.members;
};
const convert = (value, kind) => {
  const vm = scriptBinding(value)?.vm ?? primitiveRuntime;
  if (!vm) throw new Error('TJS value conversion requires an attached runtime');
  return vm.withReference(value, id => vm.decode(vm.module._tjs_value_convert(vm.runtime, id, kind)));
};
export const string = value => typeof value === 'string' ? value : convert(value, 3);
// Numeric primitives can be consumed directly by JS platform interfaces.
// String/object conversion uses the original tTJSVariant implementation.
export const number = value => value === undefined ? 0 : typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean' ? Number(value) : convert(value, 0);
export const integer = value => typeof value === 'bigint' ? value : typeof value === 'number' || typeof value === 'boolean' || value === undefined ? BigInt(Math.trunc(number(value))) : BigInt(convert(value, 1));
export const truth = value => value instanceof Closure || typeof value === 'string' ? !!convert(value, 2) : !!value;
