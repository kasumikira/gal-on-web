// SystemImpl.cpp TVPGetAsyncKeyState / MainScene.cpp TVPGetKeyMouseAsyncState:
// scripts poll physical keys and mouse buttons through System.getKeyState. The
// bit layout matches the reference _scancode table: 0x01 is the current state and
// 0x10 means "pressed since the previous query"; every query clears 0x10.
const states = new Map();
// Generic modifier state is the aggregate of its side-specific VK states.
const MODIFIER_SIDES = new Map([
  [0x11, [0xa2, 0xa3]], [0x10, [0xa0, 0xa1]], [0x12, [0xa4, 0xa5]],
]);
const bits = code => states.get(code) ?? 0;

export function setKeyState(code, down) {
  code = Math.trunc(Number(code)) & 0xffff;
  if (!code) return;
  const current = bits(code);
  states.set(code, down ? current | 0x11 : current & ~0x01);
}

export function queryKeyState(code, getcurrent = true) {
  code = Math.trunc(Number(code)) & 0xffff;
  const sides = MODIFIER_SIDES.get(code);
  if (sides) {
    const values = [code, ...sides];
    const current = values.reduce((combined, value) => combined | bits(value), 0);
    for (const value of values) states.set(value, bits(value) & ~0x10);
    return (current & (getcurrent ? 0x01 : 0x10)) !== 0 ? 1 : 0;
  }
  const current = bits(code);
  states.set(code, current & ~0x10);
  return (current & (getcurrent ? 0x01 : 0x10)) !== 0 ? 1 : 0;
}

// Focus loss: no keyup arrives for keys held while the window lost focus.
export function clearKeyStates() { states.clear(); }
