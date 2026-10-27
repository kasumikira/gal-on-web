import assert from 'node:assert/strict';
import { TJSInterop } from '../../engine-js/wasm-vm.js';
import { readScript, readScriptTyped, disposeScriptValue, NativeProperty } from '../../engine-js/common/native.js';
import { TJSValueType } from '../../engine-js/common/values.js';

const cases = [
  ['int add exact', 'string (2147483647 + 1)', '2147483648'],
  ['int64 precision', 'string (9007199254740991 + 2)', '9007199254740993'],
  ['real add', 'string (1.5 + 2)', '3.5'],
  ['string concat', '"a" + "b"', 'ab'],
  ['normal eq string/int', '1 == "1"', 1],
  ['discern eq string/int', '1 === "1"', 0],
  ['discern eq int/real', '1 === 1.5', 0],
  ['discern eq num/num', '4 === 4', 1],
  ['discern eq integer variants', 'int 4 === 4', 1],
  ['discern eq strings', '"a" === "a"', 1],
  ['normal eq octet/object', '<% 01 %> == %[]', 0],
  ['normal eq void/0', 'void == 0', 1],
  ['clt int64 exact', '9007199254740993 < 9007199254740994', 1],
  ['cgt int64 exact', '9007199254740993 > 9007199254740994', 0],
  ['cgt int64 exact true', '9007199254740995 > 9007199254740994', 1],
  ['clt strings', '"abc" < "abd"', 1],
  ['object identity eq', '(function(){var value=%[];return value==value;})()', 1],
];
const global = Object.create(null);
const vm = await new TJSInterop().init(global);
await vm.nativePlugins(0, 'savestruct.dll');
await vm.nativePlugins(0, 'scriptsex.dll');
try {
  for (const [label, source, expected] of cases) {
    assert.equal(await vm.source(source, label, 0, undefined, true), expected, label);
  }
  await assert.rejects(vm.source('1 \\ 0', 'division', 0, undefined, true));
  await assert.rejects(vm.source('1 % 0', 'remainder', 0, undefined, true));
  const values = await vm.source('return %["i"=>int 1,"r"=>real 1,"large"=>9007199254740993,"array"=>[real 1]];', 'typed-values');
  try {
    assert.deepEqual(await readScriptTyped(values, 'i'), { type: TJSValueType.INTEGER, value: 1, text: '1' });
    assert.deepEqual(await readScriptTyped(values, 'r'), { type: TJSValueType.REAL, value: 1, text: '1' });
    assert.deepEqual(await readScriptTyped(values, 'large'), {
      type: TJSValueType.INTEGER, value: 9007199254740993n, text: '9007199254740993',
    });
    const array = await readScriptTyped(values, 'array');
    try {
      assert.equal(array.type, TJSValueType.OBJECT);
      assert.deepEqual(await readScriptTyped(array.value, '0', { ignoreProperty: true }), {
        type: TJSValueType.REAL, value: 1, text: '1',
      });
    } finally { await disposeScriptValue(array.value); }
  } finally { await disposeScriptValue(values); }
  vm.registerMembers(global.Array, {
    firstForCheck() { return readScript(this, '0'); },
  });
  assert.equal(await vm.source('var a=["A"],b=["B"];return a.firstForCheck()+b.firstForCheck();', 'attached-receiver'), 'AB');
  // saveStruct is native (native/kirikiri/plugins/saveStruct.cpp), so the
  // Array/Dictionary members exist without any JS registration step.
  const overridden = await vm.source('return ["kept"];', 'array-count-override');
  let countGetterCalls = 0;
  vm.rawSet(overridden, 'count', new NativeProperty(() => { countGetterCalls++; return 0; }));
  try {
    assert.equal(overridden.length, 1, 'host length reads native Array storage');
    assert.equal(await readScript(overridden, 'count'), 0, 'script count getter keeps its semantics');
    assert.equal(await vm.callMember(overridden, 'toStructString', overridden), '["kept"]');
    assert.equal(countGetterCalls, 1,
      'native length and serialization do not invoke the overridden getter');
  } finally { await disposeScriptValue(overridden); }

  // Large-object lookups must not cache values, reorder enumeration,
  // hide full-hash collisions, or bypass script fallback paths.
  const large = await vm.source(`
    class HashReadProbe {
      var reads = 0, misses = 0;
      property computed { getter() { return ++reads; } }
      function missing(mode, name, value) {
        if (!mode) {
          misses++;
          if (name == "dynamic") { *value = misses; return true; }
        }
        return false;
      }
    }
    return new HashReadProbe();
  `, 'large-hash-object');
  const collisionA = 'member_collision_37381', collisionB = 'member_collision_80300';
  try {
    // These two names share the complete 32-bit TJS hash, 0xf8c5da2d.
    vm.rawSet(large, collisionA, 11);
    vm.rawSet(large, collisionB, 12);
    for (let i = 0; i < 1600; i++) vm.rawSet(large, `member_${i}`, i);
    const names = vm.keys(large);
    for (let i = 0; i < 64; i++) assert.equal(vm.rawHas(large, `absent_${i}`), false);
    assert.deepEqual(vm.keys(large), names, 'negative lookups preserve enumeration order');
    vm.rawSet(large, 'new_after_filter', 77);
    assert.equal(await vm.get(large, 'new_after_filter'), 77, 'new hashes remain visible after filtering starts');
    assert.equal(await vm.get(large, collisionA), 11);
    assert.equal(await vm.get(large, collisionB), 12);
    assert.equal(vm.deleteMember(large, collisionA), true);
    assert.equal(vm.rawHas(large, collisionA), false, 'colliding hash still requires name comparison');
    assert.equal(await vm.get(large, collisionB), 12, 'deleting a collision keeps its peer visible');
    assert.equal(vm.deleteMember(large, collisionB), true);
    assert.equal(vm.rawHas(large, collisionB), false);
    vm.rawSet(large, collisionA, 13);
    assert.equal(await vm.get(large, collisionA), 13, 'insertion remains visible');
    for (let i = 0; i < 64; i++) assert.equal(vm.rawHas(large, `absent_${i}`), false);
    vm.setMissingHandler(large);
    assert.equal(await vm.get(large, 'computed'), 1);
    assert.equal(await vm.get(large, 'computed'), 2, 'getters still run on every read');
    assert.equal(await vm.get(large, 'dynamic'), 1);
    assert.equal(await vm.get(large, 'dynamic'), 2, 'negative lookup still invokes missing');
    vm.registerGlobal('largeHashScope', large);
    assert.equal(await vm.source('var hashScopeFallback=91; with(largeHashScope) { return hashScopeFallback; }', 'hash-scope'), 91);
    for (let i = 0; i < 1550; i++) vm.deleteMember(large, `member_${i}`);
    assert.equal(await vm.get(large, 'member_1599'), 1599, 'deletion preserves remaining members');
    for (let i = 0; i < 1550; i++) vm.rawSet(large, `member_${i}`, i + 1);
    for (let i = 0; i < 64; i++) assert.equal(vm.rawHas(large, `absent_${i}`), false);
    vm.rehash();
    assert.equal(await vm.get(large, 'member_1599'), 1599);
    assert.equal(await vm.get(large, 'member_0'), 1, 'rebuilt table preserves the reinserted value');
    assert.equal(vm.rawHas(large, 'absent_after_rebuild'), false);
    assert.equal(await vm.get(large, collisionA), 13);
    assert.equal(await vm.get(large, 'computed'), 3);
    const missesBeforeRebuiltRead = await vm.get(large, 'misses');
    assert.equal(await vm.get(large, 'dynamic'), missesBeforeRebuiltRead + 1);
  } finally { await vm.dispose(large); }

  console.log('large-object hash maintenance regression passed');
  console.log('passed', cases.length, '/', cases.length, '; division/remainder errors passed');
  console.log('typed member reads passed');
  console.log('attached script receivers passed');
  console.log('native array length and saveStruct override regression passed');
} finally {
  await vm.dispose();
}
