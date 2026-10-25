import { createTJS2Storage } from './storage.js';
import { TJSRuntime } from "./tjs-runtime/runtime.js";
import { Closure, SHADOW, TJSValueType, unwrap, setPrimitiveRuntime, clearPrimitiveRuntime } from "#krkr/values";
import {
  createNativeProperty,
  encodeNativeValue,
  isNativeClass,
  isNativeProperty,
  bindScriptReference,
  scriptBinding,
} from "#krkr/native";

// Classes the interpreter owns; host globals must not shadow them.
const INTERPRETER_CLASSES = [
  "Array",
  "Dictionary",
  "Exception",
  "RegExp",
  "Math",
  "Date",
  "KAGParser",
  "Scripts",
  "Rect",
  "Pad",
  "MenuItem",
  "Timer",
  "AsyncTrigger",
  "Storages",
];
const TJS_MEMBER_ENSURE_IGNORE_PROPERTY = 0x0a00;
const TJS_HIDDEN_MEMBER = 0x1000;

// Synchronous member access reads raw stored variants only. Script getters and
// calls always enter the asynchronous get/set/call path and can suspend in JSPI.
class Members extends Map {
  constructor(vm, owner) {
    super();
    this.vm = vm;
    this.owner = owner;
  }
  get(name) {
    return this.vm.rawGet(this.owner, String(name));
  }
  set(name, value, flags) {
    this.vm.rawSet(this.owner, String(name), value, flags);
    return this;
  }
  has(name) {
    return this.keysArray().includes(String(name));
  }
  keysArray() {
    return this.vm.keys(this.owner);
  }
  *keys() {
    yield* this.keysArray();
  }
  *entries() {
    for (const name of this.keys()) yield [name, this.get(name)];
  }
  *values() {
    for (const name of this.keys()) yield this.get(name);
  }
  delete(name) {
    return this.vm.deleteMember(this.owner, String(name));
  }
  clear() {
    for (const name of this.keys()) this.delete(name);
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  get size() {
    return this.keysArray().length;
  }
}

export class TJSInterop {
  constructor(wasmURL) {
    this.host = new TJSRuntime(wasmURL);
  }
  get module() {
    return this.host.module;
  }
  get runtime() {
    return this.host.runtime;
  }
  get callbacks() {
    return this.host.callbacks;
  }
  async init(global) {
    await this.host.init({
      onError: (message) => this.setRuntimeError(message),
      onReadOnly: (callback, name) => this.encodeResult(this.callbacks.get(callback)(name)),
      onDispatch: (callback, operation, receiver, args) => {
        const fn = this.callbacks.get(callback);
        if (!fn) throw new Error(`Expired JS host callback: ${callback}`);
        const result = fn({ operation, receiver: this.decode(receiver), args: args.map(id => this.decode(id)) });
        return result && typeof result.then === "function"
          ? result.then(value => this.encodeResult(value)) : this.encodeResult(result);
      },
    });
    this.global = global;
    this.module.hostRelease = (_, handle) => this.releaseHost(handle);
    this.module.hostRetain = (_, handle) => this.retainHost(handle);
    this.module.hostOwner = id => this.storeHost(this.decode(id));
    setPrimitiveRuntime(this);
    const root = this.module._tjs_runtime_global(this.runtime);
    try {
      for (const name of INTERPRETER_CLASSES) {
        const value = this.withString(name, p =>
          this.decode(this.module._tjs_object_get_raw(this.runtime, root, p)),
        );
        try { global[name] = await this.pin(value); }
        finally { await this.dispose(value); }
      }
      const random = this.rawGet(global.Math, "RandomGenerator");
      try { this.registerGlobal("RandomGenerator", await this.pin(random)); }
      finally { await this.dispose(random); }
    } finally {
      this.releaseHandle(root);
    }
    return this;
  }
  string(s) {
    return this.host.string(s);
  }
  // Runs `fn` with a WASM heap pointer and frees it once the result settles, so
  // async native calls keep their buffer alive until they complete.
  withPointer(pointer, fn) {
    let result;
    try {
      result = fn(pointer);
    } catch (error) {
      this.module._free(pointer);
      throw error;
    }
    if (result && typeof result.then === "function")
      return Promise.resolve(result).finally(() => this.module._free(pointer));
    this.module._free(pointer);
    return result;
  }
  withString(text, fn) {
    return this.withPointer(this.string(text), fn);
  }
  withBuffer(bytes, fn) {
    const pointer = this.module._malloc(bytes.length);
    this.module.HEAPU8.set(bytes, pointer);
    return this.withPointer(pointer, fn);
  }
  encodePrimitive(value) {
    const m = this.module;
    const r = this.runtime;
    if (value === undefined) return m._tjs_value_void(r);
    if (value === null) return m._tjs_value_null(r);
    if (value instanceof Uint8Array)
      return this.withBuffer(value, (pointer) =>
        m._tjs_value_octet(r, pointer, value.length),
      );
    if (typeof value === "boolean") value = Number(value);
    if (typeof value === "number" && !Number.isInteger(value))
      return m._tjs_value_real(r, value);
    if (!["string", "number", "bigint"].includes(typeof value))
      throw Error("Host values must be primitives, Octets or retained TJS references");
    return this.withString(String(value), (pointer) =>
      typeof value === "string"
        ? m._tjs_value_string(r, pointer)
        : m._tjs_value_integer(r, pointer),
    );
  }
  decodePrimitive(id) {
    // Single error convention: a failing WASM export returns 0 and the
    // message is stored in the runtime error slot (checked() / tjs_error_set).
    if (!id) this.fail();
    const m = this.module, r = this.runtime;
    let value;
    switch (m._tjs_value_type(r, id)) {
      case 0: value = undefined; break;
      case 1: value = null; break;
      case 2: value = m.UTF16ToString(m._tjs_value_as_string(r, id)); break;
      case 3: {
        const p = m._tjs_value_octet_data(r, id);
        value = m.HEAPU8.slice(p, p + m._tjs_value_octet_size(r, id));
        break;
      }
      case 4: {
        const n = BigInt(m.UTF16ToString(m._tjs_value_as_string(r, id)));
        value = n <= BigInt(Number.MAX_SAFE_INTEGER) && n >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(n) : n;
        break;
      }
      case 5: value = m._tjs_value_as_real(r, id); break;
    }
    this.releaseHandle(id);
    return value;
  }
  // JS-originated failures (host callbacks) land in the same error slot:
  // the C++ glue calls hostError -> tjs_error_set, then returns 0.
  setRuntimeError(message) {
    const pointer = this.string(String(message));
    try { this.module._tjs_error_set(this.runtime, pointer); }
    finally { this.module._free(pointer); }
  }
  fail() {
    const message = this.module.UTF16ToString(
      this.module._tjs_runtime_error(this.runtime),
    );
    const diagnostic = this.module.UTF16ToString(
      this.module._tjs_runtime_diagnostic(this.runtime),
    );
    const error = Error(message);
    error.vmDiagnostic = diagnostic;
    console.error(
      "[TJS/WASM error]",
      diagnostic ? `${message}\n${diagnostic}` : message,
    );
    throw error;
  }
  async bytecode(bytes, name = "bytecode", context) {
    const n = this.string(name);
    const id = context ? this.encode(context) : 0;
    try {
      return await this.withBuffer(bytes, async (p) =>
        this.decode(
          await this.module._tjs_execute_bytecode(
            this.runtime, p, bytes.length, n, id,
          ),
        ),
      );
    } finally {
      this.module._free(n);
      if (id) this.releaseHandle(id);
    }
  }
  enqueue(job) {
    return this.host.enqueue(job);
  }
  withReference(value, fn) {
    const id = this.encode(value);
    try {
      return fn(id);
    } finally {
      this.releaseHandle(id);
    }
  }
  async withAsyncReference(value, fn) {
    const id = this.encode(value);
    try {
      return await fn(id);
    } finally {
      await this.releaseHandleAsync(id);
    }
  }
  async withBorrow(value, fn) {
    const id = this.withReference(value, ref => this.module._tjs_value_borrow(this.runtime, ref));
    if (!id) this.fail();
    try {
      const result = fn(this.decode(id));
      if (result && typeof result.then === "function")
        throw new TypeError("withBorrow callback must return synchronously; retain values used after await");
      return result;
    } finally {
      if (!await this.module._tjs_borrow_end(this.runtime, id)) this.fail();
    }
  }
  retain(value, owner) {
    return this.withReference(value, id => {
      const retained = owner == null
        ? this.module._tjs_value_retain(this.runtime, id)
        : this.withReference(owner, ownerId =>
            this.module._tjs_value_retain_for_owner(this.runtime, id, ownerId));
      return this.decode(retained);
    });
  }
  releaseHandle(id) {
    if (!this.module._tjs_value_release(this.runtime, id)) this.fail();
  }
  async releaseHandleAsync(id) {
    if (!await this.module._tjs_value_release_async(this.runtime, id)) this.fail();
  }
  bindOwnerHandle(id, owner) {
    return this.withReference(owner, ownerId => {
      if (!this.module._tjs_value_bind_owner(this.runtime, id, ownerId)) this.fail();
    });
  }
  async dispose(value) {
    if (arguments.length === 0) {
      try {
        if (!await this.host.dispose()) this.fail();
      } finally {
        // Script finalization may fail on TJS reference cycles. The stopped
        // VM's linear memory must still be collectible as a whole by V8.
        clearPrimitiveRuntime(this);
        this.callbacks.clear();
        this.host.runtime = 0;
        this.host.module = null;
      }
      return;
    }
    const binding = scriptBinding(value);
    if (binding) await this.releaseHandleAsync(binding.id);
  }
  windowObjects(window, value, operation) {
    return this.withAsyncReference(window, windowId =>
      this.withAsyncReference(value, async valueId => {
        if (!await this.module._tjs_window_objects(this.runtime, windowId, valueId, operation)) this.fail();
      }));
  }
  pin(value) {
    return this.withReference(value, id => this.decode(this.module._tjs_value_pin(this.runtime, id)));
  }
  isInstanceOf(value, name) {
    return this.withReference(value, (id) =>
      this.withString(name, (p) =>
        !!this.module._tjs_object_is_instance_of(this.runtime, id, p),
      ),
    );
  }
  owner(value) {
    const binding = scriptBinding(value);
    const host = this.module._tjs_native_owner(this.runtime, binding.id);
    if (!host) this.fail();
    return host > 0 ? this.callbacks.get(host) : value;
  }
  bindContext(value, context) {
    return this.withReference(value, id => context == null
      ? this.decode(this.module._tjs_value_bind(this.runtime, id, 0))
      : this.withReference(context, receiver => this.decode(this.module._tjs_value_bind(this.runtime, id, receiver))));
  }
  context(value) {
    return this.withReference(value, id => this.decode(this.module._tjs_value_context(this.runtime, id)));
  }
  isNullContext(value) {
    return this.withReference(value, id => this.decodeBoolean(this.module._tjs_value_is_null_context(this.runtime, id)));
  }
  sameReference(left, right, context = true) {
    return this.withReference(left, a => this.withReference(right, b =>
      this.decodeBoolean(this.module._tjs_value_equal(this.runtime, a, b, Number(context)))));
  }
  isValid(value) {
    const binding = scriptBinding(value);
    const result = this.module._tjs_object_is_valid(this.runtime, binding.id);
    return this.decodeBoolean(result);
  }
  decodeBoolean(result) {
    if (!result) this.fail();
    return result === 2;
  }
  decode(id) {
    if (!id || this.module._tjs_value_type(this.runtime, id) !== 1 ||
        !this.module._tjs_value_is_object(this.runtime, id))
      return this.decodePrimitive(id);
    const info = { vm: this, id };
    const vm = this;
    const isType = name => this.withString(name, p => this.module._tjs_object_is_instance_of(this.runtime, id, p));
    const callable = isType("Function");
    const target = isType("Array") ? [] : isType("Dictionary") ? new Map() : callable ? function() {} : {};
    const members = new Members(this, null);
    const shadow = new Proxy(target, {
      apply(_target, receiver, args) { return vm.call(shadow, receiver, args); },
      get(target, name, receiver) {
        if (name === SHADOW) return true;
        if (name === "then") return undefined;
        if (name === "object") return shadow;
        if (name === "thisObject") return vm.context(shadow);
        if (name === "invalid") return !vm.isValid(shadow);
        if (name === "members") return members;
        if (name === "classNames") return new Set(vm.classNames(shadow));
        if (name === Symbol.iterator && target instanceof Map) return members[Symbol.iterator].bind(members);
        if (typeof name === "symbol") return Reflect.get(target, name, receiver);
        if (Array.isArray(target)) {
          if (name === "length" || name === "count") return vm.withReference(shadow, ref => vm.module._tjs_array_count(vm.runtime, ref));
          if (/^-?\d+$/.test(name)) return vm.rawGet(shadow, name);
          if (name in Array.prototype) return Reflect.get(target, name, receiver);
        }
        if (target instanceof Map) {
          if (name === "size") return members.size;
          if (name === "set") return (key, value) => { members.set(key, value); return shadow; };
          if (["get", "has", "delete", "clear", "keys", "values", "entries"].includes(name))
            return members[name].bind(members);
        }
        if (callable && ["call", "apply", "bind"].includes(name)) return Function.prototype[name].bind(shadow);
        const member = (...args) => vm.callMember(shadow, name, shadow, args);
        member.then = (resolve, reject) => vm.get(shadow, name).then(resolve, reject);
        return member;
      },
      set(target, name, value) {
        if (Array.isArray(target) && (name === "length" || name === "count" || /^-?\d+$/.test(name))) {
          vm.rawSet(shadow, name === "length" ? "count" : name, value, 512);
          return true;
        }
        throw new Error("Script property writes require await writeScript(object, name, value)");
      },
      has(target, name) {
        if (Array.isArray(target) && /^\d+$/.test(name))
          return Number(name) < vm.withReference(shadow, ref => vm.module._tjs_array_count(vm.runtime, ref));
        return Reflect.has(target, name);
      },
    });
    members.owner = shadow;
    bindScriptReference(shadow, info);
    return shadow;
  }
  callback(fn, property = false) {
    const callback = this.storeHost(fn);
    return this.module._tjs_callback_create(
      this.runtime,
      callback,
      Number(property),
    );
  }
  storeHost(value) {
    const handle = this.host.nextCallback++;
    this.callbacks.set(handle, value);
    return handle;
  }
  retainHost(handle) {
    const value = this.callbacks.get(handle);
    if (value === undefined) throw new Error(`Expired JS host handle: ${handle}`);
    return this.storeHost(value);
  }
  releaseHost(handle) {
    this.callbacks.delete(handle);
  }
  rememberExport(owner, id) {
    const result = this.module._tjs_host_bind(this.runtime, this.storeHost(owner), id, this.host.identity(owner));
    if (!result) this.fail();
  }
  // Returns the host state handle; -1 means the owner has no such native
  // instance, 0 means the instance carries no state (or a VM error, which
  // throws through the standard error channel only for checked exports).
  nativeState(klass, owner, handle = 0) {
    return this.withReference(owner, id => this.withString(klass.nativeName, name =>
      this.module._tjs_native_state(this.runtime, id, name, handle)));
  }
  kagParsers() {
    return this.readArray(this.module._tjs_kag_parsers(this.runtime)).map(value => {
      try { return { name: 'KAGParser', storage: this.rawGet(value, 'storage'), line: this.rawGet(value, 'line'), text: this.rawGet(value, 'text') }; }
      finally { this.releaseHandle(scriptBinding(value).id); }
    });
  }
  nativeStates(klass) {
    const id = this.withString(klass.nativeName, name => this.module._tjs_native_states(this.runtime, name));
    return this.readArray(id).map(handle => this.callbacks.get(handle));
  }
  encodeResult(value) {
    return this.withReference(value, id => this.module._tjs_value_retain(this.runtime, id));
  }
  encode(value) {
    const info = scriptBinding(value);
    if (info) {
      const id = this.module._tjs_value_copy(this.runtime, info.id);
      if (!id) this.decodePrimitive(0);
      return id;
    }
    const object = value;
    if (
      object === null ||
      !["object", "function"].includes(typeof object) ||
      object instanceof Uint8Array
    )
      return this.encodePrimitive(object);
    const previous = this.module._tjs_host_reference(this.runtime, this.host.identity(object));
    if (previous) return previous;
    const native = encodeNativeValue(object, this);
    if (native !== undefined) return native;
    if (typeof object === "function") {
      const callback = this.storeHost(({ receiver, args }) => object.apply(receiver, args));
      const id = this.module._tjs_callback_create(this.runtime, callback, 0);
      this.rememberExport(object, id);
      return id;
    }
    const hostHandle = this.storeHost(object);
    const id = this.module._tjs_object_create_host(
      this.runtime,
      Array.isArray(object) ? 1 : object instanceof Map ? 2 : 0,
      hostHandle,
    );
    if (!id) this.fail();
    try {
      this.rememberExport(object, id);
      if (Array.isArray(object)) {
        object.forEach((item, index) => this.setEncoded(id, String(index), item));
      } else if (object instanceof Map) {
        for (const [name, item] of object) this.setEncoded(id, name, item);
      } else {
        const names = new Set(Object.keys(object));
        for (
          let proto = Object.getPrototypeOf(object);
          proto && proto !== Object.prototype;
          proto = Object.getPrototypeOf(proto)
        ) {
          for (const name of Object.getOwnPropertyNames(proto))
            if (name !== "constructor") names.add(name);
        }
        for (const name of names) {
          let descriptor;
          for (
            let proto = object;
            proto && !descriptor;
            proto = Object.getPrototypeOf(proto)
          )
            descriptor = Object.getOwnPropertyDescriptor(proto, name);
          const member = descriptor?.value;
          if (member instanceof Closure || isNativeClass(member) || isNativeProperty(member))
            this.setEncoded(id, name, member);
          else if (typeof member === "function")
            this.setEncoded(id, name, member.bind(object));
          else {
            const property = createNativeProperty(
              () => object[name],
              (_, v) => {
                object[name] = v;
              },
            );
            this.setEncoded(id, name, property);
          }
        }
      }
    } catch (error) {
      this.releaseHandle(id);
      throw error;
    }
    return id;
  }
  setEncoded(id, name, value, flags = TJS_MEMBER_ENSURE_IGNORE_PROPERTY) {
    this.withString(name, (p) => {
      const encoded = this.encode(value);
      try {
        this.decode(
          this.module._tjs_object_set_raw(this.runtime, id, p, encoded, flags),
        );
      } finally {
        this.releaseHandle(encoded);
      }
    });
  }
  rawGet(value, name) {
    if (Array.isArray(unwrap(value)) && /^-?\d+$/.test(name))
      return this.withReference(value, id =>
        this.decode(this.module._tjs_object_get_by_num_raw(this.runtime, id, Number(name))));
    return this.withReference(value, (id) =>
      this.withString(name, (p) =>
        this.decode(this.module._tjs_object_get_raw(this.runtime, id, p)),
      ),
    );
  }
  rawSet(value, name, member, flags) {
    return this.withReference(value, (id) =>
      this.setEncoded(id, name, member, flags),
    );
  }
  deleteMember(value, name) {
    return this.withReference(value, (id) =>
      this.withString(name, (p) => {
        const result = this.module._tjs_object_delete(this.runtime, id, p);
        if (!result) this.decode(result);
        return result === 2;
      }),
    );
  }
  classNames(value) {
    return this.withReference(value, id => this.readArray(this.module._tjs_object_class_names(this.runtime, id)));
  }
  setMissingHandler(value) {
    return this.withReference(value, (id) =>
      this.decode(this.module._tjs_object_set_missing(this.runtime, id)),
    );
  }
  objectCount(value) {
    return this.withReference(value, (id) =>
      this.decode(this.module._tjs_object_count(this.runtime, id)),
    );
  }
  collection(kind, entries, context) {
    const id = this.module._tjs_object_create(this.runtime, kind);
    try {
      for (const [name, value] of entries)
        this.setEncoded(id, String(name), value);
      if (context != null) this.bindOwnerHandle(id, context);
    } catch (error) {
      this.releaseHandle(id);
      throw error;
    }
    const closure = this.decode(id);
    const object = unwrap(closure);
    return object;
  }
  deserialize(bytes, context) {
    return this.withBuffer(bytes, (p) =>
      this.decode(this.module._tjs_deserialize(this.runtime, p, bytes.length)),
    );
  }
  keys(value) {
    return this.withReference(value, id => this.readArray(this.module._tjs_object_keys(this.runtime, id)));
  }
  async nativePlugins(operation, name = '') {
    const id = await this.withString(name, namePtr => this.module._tjs_plugins(this.runtime, operation, namePtr));
    return operation === 1 ? this.readArray(id) : Boolean(this.decode(id));
  }
  readArray(id) {
    if (!id) this.fail();
    try {
      const count = this.module._tjs_array_count(this.runtime, id);
      return Array.from({ length: count }, (_, index) => this.withString(String(index), name =>
        this.decode(this.module._tjs_object_get_raw(this.runtime, id, name))));
    } finally {
      this.releaseHandle(id);
    }
  }
  attachStorage(storage) {
    const backend = createTJS2Storage(storage);
    this.registerGlobal('TJS2Storage', backend.klass);
    const callback = this.storeHost(async ({ operation, args: [name, value, mode] }) => {
      switch (operation) {
        case 6: return backend.read(name);
        // Shared JS capabilities used by the native Storages interface.
        case 14: return storage.clearArchiveCache();
        case 15: return storage.currentDirectory;
        case 16: storage.currentDirectory = name; return;
        case 17: storage.addAutoPath(name); return;
        case 18: storage.removeAutoPath(name); return;
        case 19: return storage.getPlacedPath(name);
        case 10: return backend.write(name, value);
        default: throw Error('Unknown storage operation: ' + operation);
      }
    });
    this.module._tjs_runtime_set_storage(this.runtime, callback);
  }
  registerGlobal(name, value) {
    if (INTERPRETER_CLASSES.includes(name)) throw new Error(`TJS owns the global class ${name}`);
    const id = this.module._tjs_runtime_global(this.runtime);
    try { this.setEncoded(id, name, value); }
    finally { this.releaseHandle(id); }
    this.global[name] = value;
    return value;
  }
  registerMembers(target, members, { hidden = false } = {}) {
    const flags = hidden ? TJS_MEMBER_ENSURE_IGNORE_PROPERTY | TJS_HIDDEN_MEMBER : undefined;
    for (const [name, value] of Object.entries(members)) {
      if (isNativeClass(target)) target.defineMember(name, value);
      else this.rawSet(target, name, typeof value === 'function' && !scriptBinding(target) ? value.bind(target) : value, flags);
    }
  }
  async source(
    source,
    name = "global",
    offset = 0,
    context,
    expression = false,
  ) {
    return this.withString(String(source), (p) =>
      this.withString(name, async (n) => {
        const id = context ? this.encode(context) : 0;
        try {
          return this.decode(
            await this.module._tjs_execute_source(
              this.runtime,
              p,
              n,
              offset,
              id,
              Number(expression),
            ),
          );
        } finally {
          if (id) this.releaseHandle(id);
        }
      }),
    );
  }
  async get(value, name, ignoreProperty = false) {
    return this.withAsyncReference(value, async (id) =>
      this.withString(name, async (p) =>
        this.decode(
          await this.module._tjs_object_get(
            this.runtime,
            id,
            p,
            ignoreProperty ? 2048 : 0,
          ),
        ),
      ),
    );
  }
  async getTyped(value, name, ignoreProperty = false) {
    return this.withAsyncReference(value, async id => {
      const arrayIndex = ignoreProperty && Array.isArray(unwrap(value)) && /^-?\d+$/.test(String(name));
      const result = ignoreProperty
        ? arrayIndex
          ? this.module._tjs_object_get_by_num_raw(this.runtime, id, Number(name))
          : this.withString(name, p => this.module._tjs_object_get_raw(this.runtime, id, p))
        : await this.withString(name, p => this.module._tjs_object_get(this.runtime, id, p, 0));
      if (!result) this.fail();
      const type = this.module._tjs_value_type(this.runtime, result);
      const text = type === TJSValueType.INTEGER || type === TJSValueType.REAL
        ? this.decode(this.module._tjs_value_convert(this.runtime, result, 3))
        : undefined;
      return { type, value: this.decode(result), text };
    });
  }
  async set(value, name, member, ensure = false, ignoreProperty = false) {
    return this.withAsyncReference(value, async (id) =>
      this.withString(name, async (p) => {
        const encoded = this.encode(member);
        try {
          return this.decode(
            await this.module._tjs_object_set(
              this.runtime,
              id,
              p,
              encoded,
              (ensure ? 512 : 0) | (ignoreProperty ? 2048 : 0),
            ),
          );
        } finally {
          this.releaseHandle(encoded);
        }
      }),
    );
  }
  callMember(value, name, receiver, args = [], ignoreMissing = false) {
    return this.call(value, receiver, args, false, name, ignoreMissing);
  }
  async call(value, receiver, args = [], construct = false, name, ignoreMissing = false) {
    const id = this.encode(value),
      owner = receiver ? this.encode(receiver) : 0;
    const ids = args.map((value) => this.encode(value)),
      p = this.module._malloc(ids.length * 4),
      member = name === undefined ? 0 : this.string(name);
    this.module.HEAPU32.set(ids, p >>> 2);
    try {
      return this.decode(
        await (construct
          ? this.module._tjs_object_construct(this.runtime, id, ids.length, p)
          : this.module._tjs_object_call(
              this.runtime,
              id,
              owner,
              ids.length,
              p,
              member,
              ignoreMissing,
            )),
      );
    } finally {
      this.module._free(p);
      if (member) this.module._free(member);
      for (const handle of [id, owner, ...ids])
        if (handle) this.releaseHandle(handle);
    }
  }
  async invalidate(value) {
    return this.withAsyncReference(value, async (id) =>
      this.decode(await this.module._tjs_object_invalidate(this.runtime, id)),
    );
  }
  async cloneObject(value) {
    return this.withAsyncReference(value, async id =>
      this.decode(await this.module._tjs_object_clone(this.runtime, id)));
  }
}
