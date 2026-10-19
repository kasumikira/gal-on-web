// TextRender.cpp: the textrender.dll TextRenderBase layout engine.
import {
  callScript, disposeScriptValue, evalScript, nativeArray, nativeClass,
  nativeDictionary, nativeMethod, nativeProperty, nativeOwner, readScript,
  retainScriptValue,
} from '#krkr/native';
import { integer, number, truth } from '#krkr/values';

const f32 = value => Math.fround(value);
const truncInt = value => {
  const n = f32(value);
  return !Number.isFinite(n) || n < -0x80000000 || n > 0x7fffffff
    ? -0x80000000 : Math.trunc(n);
};
const i32 = value => Number(BigInt.asIntN(32, integer(value)));
const u32 = value => Number(BigInt.asUintN(32, integer(value)));
const makeLine = () => ({
  chars: [], lineBottom: 0, lineHeight: 0,
  bboxLeft: 0, bboxTop: 0, bboxRight: 0, bboxBottom: 0,
  wordBreakRun: 0, prevWasSpace: false,
});
const clearLine = line => {
  line.chars.length = 0;
  line.lineBottom = line.lineHeight = 0;
  line.bboxLeft = line.bboxTop = line.bboxRight = line.bboxBottom = 0;
  line.wordBreakRun = 0;
  line.prevWasSpace = false;
};
const cloneChar = c => ({ ...c, ruby: c.ruby.map(r => ({ ...r })) });
const cloneLine = line => ({ ...line, chars: line.chars.map(cloneChar) });

function resolveFaceIndex(s, name) {
  if (s.faceHash.has(name)) return s.faceHash.get(name);
  const index = s.faceTable.length;
  s.faceHash.set(name, index);
  // The four reference binaries intern into the hash but never append to faceTable.
  return index;
}
function faceName(s, index) {
  return index >= 0 && index < s.faceTable.length ? s.faceTable[index] : '';
}
function newState() {
  const s = {
    following: '%),:;]}。，、．：；゛゜ヽヾゝゞ々’”）〕］｝〉》」』】°′″℃￠％‰　!.?・？！ーぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ',
    leading: "\\$([{‘“（〔［｛〈《「『【￥＄￡",
    begin: '「『（‘“〔［｛〈《',
    end: '」』）’”〕］｝〉》',
    renderTextValue: '',
    verticalValue: false, wordBreak: true, ignoreColor: false,
    ignoreSize: false, ignoreDelay: false, ignoreOverX: false,
    ignoreOverY: false, widthTimeScale: false, ignoreRuby: false,
    ignoreType: false, ignoreFace: false, ignoreStyle: false,
    renderOverValue: false,
    curBold: false, curShadow: true, curEdge: false, curItalic: false,
    defaultBoldValue: false, defaultShadowValue: true,
    defaultEdgeValue: false, defaultItalicValue: false,
    curFaceIndex: 0, curAlign: -1, curValign: -1,
    defaultAlignValue: -1, defaultValignValue: -1,
    renderCountValue: 0, charBufCountdown: 0, defaultFaceIndex: 0,
    kinsokuUsed: 0, kinsokuMax: 1,
    curFontSize: -1, curBigFontSize: 0, curSmallFontSize: 0,
    curRubySize: -1, curRubyOffset: 0, curLineSpacing: 0,
    curPitch: 0, curLineSize: 0,
    defaultFontSizeValue: 24, defaultBigFontSizeValue: 48,
    defaultSmallFontSizeValue: 12, defaultRubySizeValue: 10,
    defaultRubyOffsetValue: -2, defaultLineSpacingValue: 6,
    defaultPitchValue: 0, defaultLineSizeValue: 24,
    timeScaleValue: 1, fontScaleValue: 1,
    renderDelayAccum: 0, charDelayStep: 1, lineStartX: 0,
    curChColor: 0, curShadowColor: 0, curShadowDiff: 0, curEdgeColor: 0,
    defaultChColorValue: 0xffffffff, defaultShadowColorValue: 0xff000000,
    defaultShadowDiffValue: 1, defaultEdgeColorValue: 0xff0080ff,
    penX: 0, penY: 0, renderSizeW: 0, renderSizeH: 0,
    renderLeftValue: 0, renderTopValue: 0, renderRightValue: 0,
    renderBottomValue: 0, rubyLeft: 0, rubyTop: 0, rubyRight: 0,
    rubyBottom: 0, renderPos: 0, renderPosSnap: 0,
    unusedResetStateA: 0, unusedResetStateB: 0,
    charList: [], pendingLine: makeLine(), lineList: [],
    faceTable: [], keyWaitList: [], accumBuf: [], curRubyText: '',
    faceHash: new Map(),
  };
  s.defaultFaceIndex = resolveFaceIndex(s, 'normal');
  return s;
}

