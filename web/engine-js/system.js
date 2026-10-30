// Browser services for native SystemIntf. No script handlers or engine state live here.
import { config } from './global.js';
import { queryKeyState } from './key-state.js';

export async function createSystem({ vm }) {
  const { document, inform, arguments: args, onTitleChange } = config;
  const view = document.defaultView;
  let active = true;
  await vm.initializeSystem({
    arguments: () => new Map(Object.entries(args)),
    limitContinuous60: () => config.continuousFrameRate === 60,
    title: onTitleChange,
    inform,
    inputString: (caption, prompt, value) => view.prompt(`${caption}\n${prompt}`, value) ?? undefined,
    screenWidth: () => view.innerWidth,
    screenHeight: () => view.innerHeight,
    processorNum: () => view.navigator?.hardwareConcurrency ?? 1,
    getKeyState: (key, current) => queryKeyState(key, !!current),
    dumpHeap() {}, nullpo() {}, showVersion() {}, terminate() {}, exit() {},
  });
  return {
    async startMaintenance() { await vm.maintainSystem(true); },
    async maintain() { if (active) await vm.maintainSystem(); },
    stop() { active = false; },
    async finalize() {},
  };
}
