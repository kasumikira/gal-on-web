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
    document: { defaultView: {} }, inform: () => {}, arguments: {},
    continuousFrameRate: 60, onTitleChange: () => {},
  });
  vm.attachStorage({
    ...storage, currentDirectory: '/',
    getPlacedPath: async name => await storage.exists(name) ? name : '',
    readPlaced: name => storage.read(name),
  });
  const system = createSystem({ vm, enqueueEvent: callback => Promise.resolve().then(callback), storage });
  vm.registerGlobal('System', system.api);
  return vm;
};
const missingStorage = {
  normalize: name => String(name).toLowerCase(),
  async exists() { return false; },
  async read() { throw new Error('missing'); },
};

// --- without RegisterData.tjs every lookup is void --------------------------
const vm = await create(missingStorage);
assert.equal(await vm.source('return System.readRegValue("HKEY_CURRENT_USER/Software/X");', 'reg-missing'), undefined);
assert.equal(await vm.source('return System.readRegValue("");', 'reg-empty'), undefined);
await assert.rejects(() => vm.source('System.readRegValue();', 'reg-noarg'), /requires a path/);
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
console.log('system-check passed');
await vm2.dispose();
