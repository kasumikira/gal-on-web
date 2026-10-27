// Native class index (tjsNative.cpp: NativeClassNames) and the instance index
// it feeds (runtime.h: nativeInstances). The name table moved from a linear
// vector scan to a chained hash, so the cases below target what a broken table
// loses first: dense id assignment, one name per class, and lookups that still
// resolve once the table has grown past its bucket count (TJS_HS_DEFAULT_HASH_SIZE).
//
// Construct into a variable and read the member on the next statement: with a
// native class, `return new Foo().bar();` compiles to a call whose result is
// discarded, which is a pre-existing dispatch quirk unrelated to this index.
import assert from 'node:assert/strict';
import { TJSInterop } from '../../engine-js/wasm-vm.js';
import { defineNativeClass } from '../../engine-js/common/native.js';

const vm = await new TJSInterop().init(Object.create(null));
let sequence = 0;
const makeClass = (name, value) => defineNativeClass(name, {
  initialize: () => ({ seq: sequence++, value }),
  members: { which() { return this.value; } },
});

const names = ['IndexFirst'];
const First = makeClass('IndexFirst', 0);
vm.registerGlobal('IndexFirst', First);
// 80 more classes: past the 64 buckets, so the table starts chaining.
for (let i = 0; i < 80; i++) {
  const name = `IndexFill${i}`;
  names.push(name);
  vm.registerGlobal(name, makeClass(name, i + 1));
}

// --- every class still resolves to its own id after the table grows ---------
// The checksum mixes each class result, so a collision that returned another
// class's id shows up as a wrong total instead of a passing lookup. It stays in
// real arithmetic and is reduced each step so neither side overflows.
const MODULUS = 1000003;
const script = [
  ...names.map(name => `var v_${name} = new ${name}();`),
  ...names.map(name => `s = (s * 131 + v_${name}.which()) % ${MODULUS};`),
  'return s;',
].join('\n');
const expected = names.reduce(
  (total, name, index) => (total * 131 + (index === 0 ? 0 : index)) % MODULUS,
  0,
);
const checksum = await vm.source(`var s = 0.0;\n${script}`, 'checksum');
assert.equal(checksum, expected, 'a class resolved to the wrong id after the table grew');

// --- one instance slot per class: ids never alias ---------------------------
// Two classes sharing an id would show each other's instances here.
for (const [index, klass] of [[0, First], [38, vm.global.IndexFill37], [80, vm.global.IndexFill79]]) {
  assert.equal(vm.nativeStates(klass).length, 1,
    `${klass.nativeName} (${index}) sees instances that belong to another class`);
}

// --- enumeration order is creation order (Q1) -------------------------------
const Order = makeClass('IndexOrder', 0);
vm.registerGlobal('IndexOrder', Order);
await vm.source('var o1 = new IndexOrder(); var o2 = new IndexOrder(); var o3 = new IndexOrder();', 'order');
assert.deepEqual(
  vm.nativeStates(Order).map(state => state.seq),
  [81, 82, 83],
  'instances.values() must stay in reference (creation) order',
);

// --- repeated name lookups do not re-register the class ---------------------
// nativeStates resolves the name on every call; a table that appended instead
// of matching would shift ids and duplicate the instance slot.
const before = vm.nativeStates(Order).length;
for (let i = 0; i < 8; i++) assert.equal(vm.nativeStates(Order).length, before);

// --- the constant host-object class still resolves after the growth ---------
const host = vm.encode({ note: 'after-growth' });
assert.ok(host > 0, 'host object creation failed after the class table grew');
vm.releaseHandle(host);

// --- a failed lookup must not outlive the registration it preceded ----------
// Querying a class before it is registered resolves to -1. Registration is a
// later event the cache cannot observe, so remembering the miss would pin the
// class at -1 for the VM's whole life and every instance created afterwards
// would fail with "native instance not found".
const Late = makeClass('IndexLate', 7);
assert.equal(vm.classId(Late), -1, 'an unregistered class must resolve to -1');
vm.registerGlobal('IndexLate', Late);
assert.ok(vm.classId(Late) >= 0, 'registering the class must clear the cached miss');
assert.equal(
  await vm.source('var late = new IndexLate(); return late.which();', 'late'),
  7,
  'a class that registers after a failed lookup must still instantiate',
);

console.log('index-check passed');
await vm.dispose();
