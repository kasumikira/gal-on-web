// csvParser.cpp: CSV lines -> arrays of string fields, fed to a target's
// doLine(array, lineNumber) member like NI_CSVParser::parse.
import { nativeClass, nativeMethod, nativeProperty, nativeOwner, readScript, disposeScriptValue } from '#krkr/native';
import { number } from '#krkr/values';

const find = (line, ch, start) => {
  const index = line.indexOf(ch, start);
  return index < 0 ? line.length : index;
};

// csvParser.cpp split(): quoted fields may span lines via addline().
function split(lineText, file, separator, newline) {
  const fields = [];
  let line = lineText, i = 0, j = 0;
  if (!line.length) return fields;
  do {
    let fld = '';
    if (i < line.length && line[i] === '"') {
      i++; j = i;
      let closed = false;
      do {
        for (; j < line.length; j++) {
          if (line[j] === '"' && line[++j] !== '"') {
            const end = find(line, separator, j);
            fld += line.slice(j, end);
            j = end;
            closed = true;
            break;
          }
          fld += line[j];
        }
        if (!closed) { fld += newline; const holder = { value: '' }; if (!file.addNextLine(holder)) break; line = holder.value; j = 0; }
      } while (!closed);
    } else {
      j = find(line, separator, i);
      fld = line.slice(i, j);
    }
    fields.push(fld);
    i = j + 1;
  } while (j < line.length);
  return fields;
}

class TextFile {
  constructor(text) { this.dat = text; this.pos = 0; }
  addNextLine(line) {
    if (this.pos >= this.dat.length) return false;
    const relative = this.dat.slice(this.pos).search(/[\r\n]/);
    const next = relative < 0 ? -1 : this.pos + relative;
    let chunk;
    if (next < 0) { chunk = this.dat.slice(this.pos); this.pos = this.dat.length; }
    else { chunk = this.dat.slice(this.pos, next); this.pos = next + (this.dat[next] === '\r' && this.dat[next + 1] === '\n' ? 2 : 1); }
    line.value = chunk.replace(/\r$/, '');
    return true;
  }
}

export function registerCSVParser({ storage, registerGlobal }, readText) {
  @nativeClass('CSVParser')
  class CSVParser {
    static initialize() {
      return {
        target: null, file: null, lineNo: 0, separator: ',', newline: '\r\n',
      };
    }

    @nativeMethod CSVParser(target, separator, newlineText) {
      const s = this;
      if (arguments.length > 0 && target !== undefined && target !== null) {
        s.target = nativeOwner(target);
        if (arguments.length > 1) s.separator = String.fromCharCode(Math.trunc(number(separator)));
        if (arguments.length > 2) s.newline = String(newlineText ?? '\r\n');
      }
    }
    @nativeMethod init(text) {
      if (!arguments.length) throw new Error('TJS CSVParser.init requires text');
      const s = this;
      s.file = new TextFile(String(text));
      s.lineNo = 0;
    }
    @nativeMethod async initStorage(name, utf8) {
      if (!arguments.length) throw new Error('TJS CSVParser.initStorage requires a storage name');
      const s = this;
      const text = utf8 ? new TextDecoder('utf-8', { fatal: true }).decode(await storage.read(String(name))) : await readText(String(name));
      s.file = new TextFile(text);
      s.lineNo = 0;
    }
    @nativeMethod getNextLine() {
      const s = this;
      if (!s.file) return undefined;
      const holder = { value: '' };
      if (s.file.addNextLine(holder)) {
        s.lineNo++;
        const fields = [];
        fields.push(...split(holder.value, s.file, s.separator, s.newline));
        return fields;
      }
      s.file = null;
      // The original method leaves the result void at EOF.
      return undefined;
    }
    @nativeMethod async parse(text) {
      const s = this;
      if (arguments.length > 0) this.init(text);
      const target = s.target ?? this;
      const doLine = await readScript(target, 'doLine', { ignoreProperty: true, optional: true });
      try {
        if (!doLine) { s.file = null; return; }
        for (;;) {
          const fields = this.getNextLine();
          if (!fields) break;
          const result = await doLine.call(target, fields, s.lineNo);
          await disposeScriptValue(result);
        }
        s.file = null;
      } finally { await disposeScriptValue(doLine); }
    }
    @nativeMethod async parseStorage(name, utf8) {
      if (arguments.length > 0) await this.initStorage(name, utf8);
      await this.parse();
    }

    @nativeProperty get currentLineNumber() { return this.lineNo; }
  }
  registerGlobal('CSVParser', CSVParser);
}