function requireObject(value, name) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function'))
    throw new TypeError(`TextRenderBase.${name}: TJS object required`);
}
async function withRetained(value, callback) {
  const held = retainScriptValue(value);
  try { return await callback(held); }
  finally { await disposeScriptValue(held); }
}
async function withEntry(dict, name, callback) {
  if (!dict.members.has(name)) return false;
  const value = await readScript(dict, name);
  try { await callback(value); }
  finally { await disposeScriptValue(value); }
  return true;
}
function asString(value, member) {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new TypeError(`TextRenderBase.${member}: TJS String conversion failed`);
  return value;
}
function atoi(text) {
  let i = 0, sign = 1, result = 0;
  while (i < text.length && text.charCodeAt(i) <= 0x20) i++;
  if (text.charCodeAt(i) === 45) {
    sign = -1;
    i++;
    while (i < text.length && text.charCodeAt(i) <= 0x20) i++;
    if (i >= text.length) return 0;
  }
  for (; i < text.length; i++) {
    const digit = text.charCodeAt(i) - 48;
    if (digit < 0 || digit > 9) break;
    result = (Math.imul(result, 10) + digit) | 0;
  }
  return sign < 0 ? (-result) | 0 : result;
}
function scanTagUntil(text, cursor, delimiter) {
  let result = '';
  while (cursor < text.length) {
    const ch = text[cursor++];
    if (ch === delimiter) break;
    result += ch;
  }
  return { value: result, cursor };
}
function scanDigits(text, cursor) {
  let result = '';
  while (cursor < text.length) {
    const ch = text[cursor++];
    if (ch < '0' || ch > '9') break;
    result += ch;
  }
  return { value: result, cursor };
}
function parseHexColor(text) {
  let i = text.startsWith('0x') || text.startsWith('0X') ? 2 : 0;
  let result = 0;
  for (; i < text.length; i++) {
    const code = text.charCodeAt(i);
    let digit = code >= 48 && code <= 57 ? code - 48
      : code >= 65 && code <= 70 ? code - 55
        : code >= 97 && code <= 102 ? code - 87 : -1;
    if (digit < 0) break;
    result = (digit + Math.imul(16, result)) >>> 0;
  }
  return result;
}
function scanCharIndex(set, code) {
  for (let i = 0; i < set.length; i++) if (set.charCodeAt(i) === code) return i;
  return -1;
}

