// Port of tTVPWaveLoopManager (WaveLoopManager.cpp).  This module is shared by
// the main thread (parsing .sli information and building the labels dictionary)
// and by the audio worklet (sample transport), so it must not depend on the DOM.

export const LoopCondition = Object.freeze({
  none: 0,
  equal: 1,
  notEqual: 2,
  greater: 3,
  greaterOrEqual: 4,
  lesser: 5,
  lesserOrEqual: 6,
});

const CONDITION_NAMES = new Map([
  ['no', LoopCondition.none],
  ['eq', LoopCondition.equal],
  ['ne', LoopCondition.notEqual],
  ['gt', LoopCondition.greater],
  ['ge', LoopCondition.greaterOrEqual],
  ['lt', LoopCondition.lesser],
  ['le', LoopCondition.lesserOrEqual],
]);

const isSpace = code => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
const isAlpha = code => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);

// WaveLoopManager.h operator< and tTVPWaveLabel::tSortByPositionFuncObj.
export const compareLinks = (left, right) =>
  left.From - right.From ||
  right.Condition - left.Condition ||
  right.CondVar - left.CondVar;

const compareLabels = (left, right) => left.Position - right.Position;

function integerValue(value) {
  const match = /^\s*(-?\d+)/.exec(value);
  return match ? Number(match[1]) : 0;
}

function booleanValue(value) {
  const text = value.trim().toLowerCase();
  if (text === 'true' || text === 'yes') return true;
  if (text === 'false' || text === 'no') return false;
  throw new Error(`Invalid loop information boolean: ${value}`);
}

function conditionValue(value) {
  const condition = CONDITION_NAMES.get(value.trim().toLowerCase());
  if (condition === undefined) throw new Error(`Invalid loop information condition: ${value}`);
  return condition;
}

// Read one "name=value" entity.  Quoted values use single quotes and may contain
// spaces or semicolons, matching GetEntityToken in WaveLoopManager.cpp.
function readEntity(text, start) {
  const length = text.length;
  let p = start;
  while (p < length && isSpace(text.charCodeAt(p))) p++;
  if (p >= length) throw new Error('Invalid loop information: missing entity');
  const nameStart = p;
  while (p < length) {
    const code = text.charCodeAt(p);
    if (isSpace(code) || text[p] === '=' || text[p] === '}') break;
    p++;
  }
  const name = text.slice(nameStart, p);
  while (p < length && isSpace(text.charCodeAt(p))) p++;
  if (text[p] !== '=') throw new Error(`Invalid loop information entity: ${name}`);
  p++;
  while (p < length && isSpace(text.charCodeAt(p))) p++;
  let value;
  if (text[p] === "'") {
    p++;
    const valueStart = p;
    while (p < length && text[p] !== "'") p++;
    value = text.slice(valueStart, p);
    if (text[p] === "'") p++;
  } else {
    const valueStart = p;
    while (p < length) {
      const code = text.charCodeAt(p);
      if (isSpace(code) || text[p] === ';' || text[p] === '}') break;
      p++;
    }
    value = text.slice(valueStart, p);
  }
  while (p < length && isSpace(text.charCodeAt(p))) p++;
  if (text[p] === ';') p++;
  return { name, value, next: p };
}

function readBlock(text, start) {
  const length = text.length;
  let p = start;
  while (p < length && isSpace(text.charCodeAt(p))) p++;
  if (text[p] !== '{') throw new Error('Invalid loop information: expected {');
  p++;
  const fields = [];
  while (p < length) {
    while (p < length && isSpace(text.charCodeAt(p))) p++;
    if (p >= length) throw new Error('Invalid loop information: unterminated block');
    if (text[p] === '}') return { fields, next: p + 1 };
    const entity = readEntity(text, p);
    fields.push(entity);
    p = entity.next;
  }
  throw new Error('Invalid loop information: unterminated block');
}

