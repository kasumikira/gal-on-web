import { config } from '../global.js';
// Native class/instance attachment corresponding to tjsNative.cpp.
// Decorators register JS business classes. Shadows carry opaque handles only;
// all script identity, context, native-state and lifetime queries use WASM APIs.
import { nativeAPI } from '#krkr/native-api';
import { Closure, SHADOW, unwrap } from '#krkr/values';

const reported = new Set();
// A host-created native instance is materialized as a real TJS object by the
// bridge. The descriptor carries its JS state, without emulating script fields.
export class NativeInstance {
  constructor(nativeClass, state) { this.nativeClass = nativeClass; this.state = state; }
}
export function createNativeInstance(nativeClass, state, owner) {
  const instance = new NativeInstance(nativeClass, state);
  nativeClass.instances.set(instance, state);
  return owner === undefined ? instance : bindingOf(owner).vm.retain(instance, owner);
}
export function reportUnimplemented(name) {
  if (reported.has(name)) return;
  reported.add(name);
  console.warn(`[未实现] ${name}`);
}
export function unimplemented(name, source) {
  return function() {
    const detail = `${name}${source ? ` (${source})` : ''}`;
    reportUnimplemented(detail);
    if (config.unimplementedMode === 'error') throw new Error(`[未实现] ${detail}`);
    return undefined;
  };
}
export class NativeProperty {
  constructor(getter, setter) { this.getter = getter; this.setter = setter; }
}
export const createNativeProperty = (getter, setter) =>
  new NativeProperty(getter, setter);
export const readNativeProperty = (member, owner) => {
  if (!member.getter) throw new Error('TJS property read access denied');
  return member.getter(owner);
};
export const writeNativeProperty = (member, owner, value) => {
  if (!member.setter) throw new Error('TJS property write access denied');
  return member.setter(owner, value);
};
export const isNativeProperty = member => member instanceof NativeProperty;

// ---------------------------------------------------------------------------
// Decorator metadata
// ---------------------------------------------------------------------------
// Decorators tag the member function itself, so the scanner can recognize
// annotated members from the class prototype without a side registry.
const kNativeClass = Symbol('galweb.nativeClass');
const kNativeMember = Symbol('galweb.nativeMember');
const scanned = new WeakSet();
const classes = new WeakMap();
const bindings = new WeakMap();
const readOnlyValues = new WeakMap();

// Packed native values expose their data lazily, independently of JS members.
export function bindReadOnlyValue(value, descriptor) {
  readOnlyValues.set(value, descriptor);
}

// A shadow or native JS state carries only its API endpoint and opaque handle.
export const scriptBinding = value => bindings.get(value);
export const nativeReference = value => {
  const binding = bindings.get(value);
  return binding && !value?.[SHADOW] ? binding.vm.owner(value) : value;
};
export const nativeOwner = value => {
  const binding = bindings.get(value);
  return binding ? binding.vm.owner(value) : value;
};

export function bindScriptReference(reference, info) {
  bindings.set(reference, info);
}
function bindingOf(value) {
  const binding = bindings.get(value);
  if (!binding) throw new Error('Object is not attached to a TJS runtime');
  return binding;
}

// Decoded references already provide script access; no second proxy is needed.
export const script = nativeReference;
const toScript = script;

export function retainScriptValue(value, owner) {
  const binding = bindings.get(value);
  return binding ? binding.vm.retain(value, owner) : value;
}

export function disposeScriptValue(value) {
  const binding = bindings.get(value);
  return binding ? binding.vm.dispose(value) : undefined;
}

export function invalidateScriptValue(value) {
  return bindingOf(value).vm.invalidate(nativeReference(value));
}

export function windowObjects(window, value, operation) {
  return bindingOf(window).vm.windowObjects(nativeReference(window), value, operation);
}

// Layer scalar storage lives in native. Node accessors and TJS properties use
// the same fields; this is not a cache of script properties or ownership.
export const LAYER_FIELDS = ['left', 'top', 'imageLeft', 'imageTop', 'opacity', 'visible'];
export function registerLayerFields(klass) {
  for (const [field, name] of LAYER_FIELDS.entries()) klass.members.get(name).layerField = field;
}
export function attachLayerFields(owner, node) {
  return bindingOf(owner).vm.attachLayerFields(owner, node);
}

export function writeScript(object, name, value) {
  return bindingOf(object).vm.set(nativeReference(object), name, value);
}

export async function readScript(object, name, { ignoreProperty = false, optional = false } = {}) {
  try {
    return toScript(await bindingOf(object).vm.get(nativeReference(object), name, ignoreProperty));
  } catch (error) {
    if (optional && error.message === `TJS member not found: ${name}`) return undefined;
    throw error;
  }
}

export function readScriptTyped(object, name, { ignoreProperty = false } = {}) {
  return bindingOf(object).vm.getTyped(nativeReference(object), name, ignoreProperty);
}