async function onStyleChanged(s) {
  const owner = nativeOwner(s);
  const dict = nativeDictionary(owner, [
    ['face', faceName(s, s.curFaceIndex)],
    ['bold', Number(s.curBold)], ['italic', Number(s.curItalic)],
  ]);
  try {
    const result = await callScript(owner, 'onFontChange', [dict], { ignoreMissing: true });
    await disposeScriptValue(result);
  } finally { await disposeScriptValue(dict); }
}
async function getTextWidth(s, text, size) {
  const result = await callScript(nativeOwner(s), 'onGetTextWidth', [text, f32(size)], { ignoreMissing: true });
  try { return f32(number(result)); }
  finally { await disposeScriptValue(result); }
}
async function resetFont(s) {
  const changed = s.curFaceIndex !== s.defaultFaceIndex ||
    s.curBold !== s.defaultBoldValue || s.curItalic !== s.defaultItalicValue ||
    s.curFontSize !== s.defaultFontSizeValue;
  if (changed) {
    s.curFontSize = s.defaultFontSizeValue;
    s.curFaceIndex = s.defaultFaceIndex;
    s.curBold = s.defaultBoldValue;
    s.curItalic = s.defaultItalicValue;
    await onStyleChanged(s);
  }
  if (s.curRubySize < 0 || s.defaultRubySizeValue !== s.curRubySize)
    s.curRubySize = s.defaultRubySizeValue;
  s.curRubyOffset = s.defaultRubyOffsetValue;
  s.curShadow = s.defaultShadowValue;
  s.curEdge = s.defaultEdgeValue;
  s.curChColor = s.defaultChColorValue;
  s.curShadowColor = s.defaultShadowColorValue;
  s.curShadowDiff = s.defaultShadowDiffValue;
  s.curEdgeColor = s.defaultEdgeColorValue;
}
function resetStyle(s) {
  s.curLineSpacing = s.defaultLineSpacingValue;
  s.curPitch = s.defaultPitchValue;
  s.curLineSize = s.defaultLineSizeValue;
  s.curAlign = s.defaultAlignValue;
  s.curValign = s.defaultValignValue;
}
async function clear(s) {
  clearLine(s.pendingLine);
  if (s.verticalValue) {
    s.penX = s.renderSizeW;
    s.renderLeftValue = s.renderSizeW;
    s.renderRightValue = s.renderSizeW;
    s.pendingLine.bboxRight = s.renderSizeW;
    s.pendingLine.bboxLeft = s.renderSizeW;
  } else {
    s.penX = 0;
    s.renderLeftValue = 0;
    s.renderRightValue = 0;
  }
  s.penY = 0;
  s.renderTopValue = s.renderBottomValue = 0;
  s.kinsokuUsed = 0;
  s.curRubyText = '';
  s.charBufCountdown = 0;
  s.lineStartX = 0;
  s.accumBuf.length = 0;
  await resetFont(s);
  s.curPitch = s.defaultPitchValue;
  s.curLineSize = s.defaultLineSizeValue;
  s.curLineSpacing = s.defaultLineSpacingValue;
  s.curAlign = s.defaultAlignValue;
  s.curValign = s.defaultValignValue;
  s.lineList.length = 0;
  s.charList.length = 0;
  s.renderPos = s.renderPosSnap = 0;
  s.unusedResetStateB = 0;
  s.renderDelayAccum = 0;
  s.charDelayStep = 0;
  s.unusedResetStateA = 0;
  s.renderCountValue = 0;
  s.renderOverValue = false;
  s.keyWaitList.length = 0;
  s.renderTextValue = '';
  const defaultName = faceName(s, s.defaultFaceIndex);
  s.faceHash.clear();
  s.faceTable.length = 0;
  s.defaultFaceIndex = resolveFaceIndex(s, defaultName);
}
async function finishLine(s) {
  const line = s.pendingLine;
  if (!s.verticalValue) {
    let maxCharSize = 0;
    for (const c of line.chars) if (c.size > maxCharSize) maxCharSize = c.size;
    const lineHeight = f32(maxCharSize <= s.curLineSize ? s.curLineSize : maxCharSize);
    if (s.renderSizeH > 0 && s.renderSizeH < f32(lineHeight + s.penY)) {
      s.renderOverValue = true;
      if (!s.ignoreOverY) {
        clearLine(line);
        return false;
      }
    }
    const alignOffset = s.curAlign === 1 ? f32(s.renderSizeW - s.penX)
      : s.curAlign === 0 ? f32(f32(s.renderSizeW - s.penX) * 0.5) : 0;
    if (line.chars.length) {
      let indentWidth = await getTextWidth(s, '\u3000', f32(s.fontScaleValue * s.curFontSize));
      if (indentWidth === 0) indentWidth = s.curFontSize;
      let indentCount = truncInt(f32(f32(alignOffset + line.chars[0].x) / indentWidth));
      for (; indentCount >= 1; indentCount--) s.renderTextValue += '\u3000';
    }
    let lineBottom = 0;
    for (const c of line.chars) {
      const charBottom = f32(lineHeight + c.y);
      if (lineBottom < charBottom) lineBottom = charBottom;
      c.x = f32(c.x + alignOffset);
      c.y = charBottom;
      if (c.text) s.renderTextValue += c.text;
    }
    line.lineHeight = lineHeight;
    line.lineBottom = lineBottom;
    line.bboxLeft = f32(alignOffset + line.bboxLeft);
    line.bboxRight = f32(alignOffset + line.bboxRight);
    s.penY = f32(lineHeight + s.penY);
    if (line.bboxBottom < s.penY) line.bboxBottom = s.penY;
    s.lineList.push(cloneLine(line));
    clearLine(line);
    s.renderTextValue += '\n';
    s.penX = s.lineStartX;
    if (line.bboxLeft > s.penX) line.bboxLeft = s.penX;
    s.penY = f32(s.curLineSpacing + s.penY);
  }
  s.kinsokuUsed = 0;
  s.curRubyText = '';
  s.accumBuf.length = 0;
  return true;
}
function isOver(s, c) {
  if (s.verticalValue)
    return s.renderSizeH > 0 && s.renderSizeH <= f32(s.penY + c.size) && !s.ignoreOverY;
  return s.renderSizeW > 0 && s.renderSizeW <= f32(s.penX + c.cw) && !s.ignoreOverX;
}
async function kinsoku(s, c) {
  if (isOver(s, c)) {
    const tmp = [];
    let placeWithoutFinish = false;
    if (!s.wordBreak) {
      if (s.pendingLine.wordBreakRun >= 1) {
        while (s.pendingLine.chars.length > s.pendingLine.wordBreakRun) {
          tmp.unshift(cloneChar(s.pendingLine.chars.pop()));
          s.renderCountValue--;
        }
      }
    } else if (s.following.includes(c.text)) {
      let used = s.kinsokuUsed;
      if (used >= s.kinsokuMax) {
        while (s.pendingLine.chars.length >= 2) {
          if (used < 1) {
            if (s.leading.includes(s.pendingLine.chars.at(-1).text)) {
              tmp.unshift(cloneChar(s.pendingLine.chars.pop()));
              s.renderCountValue--;
            }
            break;
          }
          tmp.unshift(cloneChar(s.pendingLine.chars.pop()));
          s.kinsokuUsed--;
          s.renderCountValue--;
          used = s.kinsokuUsed;
        }
      } else {
        s.kinsokuUsed = used + 1;
        if (!s.pendingLine.chars.length || s.following.includes(s.pendingLine.chars.at(-1).text)) {
          // End the line before this following character.
        } else placeWithoutFinish = true;
      }
    } else {
      if (s.pendingLine.chars.length >= 3) {
        const second = s.pendingLine.chars[s.pendingLine.chars.length - 2];
        if (!s.leading.includes(second.text) && s.leading.includes(s.pendingLine.chars.at(-1).text)) {
          tmp.unshift(cloneChar(s.pendingLine.chars.pop()));
          s.renderCountValue--;
        }
      }
      if (s.pendingLine.chars.length >= 2 && s.leading.includes(s.pendingLine.chars.at(-1).text)) {
        tmp.unshift(cloneChar(s.pendingLine.chars.pop()));
        s.renderCountValue--;
      }
    }
    if (!placeWithoutFinish) {
      if (!await finishLine(s)) return false;
      for (const item of tmp) if (!await kinsoku(s, item)) return false;
    }
  }

  c.x = s.penX;
  c.y = s.verticalValue ? s.penY : f32(s.penY - c.size);
  c.renderPos = s.renderPos;
  if (s.renderDelayAccum <= s.renderPos) s.renderDelayAccum = c.renderPos;
  s.pendingLine.chars.push(cloneChar(c));
  if (!s.wordBreak) {
    const isSpace = c.text === ' ';
    if (isSpace) s.pendingLine.prevWasSpace = true;
    else {
      if (s.pendingLine.prevWasSpace) s.pendingLine.wordBreakRun = s.pendingLine.chars.length;
      s.pendingLine.prevWasSpace = false;
    }
  }
  s.renderPosSnap = s.renderPos;
  if (s.widthTimeScale) {
    const rate = s.charDelayStep;
    if (s.verticalValue) {
      s.renderCountValue++;
      s.renderPos = f32(f32(rate * f32(c.size / f32(s.fontScaleValue * s.curFontSize))) + s.renderPosSnap);
      const newPenY = f32(c.size + s.penY);
      s.penY = newPenY;
      if (s.pendingLine.bboxBottom < newPenY) s.pendingLine.bboxBottom = newPenY;
      s.penY = f32(s.curPitch + newPenY);
      return true;
    }
    s.renderCountValue++;
    s.renderPos = f32(f32(rate * f32(c.cw / f32(s.fontScaleValue * s.curFontSize))) + s.renderPosSnap);
  } else {
    s.renderPos = f32(s.charDelayStep + s.renderPosSnap);
    s.renderCountValue++;
    if (s.verticalValue) {
      const newPenY = f32(c.size + s.penY);
      s.penY = newPenY;
      if (s.pendingLine.bboxBottom < newPenY) s.pendingLine.bboxBottom = newPenY;
      s.penY = f32(s.curPitch + newPenY);
      return true;
    }
  }
  const newPenX = f32(c.cw + s.penX);
  s.penX = newPenX;
  if (s.pendingLine.bboxRight < newPenX) s.pendingLine.bboxRight = newPenX;
  s.penX = f32(s.curPitch + newPenX);
  return true;
}
async function appendChar(s, code) {
  s.accumBuf.push(code);
  const countdown = s.charBufCountdown - 1;
  if (countdown >= 0) { s.charBufCountdown = countdown; return true; }
  if (s.accumBuf.length !== 1) return false;
  const text = String.fromCharCode(code);
  const size = f32(s.fontScaleValue * s.curFontSize);
  const c = {
    text, x: 0, y: 0, cw: await getTextWidth(s, text, size), size,
    renderPos: 0, chColor: s.curChColor, shadowColor: s.curShadowColor,
    edgeColor: s.curEdgeColor, graph: false, bold: s.curBold,
    italic: s.curItalic, shadow: s.curShadow, edge: s.curEdge,
    vertical: s.verticalValue, shadowDiff: s.curShadowDiff,
    faceIndex: s.curFaceIndex, ruby: [],
  };
  if (!s.verticalValue && s.curRubyText) {
    const rubyCw = await getTextWidth(s, s.curRubyText, f32(s.fontScaleValue * s.curRubySize));
    const rubyX = f32(f32(c.cw * 0.5) - f32(rubyCw * 0.5));
    const rubyY = f32(-f32(s.curRubySize * s.fontScaleValue) - s.curRubyOffset);
    c.ruby.push({ x: rubyX, y: rubyY, text: s.curRubyText, span: f32(s.curRubySize * s.fontScaleValue) });
    s.curRubyText = '';
    const ry = f32(rubyY + s.penY);
    if (ry < s.rubyTop) s.rubyTop = ry;
    const rx = f32(rubyX + s.penX);
    if (rx < s.rubyLeft) s.rubyLeft = rx;
    const rxr = f32(rubyCw + rx);
    if (rxr > s.rubyRight) s.rubyRight = rxr;
    if (s.penY < s.rubyTop) s.rubyTop = s.penY;
  } else if (!s.verticalValue && s.penY < s.rubyTop) s.rubyTop = s.penY;
  s.accumBuf.length = 0;
  return kinsoku(s, c);
}

