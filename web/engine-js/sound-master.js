// Each added stream is mixed against the accumulated output by the mixer
// AudioWorklet, matching WaveMixer.cpp's per-contribution formula.
export function mixSample(destination, source) {
  if (source > 0 && destination > 0) {
    return source + destination - destination * source;
  }
  if (source < 0 && destination < 0) {
    return source + destination + destination * source;
  }
  return destination + source;
}

export function createMixStage(context) {
  return new AudioWorkletNode(context, 'krkr-mixer', {
    numberOfInputs: 2,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
}
