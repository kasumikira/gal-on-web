// Uniform caching must compare at the precision the GPU actually receives.
// The matrix cache stores float32 (that is what uniformMatrix3fv uploads), so a
// float64 input such as 1/3 never compares equal to its stored copy: every draw
// re-uploaded the same matrix and cancelled the point of the cache. Integer and
// vec2/vec4 setters store the value as given and are unaffected.
import assert from 'node:assert/strict';
import { createServer } from 'vite';

// ------------------------------------------------------------------ fake WebGL2
// Only the surface GPUDevice's constructor, compile() and createTables() touch is
// implemented. Enum constants are handed out on demand; methods that must return
// a usable value are special-cased, everything else is a recorded no-op.
const uploads = { uniformMatrix3fv: [], uniform1i: [], uniform2f: [], uniform4f: [] };
let enumSeed = 0x1000;
let objectSeed = 0;

const gl = new Proxy({}, {
  get(target, prop) {
    if (prop in target) return target[prop];
    const name = String(prop);
    if (/^[A-Z][A-Z0-9_]*$/.test(name)) return target[prop] = ++enumSeed;
    const method = (...args) => {
      if (name in uploads) uploads[name].push(args);
      switch (name) {
        case 'getShaderParameter': case 'getProgramParameter': return true;
        case 'getExtension': return null;
        case 'getError': return 0;
        case 'getParameter': return 8192;
        // Every name resolves to a distinct location so the setters take their
        // real path instead of the "uniform optimised away" early return.
        case 'getUniformLocation': return { location: args[1] };
        case 'createTexture': case 'createShader': case 'createProgram':
        case 'createBuffer': case 'createFramebuffer': case 'createVertexArray':
          return { id: ++objectSeed, kind: name };
        default: return undefined;
      }
    };
    return target[prop] = method;
  },
});

globalThis.OffscreenCanvas = class OffscreenCanvasStub {
  constructor(width, height) { this.width = width; this.height = height; }
  getContext() { return gl; }
  addEventListener() {}
  removeEventListener() {}
};

const reset = () => { for (const key of Object.keys(uploads)) uploads[key].length = 0; };

const server = await createServer({
  configFile: 'vite.config.mjs',
  server: { middlewareMode: true },
  appType: 'custom',
  optimizeDeps: { noDiscovery: true },
});
try {
  const { initializeGPU } = await server.ssrLoadModule('/engine-js/gpu.js');
  const gpu = initializeGPU({ defaultView: { alert() {} } }, 'uniform sampler2D textTexture;\n');

  // Same state setup() establishes before it sets uniforms: an active program and
  // that program's own uniform table.
  gpu.activeProgram = gpu.program;
  gpu.uniforms = new Map();
  gpu.programUniforms.set(gpu.program, gpu.uniforms);

  // A third is exactly representable in neither base 2 nor float32, which is why
  // the comparison has to round the input the same way the upload does.
  assert.notEqual(Math.fround(1 / 3), 1 / 3, 'precondition: 1/3 is not a float32');

  // ---------------------------------------------------------------- affine mat2d
  reset();
  for (let i = 0; i < 10; i++) gpu.setAffine('transform', 1 / 3, 0, 0, 1 / 3, 10 / 3, 20 / 3);
  assert.equal(uploads.uniformMatrix3fv.length, 1,
    'repeating the same fractional affine must upload once, not once per call');
  assert.deepEqual(Array.from(uploads.uniformMatrix3fv[0][2]),
    [Math.fround(1 / 3), 0, 0, 0, Math.fround(1 / 3), 0, Math.fround(10 / 3), Math.fround(20 / 3), 1],
    'uploaded matrix keeps the column-major layout and float32 rounding');

  // A real change still reaches the GPU.
  gpu.setAffine('transform', 1 / 3, 0, 0, 1 / 7, 10 / 3, 20 / 3);
  assert.equal(uploads.uniformMatrix3fv.length, 2, 'a changed component must upload');

  // Values that collapse to the same float32 are the same uniform value, so the
  // second write carries nothing new for the GPU and is dropped.
  gpu.setAffine('transform', 1 / 3, 0, 0, 1 / 7, 10 / 3, 20 / 3 + 1e-12);
  assert.equal(uploads.uniformMatrix3fv.length, 2, 'sub-float32 change is not an upload');

  // ------------------------------------------------------------- explicit mat3
  reset();
  const mat = [1 / 3, 0, 0, 0, 1 / 3, 0, 5 / 9, 7 / 11, 1];
  for (let i = 0; i < 10; i++) gpu.setMatrix3('inverseTransform', mat);
  assert.equal(uploads.uniformMatrix3fv.length, 1, 'repeating a fractional mat3 must upload once');
  gpu.setMatrix3('inverseTransform', [1 / 3, 0, 0, 0, 1 / 3, 0, 5 / 9, 8 / 11, 1]);
  assert.equal(uploads.uniformMatrix3fv.length, 2, 'a changed mat3 entry must upload');

  // ------------------------------------------------------------- scalars / vec
  reset();
  for (let i = 0; i < 10; i++) {
    gpu.set1i('opacity', 255);
    gpu.set2f('sourceSize', 1920.5, 1080.25);
    gpu.set4f('sourceRect', 0.5, 0.25, 1000.75, 720.125);
  }
  assert.equal(uploads.uniform1i.length, 1, 'int uniform uploads once');
  assert.equal(uploads.uniform2f.length, 1, 'vec2 uniform uploads once');
  assert.equal(uploads.uniform4f.length, 1, 'vec4 uniform uploads once');

  console.log('gpu-uniform-cache-check passed');
} finally {
  await server.close();
}