// WaveLoopManager.cpp ReadInformation.  The returned positions are in the
// decoder's source sample rate (the rate stored in the .sli file).
export function parseLoopInformation(text) {
  text = String(text).replace(/^\uFEFF/, '');
  if (!text.startsWith('#')) {
    const lengthMatch = /LoopLength\s*=\s*(-?\d+)/i.exec(text);
    const startMatch = /LoopStart\s*=\s*(-?\d+)/i.exec(text);
    if (!lengthMatch || !startMatch) throw new Error('Invalid loop information');
    const start = Number(startMatch[1]);
    const length = Number(lengthMatch[1]);
    // Old sli format: one implicit non-smooth link.
    return {
      links: [{
        From: start + length,
        To: start,
        Smooth: false,
        Condition: LoopCondition.none,
        RefValue: 0,
        CondVar: 0,
      }],
      labels: [],
    };
  }

  // The reference rejects versions lexicographically newer than "#2.00"; older
  // version strings are parsed with the same v2 grammar.
  if (text.slice(0, 5) > '#2.00') throw new Error('Invalid loop information version');

  const links = [];
  const labels = [];
  const length = text.length;
  let p = 0;
  while (p < length) {
    while (p < length && isSpace(text.charCodeAt(p))) p++;
    if (p >= length) break;
    // A '#' line starts a comment.  This also skips the version banner.
    if (text[p] === '#') {
      while (p < length && text[p] !== '\n') p++;
      continue;
    }

    const afterLink = text.charCodeAt(p + 4);
    const afterLabel = text.charCodeAt(p + 5);
    if (text.slice(p, p + 4).toLowerCase() === 'link' && !isAlpha(afterLink)) {
      p += 4;
      const block = readBlock(text, p);
      p = block.next;
      const link = {
        From: 0, To: 0, Smooth: false,
        Condition: LoopCondition.none, RefValue: 0, CondVar: 0,
      };
      for (const field of block.fields) {
        switch (field.name.toLowerCase()) {
          case 'from': link.From = integerValue(field.value); break;
          case 'to': link.To = integerValue(field.value); break;
          case 'smooth': link.Smooth = booleanValue(field.value); break;
          case 'condition': link.Condition = conditionValue(field.value); break;
          case 'refvalue': link.RefValue = integerValue(field.value); break;
          case 'condvar': link.CondVar = integerValue(field.value); break;
          default: throw new Error(`Invalid loop information field: ${field.name}`);
        }
      }
      links.push(link);
      continue;
    }
    if (text.slice(p, p + 5).toLowerCase() === 'label' && !isAlpha(afterLabel)) {
      p += 5;
      const block = readBlock(text, p);
      p = block.next;
      const label = { Position: 0, Name: '' };
      for (const field of block.fields) {
        switch (field.name.toLowerCase()) {
          case 'position': label.Position = integerValue(field.value); break;
          case 'name': label.Name = field.value; break;
          default: throw new Error(`Invalid loop information field: ${field.name}`);
        }
      }
      labels.push(label);
      continue;
    }
    throw new Error('Invalid loop information: expected Link or Label');
  }

  links.sort(compareLinks);
  labels.sort(compareLabels);
  return { links, labels };
}

// Convert source-rate positions to the rate of the decoded AudioBuffer.  The
// browser's decodeAudioData resamples to the AudioContext rate, while .sli
// positions are written in the file's rate.
export function convertLoopInformation(info, ratio) {
  ratio = Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  return {
    links: (info?.links ?? []).map(link => ({
      ...link,
      From: Math.round(link.From * ratio),
      To: Math.round(link.To * ratio),
    })).sort(compareLinks),
    labels: (info?.labels ?? []).map(label => ({
      ...label,
      Position: Math.round(label.Position * ratio),
    })).sort(compareLabels),
  };
}

// A random-access PCM transport that implements the loop manager's decode
// semantics.  AudioWorklet passes decoded Float32 channels; the main thread's
// fallback BufferSource path does not use this class.
export class LoopSource {
  constructor({
    channels, sampleRate, looping = false, position = 0,
    links = [], labels = [], flags = [], frequency = 0,
    onLabel = null, onFlags = null,
  }) {
    this.channels = channels;
    this.sampleRate = sampleRate || 1;
    this.total = channels[0]?.length ?? 0;
    this.looping = !!looping;
    this.position = Math.max(0, Math.min(this.total, Math.trunc(position) || 0));
    // WaveLoopManager keeps two positions after a smooth link: the decoder's
    // read position (audio) and `Position` (links/labels/GetPosition).  They
    // are equal until a crossfade ends.
    this.readPosition = this.position;
    this.links = links.slice().sort(compareLinks);
    this.labels = labels.slice().sort(compareLabels);
    this.flags = new Int32Array(16);
    for (let index = 0; index < 16; index++) {
      const value = Math.trunc(flags[index] ?? 0);
      this.flags[index] = Math.max(0, Math.min(9999, value));
    }
    this.frequency = Math.trunc(frequency) || 0;
    this.onLabel = onLabel;
    this.onFlags = onFlags;
    this.crossfade = null;
    this.ended = this.total === 0;
    this.giveUp = 0;
  }

