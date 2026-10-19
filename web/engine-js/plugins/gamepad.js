import { nativeClass, nativeMethod, nativeProperty, createNativeInstance } from '#krkr/native';
import { number } from '#krkr/values';

// Match krkrz/gamepad's Main.cpp and GamepadInputContext.cpp. Browser standard
// mapping uses different shoulder indices and the opposite stick Y direction.
export function registerGamepad({ registerGlobal }) {
  const pads = () => typeof navigator === 'undefined' ? [] : [...(navigator.getGamepads?.() ?? [])];
  const button = (pad, index) => !!pad?.buttons[index]?.pressed;
  const axis = (pad, index) => {
    const value = (pad?.axes[index] ?? 0) * (index % 2 ? -1 : 1);
    const deadzone = (index < 2 ? 7849 : 8689) / 32767;
    return Math.abs(value) <= deadzone ? 0 : Math.sign(value) * (Math.abs(value) - deadzone) / (1 - deadzone);
  };
  const mapping = {
    0: 12, 1: 13, 2: 14, 3: 15, 4: 9, 5: 8, 6: 10, 7: 11,
    8: 4, 9: 5, 12: 0, 13: 1, 14: 2, 15: 3,
  };
  const buttonNames = {
    DpadUp: 0, DpadDown: 1, DpadLeft: 2, DpadRight: 3, Start: 4, Back: 5,
    LeftThumb: 6, RightThumb: 7, LeftShoulder: 8, RightShoulder: 9,
    A: 12, B: 13, X: 14, Y: 15,
  };
  Object.assign(global, {
    gpDInput: 3, gpFFDInput: 2, gpXInput: 1,
    gpLeftAxisX: 0x10000, gpLeftAxisY: 0x20000, gpRightAxisX: 0x40000, gpRightAxisY: 0x80000,
    gpLeftTrigger: 0x100000, gpRightTrigger: 0x200000,
    gpTouchNo: 0, gpTouchDown: 1, gpTouchLiftoff: 0,
  });
  for (const [name, bit] of Object.entries(buttonNames)) global[`gpButton${name}`] = 1 << bit;
  const counters = {};
  for (const side of ['Left', 'Right']) {
    const index = side === 'Left' ? 0 : 2;
    counters[`analog${side}UpCount`] = state => axis(state.pad, index + 1) > 0;
    counters[`analog${side}DownCount`] = state => axis(state.pad, index + 1) < 0;
    counters[`analog${side}LeftCount`] = state => axis(state.pad, index) < 0;
    counters[`analog${side}RightCount`] = state => axis(state.pad, index) > 0;
    counters[`button${side}TriggerCount`] = state => state.pad?.buttons[side === 'Left' ? 6 : 7]?.value > 0;
  }
  for (const [name, bit] of Object.entries(buttonNames)) {
    const property = name.startsWith('Dpad') ? `degital${name.slice(4)}Count` : `button${name}Count`;
    counters[property] = state => button(state.pad, mapping[bit]);
  }
  @nativeClass('Gamepad')
  class Gamepad {
    constructor(index = 0) {
      this.index = Math.trunc(number(index));
      this.pad = pads()[this.index] ?? null;
      this.counts = Object.fromEntries(Object.keys(counters).map(name => [name, 0]));
    }
    @nativeMethod update() {
      this.pad = pads()[this.index] ?? null;
      for (const [name, pressed] of Object.entries(counters)) {
        const previous = this.counts[name];
        this.counts[name] = pressed(this)
          ? previous <= 0 ? 1 : Math.min(2147483647, previous + 1)
          : previous > 0 ? 0 : Math.max(-2147483648, previous - 1);
      }
    }
    @nativeProperty get name() { return this.pad?.id ?? ''; }
    @nativeProperty get type() { return this.pad ? 1 : 0; }
    @nativeProperty get leftTrigger() { return this.pad?.buttons[6]?.value ?? 0; }
    @nativeProperty get rightTrigger() { return this.pad?.buttons[7]?.value ?? 0; }
    @nativeProperty get leftThumbStickX() { return axis(this.pad, 0); }
    @nativeProperty get leftThumbStickY() { return axis(this.pad, 1); }
    @nativeProperty get rightThumbStickX() { return axis(this.pad, 2); }
    @nativeProperty get rightThumbStickY() { return axis(this.pad, 3); }
    @nativeProperty get keyState() {
      let mask = 0;
      for (const [bit, index] of Object.entries(mapping)) if (button(this.pad, index)) mask |= 1 << bit;
      return mask;
    }
    @nativeProperty set leftVibration(value) { return this.vibrate('weakMagnitude', value); }
    @nativeProperty set rightVibration(value) { return this.vibrate('strongMagnitude', value); }
    async vibrate(channel, value) {
      const actuator = this.pad?.vibrationActuator;
      if (!actuator) return;
      await actuator.playEffect('dual-rumble', { duration: 100, [channel]: Math.max(0, Math.min(1, number(value))) });
    }
  }
  for (const name of Object.keys(counters)) Gamepad.defineProperty(name, state => state.counts[name]);
  @nativeClass('GamepadPort')
  class GamepadPort {
    @nativeMethod initialize() {}
    @nativeMethod finalize() {}
    @nativeProperty get count() { return pads().filter(Boolean).length; }
    @nativeMethod getController(index) {
      const selected = pads().filter(Boolean)[Math.trunc(number(index))];
      if (!selected) throw new Error('GamepadPort.getController: invalid controller index');
      return createNativeInstance(Gamepad, new Gamepad(selected.index));
    }
  }
  registerGlobal('Gamepad', Gamepad);
  registerGlobal('GamepadPort', GamepadPort);
}