async function evalDollarTag(s, content) {
  const result = await callScript(nativeOwner(s), 'onEval', [content], { ignoreMissing: true });
  try {
    if (result === undefined) return '';
    if (typeof result !== 'string') throw new TypeError('TextRenderBase $ tag result must be a TJS string');
    return result;
  } finally { await disposeScriptValue(result); }
}
async function renderImpl(s, text, pairMode, baseDelay, continueRender) {
  if ((continueRender & 1) === 0) {
    s.lineList.length = 0;
    s.renderDelayAccum = 0;
    s.keyWaitList.length = 0;
  }
  s.renderPos = 0;
  const curFontSizeSnap = s.curFontSize;
  s.charDelayStep = f32(baseDelay);
  let i = 0;
  const len = text.length;
  if (i >= len) return await finishLine(s);
  let atRunStart = true;
  let pairDepth = 0;
  let pairBeginChar = 0;
  while (i < len) {
    const code = text.charCodeAt(i++);
    const next = i;
    if (code === 35) {
      const scanned = scanTagUntil(text, i, ';'); i = scanned.cursor;
      if (!s.ignoreColor) s.curChColor = scanned.value ? (parseHexColor(scanned.value) | 0xff000000) >>> 0 : s.defaultChColorValue;
    } else if (code === 36) {
      const scanned = scanTagUntil(text, i, ';'); i = scanned.cursor;
      const tag = await evalDollarTag(s, scanned.value);
      for (let k = 0; k < tag.length; k++) {
        if (!await appendChar(s, tag.charCodeAt(k))) return false;
      }
      if (tag.length) atRunStart = false;
    } else if (code === 37) {
      if (next >= len) continue;
      const op = text.charCodeAt(next);
      const argIndex = next + 1;
      i = next + 1;
      if (op >= 48 && op <= 57) {
        const scanned = scanDigits(text, next); i = scanned.cursor;
        if (!s.ignoreSize) {
          const percent = scanned.value ? atoi(scanned.value) : 0;
          const target = scanned.value && percent > 0
            ? f32(f32(f32(percent) / 100) * s.defaultFontSizeValue)
            : s.defaultFontSizeValue;
          if (s.curFontSize < 0 || s.curFontSize !== target) {
            s.curFontSize = target;
            await onStyleChanged(s);
          }
        }
      } else if (op === 59) {
        if (!s.ignoreSize && (s.curFontSize < 0 || s.curFontSize !== s.defaultFontSizeValue)) {
          s.curFontSize = s.defaultFontSizeValue; await onStyleChanged(s);
        }
      } else if (op === 67 || op === 82 || op === 76 || op === 66) {
        if (!s.ignoreStyle && op !== 66) s.curAlign = -1;
        if (!s.ignoreSize && (s.curFontSize < 0 || s.curFontSize !== s.defaultBigFontSizeValue)) {
          s.curFontSize = s.defaultBigFontSizeValue; await onStyleChanged(s);
        }
      } else if (op === 83) {
        if (!s.ignoreSize && (s.curFontSize < 0 || s.curFontSize !== s.defaultSmallFontSizeValue)) {
          s.curFontSize = s.defaultSmallFontSizeValue; await onStyleChanged(s);
        }
      } else if (op === 98 || op === 105 || op === 101 || op === 115) {
        if (argIndex < len) {
          const currentDefault = op === 98 ? s.defaultBoldValue : op === 105 ? s.defaultItalicValue
            : op === 101 ? s.defaultEdgeValue : s.defaultShadowValue;
          const arg = text.charCodeAt(argIndex);
          const val = arg === 48 ? false : arg === 49 ? true : currentDefault;
          i = argIndex + 1;
          if (!s.ignoreType) {
            if (op === 98 && s.curBold !== val) { s.curBold = val; await onStyleChanged(s); }
            else if (op === 105 && s.curItalic !== val) { s.curItalic = val; await onStyleChanged(s); }
            else if (op === 101 && s.curEdge !== val) s.curEdge = val;
            else if (op === 115 && s.curShadow !== val) s.curShadow = val;
          }
        }
      } else if ([102, 100, 97, 112, 108, 116, 119].includes(op)) {
        const scanned = scanTagUntil(text, i, ';'); i = scanned.cursor;
        if (op === 102 && !s.ignoreFace) {
          const idx = scanned.value ? resolveFaceIndex(s, scanned.value) : s.defaultFaceIndex;
          if (s.curFaceIndex !== idx) { s.curFaceIndex = idx; await onStyleChanged(s); }
        } else if (op === 100 && !s.ignoreDelay) {
          s.charDelayStep = scanned.value
            ? f32(f32(f32(atoi(scanned.value)) / 100) * f32(baseDelay))
            : f32(baseDelay);
        } else if (op === 97 && !s.ignoreDelay) {
          s.charDelayStep = f32(scanned.value ? atoi(scanned.value) : baseDelay);
        } else if (op === 112 && !s.ignoreStyle) {
          s.curPitch = scanned.value ? f32(atoi(scanned.value)) : s.defaultPitchValue;
        } else if ((op === 108 || op === 116) && !s.ignoreDelay) {
          atoi(scanned.value);
        } else if (op === 119 && !s.ignoreDelay && scanned.value) {
          atoi(scanned.value);
        }
      } else if (op === 114) {
        await resetFont(s);
      } else if (op === 68) {
        if (text.charCodeAt(argIndex) !== 36) {
          const scanned = scanTagUntil(text, i, ';'); i = scanned.cursor;
          atoi(scanned.value);
        }
        else {
          i = argIndex + 1;
          const scanned = scanTagUntil(text, i, ';'); i = scanned.cursor;
          if (!s.ignoreDelay) atoi(scanned.value);
        }
      } else {
        const scanned = scanTagUntil(text, i, ';'); i = scanned.cursor;
      }
    } else if (code === 38) {
      const scanned = scanTagUntil(text, i, ';'); i = scanned.cursor;
      atRunStart = false;
    } else if (code === 91) {
      const scanned = scanTagUntil(text, i, ']'); i = scanned.cursor;
      if (!s.ignoreRuby) { const rubyText = scanned.value; void rubyText; }
    } else if (code === 92) {
      if (next >= len) continue;
      const op = text.charCodeAt(next); i = next + 1;
      if (op === 105) s.lineStartX = s.verticalValue ? s.penY : s.penX;
      else if (op === 107) { s.keyWaitList.push({ index: s.renderCountValue, time: 0 }); atRunStart = false; }
      else if (op === 110) { if (!await finishLine(s)) return false; }
      else if (op === 114) s.lineStartX = 0;
      else if (op === 116) { atRunStart = false; if (!await appendChar(s, 9)) return false; }
      else if (op === 119) { if (s.verticalValue) s.penY = f32(curFontSizeSnap + s.penY); else s.penX = f32(curFontSizeSnap + s.penX); atRunStart = false; }
      else if (op === 120) atRunStart = false;
    } else if (code === 10) {
      if (!await finishLine(s)) return false;
      atRunStart = true;
    } else if (!pairMode) {
      atRunStart = false;
      if (!await appendChar(s, code)) return false;
    } else {
      const beginIndex = scanCharIndex(s.begin, code);
      if (!await appendChar(s, code)) return false;
      if (beginIndex >= 0) {
        if (atRunStart && pairDepth === 0) {
          s.lineStartX = s.verticalValue ? s.penY : s.penX;
          pairBeginChar = code;
        }
        pairDepth++;
      } else {
        const endIndex = scanCharIndex(s.end, code);
        if (endIndex >= 0 && --pairDepth === 0 && s.begin.length === s.end.length &&
            scanCharIndex(s.begin, pairBeginChar) === endIndex) s.lineStartX = 0;
      }
      atRunStart = false;
    }
  }
  return await finishLine(s);
}