export function callScript(object, name, args = [], { receiver = object, ignoreMissing = false } = {}) {
  return bindingOf(object).vm.callMember(nativeReference(object), name, nativeReference(receiver), args, ignoreMissing);
}

export function evalScript(expression, context, name = '(eval)') {
  return bindingOf(context).vm.source(
    expression, name, 0, nativeReference(context), true,
  );
}

export function constructNative(context, klass, ...args) {
  return bindingOf(context).vm.call(klass, undefined, args, true);
}

export function nativeDictionary(context, entries = []) {
  return bindingOf(context).vm.collection(2, entries);
}

export function nativeArray(context, values = []) {
  return bindingOf(context).vm.collection(1, Array.from(values).entries());
}

export function nativeOwnedArray(owner, values = []) {
  return bindingOf(owner).vm.collection(1, Array.from(values).entries(), owner);
}

export function nativeGlobals(context) {
  return bindingOf(context).vm.global;
}

// Native business methods operate on ordinary JS state, not another shadow.
function attachNativeState(klass, owner, state, vm, handle) {
  const info = { vm, id: scriptBinding(owner).id };
  bindings.set(state, info);
  handle ??= vm.storeHost(state);
  if (vm.nativeState(klass, owner, handle) < 1) throw new Error(`TJS ${klass.nativeName} native instance not found`);
  klass.attachState?.(state);
  for (const [name, member] of klass.members) {
    if (name in state && !member?.[kNativeMember]?.virtual) continue;
    if (typeof member === 'function' && !isNativeClass(member)) {
      Object.defineProperty(state, name, {
        configurable: true, writable: true,
        value: member[kNativeMember]?.virtual
          ? (...args) => callScript(owner, name, args)
          : member,
      });
    }
  }
  return handle;
}

export const isNativeClass = value =>
  typeof value === 'function' && value[kNativeClass] === true;

function markMember(value, kind, name, virtual = value?.[kNativeMember]?.virtual ?? false) {
  if (typeof value !== 'function') throw new Error(`原生成员 ${String(name)} 必须是函数`);
  Object.defineProperty(value, kNativeMember, { value: { kind, name: String(name), virtual }, configurable: true });
  return value;
}

// @nativeMethod: exposed as a callable member.
export function nativeMethod(value, context) {
  if (context?.kind !== 'method') {
    throw new Error(`@nativeMethod 只能用于方法（${String(context?.name)}: ${context?.kind}）`);
  }
  return markMember(value, 'method', context.name);
}

// Virtual event hooks preserve TJS overrides when called from native JS code.
export function nativeEvent(value, context) {
  if (context?.kind !== 'method') throw new Error('@nativeEvent requires a method');
  return markMember(value, 'method', context.name, true);
}

// An async-capable native constructor, registered under the TJS class name.
export function nativeConstructor(value, context) {
  if (context?.kind !== 'method') throw new Error('@nativeConstructor requires a method');
  return markMember(value, 'constructor', context.name);
}

// @nativeProperty: exposed as a getter/setter pair.  Apply once to the getter
// and once to the setter; a member with only one side stays one-sided.
export function nativeProperty(value, context) {
  if (context?.kind !== 'getter' && context?.kind !== 'setter') {
    throw new Error(`@nativeProperty 只能用于 getter/setter（${String(context?.name)}: ${context?.kind}）`);
  }
  return markMember(value, context.kind, context.name);
}

// @nativeClass('TJSName'): brands the class as a native class and names it as
// the TJS engine does (the JS class name may differ, e.g. BasicDrawDevice).
export function nativeClass(name) {
  return (klass, context) => {
    if (context?.kind !== 'class') throw new Error('@nativeClass 只能用于类');
    return brandNativeClass(klass, name);
  };
}

// @nativeMembers({...}): batch form of @nativeMethod/@nativeProperty for member
// tables that are assembled dynamically (spread of helper-module methods,
// generated blocks).  Functions are annotated as methods, NativeProperty
// values become getter/setter pairs, everything else stays a linked member
// (constants, linked classes).
export function nativeMembers(members) {
  return (klass, context) => {
    if (context?.kind !== 'class') throw new Error('@nativeMembers 只能用于类');
    prepareClass(klass);
    for (const [name, member] of Object.entries(members)) {
      if (isNativeClass(member)) {
        klass.members.set(name, member);
      } else if (typeof member === 'function') {
        Object.defineProperty(klass.prototype, name, {
          value: markMember(member, 'method', name), writable: true, configurable: true,
        });
      } else if (member instanceof NativeProperty) {
        Object.defineProperty(klass.prototype, name, {
          get: member.getter ? markMember(function() { return member.getter(this); }, 'getter', name) : undefined,
          set: member.setter ? markMember(function(value) { return member.setter(this, value); }, 'setter', name) : undefined,
          configurable: true,
        });
      } else klass.members.set(name, member);
    }
    return klass;
  };
}

