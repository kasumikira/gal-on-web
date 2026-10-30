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

const NAMED_KEY_CODES = {
  Enter: 0x0d, Escape: 0x1b, Space: 0x20, Tab: 0x09, Backspace: 0x08,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Insert: 0x2d, Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  CapsLock: 0x14, Pause: 0x13, ScrollLock: 0x91, NumLock: 0x90, PrintScreen: 0x2c,
  ContextMenu: 0x5d, Shift: 0x10, Control: 0x11, Alt: 0x12, Meta: 0x5b,
};
const KEY_CODE_ALIASES = {
  ControlLeft: 0x11, ControlRight: 0x11, ShiftLeft: 0x10, ShiftRight: 0x10,
  AltLeft: 0x12, AltRight: 0x12, MetaLeft: 0x5b, MetaRight: 0x5c,
};
// Side-specific virtual keys for System.getKeyState (VK_LCONTROL and friends).
const SIDE_KEY_CODES = {
  ControlLeft: 0xa2, ControlRight: 0xa3, ShiftLeft: 0xa0,
  ShiftRight: 0xa1, AltLeft: 0xa4, AltRight: 0xa5,
};
export function virtualKeyCode(event) {
  const code = event.keyCode || KEY_CODE_ALIASES[event.code] || NAMED_KEY_CODES[event.key];
  if (code) return code;
  return event.key?.length === 1 ? event.key.toUpperCase().charCodeAt(0) : 0;
}
export function virtualKeySide(event) {
  return SIDE_KEY_CODES[event.code] ?? 0;
}
