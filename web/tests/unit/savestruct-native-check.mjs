// Verifies the native saveStruct members (native/kirikiri/plugins/saveStruct.cpp)
// against the serializer body in cpp/plugins/saveStruct.cpp.
import assert from 'node:assert/strict';
import { TJSInterop } from '../../engine-js/wasm-vm.js';

const cases = [
  [
    'array of strings',
    'return ["a", "b"].toStructString();',
    '["a","b"]',
  ],
  [
    'dictionary uses CRLF by default',
    'return (Dictionary.toStructString incontextof %["a" => int 1, "b" => int 2])();',
    '%["a"=>int 1,\r\n"b"=>int 2]',
  ],
  [
    'lf flag switches the member separator',
    'return (Dictionary.toStructString incontextof %["a" => int 1, "b" => int 2])(1);',
    '%["a"=>int 1,\n"b"=>int 2]',
  ],
  [
    'scalars and special values',
    'return [int 1, real 1.5, "x", <% 01 02 %>, void, null].toStructString();',
    '[int 1,real 1.5,"x",<% 01 02 %>,void,nullptr]',
  ],
  [
    'string escaping',
    String.raw`return ['a"b', 'c\\d'].toStructString();`,
    String.raw`["a\"b","c\\d"]`,
  ],
  [
    // EnumMembers yields hash order, so nesting is checked one shape at a time.
    'array nested in dictionary',
    'return (Dictionary.toStructString incontextof %["arr" => [1, [2]]])(1);',
    '%["arr"=>[int 1,[int 2]]]',
  ],
  [
    'dictionary nested in dictionary',
    'return (Dictionary.toStructString incontextof %["d" => %["k" => "v"]])(1);',
    '%["d"=>%["k"=>"v"]]',
  ],
  [
    // getArrayString reads Array.count from the class property with the array as
    // objthis, so an instance-level count override must not affect the output.
    'object count drives the array walk',
    'var a = ["kept"]; return a.toStructString();',
    '["kept"]',
  ],
];

const global = Object.create(null);
const vm = await new TJSInterop().init(global);
await vm.nativePlugins(0, 'savestruct.dll');
try {
  for (const [label, source, expected] of cases) {
    assert.equal(await vm.source(source, label), expected, label);
  }
  console.log('passed', cases.length, '/', cases.length);
} finally {
  await vm.dispose();
}