export function brandNativeClass(klass, name) {
  Object.defineProperty(klass, kNativeClass, { value: true, configurable: true });
  Object.defineProperty(klass, 'nativeName', {
    value: name ?? klass.name, configurable: true, writable: true,
  });
  prepareClass(klass);
  scanNativeMembers(klass);
  return klass;
}

function prepareClass(klass) {
  if (classes.has(klass)) return;
  // `statics` keeps the static flag for members declared before the class is
  // exported to a VM (plugins usually run afterwards, decorators never carry it).
  const descriptor = { members: new Map(), statics: new Set(), instances: new NativeStates(klass) };
  classes.set(klass, descriptor);
  Object.defineProperties(klass, {
    members: { get: () => descriptor.members, configurable: true },
    instances: { get: () => descriptor.instances, configurable: true },
    state: { value(owner) {
      const state = descriptor.instances.get(owner);
      if (!state) throw new Error(`TJS ${this.nativeName} native instance not found`);
      return state;
    }, configurable: true },
    of: { value(owner) { return this.state(owner); }, configurable: true },
    defineMember: { value(member, value, options = {}) {
      // Plugin attachments must also reach a class already exported to TJS.
      // Explicit class-level entries use the JS class as receiver. Instance
      // attachments still resolve their native state through the VM.
      if (options.static) descriptor.statics.add(member);
      else descriptor.statics.delete(member);
      const vm = descriptor.instances.vm;
      if (vm) {
        const id = vm.encode(klass);
        try { registerNativeMember(klass, member, value, vm, id, !!options.static); }
        finally { vm.releaseHandle(id); }
      }
      descriptor.members.set(member, value);
      return this;
    }, configurable: true },
    defineProperty: { value(member, getter, setter, options = {}) { return this.defineMember(member, new NativeProperty(getter, setter), options); }, configurable: true },
  });
}

function registerNativeMember(klass, name, member, interop, id, forceStatic = false) {
  const property = member instanceof NativeProperty;
  const isStatic = forceStatic || (property ? member.static : typeof member === 'function' && member[kNativeMember]?.static);
  if (isStatic) {
    const value = property ? new NativeProperty(
      member.getter ? () => readNativeProperty(member, klass) : undefined,
      member.setter ? (_, value) => writeNativeProperty(member, klass, value) : undefined,
    ) : member.bind(klass);
    interop.setEncoded(id, name, value, 0x10000 | 0x200 | 0x800);
  } else if (!isNativeClass(member) && (typeof member === 'function' || property)) {
    const callback = interop.storeHost(({ receiver, args, operation }) =>
      property
        ? operation === 2
          ? writeNativeProperty(member, klass.state(receiver), args[0])
          : readNativeProperty(member, klass.state(receiver))
        : member.apply(klass.state(receiver), args),
    );
    interop.withString(name, pointer => interop.decode(
      interop.module._tjs_class_register_member(interop.runtime, id, pointer, callback,
        property && member.layerField !== undefined ? 2 + member.layerField : Number(property)),
    ));
  } else interop.setEncoded(id, name, member);
}

// Programmatic equivalent of @nativeClass for classes whose TJS name is only
// known at runtime (unimplemented stubs, Motion subclasses, ...).
export function defineNativeClass(name, { initialize, members } = {}) {
  class Placeholder {}
  if (initialize) Placeholder.initialize = initialize;
  prepareClass(Placeholder);
  for (const [member, value] of Object.entries(members ?? {})) Placeholder.members.set(member, value);
  return brandNativeClass(Placeholder, name);
}

// Collect the annotated members of `klass` into its member table, then install
// the unimplemented declarations the native engine exposes for that class
// (tNativeAPIs). Mounting is idempotent; later additions through
// `Klass.members.set` (dynamic members, plugin API fallbacks) are preserved.
export function scanNativeMembers(klass) {
  if (!isNativeClass(klass)) return klass?.members;
  if (scanned.has(klass)) return klass.members;
  scanned.add(klass);
  const members = klass.members;
  // Base prototypes first so that derived overrides win.
  const chain = [];
  for (let proto = klass.prototype; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    chain.unshift(proto);
  }
  if (!klass.initialize && !members.has(klass.nativeName)) {
    members.set(klass.nativeName, function(...args) {
      const { vm } = bindingOf(this);
      const owner = nativeOwner(this);
      const state = Reflect.construct(klass, args);
      attachNativeState(klass, owner, state, vm);
    });
  }
  for (const proto of [...chain, klass]) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      const value = descriptor.value;
      if (typeof value === 'function' && value[kNativeMember]?.kind === 'method') {
        value[kNativeMember].static = proto === klass;
        members.set(name, value);
        continue;
      }
      if (typeof value === 'function' && value[kNativeMember]?.kind === 'constructor') {
        members.set(klass.nativeName, value);
        continue;
      }
      const getter = descriptor.get, setter = descriptor.set;
      if (getter?.[kNativeMember]?.kind === 'getter' || setter?.[kNativeMember]?.kind === 'setter') {
        const isStatic = proto === klass;
        const property = new NativeProperty(
          getter ? owner => getter.call(isStatic ? klass : owner) : undefined,
          setter ? (owner, value) => setter.call(isStatic ? klass : owner, value) : undefined,
        );
        property.static = isStatic;
        members.set(name, property);
      }
    }
  }
  if (klass.nativeName) installNativeStubs(klass, klass.nativeName);
  return members;
}

