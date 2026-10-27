// Error-convention smoke check: every failing WASM export returns 0 and the
// message travels through the runtime error slot (checked() / tjs_error_set).
// Covers: script errors, JS host callbacks (sync + async), read-only packed
// values, tri-state returns, native class attach, and error-slot leak parity.
import { TJSInterop } from '../../engine-js/wasm-vm.js';
import {
  defineNativeClass,
  NativeProperty,
  bindReadOnlyValue,
  createNativeInstance,
  registerLayerFields, LAYER_FIELDS, registerLayerMethods, registerFontFields,
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

// Raw membership must distinguish an existing void value from a missing key,
// without retaining the queried value as a new JS shadow.
const dictionary = await vm.source('return %["empty" => void, "object" => %[]];', 'membership');
const array = await vm.source('return [void, 3];', 'membership');
try {
  check('member set preserves chaining', dictionary.members.set('value', 7) === dictionary.members);
  check('void member exists', dictionary.members.has('empty'));
  check('missing member does not exist', !dictionary.members.has('missing'));
  const count = vm.module._tjs_runtime_handle_count(vm.runtime);
  for (let i = 0; i < 100; i++) dictionary.members.has('object');
  check('membership does not allocate handles', vm.module._tjs_runtime_handle_count(vm.runtime) === count);
  check('array void index exists', array.members.has('0'));
  check('array negative index exists', array.members.has('-1'));
  check('array out-of-range index is absent', !array.members.has('2') && !array.members.has('-3'));
} finally {
  await vm.dispose(dictionary);
  await vm.dispose(array);
}

let missingCalls = 0;
vm.registerGlobal('membershipMissingProbe', () => { missingCalls++; });
const missingObject = await vm.source(`
  class MembershipMissing {
    function missing(mode, name, value) { membershipMissingProbe(); return false; }
  }
  return new MembershipMissing();
`, 'membership-missing');
try {
  vm.setMissingHandler(missingObject);
  check('membership does not execute missing', !missingObject.members.has('absent') && missingCalls === 0);
} finally { await vm.dispose(missingObject); }

let rawReadCalls = 0;
vm.registerGlobal('rawReadProbe', async () => {
  await Promise.resolve();
  rawReadCalls++;
  return 42;
});
vm.registerGlobal('rawReadReject', async () => { throw new Error('raw-read-rejection'); });
const rawObject = await vm.source(`
  class RawReadProbe {
    property guarded { getter() { throw "getter must not run"; } }
    function missing(mode, name, value) {
      if (name == "dynamic") { *value = rawReadProbe(); return true; }
      if (name == "failed") rawReadReject();
      return false;
    }
  }
  return new RawReadProbe();
`, 'raw-read-missing');
try {
  vm.setMissingHandler(rawObject);
  check('stored reads do not execute missing', rawObject.members.get('dynamic') === undefined && rawReadCalls === 0);
  check('raw read awaits missing host callback', await vm.rawGet(rawObject, 'dynamic') === 42 && rawReadCalls === 1);
  const typed = await vm.getTyped(rawObject, 'dynamic', true);
  check('typed raw read awaits missing', typed.value === 42 && typed.text === '42' && rawReadCalls === 2);
  check('raw missing member returns void', await vm.rawGet(rawObject, 'absent') === undefined);
  const property = await vm.rawGet(rawObject, 'guarded');
  check('raw read preserves property object', property !== undefined);
  await vm.dispose(property);
  await expectThrow('raw read propagates host rejection', () => vm.rawGet(rawObject, 'failed'), /raw-read-rejection/);
  check('raw read remains usable after rejection', await vm.rawGet(rawObject, 'dynamic') === 42);
} finally { await vm.dispose(rawObject); }

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

const nativeOwner = await vm.source('new Widget()', 'native-query-owner', 0, undefined, true);
const copyValue = vm.module._tjs_value_copy;
let queryCopies = 0;
vm.module._tjs_value_copy = (...args) => { queryCopies++; return copyValue(...args); };
try {
  for (let i = 0; i < 100; i++) vm.nativeState(Widget, nativeOwner);
} finally { vm.module._tjs_value_copy = copyValue; }
check('native state reads do not copy handles', queryCopies === 0, queryCopies);
const ownedNative = createNativeInstance(Widget, { n: 7 }, nativeOwner);
vm.registerGlobal('getOwnedNativeForCheck', () => ownedNative);
let temporaryNative = await vm.source('return getOwnedNativeForCheck();', 'owned-native-first');
await vm.set(temporaryNative, 'kept', 789, true);
await vm.dispose(temporaryNative);
temporaryNative = await vm.source('return getOwnedNativeForCheck();', 'owned-native-second');
check('owner-held native survives temporary references', await vm.get(temporaryNative, 'kept') === 789);
await vm.dispose(temporaryNative);
const ownedCount = vm.module._tjs_runtime_handle_count(vm.runtime);
await vm.invalidate(nativeOwner);
check('owner invalidation releases owned native reference', vm.module._tjs_runtime_handle_count(vm.runtime) === ownedCount - 1);
await vm.dispose(nativeOwner);

// --- error slot must not accumulate handles across failing calls ---
await vm.source('failingFn();', 'warmup').catch(() => {});
const before = vm.module._tjs_runtime_handle_count(vm.runtime);
for (let i = 0; i < 10; i++) await vm.source('failingFn();', 'leak' + i).catch(() => {});
const after = vm.module._tjs_runtime_handle_count(vm.runtime);
check('failing calls do not leak handles', before === after, `${before} -> ${after}`);

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

// Layer/Font business state stays in JS. Native adapters preserve parameter
// conversion, canonical script objects and their invalidation lifetimes.
const Layer = defineNativeClass('Layer', {
  initialize: () => ({ node: {
    owner: null, parent: null, children: [], orderIndex: 0, manager: null,
    left: 0, top: 0, imageLeft: 0, imageTop: 0, opacity: 255, visible: true,
    enabled: true, absoluteOrderMode: false, absoluteOrderIndex: 0, isPrimary: false,
    type: 0, displayType: 0, face: 128, drawFace: 0, holdAlpha: false,
    hitType: 0, hitThreshold: 16, attentionLeft: 0, attentionTop: 0, useAttention: false,
    focusable: false, joinFocusChain: true, imeMode: 3, cursor: 0, cursorX: 0, cursorY: 0,
    font: { height: 23, angle: 0, flags: 0, face: 'MS Shell Dlg 2', faceIsFileName: false },
  } }),
  members: {
    ...Object.fromEntries(LAYER_FIELDS.map(([name, boolean]) => [name, new NativeProperty(
      state => Number(state.node[name]),
      (state, value) => { state.node[name] = boolean ? Boolean(value) : Number(value); },
    )])),
    parent: new NativeProperty(state => state.node.parent?.owner ?? null),
    children: new NativeProperty(state => state.node.children.map(child => child.owner)),
    order: new NativeProperty(state => state.node.orderIndex),
    font: new NativeProperty(() => { throw new Error('Font identity must stay native'); }),
    setPos(x, y, w, h) {
      this.node.left = x; this.node.top = y;
      if (arguments.length === 4 && w !== undefined && h !== undefined) sizes.push([w, h]);
    },
    setImagePos(x, y) { this.node.imageLeft = x; this.node.imageTop = y; },
  },
});
const { joinLayer, detachLayerTree, setLayerOrder, exchangeLayers,
  focusNeighbor, layerOffset, isNodeEnabled } = await import('../../engine-js/layer-tree.js');
Layer.invalidate = owner => detachLayerTree(Layer.state(owner).node);
registerLayerFields(Layer);
registerLayerMethods(Layer, { setPos: 0, setImagePos: 1 });
vm.registerGlobal('Layer', Layer);
const Font = defineNativeClass('Font', {
  initialize: () => ({ font: { height: 23, angle: 0, flags: 0, face: 'default', faceIsFileName: false } }),
  members: {
    Font(layer) { this.font = Layer.state(layer).node.font; },
    ...Object.fromEntries(['height', 'angle', 'bold', 'italic', 'strikeout', 'underline', 'face', 'faceIsFileName'].map(name => [name, new NativeProperty(
      state => state.font[name], (state, value) => { state.font[name] = value; },
    )])),
  },
});
registerFontFields(Font);
vm.registerGlobal('Font', Font);
const sizes = [];
const owners = [];
const makeLayer = async () => {
  const owner = await vm.source('new Layer()', 'js-layer', 0, undefined, true);
  const node = Layer.state(owner).node;
  node.owner = owner;
  owners.push(owner);
  return node;
};
const root = await makeLayer(), child = await makeLayer(), sibling = await makeLayer(), grandchild = await makeLayer();
let children, font, secondFont;
try {
  joinLayer(child, root); joinLayer(sibling, root); joinLayer(grandchild, child);
  check('JS tree owns parent and ordered children', child.parent === root && root.children[0] === child);
  exchangeLayers(child, sibling, false);
  check('exchange keeps children with their layer', grandchild.parent === child && root.children[1] === child);
  exchangeLayers(child, sibling, true);
  check('swap exchanges child branches', grandchild.parent === sibling);
  joinLayer(grandchild, child);
  setLayerOrder(child, 1);
  check('JS ordering maintains indices', child.orderIndex === 1 && sibling.orderIndex === 0);
  await expectThrow('JS tree rejects cycles', () => joinLayer(root, grandchild), /parent to self or descendant/);
  const other = await makeLayer();
  root.manager = {}; child.manager = root.manager; other.manager = {};
  await expectThrow('JS tree keeps manager boundaries', () => joinLayer(child, other), /another primary layer manager/);
  check('rejected join preserves original parent', child.parent === root);
  children = await vm.get(root.owner, 'children');
  const first = await vm.get(children, '0');
  check('script children follows JS Z order', vm.sameReference(first, sibling.owner));
  await vm.dispose(first);
  await vm.set(child.owner, 'left', 9007199254740993n);
  check('TJS integer conversion preserves low bits', child.left === 1);
  await vm.callMember(child.owner, 'setPos', child.owner, [4294967297n, 2, 3, 4]);
  check('setPos converts coordinates and dispatches size form', child.left === 1 && child.top === 2 && sizes.length === 1);
  await vm.callMember(child.owner, 'setPos', child.owner, [1, 2, 3, 4, 5]);
  check('setPos only resizes for exactly four arguments', sizes.length === 1);
  child.focusable = true; sibling.focusable = true;
  check('JS focus search follows Z order', focusNeighbor(sibling, 1) === child);
  sibling.focusable = false;
  check('JS focus search wraps to the only focusable layer', focusNeighbor(child, 1) === child && focusNeighbor(child, -1) === child);
  root.enabled = false;
  check('JS enabled query walks ancestors', !isNodeEnabled(child));
  root.enabled = true;
  child.left = 10; child.top = 20; grandchild.left = 1; grandchild.top = 2;
  const offset = layerOffset(grandchild);
  check('JS coordinates accumulate ancestor offsets', offset.x === 11 && offset.y === 22);
  font = await vm.get(child.owner, 'font');
  secondFont = await vm.get(child.owner, 'font');
  check('native retains canonical Font identity', vm.sameReference(font, secondFont));
  await vm.set(font, 'height', 4294967327n);
  await vm.set(font, 'face', 'test font');
  check('Font shares JS parameters with Layer', child.font.height === 31 && child.font.face === 'test font');
  child.font.height = 42;
  check('Font script reads current JS parameters', await vm.get(font, 'height') === 42);
  await vm.invalidate(child.owner);
  check('Layer invalidation invalidates its canonical Font', !vm.isValid(font));
  check('Layer invalidation detaches the JS tree', child.parent === null && grandchild.parent === null && root.children.length === 1);
  const updated = await vm.get(root.owner, 'children');
  check('children array keeps its native identity after JS mutations', vm.sameReference(children, updated) && updated.length === 1);
  await vm.dispose(updated);
} finally {
  for (const value of [font, secondFont, children]) if (value) await vm.dispose(value);
  for (const owner of owners.reverse()) {
    if (vm.isValid(owner)) await vm.invalidate(owner);
    await vm.dispose(owner);
  }
}
await vm.dispose();
check('host table empty after shutdown', vm.callbacks.size === 0, vm.callbacks.size);
console.log(failures ? `${failures} check(s) FAILED` : 'all checks passed');
process.exit(failures ? 1 : 0);