  setLooping(value) {
    this.looping = !!value;
  }

  setFrequency(value) {
    this.frequency = Math.trunc(value) || 0;
  }

  setFlag(index, value) {
    index = Math.trunc(index);
    if (index < 0 || index >= 16) return;
    value = Math.trunc(value);
    this.flags[index] = Math.max(0, Math.min(9999, value));
  }

  resetFlags() {
    this.flags.fill(0);
  }

  empty() {
    return this.channels.map(() => new Float32Array(0));
  }

  copyRaw(position, count) {
    const result = this.channels.map(() => new Float32Array(count));
    const start = Math.trunc(position);
    for (let index = 0; index < count; index++) {
      const at = start + index;
      if (at < 0 || at >= this.total) continue;
      for (let channel = 0; channel < this.channels.length; channel++) {
        result[channel][index] = this.channels[channel][at];
      }
    }
    return result;
  }

  conditionMatches(link) {
    if (link.CondVar === -1) return true;
    const index = Math.trunc(link.CondVar);
    if (index < 0 || index >= 16) return false;
    const flag = this.flags[index];
    switch (link.Condition) {
      case LoopCondition.none: return true;
      case LoopCondition.equal: return link.RefValue === flag;
      case LoopCondition.notEqual: return link.RefValue !== flag;
      case LoopCondition.greater: return link.RefValue < flag;
      case LoopCondition.greaterOrEqual: return link.RefValue <= flag;
      case LoopCondition.lesser: return link.RefValue > flag;
      case LoopCondition.lesserOrEqual: return link.RefValue >= flag;
      default: return false;
    }
  }