async function setOption(s, dict) {
  requireObject(dict, 'setOption');
  for (const [name, field] of [['following', 'following'], ['leading', 'leading'], ['begin', 'begin'], ['end', 'end']])
    await withEntry(dict, name, value => { s[field] = asString(value, 'setOption'); });
  await withEntry(dict, 'vertical', value => { s.verticalValue = truth(value); });
  await withEntry(dict, 'kinsoku_max', value => { s.kinsokuMax = truth(value) ? 1 : 0; });
  for (const [name, field] of [
    ['word_break', 'wordBreak'], ['ignore_color', 'ignoreColor'],
    ['ignore_size', 'ignoreSize'], ['ignore_delay', 'ignoreDelay'], ['ignore_over', 'ignoreOverY'],
    ['ignore_overy', 'ignoreOverY'], ['ignore_overx', 'ignoreOverX'], ['width_time_scale', 'widthTimeScale'],
    ['ignore_ruby', 'ignoreRuby'], ['ignore_type', 'ignoreType'], ['ignore_face', 'ignoreFace'],
    ['ignore_style', 'ignoreStyle'],
  ]) await withEntry(dict, name, value => { s[field] = truth(value); });
}
async function setDefault(s, dict) {
  requireObject(dict, 'setDefault');
  await withEntry(dict, 'face', value => { s.defaultFaceIndex = resolveFaceIndex(s, asString(value, 'setDefault')); });
  await withEntry(dict, 'bold', value => { s.defaultBoldValue = truth(value); });
  let hasFontsize = false;
  await withEntry(dict, 'fontsize', value => { hasFontsize = true; s.defaultFontSizeValue = f32(number(value)); });
  if (hasFontsize) {
    if (!await withEntry(dict, 'bigfontsize', () => {})) s.defaultBigFontSizeValue = s.defaultFontSizeValue;
    if (!await withEntry(dict, 'smallfontsize', () => {})) s.defaultSmallFontSizeValue = s.defaultFontSizeValue;
    if (!await withEntry(dict, 'rubysize', () => {})) s.defaultRubySizeValue = s.defaultFontSizeValue;
  } else {
    await withEntry(dict, 'bigfontsize', value => { s.defaultBigFontSizeValue = f32(number(value)); });
    await withEntry(dict, 'smallfontsize', value => { s.defaultSmallFontSizeValue = f32(number(value)); });
    await withEntry(dict, 'rubysize', value => { s.defaultRubySizeValue = f32(number(value)); });
  }
  await withEntry(dict, 'rubyoffset', value => { s.defaultRubyOffsetValue = f32(number(value)); });
  await withEntry(dict, 'color', value => { s.defaultChColorValue = u32(value); });
  await withEntry(dict, 'shadow', value => { s.defaultShadowValue = truth(value); });
  await withEntry(dict, 'shadowcolor', value => { s.defaultShadowColorValue = u32(value); });
  await withEntry(dict, 'shadowdiff', value => { s.defaultShadowDiffValue = u32(value); });
  await withEntry(dict, 'edge', value => { s.defaultEdgeValue = truth(value); });
  await withEntry(dict, 'edgecolor', value => { s.defaultEdgeColorValue = u32(value); });
  await withEntry(dict, 'linespacing', value => { s.defaultLineSpacingValue = f32(number(value)); });
  await withEntry(dict, 'pitch', value => { s.defaultPitchValue = f32(number(value)); });
  if (!await withEntry(dict, 'linesize', value => { s.defaultLineSizeValue = f32(number(value)); }))
    await withEntry(dict, 'fontsize', value => { s.defaultLineSizeValue = f32(number(value)); });
  await withEntry(dict, 'align', value => { s.defaultAlignValue = i32(value); });
  await withEntry(dict, 'valign', value => { s.defaultValignValue = i32(value); });
}
async function setFont(s, dict) {
  requireObject(dict, 'setFont');
  let changed = false;
  await withEntry(dict, 'face', value => {
    const index = resolveFaceIndex(s, asString(value, 'setFont'));
    if (s.curFaceIndex !== index) { s.curFaceIndex = index; changed = true; }
  });
  await withEntry(dict, 'bold', value => {
    const bold = truth(value);
    if (s.curBold !== bold) { s.curBold = bold; changed = true; }
  });
  await withEntry(dict, 'fontsize', value => {
    const size = f32(number(value));
    if (s.curFontSize < 0 || s.curFontSize !== size) { s.curFontSize = size; changed = true; }
  });
  await withEntry(dict, 'rubysize', value => {
    const size = f32(number(value));
    if (s.curRubySize < 0 || s.curRubySize !== size) s.curRubySize = size;
  });
  await withEntry(dict, 'rubyoffset', value => { s.curRubyOffset = f32(number(value)); });
  await withEntry(dict, 'color', value => { s.curChColor = u32(value); });
  await withEntry(dict, 'shadow', value => { s.curShadow = truth(value); });
  await withEntry(dict, 'shadowcolor', value => { s.curShadowColor = u32(value); });
  await withEntry(dict, 'shadowdiff', value => { s.curShadowDiff = u32(value); });
  await withEntry(dict, 'edge', value => { s.curEdge = truth(value); });
  await withEntry(dict, 'edgecolor', value => { s.curEdgeColor = u32(value); });
  if (changed) await onStyleChanged(s);
}
async function setStyle(s, dict) {
  requireObject(dict, 'setStyle');
  await withEntry(dict, 'linespacing', value => { s.curLineSpacing = f32(number(value)); });
  await withEntry(dict, 'pitch', value => { s.curPitch = f32(number(value)); });
  if (!await withEntry(dict, 'linesize', value => { s.curLineSize = f32(number(value)); }))
    await withEntry(dict, 'fontsize', value => { s.curLineSize = f32(number(value)); });
  await withEntry(dict, 'align', value => { s.curAlign = i32(value); });
  await withEntry(dict, 'valign', value => { s.curValign = i32(value); });
}

