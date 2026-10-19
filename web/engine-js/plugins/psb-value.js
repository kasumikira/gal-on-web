// PSBFile.cpp PSBValueDispatch: read-only views, not mutable TJS containers.
import { bindReadOnlyValue } from '#krkr/native';
export class PSBValue {
  constructor(node) {
    this.node = node;
    this.classNames = new Set([node.category === 6 ? 'Array' : 'Dictionary']);
    bindReadOnlyValue(this, {
      ...(node.category === 6 ? { length: node.count } : { keys: node.keys() }),
      get: name => this.get(name),
    });
  }
  get length() { return this.node.count; }
  has(name) { return this.node.category === 6 ? name === 'count' || /^\d+$/.test(String(name)) && Number(name) < this.length : this.node.has(String(name)); }
  get(name) {
    if (this.node.category === 6) {
      if (name === 'count') return this.length;
      return psbVariant(this.node.toArray()[Number(name)]);
    }
    return psbVariant(this.node.get(String(name)));
  }
  get members() { return new Map(this.node.category === 6 ? [...this].map((value, i) => [String(i), value]) : this.node.keys().map(key => [key, this.get(key)])); }
  *[Symbol.iterator]() { for (const node of this.node.toArray()) yield psbVariant(node); }
}
export function psbVariant(node) {
  if (!node) return undefined;
  if (node.category === 6 || node.category === 7) return new PSBValue(node);
  const value = node.toValue();
  return typeof value === 'boolean' ? Number(value) : value;
}
