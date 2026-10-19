import FFT from 'fft.js';

/*! PhaseVocoderDSP / MathAlgorithms port.
 * Copyright (C) 2000 W.Dee <dee@kikyou.info> and contributors.
 * Original engine license: ../../native/kirikiri/LICENSE.
 * FFT.js license: node_modules/fft.js/README.md.
 */

// PhaseVocoderDSP.cpp / MathAlgorithms.h, scalar path. FFT.js uses the
// opposite imaginary sign and a normalized inverse compared with Ooura rdft.
const tau = 2*Math.PI;
const wrap = value => {
  let unit = Math.trunc(value/Math.PI);
  unit += unit >= 0 ? unit & 1 : -(unit & 1);
  return value-Math.PI*unit;
};
function angle(y,x) {
  const abs = Math.abs(y)+1e-10;
  const result = x >= 0 ? Math.PI/4*(1-(x-abs)/(x+abs)) : 3*Math.PI/4-Math.PI/4*(x+abs)/(abs-x);
  return y < 0 ? -result : result;
}
function sincos(value) {
  const x = value/tau, q = x-Math.trunc(x+(x > 0 ? .5 : -.5)), q2 = q*q;
  const s = q*(1.5707963235+q2*(-.645963615+q2*(.0796819754+q2*-.0046075748)));
  const c = 1+q2*(-1.2336977925+q2*(.2536086171+q2*-.0204391631));
  const c2 = c*c-s*s, s2 = 2*s*c, correction = 2-c2*c2-s2*s2;
  return [2*s2*c2*correction,(c2*c2-s2*s2)*correction];
}

export class PhaseVocoderDSP {
  constructor(size,channels) {
    this.size = size;
    this.fft = new FFT(size);
    this.inputWindow = new Float32Array(size);
    for (let i=0;i<size;i++) {
      const sine = Math.sin(Math.PI*(i+.5)/size);
      this.inputWindow[i] = Math.sin(Math.PI/2*sine*sine);
    }
    this.analysis = Array.from({length:channels},()=>new Float32Array(size/2));
    this.synthesis = Array.from({length:channels},()=>new Float32Array(size/2));
    this.overlap = Array.from({length:channels},()=>new Float32Array(size));
    this.input = new Float32Array(size);
    this.spectrum = this.fft.createComplexArray();
    this.inverse = this.fft.createComplexArray();
    this.magnitudes = new Float32Array(size/2);
    this.frequencies = new Float32Array(size/2);
    this.adjustCounter = 0;
  }
  configure({pitch,time,overlap}) {
    this.pitch = pitch;
    this.time = time;
    this.sampling = overlap || (time <= .2 ? 2 : time <= 1.2 ? 4 : 8);
    this.inputHop = this.size/this.sampling;
    this.outputHop = Math.trunc(this.inputHop*time) & ~1;
    if (this.outputHop <= 0 || this.outputHop > this.size) throw new Error('PhaseVocoder output hop is outside the frame');
  }
  process(channels) {
    const size = this.size, bands = size/2, radian = tau/this.sampling;
    const scale = this.outputHop/this.inputHop;
    // rdft inverse contributes size/2; FFT.js inverse is normalized.
    const volume = this.time/Math.sqrt(this.pitch)/this.sampling*2;
    const result = [];
    for (let ch=0;ch<channels.length;ch++) {
      const previous = this.analysis[ch], phase = this.synthesis[ch];
      for (let i=0;i<size;i++) this.input[i] = channels[ch][i]*this.inputWindow[i];
      this.fft.realTransform(this.spectrum,this.input);
      for (let i=0;i<bands;i++) {
        const re = this.spectrum[2*i], im = i ? -this.spectrum[2*i+1] : 0;
        const arg = angle(im,re), delta = wrap(previous[i]-arg-i*radian);
        previous[i] = arg;
        this.magnitudes[i] = Math.hypot(re,im);
        this.frequencies[i] = i+delta/radian;
      }
      for (let i=0;i<bands;i++) {
        const position = i/this.pitch, index = Math.trunc(position), fraction = position-index;
        let magnitude = 0, frequency = 0;
        if (index+1 < bands) {
          magnitude = this.magnitudes[index]+fraction*(this.magnitudes[index+1]-this.magnitudes[index]);
          frequency = this.pitch*(this.frequencies[index]+fraction*(this.frequencies[index+1]-this.frequencies[index]));
        } else if (index < bands) {
          magnitude = this.magnitudes[index]; frequency = this.frequencies[index]*this.pitch;
        }
        phase[i] -= frequency*radian*scale;
        const [sine,cosine] = sincos(phase[i]);
        this.spectrum[2*i] = magnitude*cosine;
        this.spectrum[2*i+1] = i ? -magnitude*sine : 0;
      }
      this.spectrum[size] = this.spectrum[size+1] = 0;
      this.fft.completeSpectrum(this.spectrum);
      this.fft.inverseTransform(this.inverse,this.spectrum);
      const output = this.overlap[ch];
      for (let i=0;i<size;i++) output[i] += this.inverse[2*i]*this.inputWindow[i]*volume;
      result.push(output.slice(0,this.outputHop));
      output.copyWithin(0,this.outputHop); output.fill(0,size-this.outputHop);
    }
    this.adjustCounter += 0x03e8a444;
    if (this.adjustCounter >= 0xfa2911fe) {
      this.adjustCounter = 0;
      for (const phase of this.synthesis) for (let i=0;i<phase.length;i++) phase[i] -= Math.trunc(phase[i]/tau)*tau;
    }
    return result;
  }
}
