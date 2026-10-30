// Targeted check for System.readRegValue (SystemImpl.cpp 130/785): the registry
// is emulated by RegisterData.tjs in the app data path, and the patch.tjs pattern
// (alias the native method, then replace it) must keep working.
import assert from 'node:assert/strict';
import { TJSInterop } from '../../engine-js/wasm-vm.js';
import { config } from '../../engine-js/global.js';
import { createSystem } from '../../engine-js/system.js';

const create = async storage => {
  const vm = await new TJSInterop().init(Object.create(null));
  Object.assign(config, {
    document: { defaultView: {} }, inform: () => {}, arguments: { startup: "value" },
    continuousFrameRate: 60, onTitleChange: () => {},
  });
  vm.attachStorage({
    ...storage, currentDirectory: '/',
    getPlacedPath: async name => await storage.exists(name) ? name : '',
    readPlaced: name => storage.read(name),
  });
  const system = await createSystem({ vm, storage });
  await system.startMaintenance();
  return vm;
};
const missingStorage = {
  normalize: name => String(name).toLowerCase(),
  async exists() { return false; },
  async read() { throw new Error('missing'); },
};

// --- without RegisterData.tjs every lookup is void --------------------------
const vm = await create(missingStorage);
assert.equal(await vm.source('return System.getArgument("startup");'), "value");
assert.equal(await vm.source('return System.readRegValue("HKEY_CURRENT_USER/Software/X");', 'reg-missing'), undefined);
assert.equal(await vm.source('return System.readRegValue("");', 'reg-empty'), undefined);
await assert.rejects(() => vm.source('System.readRegValue();', 'reg-noarg'), /Invalid argument count/);
await vm.source('System.doCompact(5);');
await vm.source('System.doCompact("15");');
assert.equal(await vm.source('return System.graphicCacheLimit;'), 0);
await vm.source('System.doCompact();');
assert.equal(await vm.source('return System.graphicCacheLimit;'), 0);
assert.equal(await vm.compact(), 100);
await assert.rejects(vm.compact(null), /Cannot convert/);
assert.equal(await vm.compact(-1), -1);
await vm.dispose();

// --- RegisterData.tjs is evaluated as an expression and walked --------------
const data = '%[ "HKEY_CURRENT_USER" => %[ "Software" => %[ "Foo" => "bar", "N" => 42 ] ] ]';
const registryStorage = {
  normalize: name => String(name).toLowerCase(),
  async exists(name) { return name === '/registerdata.tjs'; },
  async read(name) { return name === '/registerdata.tjs' ? new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(data, 'utf16le')])) : new Uint8Array(); },
};
const vm2 = await create(registryStorage);
assert.equal(await vm2.source('return System.readRegValue("HKEY_CURRENT_USER/Software/Foo");', 'reg-foo'), 'bar');
assert.equal(await vm2.source('return System.readRegValue("HKEY_CURRENT_USER/Software/N");', 'reg-n'), 42);
assert.equal(await vm2.source('return System.readRegValue("HKEY_CURRENT_USER/Software/Gone");', 'reg-gone'), undefined);
assert.equal(await vm2.source('return System.readRegValue("HKEY_CURRENT_USER/Software/Foo/Deep");', 'reg-deep'), undefined);

// --- patch.tjs aliases the native method, then replaces it ------------------
const patched = await vm2.source(`
System._readRegValue = System.readRegValue;
System.readRegValue = function(path) {
  var prefix = "HKEY_LOCAL_MACHINE/Software/Microsoft/Windows/CurrentVersion/Uninstall";
  if(path.substr(0, prefix.length) == prefix) return "1";
  return "";
};
return [System.readRegValue("HKEY_LOCAL_MACHINE/Software/Microsoft/Windows/CurrentVersion/Uninstall/X"),
        System._readRegValue("HKEY_CURRENT_USER/Software/Foo")];
`, 'patch');
assert.deepEqual(patched, ['1', 'bar'], 'the aliased native method and the replacement both work');
await vm2.dispose();

// Maintenance and continuous-handler ownership now run in the native VM.
const vm3 = await create(missingStorage);
let continuous = false;
await vm3.visualEvents(0, { schedule() {}, continuous(value) { continuous = !!value; } });
await vm3.source('var calls = 0; function handler(tick) { calls++; } System.addContinuousHandler(handler); System.addContinuousHandler(handler);');
assert.equal(continuous, true);
await vm3.visualEvents(2);
assert.equal(await vm3.source('return calls;'), 1, 'native handler registration deduplicates the closure');
await vm3.source('System.eventDisabled = true;');
assert.equal(await vm3.source('return System.eventDisabled;'), 1);
await vm3.visualEvents(2);
assert.equal(await vm3.source('return calls;'), 1, 'eventDisabled gates script continuous delivery');
await vm3.source('System.eventDisabled = false; System.removeContinuousHandler(handler);');
await vm3.visualEvents(2);
assert.equal(continuous, false);
await vm3.source('System.setArgument("test", 42);');
assert.equal(await vm3.source('return System.getArgument("test");'), '42');
await vm3.dispose();

console.log("system-check passed");
