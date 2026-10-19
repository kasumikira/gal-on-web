import { nativeClass, nativeMethod } from '#krkr/native';

// PadIntf.cpp's active port disables the editor (PadImpl.cpp is under #if 0).
// Its getters return constants and setters succeed without retaining values.
export function createPadClass() {
  @nativeClass('Pad')
  class Pad {
    @nativeMethod Pad() {}
  }
  const defaults = {
    text: '', fileName: '', color: 0, visible: 0, title: '',
    fontColor: 0, fontHeight: 10, fontSize: 10, fontBold: 0, fontItalic: 0,
    fontUnderline: 0, fontStrikeOut: 0, fontFace: '', readOnly: 1,
    wordWrap: 0, opacity: 255, showStatusBar: 0, showScrollBars: 0,
    statusText: '', borderStyle: 0, width: 100, height: 100, top: 0, left: 0,
  };
  for (const [name, value] of Object.entries(defaults)) {
    Pad.defineProperty(name, () => value, () => {});
  }
  return Pad;
}