async function buildRubyArray(s, ruby) {
  const owner = nativeOwner(s);
  const array = nativeArray(owner);
  try {
    for (const item of ruby) {
      const dict = nativeDictionary(owner, [
        ['text', item.text], ['x', item.x], ['y', item.y], ['size', item.span],
      ]);
      try { array.push(dict); }
      finally { await disposeScriptValue(dict); }
    }
    return array;
  } catch (error) {
    await disposeScriptValue(array);
    throw error;
  }
}
async function getCharacters(s, start, count) {
  start = i32(start); count = i32(count);
  if (count === 0) count = s.renderCountValue - start;
  const listCount = s.charList.length;
  const resultCount = count + start <= listCount ? count : listCount - start;
  const owner = nativeOwner(s);
  const array = nativeArray(owner);
  try {
    if (resultCount >= 1) {
      let lastFaceIndex = -1, currentFace = '';
      for (let offset = 0; offset < resultCount; offset++) {
        const c = s.charList[offset + start];
        if (lastFaceIndex !== c.faceIndex) { currentFace = faceName(s, c.faceIndex); lastFaceIndex = c.faceIndex; }
        let ruby;
        try {
          if (c.ruby.length) ruby = await buildRubyArray(s, c.ruby);
          const entries = [
            ['graph', Number(c.graph)], ['text', c.text], ['x', c.x], ['y', c.y],
            ['cw', c.cw], ['size', c.size], ['face', currentFace],
            ['color', c.chColor >>> 0], ['bold', Number(c.bold)], ['italic', Number(c.italic)],
            ['shadow', Number(c.shadow)], ['edge', Number(c.edge)],
            ['shadowColor', c.shadowColor >>> 0], ['shadowDiff', i32(c.shadowDiff)],
            ['edgeColor', c.edgeColor >>> 0],
          ];
          if (ruby) entries.push(['ruby', ruby]);
          entries.push(['vertical', Number(c.vertical)], ['delay', c.renderPos]);
          const dict = nativeDictionary(owner, entries);
          try { array.push(dict); }
          finally { await disposeScriptValue(dict); }
        } finally { if (ruby) await disposeScriptValue(ruby); }
      }
    }
    return array;
  } catch (error) {
    await disposeScriptValue(array);
    throw error;
  }
}

