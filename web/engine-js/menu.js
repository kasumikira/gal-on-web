import { nativeClass, nativeMethod, nativeEvent, nativeProperty, nativeDictionary, nativeOwnedArray, nativeOwner, callScript, retainScriptValue, disposeScriptValue, invalidateScriptValue } from '#krkr/native';
import { truth, number } from '#krkr/values';

// MenuItemIntf.cpp / MenuItemImpl.cpp: hierarchy and script event dispatch.
export function createMenuItemClass(Window) {
  const state = value => MenuItem.state(value);
  const root = value => { let item = value; while (item.parent) item = state(item.parent); return item; };

  @nativeClass('MenuItem')
  class MenuItem {
    static initialize(owner) {
      const childrenArray = nativeOwnedArray(owner);
      return {
        owner, actionOwner: null, window: null, parent: null, children: [], childrenArray,
        caption: '', checked: false, enabled: true, radio: false, visible: true, group: 0,
      };
    }

    @nativeMethod MenuItem(actionOwner, caption) {
      if (!arguments.length) throw new Error('TJS MenuItem requires an action owner');
      const s = this;
      s.actionOwner = retainScriptValue(actionOwner, this);
      if (caption !== null && (typeof caption === 'object' || typeof caption === 'function')) {
        const owner = nativeOwner(caption);
        Window.state(owner);
        s.window = owner;
      } else if (arguments.length >= 2) s.caption = caption === undefined ? '' : String(caption);
    }
    @nativeMethod add(value) {
      if (!arguments.length) throw new Error('TJS MenuItem.add requires an item');
      const s = this, child = state(value);
      if (!s.children.includes(child.owner)) {
        s.childrenArray.push(child.owner);
        s.children.push(child.owner); child.parent = nativeOwner(this);
      }
    }
    @nativeMethod insert(value, index) {
      if (arguments.length < 2) throw new Error('TJS MenuItem.insert requires an item and index');
      const s = this, child = state(value), position = Math.trunc(number(index));
      if (position < 0 || position > s.children.length) throw new Error('TJS MenuItem index out of range');
      if (!s.children.includes(child.owner)) {
        s.childrenArray.splice(position, 0, child.owner);
        s.children.splice(position, 0, child.owner); child.parent = nativeOwner(this);
      }
    }
    @nativeMethod remove(value) {
      if (!arguments.length) throw new Error('TJS MenuItem.remove requires an item');
      const s = this, child = state(value), index = s.children.indexOf(child.owner);
      if (index >= 0) { s.childrenArray.splice(index, 1); s.children.splice(index, 1); child.parent = null; }
    }
    @nativeMethod popup() { throw new Error('TJS MenuItem.popup rendering is not implemented yet'); }
    @nativeEvent async onClick() {
      if (nativeOwner(this.actionOwner) != null) {
        const event = nativeDictionary(this, [['type', 'onClick'], ['target', this]]);
        try {
          const result = await callScript(this.actionOwner, 'action', [event], { ignoreMissing: true });
          await disposeScriptValue(result);
        } finally { await disposeScriptValue(event); }
      }
    }
    @nativeMethod async fireClick() {
      const s = this;
      for (let item = s; item; item = item.parent ? state(item.parent) : null) if (!item.enabled) return;
      const window = root(s).window;
      if (!window || !Window.state(window).visible || !Window.state(window).enabled) return;
      await this.onClick();
    }

    @nativeProperty get caption() { return this.caption; }
    @nativeProperty set caption(value) { this.caption = String(value); }
    @nativeProperty get enabled() { return this.enabled; }
    @nativeProperty set enabled(value) { this.enabled = truth(value); }
    @nativeProperty get radio() { return this.radio; }
    @nativeProperty set radio(value) { this.radio = truth(value); }
    @nativeProperty get visible() { return this.visible; }
    @nativeProperty set visible(value) { this.visible = truth(value); }
    @nativeProperty get group() { return this.group; }
    @nativeProperty set group(value) { this.group = Math.trunc(number(value)); }
    @nativeProperty get checked() { return this.checked; }
    @nativeProperty set checked(value) {
      const s = this, checked = truth(value);
      if (checked && s.radio && s.parent) for (const child of state(s.parent).children) {
        const sibling = state(child);
        if (sibling.radio && sibling.group === s.group) sibling.checked = false;
      }
      s.checked = checked;
    }
    @nativeProperty get shortcut() { return ''; }
    @nativeProperty set shortcut(value) {}
    @nativeProperty get index() {
      const s = this;
      return s.parent ? Math.max(0, state(s.parent).children.indexOf(s.owner)) : 0;
    }
    @nativeProperty set index(value) {}
    @nativeProperty get parent() { return this.parent; }
    @nativeProperty get root() { return root(this).owner; }
    @nativeProperty get window() { return root(this).window; }
    @nativeProperty get children() {
      return this.childrenArray;
    }
    @nativeProperty get HMENU() { return 0; }
  }
  MenuItem.invalidate = async owner => {
    const s = state(owner);
    if (s.parent) {
      const parent = state(s.parent);
      const index = parent.children.indexOf(s.owner);
      if (index >= 0) { parent.children.splice(index, 1); parent.childrenArray.splice(index, 1); }
    }
    // MenuItemIntf.cpp: invalidate descendants before releasing the child array.
    // Each child's native cleanup removes it from this parent's list.
    while (s.children.length) await invalidateScriptValue(s.children[0]);
    s.parent = null;
    if (s.actionOwner) await disposeScriptValue(s.actionOwner);
    await disposeScriptValue(s.childrenArray);
    s.actionOwner = null;
    s.childrenArray = null;
  };
  return MenuItem;
}
