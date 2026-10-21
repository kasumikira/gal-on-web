import { registerTransition, unregisterTransition } from '../layer-transition-effects.js';
import { getGPU } from '../gpu.js';
import { renderDistortion } from './extrans-distortion.js';
import { renderTurn, drawQuad } from './extrans-geometry.js';
import { number } from '#krkr/values';

const PI = Math.PI;
const TAU = PI * 2;

function integer(value) {
  return Math.trunc(number(value));
}

function requiredTime(value) {
  const time = integer(value);
  return Math.max(2, time);
}

function colorBytes(value) {
  const color = number(value) >>> 0;
  return [(color >>> 16) & 255, (color >>> 8) & 255, color & 255, color >>> 24];
}

function fillColor(image, color) {
  getGPU().fill(image, { left: 0, top: 0, right: image.width, bottom: image.height }, color);
}

function blendColor(a, b, opacity) {
  return a.map((v, i) => v + ((b[i] - v) * opacity >> 8));
}

function phaseTime(phase, time) {
  return Math.min(time, Math.max(0, integer(phase)));
}

function optionValue(option, key, fallback, convert = number) {
  return option(key, fallback).then(value => convert(value));
}

function checkedSize(src1, src2, width, height) {
  if (src1.width !== width || src1.height !== height || src2.width !== width || src2.height !== height)
    throw new Error('extrans source images must have equal dimensions');
}

async function createWave({ option, required, width, height, type }) {
  const time = requiredTime(await required('time'));
  const maxH = await optionValue(option, 'maxh', 50, number);
  const maxOmega = await optionValue(option, 'maxomega', 0.2, number);
  const bgcolor1 = colorBytes(await option('bgcolor1', 0));
  const bgcolor2 = colorBytes(await option('bgcolor2', 0));
  const waveType = integer(await option('wavetype', 0));
  return {
    maxPhase: time,
    render(frame, src1, src2, phase) {
      checkedSize(src1, src2, width, height);
      const curTime = phaseTime(phase, time);
      let t = curTime;
      const half = time / 2;
      if (t >= half) t = time - t;
      if (t < 0) t = 0;
      const tt = Math.sin((PI / 2) * t / half);
      const curH = tt * maxH;
      let omega;
      if (waveType === 1) omega = maxOmega * (time - curTime) / time;
      else if (waveType === 2) omega = maxOmega * curTime / time;
      else omega = maxOmega * tt;
      const radStart = -omega * (height / 2);
      const blend = Math.min(255, Math.trunc(curTime * 255 / time));
      const background = blendColor(bgcolor1, bgcolor2, blend);
      renderDistortion(frame, src1, src2, { kind: 'wave', width, height, type, blend, curH, omega, radStart, background });
    },
  };
}

async function createMosaic({ option, required, width, height, type }) {
  const time = requiredTime(await required('time'));
  const maxSize = integer(await option('maxsize', 30));
  return {
    maxPhase: time,
    render(frame, src1, src2, phase) {
      checkedSize(src1, src2, width, height);
      const curTime = phaseTime(phase, time);
      let t = curTime;
      const half = time / 2;
      if (t >= half) t = time - t;
      if (t < 0) t = 0;
      const block = Math.trunc((maxSize - 2) * t / half + 2);
      const blend = Math.min(255, Math.trunc(curTime * 255 / time));
      let cx = Math.trunc(width / 2 / block) * block;
      let cy = Math.trunc(height / 2 / block) * block;
      let ox = Math.trunc((width - block) / 2) - cx;
      let oy = Math.trunc((height - block) / 2) - cy;
      if (ox > 0) ox -= block;
      if (oy > 0) oy -= block;
      renderDistortion(frame, src1, src2, { kind: 'mosaic', width, height, type, blend, block, ox, oy });
    },
  };
}

async function createTurn({ option, required, width, height, type }) {
  const time = requiredTime(await required('time'));
  const bg = colorBytes(await option('bgcolor', 0));
  const xcount = Math.floor((width - 1) / 64) + 1;
  const ycount = Math.floor((height - 1) / 64) + 1;
  return {
    maxPhase: time,
    render(frame, src1, src2, phase) {
      checkedSize(src1, src2, width, height);
      const curTime = phaseTime(phase, time);
      const total = 64 + (xcount + ycount) * 2;
      const turnPhase = Math.floor(curTime * total / time) - ycount * 2;
      renderTurn(frame, src1, src2, turnPhase, bg);
    },
  };
}

