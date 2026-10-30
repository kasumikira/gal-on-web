import assert from 'node:assert/strict';
import { TJSInterop } from '../../engine-js/wasm-vm.js';

const vm = await new TJSInterop().init({});
try {
  await vm.source('var originalParser = new KAGParser();');
  await vm.nativePlugins(0, 'kagparserex.dll');
  assert.equal(await vm.source(`
    var BaseConductorExtendClass = KAGParser;
    class Conductor extends BaseConductorExtendClass {
      function Conductor() { super.KAGParser(); }
      function onScenarioLoad(name) { return "@tag a=base\\n"; }
      function loadScenario(name) { BaseConductorExtendClass.loadScenario(name); }
    }
    var conductor = new Conductor();
    conductor.loadScenario("alias.ks");
    return conductor.getNextTag().a;
  `), 'base');

  async function parse(scenario, setup = '') {
    return vm.source(`
      var scenario = ${JSON.stringify(scenario)};
      var p = new KAGParser();
      p.onScenarioLoad = function(name) { return scenario; };
      ${setup}
      p.loadScenario("test.ks");
      var tag = p.getNextTag();
      return tag.tagname + ":" + tag.a + ":" + tag.b + ":" + tag.c;
    `);
  }
  assert.equal(await parse('@tag a=1 \\\n; b=2\n', 'p.multiLineTagEnabled = true;'), 'tag:1:2:');
  assert.equal(await parse('@pmacro name=combo a=one b=two\n@tag combo\n'), 'tag:one:two:');
  assert.equal(await parse('[emb exp="\'[tag a=ok]\'" escape=false]'), 'tag:ok::');
  assert.equal(await parse('@macro name=m\n@tag a=before * b=after\n@endmacro\n@m c=ok\n'), 'tag:before:after:ok');
  assert.equal(await vm.source('return tag.taglist.join(",");'), 'tagname,a,c,b');
  assert.equal(await vm.source(`
    var saved = p.store();
    var restored = new KAGParser();
    restored.onScenarioLoad = function(name) { return scenario; };
    restored.restore(saved);
    return restored.getNextTag().tagname;
  `), 'tag');
  // Replacement must not let an original NI be cast to the extension's layout.
  await assert.rejects(vm.source('p.assign(originalParser);'), /KAGParser/);
} finally {
  await vm.dispose();
}

// Cached Array/Dictionary methods must belong to the new VM after disposal.
const next = await new TJSInterop().init({});
try {
  await next.nativePlugins(0, 'kagparserex.dll');
  assert.equal(await next.source('var p=new KAGParser(); p.paramMacros["x"]=["a","ok"]; p.onScenarioLoad=function(name){return "@tag x\\n";}; p.loadScenario("next.ks"); return p.getNextTag().a;'), 'ok');
} finally {
  await next.dispose();
}
console.log('KAGParserEx extensions, state and VM lifetime passed');
