// Serialized opcode names for developer bytecode inspection.
const names = ['NOP','CONST','CP','CL','CCL','TT','TF','CEQ','CDEQ','CLT','CGT','SETF','SETNF','LNOT','NF','JF','JNF','JMP'];
for (const name of ['INC','DEC','LOR','LAND','BOR','BXOR','BAND','SAR','SAL','SR','ADD','SUB','MOD','DIV','IDIV','MUL']) names.push(name, name+'PD', name+'PI', name+'P');
names.push('BNOT','TYPEOF','TYPEOFD','TYPEOFI','EVAL','EEXP','CHKINS','ASC','CHR','NUM','CHS','INV','CHKINV','INT','REAL','STR','OCTET','CALL','CALLD','CALLI','NEW','GPD','SPD','SPDE','SPDEH','GPI','SPI','SPIE','GPDS','SPDS','GPIS','SPIS','SETP','GETP','DELD','DELI','SRV','RET','ENTRY','EXTRY','THROW','CHGTHIS','GLOBAL','ADDCI','REGMEMBER','DEBUGGER');
export const opcodes = Object.fromEntries(names.map((name, value) => [name, value]));

// TJS2 100 bytecode layout, ported from tjsByteCodeLoader.cpp.
const decoder = new TextDecoder('utf-16le');
export function loadBytecode(bytes) {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const i32 = () => { const v = data.getInt32(offset, true); offset += 4; return v; };
  const i16 = () => { const v = data.getInt16(offset, true); offset += 2; return v; };
  const tag = expected => {
    const actual = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    offset += 4;
    if (actual !== expected) throw new Error(`Invalid TJS bytecode tag: ${actual}`);
  };
  const array = read => Array.from({ length: i32() }, read);
  tag('TJS2'); tag('100\0');
  if (i32() !== bytes.length) throw new Error('TJS bytecode size mismatch');
  tag('DATA');
  const dataSize = i32();
  const byte = array(() => data.getInt8(offset++));
  offset = (offset + 3) & ~3;
  const short = array(i16);
  offset = (offset + 3) & ~3;
  const integer = array(i32);
  const long = array(() => { const v = data.getBigInt64(offset, true); offset += 8; return v; });
  const real = array(() => { const v = data.getFloat64(offset, true); offset += 8; return v; });
  const strings = array(() => {
    const length = i32();
    const value = decoder.decode(bytes.subarray(offset, offset + length * 2));
    offset += (length * 2 + 3) & ~3;
    return value;
  });
  const octets = array(() => {
    const length = i32();
    const value = bytes.slice(offset, offset + length);
    offset += (length + 3) & ~3;
    return value;
  });
  if (offset !== 12 + dataSize) throw new Error('Invalid TJS data area size');
  tag('OBJS');
  const objectSize = i32();
  const topLevel = i32();
  const replacements = [];
  const pools = { 3: strings, 4: octets, 5: real, 6: byte, 7: short, 8: integer, 9: long };
  const objects = array(() => {
    tag('TJS2');
    const size = i32();
    const end = offset + size;
    const object = {};
    for (const field of ['parentIndex', 'nameIndex', 'contextType', 'maxVariableCount', 'variableReserveCount', 'maxFrameCount', 'argumentCount', 'unnamedArgumentBase', 'collapseBase', 'setterIndex', 'getterIndex', 'superClassGetterIndex']) object[field] = i32();
    object.name = strings[object.nameIndex];
    const sourceCount = i32();
    object.sourcePositions = Array.from({ length: sourceCount }, i32);
    object.sourceOffsets = Array.from({ length: sourceCount }, i32);
    object.code = array(i16);
    offset = (offset + 3) & ~3;
    object.constants = array(() => {
      const type = i16(), index = i16();
      if (type === 0) return undefined;
      if (type === 1) return null;
      if (type === 2 || type === 10) {
        const reference = { objectIndex: index };
        replacements.push(reference);
        return reference;
      }
      if (!pools[type]) throw new Error(`Unknown TJS constant type ${type}`);
      return pools[type][index];
    });
    object.superClassGetterPositions = array(i32);
    object.properties = array(() => [strings[i32()], i32()]);
    object.members = new Map();
    if (offset !== end) throw new Error(`Invalid TJS object size: ${object.name}`);
    return object;
  });
  for (const reference of replacements) reference.object = objects[reference.objectIndex];
  for (const object of objects) {
    object.parent = objects[object.parentIndex];
    object.setter = objects[object.setterIndex];
    object.getter = objects[object.getterIndex];
    object.superClassGetter = objects[object.superClassGetterIndex];
    for (const [name, index] of object.properties) object.parent.members.set(name, objects[index]);
  }
  if (offset !== bytes.length || objectSize !== bytes.length - (12 + dataSize)) throw new Error('Invalid TJS object area size');
  return { topLevel: objects[topLevel], objects, strings };
}
