// Rect native class from RectItf.cpp over tTVPRect (ComplexRect.h).
// Rect { left, top, right, bottom }; width = right-left, height = bottom-top.
import { nativeClass, nativeMethod, nativeProperty } from '#krkr/native';
import { Closure, number } from '#krkr/values';

const unwrap = value => value instanceof Closure ? value.object : value;
const instanceOf = (Rect, owner) => {
  const state = Rect.instances.get(unwrap(owner));
  if (!state) throw new Error('TJS Rect native instance not found');
  return state;
};
const rectOf = (Rect, value) => instanceOf(Rect, value).rect;
const int = value => Math.trunc(number(value));

export function createRectClass() {
  @nativeClass('Rect')
  class Rect {
    static initialize() { return { rect: { left: 0, top: 0, right: 0, bottom: 0 } }; }

    // RectItf.cpp 8: () empty, (rect) copy, or (l, t, r, b).
    @nativeMethod Rect(...args) {
      const state = this;
      if (!args.length) return;
      if (args.length === 1) {
        const ref = rectOf(Rect, args[0]);
        state.rect = { left: ref.left, top: ref.top, right: ref.right, bottom: ref.bottom };
      } else if (args.length === 4) {
        state.rect = { left: int(args[0]), top: int(args[1]), right: int(args[2]), bottom: int(args[3]) };
      } else throw new Error('TJS Rect constructor requires 0, 1 or 4 arguments');
    }
    // RectItf.cpp 55: empty means left>=right || top>=bottom.
    @nativeMethod isEmpty() {
      const rect = this.rect;
      return Number(rect.left >= rect.right || rect.top >= rect.bottom);
    }
    @nativeMethod setSize(w, h) {
      if (arguments.length < 2) throw new Error('TJS Rect.setSize requires 2 arguments');
      const rect = this.rect;
      rect.right = rect.left + int(w);
      rect.bottom = rect.top + int(h);
    }
    @nativeMethod setOffset(x, y) {
      if (arguments.length < 2) throw new Error('TJS Rect.setOffset requires 2 arguments');
      const rect = this.rect;
      rect.right = int(x) + (rect.right - rect.left);
      rect.bottom = int(y) + (rect.bottom - rect.top);
      rect.left = int(x); rect.top = int(y);
    }
    @nativeMethod addOffset(x, y) {
      if (arguments.length < 2) throw new Error('TJS Rect.addOffset requires 2 arguments');
      const rect = this.rect;
      rect.left += int(x); rect.right += int(x);
      rect.top += int(y); rect.bottom += int(y);
    }
    @nativeMethod clear() { const rect = this.rect; rect.left = rect.top = rect.right = rect.bottom = 0; }
    @nativeMethod set(l, t, r, b) {
      if (arguments.length < 4) throw new Error('TJS Rect.set requires 4 arguments');
      const rect = this.rect;
      rect.left = int(l); rect.top = int(t); rect.right = int(r); rect.bottom = int(b);
    }
    // ComplexRect.cpp TVPIntersectRect: keeps the intersection, returns
    // whether anything remains.
    @nativeMethod clip(src) {
      if (!arguments.length) throw new Error('TJS Rect.clip requires a rect');
      const rect = this.rect, ref = rectOf(Rect, src);
      const left = Math.max(rect.left, ref.left), top = Math.max(rect.top, ref.top);
      const right = Math.min(rect.right, ref.right), bottom = Math.min(rect.bottom, ref.bottom);
      if (right > left && bottom > top) {
        rect.left = left; rect.top = top; rect.right = right; rect.bottom = bottom;
        return 1;
      }
      return 0;
    }
    @nativeMethod union(src) {
      if (!arguments.length) throw new Error('TJS Rect.union requires a rect');
      const rect = this.rect, ref = rectOf(Rect, src);
      if (ref.left >= ref.right || ref.top >= ref.bottom) return 0;
      if (rect.left > ref.left) rect.left = ref.left;
      if (rect.top > ref.top) rect.top = ref.top;
      if (rect.right < ref.right) rect.right = ref.right;
      if (rect.bottom < ref.bottom) rect.bottom = ref.bottom;
      return 1;
    }
    @nativeMethod intersects(src) {
      if (!arguments.length) throw new Error('TJS Rect.intersects requires a rect');
      const rect = this.rect, ref = rectOf(Rect, src);
      if (ref.left >= ref.right || ref.top >= ref.bottom || rect.left >= rect.right || rect.top >= rect.bottom) return 0;
      return !(rect.left >= ref.right || rect.top >= ref.bottom || rect.right <= ref.left || rect.bottom <= ref.top) ? 1 : 0;
    }
    @nativeMethod included(src, top) {
      // Two forms: included(rect) → included_in, or included(x, y) → point
      // test (RectItf.h 54).
      const rect = this.rect;
      if (arguments.length >= 2) {
        const x = int(src), y = int(top);
        return x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom ? 1 : 0;
      }
      if (!arguments.length) throw new Error('TJS Rect.included requires a rect or a point');
      const ref = rectOf(Rect, src);
      if (ref.left >= ref.right || ref.top >= ref.bottom || rect.left >= rect.right || rect.top >= rect.bottom) return 0;
      return ref.left <= rect.left && ref.top <= rect.top && ref.right >= rect.right && ref.bottom >= rect.bottom ? 1 : 0;
    }
    @nativeMethod includedPos(x, y) {
      if (arguments.length < 2) throw new Error('TJS Rect.includedPos requires 2 arguments');
      const rect = this.rect;
      const px = int(x), py = int(y);
      return px >= rect.left && px < rect.right && py >= rect.top && py < rect.bottom ? 1 : 0;
    }
    @nativeMethod equal(src) {
      if (!arguments.length) throw new Error('TJS Rect.equal requires a rect');
      const rect = this.rect, ref = rectOf(Rect, src);
      return rect.left === ref.left && rect.top === ref.top && rect.right === ref.right && rect.bottom === ref.bottom ? 1 : 0;
    }

    @nativeProperty get width() { const rect = this.rect; return rect.right - rect.left; }
    @nativeProperty set width(value) { const rect = this.rect; rect.right = rect.left + int(value); }
    @nativeProperty get height() { const rect = this.rect; return rect.bottom - rect.top; }
    @nativeProperty set height(value) { const rect = this.rect; rect.bottom = rect.top + int(value); }
    @nativeProperty get left() { return this.rect.left; }
    @nativeProperty set left(value) { this.rect.left = int(value); }
    @nativeProperty get top() { return this.rect.top; }
    @nativeProperty set top(value) { this.rect.top = int(value); }
    @nativeProperty get right() { return this.rect.right; }
    @nativeProperty set right(value) { this.rect.right = int(value); }
    @nativeProperty get bottom() { return this.rect.bottom; }
    @nativeProperty set bottom(value) { this.rect.bottom = int(value); }
    // nativeArray exposes the C++ int[4] address; scripts using it need the
    // pointer identity, which has no browser meaning (RectItf.cpp 336).
    @nativeProperty get nativeArray() { return 0; }
    @nativeProperty set nativeArray(value) {}
  }
  return Rect;
}