  // WaveLoopManager.cpp GetNearestEvent: first link at or after current whose
  // condition matches.  When conditions are ignored, only the position matters
  // (used to bound the second half of a smooth crossfade).
  nearestLink(current, ignoreConditions = false) {
    const links = this.links;
    if (!links.length) return null;
    let low = 0, high = links.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (links[middle].From < current) low = middle + 1;
      else high = middle;
    }
    if (low >= links.length) return null;
    const from = links[low].From;
    while (low > 0 && links[low - 1].From === from) low--;
    for (let index = low; index < links.length; index++) {
      const link = links[index];
      if (link.From < current) continue;
      if (ignoreConditions || this.conditionMatches(link)) return link;
    }
    return null;
  }

  jumpTarget(to) {
    let target = Math.trunc(to);
    if (!Number.isFinite(target)) target = 0;
    if (target < 0) target = 0;
    if (target >= this.total) {
      if (this.looping) return 0;
      return this.total;
    }
    return target;
  }

  evaluateLabel(name) {
    if (!name.startsWith(':')) return;
    const match = /^\s*:\s*\[\s*(\d+)\s*\]\s*(=|\+=|-=|\+\+|--)\s*(?:\[\s*(\d+)\s*\]|(-?\d+))?\s*$/.exec(name);
    if (!match) return;
    const left = Number(match[1]);
    if (left < 0 || left >= 16) return;
    const operation = match[2];
    let right = 0;
    if (match[3] !== undefined) {
      const index = Number(match[3]);
      if (index < 0 || index >= 16) return;
      right = this.flags[index];
    } else if (match[4] !== undefined) {
      right = Number(match[4]);
    } else if (operation !== '++' && operation !== '--') {
      return;
    }
    switch (operation) {
      case '=': this.flags[left] = right; break;
      case '+=': this.flags[left] += right; break;
      case '-=': this.flags[left] -= right; break;
      case '++': this.flags[left]++; break;
      case '--': this.flags[left]--; break;
      default: return;
    }
    if (this.flags[left] < 0) this.flags[left] = 0;
    if (this.flags[left] > 9999) this.flags[left] = 9999;
    this.onFlags?.(Array.from(this.flags));
  }

  // WaveLoopManager.cpp GetLabelAt: labels in [from, to).  Expressions are
  // evaluated before the label event, and both are delivered from the audio
  // thread in transport order.
  collectLabels(from, to) {
    if (!this.labels.length || to <= from) return;
    let low = 0, high = this.labels.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.labels[middle].Position < from) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < this.labels.length; index++) {
      const label = this.labels[index];
      if (label.Position >= to) break;
      if (label.Position < from) continue;
      this.evaluateLabel(label.Name);
      this.onLabel?.(label.Name, label.Position);
    }
  }

  beginCrossfade(link, before, half) {
    before = Math.max(0, Math.min(Math.trunc(before), link.From, link.To));
    let after = Math.max(0, Math.min(half, this.total - link.From, this.total - link.To));
    const over = this.nearestLink(link.To, true);
    if (over && over.From > link.To) after = Math.max(0, Math.min(after, over.From - link.To));
    const length = before + after;
    if (length <= 0) {
      const target = this.jumpTarget(link.To);
      this.position = target;
      this.readPosition = target;
      return;
    }
    const source1 = this.copyRaw(this.readPosition, length);
    const source2 = this.copyRaw(link.To - before, length);
    const data = this.channels.map((_, channel) => {
      const output = new Float32Array(length);
      for (let index = 0; index < before; index++) {
        const ratio = before ? 0.5 * index / before : 0.5;
        output[index] = source1[channel][index] +
          (source2[channel][index] - source1[channel][index]) * ratio;
      }
      for (let index = 0; index < after; index++) {
        const ratio = after ? 0.5 + 0.5 * index / after : 1;
        output[before + index] = source1[channel][before + index] +
          (source2[channel][before + index] - source1[channel][before + index]) * ratio;
      }
      return output;
    });
    this.crossfade = {
      data,
      offset: 0,
      eventEnd: link.From + after,
      audioEnd: link.To + after,
    };
  }

  read(count) {
    count = Math.trunc(count);
    if (this.ended || count <= 0) return this.empty();
    const output = this.channels.map(() => new Float32Array(count));
    let written = 0;
    while (written < count && !this.ended) {
      if (this.crossfade) {
        const fade = this.crossfade;
        const available = fade.data[0].length - fade.offset;
        const copy = Math.min(count - written, available);
        for (let channel = 0; channel < output.length; channel++) {
          output[channel].set(fade.data[channel].subarray(fade.offset, fade.offset + copy), written);
        }
        this.collectLabels(this.position, this.position + copy);
        this.position += copy;
        fade.offset += copy;
        written += copy;
        if (fade.offset >= fade.data[0].length) {
          this.position = fade.eventEnd;
          this.readPosition = fade.audioEnd;
          this.crossfade = null;
        }
        continue;
      }

      if (this.readPosition >= this.total) {
        if (this.looping) {
          this.position = 0;
          this.readPosition = 0;
          continue;
        }
        this.ended = true;
        break;
      }

      const link = this.nearestLink(this.position);
      if (link && link.From === this.position) {
        // WaveLoopManager.cpp gives up after ten jumps without consuming data.
        if (++this.giveUp >= 10) {
          this.ended = true;
          break;
        }
        const target = this.jumpTarget(link.To);
        this.position = target;
        this.readPosition = target;
        continue;
      }

      let next = link ? link.From : Infinity;
      if (link && link.Smooth) {
        const half = Math.floor(this.sampleRate * 25 / 1000);
        let before = Math.min(half, link.From, link.To);
        const fadeStart = link.From - before;
        if (this.position < fadeStart) {
          next = fadeStart;
        } else {
          before = link.From - this.position;
          this.beginCrossfade(link, before, half);
          continue;
        }
      }
      // `Position` may be ahead of the decoder after a smooth link; the read
      // position, not the event position, bounds the remaining audio.
      let one = Math.min(count - written, next - this.position,
        this.total - this.readPosition);
      if (!(one > 0)) {
        if (this.readPosition >= this.total) {
          if (this.looping) {
            this.position = 0;
            this.readPosition = 0;
            continue;
          }
          this.ended = true;
          break;
        }
        // No link and no remaining event gap: emit the audio tail.
        one = Math.min(count - written, this.total - this.readPosition);
        if (!(one > 0)) {
          this.ended = true;
          break;
        }
      }
      this.collectLabels(this.position, this.position + one);
      for (let channel = 0; channel < output.length; channel++) {
        output[channel].set(this.channels[channel].subarray(this.readPosition, this.readPosition + one), written);
      }
      this.position += one;
      this.readPosition += one;
      written += one;
      this.giveUp = 0;
    }
    return output.map(channel => channel.subarray(0, written));
  }
}
