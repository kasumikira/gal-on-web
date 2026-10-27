// Targeted check for System.readRegValue (SystemImpl.cpp 130/785): the registry
// is emulated by RegisterData.tjs in the app data path, and the patch.tjs pattern
// (alias the native method, then replace it) must keep working.
import assert from 'node:assert/strict';
import { TJSInterop } from '../../engine-js/wasm-vm.js';
import { config } from '../../engine-js/global.js';
import { createSystem } from '../../engine-js/system.js';

const create = async (storage, graphicCache) => {
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
  const system = createSystem({ vm, enqueueEvent: callback => Promise.resolve().then(callback), storage, graphicCache });
  vm.registerGlobal('System', system.api);
  return vm;
};
const missingStorage = {
  normalize: name => String(name).toLowerCase(),
  async exists() { return false; },
  async read() { throw new Error('missing'); },
};

// --- without RegisterData.tjs every lookup is void --------------------------
let graphicClears = 0;
const vm = await create(missingStorage, { limit: 0, clear() { graphicClears++; } });
assert.equal(await vm.source('return System.readRegValue("HKEY_CURRENT_USER/Software/X");', 'reg-missing'), undefined);
assert.equal(await vm.source('return System.readRegValue("");', 'reg-empty'), undefined);
await assert.rejects(() => vm.source('System.readRegValue();', 'reg-noarg'), /requires a path/);
await vm.source('System.doCompact(5);');
assert.equal(graphicClears, 0, 'idle compact keeps the graphic cache');
await vm.source('System.doCompact("15");');
assert.equal(graphicClears, 1, 'native integer conversion selects minimize compact');
await vm.source('System.doCompact();');
assert.equal(graphicClears, 2, 'omitted level uses the strongest compact');
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
console.log('system-check passed');
await vm2.dispose();

// Maintenance follows the reference's strict interval and continuous-mode gate.
const originalPerformance = globalThis.performance;
let tick = 1500, rehashes = 0, timerJob = null, timerDelay = null;
const compactLevels = [];
Object.assign(config, { document: { defaultView: {
  requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  setTimeout(callback, delay) { timerJob = callback; timerDelay = delay; return 1; },
  clearTimeout() { timerJob = null; },
} } });
const maintenance = createSystem({ vm: {
  async compact(level) { compactLevels.push(level); },
  rehash() { rehashes++; }, retain: value => value,
  sameReference: (a, b) => a === b, async dispose() {},
}, enqueueEvent: async callback => {
  await maintenance.maintain();
  await callback();
  await maintenance.maintain();
} });
try {
  globalThis.performance = { now: () => tick };
  await maintenance.maintain();
  assert.equal(rehashes, 0);
  tick++;
  await maintenance.maintain();
  await maintenance.maintain();
  assert.equal(rehashes, 1);
  const handler = () => {};
  maintenance.api.addContinuousHandler(handler);
  tick += 2000;
  await maintenance.maintain();
  assert.equal(rehashes, 1, 'continuous delivery suppresses periodic rehash');
  await maintenance.api.removeContinuousHandler(handler);
  await maintenance.maintain();
  assert.equal(rehashes, 2, 'maintenance resumes after continuous delivery');
  tick = 4000;
  await maintenance.maintain();
  assert.deepEqual(compactLevels, []);
  tick++;
  await maintenance.maintain();
  assert.deepEqual(compactLevels, [5], 'idle maintenance uses level 5 after the strict interval');
  maintenance.startMaintenance();
  assert.equal(typeof timerJob, 'function', 'idle pages schedule an independent wakeup');
  tick += timerDelay;
  await timerJob();
  assert.equal(rehashes, 3, 'timer delivers maintenance without user input');
  maintenance.api.addContinuousHandler(handler);
  assert.equal(timerJob, null, 'continuous delivery cancels the idle wakeup');
  await maintenance.api.removeContinuousHandler(handler);
  assert.equal(typeof timerJob, 'function');
  maintenance.stop();
  assert.equal(timerJob, null);
  tick += 2000;
  await maintenance.maintain();
  assert.equal(rehashes, 3);
} finally {
  globalThis.performance = originalPerformance;
  maintenance.stop();
  await maintenance.finalize();
}