export function registerTextRender({ global, registerGlobal }) {
  if (global.TextRenderBase) return;
  @nativeClass('TextRenderBase')
  class TextRenderBase {
    static initialize() { return newState(); }
    @nativeMethod TextRenderBase() {}

    @nativeMethod async setOption(dict) {
      if (!arguments.length) throw new Error('TextRenderBase.setOption requires an object');
      await withRetained(dict, held => setOption(this, held));
    }
    @nativeMethod async setDefault(dict) {
      if (!arguments.length) throw new Error('TextRenderBase.setDefault requires an object');
      await withRetained(dict, held => setDefault(this, held));
    }
    @nativeMethod async setRenderSize(width, height) {
      if (arguments.length < 2) throw new Error('TextRenderBase.setRenderSize requires width and height');
      this.renderSizeW = f32(number(width)); this.renderSizeH = f32(number(height));
      await clear(this);
    }
    @nativeMethod async clear() { await clear(this); }
    @nativeMethod async resetFont() { await resetFont(this); }
    @nativeMethod resetStyle() { resetStyle(this); }
    @nativeMethod async setFont(dict) {
      if (!arguments.length) throw new Error('TextRenderBase.setFont requires an object');
      await withRetained(dict, held => setFont(this, held));
    }
    @nativeMethod async setStyle(dict) {
      if (!arguments.length) throw new Error('TextRenderBase.setStyle requires an object');
      await withRetained(dict, held => setStyle(this, held));
    }
    @nativeMethod async render(...args) {
      if (args.length < 3) throw new Error('TextRenderBase.render requires text, pair mode, and base delay');
      const text = args[0] === undefined ? '' : String(args[0]);
      const pairMode = i32(args[1]), baseDelay = i32(args[2]);
      if (args.length > 3) f32(number(args[3])); // The reference converts and passes this unused size argument.
      const continueRender = args.length >= 5 ? truth(args[4]) : false;
      return Number(await renderImpl(this, text, pairMode, baseDelay, continueRender));
    }
    @nativeMethod async newline() { if (this.pendingLine.chars.length) await finishLine(this); }
    @nativeMethod async done() {
      const s = this;
      if (s.pendingLine.chars.length) await finishLine(s);
      for (const line of s.lineList) {
        if (s.renderTopValue > line.bboxTop) s.renderTopValue = line.bboxTop;
        if (s.renderBottomValue < line.bboxBottom) s.renderBottomValue = line.bboxBottom;
        if (s.renderLeftValue > line.bboxLeft) s.renderLeftValue = line.bboxLeft;
        if (s.renderRightValue < line.bboxRight) s.renderRightValue = line.bboxRight;
      }
      if (!s.verticalValue) {
        const currentBottom = s.renderBottomValue;
        const delta = s.curValign === 1 ? truncInt(f32(s.renderSizeH - currentBottom))
          : s.curValign === 0 ? truncInt(f32(f32(s.renderSizeH - currentBottom) * 0.5)) : 0;
        if (delta !== 0) for (const line of s.lineList) for (const c of line.chars) c.y = f32(c.y + delta);
        s.renderBottomValue = f32(currentBottom + delta);
        s.renderTopValue = f32(s.renderTopValue + delta);
      }
      s.charList = [];
      for (const line of s.lineList) s.charList.push(...line.chars);
      for (const item of s.keyWaitList) {
        const c = s.charList[item.index];
        const buffer = new ArrayBuffer(4), view = new DataView(buffer);
        view.setFloat32(0, c.renderPos, true); item.time = view.getInt32(0, true);
      }
      s.charList.sort((a, b) => a.renderPos < b.renderPos ? -1 : a.renderPos > b.renderPos ? 1 : 0);
    }
    @nativeMethod async onEval(expression) {
      if (!arguments.length) throw new Error('TextRenderBase.onEval requires an expression');
      return evalScript(typeof expression === 'string' ? expression : '', nativeOwner(this), 'TextRenderBase.onEval');
    }
    @nativeMethod async getKeyWait() {
      const owner = nativeOwner(this);
      const array = nativeArray(owner);
      try {
        for (const item of this.keyWaitList) {
          const dict = nativeDictionary(owner, [['pos', item.index], ['time', item.index]]);
          try { array.push(dict); }
          finally { await disposeScriptValue(dict); }
        }
        return array;
      } catch (error) { await disposeScriptValue(array); throw error; }
    }
    @nativeMethod calcLineOffset(lineIndex) {
      if (!arguments.length) throw new Error('TextRenderBase.calcLineOffset requires a line index');
      const index = i32(lineIndex);
      if (index < 0 || index >= this.lineList.length) return this.renderBottomValue;
      return this.lineList[index].lineBottom;
    }
    @nativeMethod calcShowCount(width) {
      if (!arguments.length) throw new Error('TextRenderBase.calcShowCount requires a width');
      const count = this.charList.length;
      if (count <= 1) return 0;
      const limit = i32(width), scale = this.timeScaleValue;
      let index = count - 1, result = count;
      while (f32(this.charList[index].renderPos * scale) > limit) {
        const atHead = index <= 1;
        index--; result--;
        if (atHead) return 0;
      }
      return result;
    }
    @nativeMethod async getCharacters(start, count) {
      if (arguments.length < 2) throw new Error('TextRenderBase.getCharacters requires start and count');
      return getCharacters(this, start, count);
    }

    @nativeProperty get vertical() { return this.verticalValue; }
    @nativeProperty set vertical(value) { this.verticalValue = truth(value); }
    @nativeProperty get timeScale() { return this.timeScaleValue; }
    @nativeProperty set timeScale(value) { this.timeScaleValue = f32(number(value)); }
    @nativeProperty get fontScale() { return this.fontScaleValue; }
    @nativeProperty set fontScale(value) { this.fontScaleValue = f32(number(value)); }
    @nativeProperty get defaultFace() { return faceName(this, this.defaultFaceIndex); }
    @nativeProperty set defaultFace(value) { this.defaultFaceIndex = resolveFaceIndex(this, typeof value === 'string' ? value : ''); }
    @nativeProperty get defaultFontSize() { return this.defaultFontSizeValue; }
    @nativeProperty set defaultFontSize(value) { this.defaultFontSizeValue = f32(number(value)); }
    @nativeProperty get defaultBigFontSize() { return this.defaultBigFontSizeValue; }
    @nativeProperty set defaultBigFontSize(value) { this.defaultBigFontSizeValue = f32(number(value)); }
    @nativeProperty get defaultSmallFontSize() { return this.defaultSmallFontSizeValue; }
    @nativeProperty set defaultSmallFontSize(value) { this.defaultSmallFontSizeValue = f32(number(value)); }
    @nativeProperty get defaultLineSize() { return this.defaultLineSizeValue; }
    @nativeProperty set defaultLineSize(value) { this.defaultLineSizeValue = f32(number(value)); }
    @nativeProperty get defaultLineSpacing() { return this.defaultLineSpacingValue; }
    @nativeProperty set defaultLineSpacing(value) { this.defaultLineSpacingValue = f32(number(value)); }
    @nativeProperty get defaultPitch() { return this.defaultPitchValue; }
    @nativeProperty set defaultPitch(value) { this.defaultPitchValue = f32(number(value)); }
    @nativeProperty get defaultAlign() { return this.defaultAlignValue; }
    @nativeProperty set defaultAlign(value) { this.defaultAlignValue = i32(value); }
    @nativeProperty get defaultValign() { return this.defaultValignValue; }
    @nativeProperty set defaultValign(value) { this.defaultValignValue = i32(value); }
    @nativeProperty get defaultRubySize() { return this.defaultRubySizeValue; }
    @nativeProperty set defaultRubySize(value) { this.defaultRubySizeValue = f32(number(value)); }
    @nativeProperty get defaultRubyOffset() { return this.defaultRubyOffsetValue; }
    @nativeProperty set defaultRubyOffset(value) { this.defaultRubyOffsetValue = f32(number(value)); }
    @nativeProperty get defaultChColor() { return i32(this.defaultChColorValue); }
    @nativeProperty set defaultChColor(value) { this.defaultChColorValue = u32(value); }
    @nativeProperty get defaultShadow() { return this.defaultShadowValue; }
    @nativeProperty set defaultShadow(value) { this.defaultShadowValue = truth(value); }
    @nativeProperty get defaultShadowColor() { return i32(this.defaultShadowColorValue); }
    @nativeProperty set defaultShadowColor(value) { this.defaultShadowColorValue = u32(value); }
    @nativeProperty get defaultShadowDiff() { return i32(this.defaultShadowDiffValue); }
    @nativeProperty set defaultShadowDiff(value) { this.defaultShadowDiffValue = u32(value); }
    @nativeProperty get defaultEdge() { return this.defaultEdgeValue; }
    @nativeProperty set defaultEdge(value) { this.defaultEdgeValue = truth(value); }
    @nativeProperty get defaultEdgeColor() { return i32(this.defaultEdgeColorValue); }
    @nativeProperty set defaultEdgeColor(value) { this.defaultEdgeColorValue = u32(value); }
    @nativeProperty get defaultBold() { return this.defaultBoldValue; }
    @nativeProperty set defaultBold(value) { this.defaultBoldValue = truth(value); }
    @nativeProperty get defaultItalic() { return this.defaultItalicValue; }
    @nativeProperty set defaultItalic(value) { this.defaultItalicValue = truth(value); }
    @nativeProperty get renderOver() { return this.renderOverValue; }
    @nativeProperty get renderLines() { return this.lineList.length; }
    @nativeProperty get renderCount() { return this.renderCountValue; }
    @nativeProperty get renderDelay() { return f32(this.renderDelayAccum * this.timeScaleValue); }
    @nativeProperty get renderLeft() { return this.renderLeftValue; }
    @nativeProperty get renderTop() { return this.renderTopValue; }
    @nativeProperty get renderRight() { return this.renderRightValue; }
    @nativeProperty get renderBottom() { return this.renderBottomValue; }
    @nativeProperty get renderText() { return this.renderTextValue; }
    @nativeProperty get maxScrollOffset() {
      return this.verticalValue ? f32(this.renderSizeW - this.renderLeftValue) : f32(this.renderSizeH - this.renderBottomValue);
    }
    @nativeProperty get maxScrollLine() {
      const count = this.lineList.length;
      if (count < 1) return 0;
      let offset = 0;
      let remaining = this.verticalValue ? this.renderSizeW : this.renderSizeH;
      let index = count - 1;
      for (;;) {
        remaining = f32(remaining - this.lineList[index].lineHeight);
        if (remaining < 0) break;
        offset--;
        if (count + offset <= 0) return 1;
        index--;
      }
      return offset !== 0 ? count + offset : 0;
    }
  }
  registerGlobal('TextRenderBase', TextRenderBase);
}
