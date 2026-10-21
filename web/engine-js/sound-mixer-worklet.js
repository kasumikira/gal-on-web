import { mixSample } from './sound-master.js';

class WaveMixerProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const output = outputs[0];
    const accumulated = inputs[0] ?? [];
    const contribution = inputs[1] ?? [];
    for (let channel = 0; channel < output.length; channel++) {
      const destination = accumulated[channel];
      const source = contribution[channel];
      const result = output[channel];
      for (let frame = 0; frame < result.length; frame++) {
        result[frame] = mixSample(destination?.[frame] ?? 0, source?.[frame] ?? 0);
      }
    }
    return true;
  }
}

registerProcessor('krkr-mixer', WaveMixerProcessor);
