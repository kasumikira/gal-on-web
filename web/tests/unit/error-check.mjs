// Error-convention smoke check: every failing WASM export returns 0 and the
// message travels through the runtime error slot (checked() / tjs_error_set).
// Covers: script errors, JS host callbacks (sync + async), read-only packed
// values, tri-state returns, native class attach, and error-slot leak parity.
import { TJSInterop } from '../../engine-js/wasm-vm.js';
import {
  defineNativeClass,
  NativeProperty,
  bindReadOnlyValue,
} from '../../engine-js/common/native.js';

let failures = 0;
const check = (label, condition, detail) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${condition ? '' : ' -- ' + detail}`);
  if (!condition) failures++;
};
const expectThrow = async (label, run, pattern) => {
  try {
    await run();
    check(label, false, 'expected a throw');
  } catch (error) {
    const message = String(error?.message ?? error);
    check(label, pattern.test(message), `unexpected message: ${message}`);
  }
};

const vm = await new TJSInterop().init(Object.create(null));
const globalId = vm.module._tjs_runtime_global(vm.runtime);
const release = id => vm.module._tjs_value_release(vm.runtime, id);

// --- success paths still return values ---
const sum = await vm.source('var __a = 40 + 2; return __a;', 'sum');
check('script success returns value', sum === 42, sum);

// --- C++ origin: script error -> checked() -> 0 + error slot ---
await expectThrow(
  'script error propagates message',
  () => vm.source('nosuchfunc_xyz();', 'cpperr'),
  /nosuchfunc_xyz/,
);

// --- JS origin via host_call: sync throw ---
vm.setEncoded(globalId, 'failingFn', () => { throw new Error('js-boom'); });
await expectThrow(
  'host callback sync throw',
  () => vm.source('failingFn();', 'boom1'),
  /js-boom/,
);

// --- JS origin via host_call: async rejection ---
vm.setEncoded(globalId, 'failingAsyncFn', async () => { throw new Error('js-async-boom'); });
await expectThrow(
  'host callback async rejection',
  () => vm.source('failingAsyncFn();', 'boom2'),
  /js-async-boom/,
);

// --- JS origin via host_readonly_get: packed value getter throws ---
const packed = { keys: ['ok', 'bad'], get(name) {
  if (name === 'ok') return 42;
  throw new Error('readonly-boom');
} };
bindReadOnlyValue(packed, packed);
vm.setEncoded(globalId, 'packedObj', packed);
check('read-only success reads value', await vm.source('return packedObj.ok;', 'ro1') === 42);
await expectThrow(
  'read-only getter throw',
  () => vm.source('packedObj.bad;', 'ro2'),
  /readonly-boom/,
);

// --- tri-state returns (1+bool) still decode, 0 stays the error value ---
const dict = vm.collection(2, [['x', 1]]);
check('sameReference true', vm.sameReference(dict, dict) === true);
check('sameReference false', vm.sameReference(dict, vm.collection(2, [])) === false);
check('deleteMember present -> true', vm.deleteMember(dict, 'x') === true);
check('deleteMember missing -> false', vm.deleteMember(dict, 'x') === false);
check('isValid returns boolean', typeof vm.isValid(dict) === 'boolean');

// --- native class round trip: attach, property, method, state enumeration ---
const Widget = defineNativeClass('Widget', { members: {
  value: new NativeProperty(state => state.n, (state, v) => { state.n = Number(v); }),
  speak() { return 'widget:' + this.n; },
} });
vm.setEncoded(globalId, 'Widget', Widget);
check('native class construct+members',
  await vm.source('var w = new Widget(); w.value = 41; return w.speak();', 'widget') === 'widget:41');
check('native state enumeration', vm.nativeStates(Widget).length === 1, vm.nativeStates(Widget).length);

// --- error slot must not accumulate handles across failing calls ---
await vm.source('failingFn();', 'warmup').catch(() => {});
const before = vm.module._tjs_runtime_handle_count(vm.runtime);
for (let i = 0; i < 10; i++) await vm.source('failingFn();', 'leak' + i).catch(() => {});
const after = vm.module._tjs_runtime_handle_count(vm.runtime);
check('failing calls do not leak handles', before === after, `${before} -> ${after}`);

// --- withBorrow still rejects async blocks ---
try {
  await vm.withBorrow(dict, async () => {});
  check('withBorrow rejects async block', false, 'no throw');
} catch (error) {
  check('withBorrow rejects async block', error instanceof TypeError, error?.message);
}

// Owner indices preserve handle order, including values added by a destructor.
vm.registerGlobal('IndexOwner', defineNativeClass('IndexOwner'));
const indexOwner = await vm.source('new IndexOwner()', 'index-owner', 0, undefined, true);
const released = [], labels = new Map();
const indexedCallback = label => {
  const callback = vm.storeHost(() => 0);
  labels.set(callback, label);
  return vm.module._tjs_callback_create(vm.runtime, callback, 0);
};
const first = indexedCallback(1), second = indexedCallback(2);
vm.bindOwnerHandle(second, indexOwner);
vm.bindOwnerHandle(first, indexOwner);
const originalRelease = vm.module.hostRelease;
vm.module.hostRelease = (runtime, handle) => {
  const label = labels.get(handle);
  if (label) {
    released.push(label);
    if (label === 1) vm.bindOwnerHandle(indexedCallback(3), indexOwner);
  }
  originalRelease(runtime, handle);
};
const indexedCount = vm.module._tjs_runtime_handle_count(vm.runtime);
try { await vm.invalidate(indexOwner); }
finally { vm.module.hostRelease = originalRelease; }
check('owner index preserves release order across reentry', released.join(',') === '1,2,3', released);
check('owner index releases reentrant values', vm.module._tjs_runtime_handle_count(vm.runtime) === indexedCount - 2);
await vm.dispose(indexOwner);

const identityValue = { value: 1 };
let identityHandle = vm.encode(identityValue);
const repeatedHandle = vm.encode(identityValue);
check('host identity index reuses script object', vm.module._tjs_value_equal(vm.runtime, identityHandle, repeatedHandle, 1) === 2);
await vm.releaseHandleAsync(identityHandle);
await vm.releaseHandleAsync(repeatedHandle);
check('destroyed exports leave no identity entry', vm.module._tjs_host_reference(vm.runtime, vm.host.identity(identityValue)) === 0);
identityHandle = vm.encode(identityValue);
check('same JS identity can be exported again', identityHandle > 0);
await vm.releaseHandleAsync(identityHandle);

await vm.dispose();
check('host table empty after shutdown', vm.callbacks.size === 0, vm.callbacks.size);

console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
