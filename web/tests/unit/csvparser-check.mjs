// Verifies the native CSVParser class (native/kirikiri/plugins/csvParser.cpp)
// against the reference parser body in cpp/plugins/csvParser.cpp.
import assert from 'node:assert/strict';
import { TJSInterop } from '../../engine-js/wasm-vm.js';

const cases = [
  ['registered global', 'return CSVParser === void ? "missing" : "present";', 'present'],
  [
    'plain rows',
    `var p = new CSVParser();
     p.init("a,b,c\\r\\n1,2,3\\r\\n");
     var l1 = p.getNextLine(), l2 = p.getNextLine(), l3 = p.getNextLine();
     return l1.join("|") + " / " + l2.join("|") + " / " + (l3 === void) + " / " + p.currentLineNumber;`,
    'a|b|c / 1|2|3 / 1 / 2',
  ],
  [
    'quoted field keeps separator',
    `var p = new CSVParser();
     p.init("\\"x,y\\",z\\r\\n");
     return p.getNextLine().join("|");`,
    'x,y|z',
  ],
  [
    'doubled quote unescapes',
    `var p = new CSVParser();
     p.init("\\"a\\"\\"b\\",c\\r\\n");
     return p.getNextLine().join("|");`,
    'a"b|c',
  ],
  [
    'quoted field spans lines',
    `var p = new CSVParser();
     p.init("\\"a\\r\\nb\\",c\\r\\n");
     var l = p.getNextLine();
     return l.count + ":" + l[0].length + ":" + l[1] + ":" + p.currentLineNumber;`,
    // Reference appends the CRLF line separator inside the quoted field.
    '2:4:c:1',
  ],
  [
    'custom separator',
    `var p = new CSVParser(null, 0x3b);
     p.init("a;b,c\\r\\n");
     return p.getNextLine().join("|");`,
    'a|b,c',
  ],
  [
    // The reference calls doLine as a nested FuncCall, so the target is fully
    // populated the moment parse() returns, with no await anywhere.
    'parse is synchronous',
    `class Target {
       var lines;
       function Target() { lines = []; }
       function doLine(fields, line) { lines.add(line + "=" + fields.join("-")); }
     }
     var target = new Target();
     var p = new CSVParser(target);
     p.init("1,2\\r\\n3,4\\r\\n");
     p.parse();
     return target.lines.join(";");`,
    '1=1-2;2=3-4',
  ],
  [
    // split() returns early for an empty line, so the row is an empty array
    // rather than one empty field.
    'empty line yields an empty array',
    `var p = new CSVParser();
     p.init("\\r\\na\\r\\n");
     var l = p.getNextLine();
     return l.count + ":" + l[0] + ":" + p.currentLineNumber;`,
    '0::1',
  ],
  [
    'no trailing newline still yields the last row',
    `var p = new CSVParser();
     p.init("a,b");
     var l = p.getNextLine();
     var done = p.getNextLine();
     return l.join("|") + "/" + (done === void);`,
    'a|b/1',
  ],
];

const global = Object.create(null);
const vm = await new TJSInterop().init(global);
await vm.nativePlugins(0, 'csvparser.dll');
try {
  for (const [label, source, expected] of cases) {
    assert.equal(await vm.source(source, label), expected, label);
  }
  console.log('passed', cases.length, '/', cases.length);
} finally {
  await vm.dispose();
}