export function installNativeStubs(target, name) {
  if (bindings.get(target)?.id !== undefined) return;
  const native = isNativeClass(target);
  if (native) scanNativeMembers(target);
  const namespace = typeof target === 'function' && target.prototype ? target.prototype : target;
  for (const [member, declaration] of Object.entries(nativeAPI[name] ?? {})) {
    const present = native
      ? target.members.has(member)
      : member in target || member in namespace;
    if (present) continue;
    const missing = unimplemented(`${name}.${member}`, declaration.source);
    const stub = declaration.kind === 'method'
      ? missing
      : new NativeProperty(missing, missing);
    if (native) target.members.set(member, stub);
    else namespace[member] = stub;
  }
}

// Class lookup and enumeration query the original C++ native instance slots.
class NativeStates {
  constructor(klass) { this.klass = klass; }
  get(value) {
    if (value instanceof NativeInstance) return value.nativeClass === this.klass ? value.state : undefined;
    const binding = bindings.get(value);
    return binding ? binding.vm.callbacks.get(binding.vm.nativeState(this.klass, value)) : undefined;
  }
  set(value, state) {
    if (value instanceof NativeInstance) { value.state = state; return this; }
    const { vm } = bindingOf(value);
    attachNativeState(this.klass, nativeOwner(value), state, vm);
    return this;
  }
  has(value) { return this.get(value) !== undefined; }
  values() { return this.vm.nativeStates(this.klass).values(); }
}

export function encodeNativeValue(value, interop) {
  const readOnly = readOnlyValues.get(value);
  if (readOnly) {
    const callback = interop.storeHost(name => readOnly.get(name));
    const keys = interop.encode(readOnly.keys ?? []);
    try {
      const id = interop.module._tjs_readonly_create(interop.runtime, callback, keys, readOnly.length ?? -1);
      if (!id) return interop.fail();
      interop.rememberExport(value, id);
      return id;
    } finally {
      interop.releaseHandle(keys);
    }
  }
  if (value instanceof NativeInstance) {
    const klass = interop.encode(value.nativeClass);
    const stateHandle = interop.storeHost(value.state);
    let id;
    try {
      id = interop.module._tjs_class_instance(interop.runtime, klass, stateHandle);
    } finally {
      interop.releaseHandle(klass);
    }
    if (!id) return interop.fail();
    const owner = interop.callbacks.get(interop.module._tjs_native_owner(interop.runtime, id));
    attachNativeState(value.nativeClass, owner, value.state, interop, stateHandle);
    interop.rememberExport(value, id);
    return id;
  }
  if (isNativeClass(value)) {
    value.instances.vm = interop;
    const members = scanNativeMembers(value);
    const initialize = interop.storeHost(async ({ receiver, operation }) => {
      const owner = nativeOwner(receiver);
      if (operation === 4) {
        if (value.invalidate) await value.invalidate(owner);
        return;
      }
      const constructor = members.get(value.nativeName);
      const state = value.initialize
        ? await value.initialize(owner, interop)
        : constructor?.[kNativeMember]?.kind === 'constructor'
          ? Reflect.construct(value, [])
          : Object.create(value.prototype);
      attachNativeState(value, owner, state, interop);
    });
    const id = interop.withString(value.nativeName ?? value.name, name =>
      interop.module._tjs_class_create(interop.runtime, name, initialize));
    if (!id) return interop.fail();
    interop.rememberExport(value, id);
    for (const [memberName, member] of members) {
      registerNativeMember(value, memberName, member, interop, id, classes.get(value)?.statics.has(memberName) ?? false);
    }
    return id;
  }
  if (value instanceof NativeProperty) {
    const callback = interop.storeHost(
      ({ receiver, args, operation }) =>
        operation === 2
          ? writeNativeProperty(value, unwrap(receiver), args[0])
          : readNativeProperty(value, unwrap(receiver)),
    );
    const id = interop.module._tjs_callback_create(interop.runtime, callback, 1);
    interop.rememberExport(value, id);
    return id;
  }
  return undefined;
}