function rotatePoints(width, height, centerX, centerY, factor, targetFactor, accel, twist, twistAccel, time, curTime) {
  let zm = curTime / time;
  let tm = zm;
  if (accel < 0) { zm = 1 - zm; zm = Math.pow(zm, -accel); zm = 1 - zm; }
  else if (accel > 0) zm = Math.pow(zm, accel);
  const scx = Math.floor(width / 2), scy = Math.floor(height / 2);
  const cx = Math.trunc((scx - centerX) * zm + centerX);
  const cy = Math.trunc((scy - centerY) * zm + centerY);
  if (twistAccel < 0) { tm = 1 - tm; tm = Math.pow(tm, -twistAccel); tm = 1 - tm; }
  else if (twistAccel > 0) tm = Math.pow(tm, twistAccel);
  const rad = curTime === time ? 0 : TAU * twist * tm;
  zm = (targetFactor - factor) * zm + factor;
  const s = Math.sin(rad) * zm, c = Math.cos(rad) * zm;
  const point = (x, y) => [Math.trunc(x), Math.trunc(y)];
  return [
    point(-cx * c + -cy * s + scx, -cx * -s + -cy * c + scy),
    point((width - 1 - cx) * c + -cy * s + scx, (width - 1 - cx) * -s + -cy * c + scy),
    point(-cx * c + (height - 1 - cy) * s + scx, -cx * -s + (height - 1 - cy) * c + scy),
  ];
}

function swapPoints(width, height, twist, time, curTime, source) {
  const scx = Math.floor(width / 2), scy = Math.floor(height / 2);
  const zm = curTime / time;
  let tm, cx, cy, rad;
  if (source === 1) {
    tm = zm * zm;
    cx = Math.trunc(-scx * tm + scx + Math.sin(tm * PI) * scx * 1.5);
    cy = Math.trunc(-scy * tm + scy);
    rad = tm * twist;
  } else {
    tm = 1 - (1 - zm) * (1 - zm);
    cx = Math.trunc((scx - (width - 1)) * tm + (width - 1) - Math.sin(tm * PI) * scx * 1.5);
    cy = Math.trunc((scy - (height - 1)) * tm + (height - 1));
    rad = (-1 + tm) * twist;
  }
  const s = Math.sin(rad) * tm, c = Math.cos(rad) * tm;
  const point = (x, y) => [Math.trunc(x), Math.trunc(y)];
  return [
    point(-scx * c + -scy * s + cx, (-scx * -s + -scy * c) * tm + cy),
    point((width - 1 - scx) * c + -scy * s + cx, ((width - 1 - scx) * -s + -scy * c) * tm + cy),
    point(-scx * c + (height - 1 - scy) * s + cx, (-scx * -s + (height - 1 - scy) * c) * tm + cy),
  ];
}

async function createRotate({ option, required, width, height, variant }) {
  const time = requiredTime(await required('time'));
  const factor = variant === 'rotatevanish' ? 1 : await optionValue(option, 'factor', 1, number);
  const targetFactor = variant === 'rotatevanish' ? 0 : 1;
  const accel = await optionValue(option, 'accel', variant === 'rotatevanish' ? 2 : 0, number);
  const twist = await optionValue(option, 'twist', 2, number);
  const twistAccel = await optionValue(option, 'twistaccel', variant === 'rotatevanish' ? 2 : -2, number);
  const centerX = integer(await option('centerx', Math.floor(width / 2)));
  const centerY = integer(await option('centery', Math.floor(height / 2)));
  return {
    maxPhase: time,
    render(frame, src1, src2, phase) {
      checkedSize(src1, src2, width, height);
      fillColor(frame, [0, 0, 0, 0]);
      const curTime = phaseTime(phase, time);
      const points = rotatePoints(width, height, centerX, centerY, factor, targetFactor, accel, twist, twistAccel, time, curTime);
      const fixed = [[0, 0], [width - 1, 0], [0, height - 1]];
      if (variant === 'rotatezoom') { drawQuad(frame, src1, fixed, width, height); drawQuad(frame, src2, points, width, height); }
      else { drawQuad(frame, src2, fixed, width, height); drawQuad(frame, src1, points, width, height); }
    },
  };
}

