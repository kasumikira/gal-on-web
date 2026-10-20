import { callScript, readScript, readScriptTyped, retainScriptValue, disposeScriptValue } from '#krkr/native';
import { string, integer, TJSValueType } from '#krkr/values';
import { encodeTextStream } from '../text-stream.js';

function quote(value) {
  let result = '"';
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0) break;
    const character = value[i];
    result += character === '"' ? '\\"' : character === '\\' ? '\\\\' : character;
  }
  return result + '"';
}

function quoteOctet(bytes) {
  let result = '<% ';
  for (const byte of bytes) result += `${byte.toString(16).padStart(2, '0')} `;
  return result + '%>';
}

async function formatObject(object, newline) {
  if (object.classNames.has('Array')) {
    const count = object.length;
    const items = [];
    for (let i = 0; i < count; i++) {
      const item = await readScriptTyped(object, String(i), { ignoreProperty: true });
      try { items.push(await formatValue(item, newline)); }
      finally { await disposeScriptValue(item.value); }
    }
    return `[${items.join(',')}]`;
  }

  const members = [];
  for (const name of object.members.keys()) {
    const item = await readScriptTyped(object, name, { ignoreProperty: true });
    try { members.push(`${quote(name)}=>${await formatValue(item, newline)}`); }
    finally { await disposeScriptValue(item.value); }
  }
  return `%[${members.join(`,${newline}`)}]`;
}

async function formatValue({ type, value, text }, newline) {
  switch (type) {
    case TJSValueType.VOID: return 'void';
    case TJSValueType.OBJECT:
      if (value === null) return 'nullptr';
      if (value && (typeof value === 'object' || typeof value === 'function')) {
        const held = retainScriptValue(value);
        try { return await formatObject(held, newline); }
        finally { await disposeScriptValue(held); }
      }
      return 'nullptr';
    case TJSValueType.STRING: return quote(value);
    case TJSValueType.OCTET: return quoteOctet(value);
    case TJSValueType.INTEGER: return `int ${text}`;
    case TJSValueType.REAL: return `real ${text}`;
    default: return 'void';
  }
}

function encodeStructText(text) {
  const bytes = new Uint8Array(text.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
  return bytes;
}

async function formatReceiver(receiver, lf) {
  const held = retainScriptValue(receiver);
  try { return await formatObject(held, integer(lf) ? '\n' : '\r\n'); }
  finally { await disposeScriptValue(held); }
}

// saveStruct.cpp writes the struct stream as UTF-16 code units directly, with
// no text-stream BOM. The existing save2 method is a separate line-oriented
// format and continues to use TextStream encoding.
export function registerSaveStruct({ storage, get, registerMembers }) {
  registerMembers(get('Array'), {
    async save2(name, utf, lf = 0) {
      if (!arguments.length) throw new Error('Array.save2 requires a filename');
      name = string(name);
      const newline = integer(lf) ? '\n' : '\r\n';
      const held = retainScriptValue(this);
      try {
        const count = await readScript(held, 'count');
        const text = count ? await callScript(held, 'join', [newline]) + newline : '';
        await storage.write(name, encodeTextStream(text));
      } finally {
        await disposeScriptValue(held);
      }
    },
    async saveStruct2(name, utf, lf = 0) {
      if (!arguments.length) throw new Error('Array.saveStruct2 requires a filename');
      await storage.write(string(name), encodeStructText(await formatReceiver(this, lf)));
    },
    async toStructString(lf = 0) {
      return formatReceiver(this, lf);
    },
  });

  registerMembers(get('Dictionary'), {
    async saveStruct2(name, utf, lf = 0) {
      if (!arguments.length) throw new Error('Dictionary.saveStruct2 requires a filename');
      await storage.write(string(name), encodeStructText(await formatReceiver(this, lf)));
    },
    async toStructString(lf = 0) {
      return formatReceiver(this, lf);
    },
  }, { hidden: true });
}
