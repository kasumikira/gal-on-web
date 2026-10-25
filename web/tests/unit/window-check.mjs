// Window class-level notifications (windowEx.cpp 751/759): scripts call
// Window.getNotificationNum("SYSKEYDOWN") on the class object, so these helpers
// must be static and must spell the names without the WM_ prefix. Loaded through
// Vite because window.js uses native decorators.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

const server = await createServer({
  configFile: 'vite.config.mjs',
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
try {
  const { config } = await server.ssrLoadModule('/engine-js/global.js');
  Object.assign(config, { document: {}, container: {}, inform: () => {} });
  const { TJSInterop } = await server.ssrLoadModule('/engine-js/wasm-vm.js');
  const { createBasicDrawDeviceClass, createWindowClass } = await server.ssrLoadModule('/engine-js/window.js');
  const vm = await new TJSInterop().init(Object.create(null));
  const Window = createWindowClass(createBasicDrawDeviceClass());
  vm.registerGlobal('Window', Window);

  assert.equal(await vm.source('return Window.getNotificationNum("SYSKEYDOWN");', 'num'), 0x0104);
  assert.equal(await vm.source('return Window.getNotificationNum("KEYDOWN");', 'num2'), 0x0100);
  assert.equal(await vm.source('return Window.getNotificationNum("WM_SYSKEYDOWN");', 'prefixed'), -1);
  assert.equal(await vm.source('return Window.getNotificationName(0x0104);', 'name'), 'SYSKEYDOWN');
  assert.equal(await vm.source('return Window.getNotificationName(0x0100);', 'name2'), 'KEYDOWN');
  await assert.rejects(() => vm.source('Window.getNotificationNum();', 'noarg'), /requires a name/);
  console.log('window-check passed');
  await vm.dispose();
} finally {
  await server.close();
}
