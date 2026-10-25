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
  console.log('passed', cases.length, '/', cases.length, '; division/remainder errors passed');
  console.log('typed member reads passed');
  console.log('attached script receivers passed');
  console.log('native array length and saveStruct override regression passed');
} finally {
  await vm.dispose();
}
