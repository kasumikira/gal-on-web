// fftgraph.cpp (Kirikiroid2): the whole plugin is an empty drawFFTGraph stub, so
// linking it silences "fftgraph.dll がありません" without drawing a spectrum.
// A real spectrum would need its own FFT pass (see the sound gallery path).
export function registerFftGraph({ registerGlobal }) {
  registerGlobal('drawFFTGraph', function drawFFTGraph() {});
}