async function createRotateSwap({ option, required, width, height }) {
  const time = requiredTime(await required('time'));
  const bgcolor = colorBytes(await option('bgcolor', 0));
  const twist = number(await option('twist', 1)) * PI * 2;
  return {
    maxPhase: time,
    render(frame, src1, src2, phase) {
      checkedSize(src1, src2, width, height);
      fillColor(frame, bgcolor);
      const curTime = phaseTime(phase, time);
      const p1 = swapPoints(width, height, twist, time, curTime, 1);
      const p2 = swapPoints(width, height, twist, time, curTime, 2);
      if (curTime >= time / 2) { drawQuad(frame, src1, p1, width, height); drawQuad(frame, src2, p2, width, height); }
      else { drawQuad(frame, src2, p2, width, height); drawQuad(frame, src1, p1, width, height); }
    },
  };
}

function roundedFixed(value) {
  return value < 0 ? Math.trunc(value - 0.5) : Math.trunc(value + 0.5);
}

async function createRipple({ option, required, width, height, type }) {
  const time = requiredTime(await required('time'));
  const centerX = integer(await option('centerx', width >> 1));
  const centerY = integer(await option('centery', height >> 1));
  if (centerX < 0 || centerY < 0 || centerX >= width || centerY >= height) throw new Error('centerx and centery cannot be out of the image');
  const rippleWidth = integer(await option('rwidth', 128));
  if (![16, 32, 64, 128].includes(rippleWidth)) throw new Error('rwidth must be 16, 32, 64 or 128');
  const roundness = number(await option('roundness', 1));
  if (roundness <= 0) throw new Error('roundness cannot be nagative or equal to 0');
  const speed = number(await option('speed', 6));
  const maxDrift = integer(await option('maxdrift', 24));
  if (maxDrift < 0 || maxDrift >= 128) throw new Error('maxdrift cannot be nagative or larger than 127');
  if (maxDrift >= width || maxDrift >= height) throw new Error('maxdrift must be lesser than both image width and height');
  const rippleForm = Array.from({ length: rippleWidth }, (_, w) => {
    const rad = w / rippleWidth * -TAU;
    let s = (Math.sin(rad) + Math.sin(rad * 2 - 2) * 0.2) / 1.19;
    s = Math.max(-1, Math.min(1, s));
    return roundedFixed(s * 2048);
  });
  const cosTable = [], sinTable = [];
  for (let dir = 0; dir < 32; dir++) {
    const fdir = PI * 0.5 - ((dir + 0.5) * (PI / 2 / 32));
    cosTable.push(roundedFixed(Math.cos(fdir) * 2048));
    sinTable.push(roundedFixed(Math.sin(fdir) * 2048));
  }
  return {
    maxPhase: time,
    render(frame, src1, src2, phase) {
      checkedSize(src1, src2, width, height);
      const curTime = phaseTime(phase, time);
      const blend = Math.min(255, Math.trunc(curTime * 255 / time));
      let wavePhase = Math.trunc(speed * (1 / TAU) * (1 / 1000) * curTime * rippleWidth) % rippleWidth;
      if (wavePhase < 0) wavePhase = 0;
      wavePhase = rippleWidth - wavePhase - 1;
      let drift = Math.trunc(Math.sin(PI * curTime / time) * maxDrift * 4);
      drift = Math.max(0, Math.min(maxDrift * 4 - 1, drift));
      const fdrift = Math.trunc((drift << 10) / 4);
      renderDistortion(frame, src1, src2, { kind: 'ripple', width, height, type, blend, centerX, centerY, roundness, rippleWidth, wavePhase, fdrift, rippleForm, cosTable, sinTable });
    },
  };
}

const providers = {
  wave: createWave,
  mosaic: createMosaic,
  turn: createTurn,
  rotatezoom: args => createRotate({ ...args, variant: 'rotatezoom' }),
  rotatevanish: args => createRotate({ ...args, variant: 'rotatevanish' }),
  rotateswap: createRotateSwap,
  ripple: createRipple,
};

export function registerExtrans(context = {}) {
  const add = context.registerTransition || registerTransition;
  const remove = context.unregisterTransition || unregisterTransition;
  const names = Object.keys(providers);
  for (const name of names) add(name, providers[name]);
  return () => { for (const name of names) remove(name); };
}

export function unregisterExtrans(context = {}) {
  const remove = context.unregisterTransition || unregisterTransition;
  for (const name of Object.keys(providers)) remove(name);
}

export { providers as extransProviders };
