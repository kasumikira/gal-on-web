// Keyboard state for games: modifier keys must reach the engine (previously
// Control/Shift/Alt produced key 0 and were dropped in layer-composite), and
// System.getKeyState must report physical keys/mouse buttons (SystemImpl.cpp
// TVPGetAsyncKeyState semantics: 0x01 current, 0x10 pressed-since-last-query).
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.config.mjs',
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
try {
  const { setKeyState, queryKeyState, clearKeyStates } = await server.ssrLoadModule('/engine-js/key-state.js');
  const { virtualKeyCode, virtualKeySide } = await server.ssrLoadModule('/engine-js/layer-composite.js');

  assert.equal(virtualKeyCode({ key: 'Control', code: 'ControlLeft', keyCode: 17 }), 0x11);
  assert.equal(virtualKeyCode({ key: 'Control', code: 'ControlLeft', keyCode: 0 }), 0x11);
  assert.equal(virtualKeyCode({ key: 'Shift', code: 'ShiftRight', keyCode: 0 }), 0x10);
  assert.equal(virtualKeyCode({ key: 'Alt', code: 'AltLeft', keyCode: 0 }), 0x12);
  assert.equal(virtualKeyCode({ key: 'a', keyCode: 65 }), 65);
  assert.equal(virtualKeyCode({ key: 'ArrowUp', keyCode: 38 }), 38);
  assert.equal(virtualKeyCode({ key: 'F10', keyCode: 121 }), 121);
  assert.equal(virtualKeySide({ code: 'ControlLeft' }), 0xa2);
  assert.equal(virtualKeySide({ code: 'ControlRight' }), 0xa3);
  assert.equal(virtualKeySide({ code: 'KeyA' }), 0);

  clearKeyStates();
  setKeyState(0xa2, true); // left Ctrl
  assert.equal(queryKeyState(0x11), 1, 'generic VK_CONTROL sees the held left key');
  assert.equal(queryKeyState(0xa2), 1, 'VK_LCONTROL sees its own state');
  assert.equal(queryKeyState(0xa3), 0, 'VK_RCONTROL is independent');
  assert.equal(queryKeyState(0x11, false), 0, 'the edge flag was consumed by the previous query');
  assert.equal(queryKeyState(0x11), 1, 'the key is still held');
  setKeyState(0xa2, false);
  assert.equal(queryKeyState(0x11), 0, 'release clears the current state');

  clearKeyStates();
  const press = (code, down) => {
    const event = { key: 'Control', code, keyCode: 17 };
    setKeyState(virtualKeySide(event) || virtualKeyCode(event), down);
  };
  press('ControlLeft', true);
  assert.equal(queryKeyState(0xa3), 0, 'left Ctrl does not press right Ctrl');
  press('ControlRight', true);
  press('ControlLeft', false);
  assert.equal(queryKeyState(0x11), 1, 'generic Ctrl stays pressed while right Ctrl is held');
  assert.equal(queryKeyState(0xa2), 0);
  assert.equal(queryKeyState(0xa3), 1);
  press('ControlRight', false);
  assert.equal(queryKeyState(0x11), 0);

  clearKeyStates();
  setKeyState(0xa2, true);
  setKeyState(0xa2, false);
  assert.equal(queryKeyState(0x11, false), 1, 'a press/release between queries keeps the edge flag');

  const { config } = await server.ssrLoadModule('/engine-js/global.js');
  Object.assign(config, { document: { defaultView: {} }, inform: () => {}, arguments: {}, continuousFrameRate: 60, onTitleChange: () => {} });
  const { TJSInterop } = await server.ssrLoadModule('/engine-js/wasm-vm.js');
  const { createSystem } = await server.ssrLoadModule('/engine-js/system.js');
  const vm = await new TJSInterop().init(Object.create(null));
  const system = createSystem({ vm, enqueueEvent: callback => Promise.resolve().then(callback), storage: null });
  vm.registerGlobal('System', system.api);
  setKeyState(0xa2, true);
  assert.equal(await vm.source('return System.getKeyState(17);', 'poll-generic'), 1);
  assert.equal(await vm.source('return System.getKeyState(0xA2);', 'poll-left'), 1);
  setKeyState(0xa2, false);
  assert.equal(await vm.source('return System.getKeyState(17);', 'poll-released'), 0);
  await assert.rejects(() => vm.source('System.getKeyState();', 'poll-noarg'), /requires a key code/);
  await vm.dispose();

  console.log('key-state-check passed');
  await server.close();
} catch (error) {
  await server.close();
  throw error;
}

