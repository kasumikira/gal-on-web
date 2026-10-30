
// Public images use straight RGBA8, including RGB underneath zero alpha.
let device = null;
export const getGPU = () => device;
export function initializeGPU(document) {
  if (device) throw new Error('GPU renderer is already initialized');
  try {
    device = new GPUDevice(document);
  } catch (error) {
    document.defaultView.alert(`WebGL 2 初始化失败，无法启动游戏。\n${error.message}`);
    throw error;
  }
  return device;
}

// The quad used by every program the device owns or that a feature module
// compiles through GPUDevice.compile. Modules draw six vertices with it.
export const QUAD_VERTEX = `#version 300 es
precision highp float;
uniform vec2 targetSize;
uniform vec4 sourceRect;
uniform mat3 transform;
out vec2 sourcePoint;
void main() {
  vec2 corners[6] = vec2[6](vec2(0,0),vec2(1,0),vec2(0,1),vec2(0,1),vec2(1,0),vec2(1,1));
  sourcePoint = mix(sourceRect.xy, sourceRect.zw, corners[gl_VertexID]);
  vec2 point = (transform * vec3(sourcePoint,1)).xy;
  gl_Position = vec4(point / targetSize * 2.0 - 1.0, 0, 1);
}`;

// Uniform cache slot kinds. Each cached name always uses one GL type, so the
// kind doubles as the "was this ever set" flag on the entry.
const UNIFORM_INT = 1, UNIFORM_FLOAT2 = 2, UNIFORM_FLOAT4 = 3, UNIFORM_MATRIX3 = 4;

class GPUDevice {
  constructor(document) {
    this.canvas = new OffscreenCanvas(1, 1);
    const gl = this.gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('WebGL 2 is required');
    this.lost = false;
    this.onLost = event => { event.preventDefault(); this.lost = true; };
    this.canvas.addEventListener('webglcontextlost', this.onLost);
    gl.disable(gl.BLEND);
    gl.disable(gl.DITHER);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    this.programUniforms = new Map();
    this.uniforms = null;
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    this.stats = { uploads: 0, uploadedBytes: 0, readbacks: 0, readbackBytes: 0, snapshots: 0, draws: 0 };
    // Like tTVPOGLTexture2D, a bitmap owns its resident texture. Active render
    // targets cannot be evicted: preserving them would require a GPU readback.
    // Images are JS pixel buffers, not TJS owners; do not keep them alive here.
    this.textures = new WeakMap();
    this.imageTextures = new Set();
    this.textureBytes = 0;
    this.textureFinalizer = new FinalizationRegistry(entry => this.releaseTexture(entry));
    this.scratch = null;
    // Feature modules own their own programs and textures; release them here so
    // device shutdown stays the single teardown point.
    this.disposers = new Set();
  }
  onDispose(dispose) {
    this.disposers.add(dispose);
  }
  compile(vertex, fragment) {
    const gl = this.gl;
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
      gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    return program;
  }
  // Uniform locations belong to the program that was active when they were
  // queried; setup() swaps this.uniforms to the matching program's table.
  // Every entry remembers the value it last pushed, so a repeated uniform is
  // one comparison instead of a WebGL round trip. The typed setters exist so
  // the hot path never goes through gl[type](...): a dynamic property lookup
  // plus a rest-argument array for each uniform of each draw.
  uniformEntry(name) {
    let entry = this.uniforms.get(name);
    if (entry === undefined) {
      entry = { location: this.gl.getUniformLocation(this.activeProgram, name),
        kind: 0, a: 0, b: 0, c: 0, d: 0, matrix: null };
      this.uniforms.set(name, entry);
    }
    return entry;
  }
  set1i(name, value) {
    const entry = this.uniformEntry(name);
    if (entry.location === null || entry.kind === UNIFORM_INT && entry.a === value) return;
    entry.kind = UNIFORM_INT;
    entry.a = value;
    this.gl.uniform1i(entry.location, value);
  }
  set2f(name, x, y) {
    const entry = this.uniformEntry(name);
    if (entry.location === null || entry.kind === UNIFORM_FLOAT2 && entry.a === x && entry.b === y) return;
    entry.kind = UNIFORM_FLOAT2;
    entry.a = x; entry.b = y;
    this.gl.uniform2f(entry.location, x, y);
  }
  set4f(name, x, y, z, w) {
    const entry = this.uniformEntry(name);
    if (entry.location === null
      || entry.kind === UNIFORM_FLOAT4 && entry.a === x && entry.b === y && entry.c === z && entry.d === w) return;
    entry.kind = UNIFORM_FLOAT4;
    entry.a = x; entry.b = y; entry.c = z; entry.d = w;
    this.gl.uniform4f(entry.location, x, y, z, w);
  }
  // mat2d affine [a b c d e f] as a column-major mat3, the layout the shaders
  // expect. The matrix lives in a per-entry Float32Array, so a changed
  // transform reuses that allocation instead of building a new array.
  // The cache holds what the GPU received, and the GPU receives float32: the
  // incoming doubles are rounded the same way before the comparison, otherwise
  // an input like 1/3 never equals its stored float32 copy and every draw
  // re-uploads the matrix. Two doubles that round to one float32 are the same
  // uniform value, so dropping the second upload is exact, not approximate.
  setAffine(name, a, b, c, d, e, f) {
    const entry = this.uniformEntry(name);
    if (entry.location === null) return;
    a = Math.fround(a); b = Math.fround(b); c = Math.fround(c);
    d = Math.fround(d); e = Math.fround(e); f = Math.fround(f);
    const matrix = entry.matrix ??= new Float32Array(9);
    if (entry.kind === UNIFORM_MATRIX3
      && matrix[0] === a && matrix[1] === b && matrix[3] === c
      && matrix[4] === d && matrix[6] === e && matrix[7] === f) return;
    entry.kind = UNIFORM_MATRIX3;
    matrix[0] = a; matrix[1] = b; matrix[2] = 0;
    matrix[3] = c; matrix[4] = d; matrix[5] = 0;
    matrix[6] = e; matrix[7] = f; matrix[8] = 1;
    this.gl.uniformMatrix3fv(entry.location, false, matrix);
  }
  create(width, height, gray = false) {
    const gl = this.gl;
    if (width <= 0 || height <= 0 || width > this.maxTextureSize || height > this.maxTextureSize) throw new Error(`GPU image has invalid dimensions: ${width}x${height}`);
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gray ? gl.R8 : gl.RGBA8, width, height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    // Validate the normalized and floating-point attachment layouts once;
    // querying every allocation synchronously drains the GPU command queue.
    if (!this.framebufferValidated) {
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('GPU framebuffer is incomplete');
      this.framebufferValidated = true;
    }
    return { device: this, texture, framebuffer, width, height, gray, bytesPerPixel: gray ? 1 : 4, filter: gl.NEAREST };
  }
  texture(image, discard = false) {
    if (this.lost) throw new Error('WebGL context was lost; reload the game');
    // An exported writable view can change without an Image method call.
    // At the next GPU use, explicitly enter the CPU-write contract.
    if (image.externallyWritable) image.markCPUWritten();
    // Storage geometry is immutable; resizing replaces the storage and key.
    const storage = image._storage;
    let entry = this.textures.get(storage);
    if (!entry) {
      entry = this.create(image.width, image.height, image.gray);
      entry.storage = new WeakRef(storage);
      this.textures.set(storage, entry);
      this.imageTextures.add(entry);
      this.textureBytes += entry.width * entry.height * entry.bytesPerPixel;
      this.textureFinalizer.register(storage, entry, entry);
    }
    if (!discard && !image.gpuValid) {
      if (!image.cpuValid) throw new Error('Image has no authoritative source');
      const pixels = image._pixels;
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      if (pixels) {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, image.width, image.height, image.gray ? gl.RED : gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        this.stats.uploads++;
        this.stats.uploadedBytes += pixels.byteLength;
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, entry.framebuffer);
        gl.disable(gl.SCISSOR_TEST);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      image.gpuValid = true;
      // Uploaded pixels are now owned by the resident texture. CoW aliases
      // share this storage, so retaining its CPU shadow doubles cache memory.
      // External writable views must retain their original backing array.
      if (!image.externallyWritable) image.markGPUWritten();
    }
    image.gpu = entry;
    return entry;
  }
  // Canvas-backed rasterizers upload directly, without a JS pixel readback.
  uploadCanvas(image, canvas) {
    image.detach(false);
    const entry = this.texture(image, true), gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    this.commit(image, entry);
    this.stats.uploads++;
    this.stats.uploadedBytes += image.width * image.height * 4;
  }
  releaseTexture(entry) {
    const storage = entry.storage?.deref();
    if (storage?.gpu === entry) {
      // A shared storage may still be in use by another Image. Preserve its
      // content before the only resident copy disappears.
      if (storage.refs > 1 && !storage.cpuValid && !this.lost) {
        storage.pixels = this.read(entry);
        storage.cpuValid = true;
      }
      storage.gpu = null;
      storage.gpuValid = false;
    }
    if (storage && this.textures.get(storage) === entry) this.textures.delete(storage);
    this.textureFinalizer.unregister(entry);
    this.imageTextures.delete(entry);
    this.textureBytes -= entry.width * entry.height * entry.bytesPerPixel;
    this.gl.deleteFramebuffer(entry.framebuffer);
    this.gl.deleteTexture(entry.texture);
  }
  read(entry, rect = { left: 0, top: 0, right: entry.width, bottom: entry.height }) {
    if (this.lost) throw new Error('Cannot read pixels after WebGL context loss');
    const width = rect.right - rect.left, height = rect.bottom - rect.top;
    const gl = this.gl;
    const pixels = new Uint8ClampedArray(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, entry.framebuffer);
    gl.readPixels(rect.left, rect.top, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.stats.readbacks++; this.stats.readbackBytes += pixels.byteLength;
    if (entry.gray) return Uint8ClampedArray.from({ length: width * height }, (_, i) => pixels[i * 4]);
    return pixels;
  }
  bind(entry, unit, uniform) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    this.set1i(uniform, unit);
  }
  setup(target, source, rect, matrix, clip, destination, program) {
    const gl = this.gl;
    gl.useProgram(program);
    this.activeProgram = program;
    this.uniforms = this.programUniforms.get(program);
    if (!this.uniforms) this.programUniforms.set(program, this.uniforms = new Map());
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top);
    this.bind(source, 0, 'sourceTexture');
    this.bind(destination, 1, 'destinationTexture');
    this.bind(destination, 2, 'secondTexture');
    this.bind(destination, 3, 'ruleTexture');
    this.set2f('sourceSize', source.width, source.height);
    this.set1i('smoothSampling', 0);
    this.set1i('explicitCoverage', 0);
    this.set2f('targetSize', target.width, target.height);
    this.set4f('sourceRect', rect.left, rect.top, rect.right, rect.bottom);
    this.setAffine('transform', matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
  }
  draw(targetImage, sourceImage, options = {}) {
    if (options.matrix || options.clip || options.mode !== 1 || !options.copySourceAlpha || options.smooth)
      throw new Error('GPU draw supports only an untransformed image resize copy');
    const rect = options.sourceRect ?? { left: 0, top: 0, right: sourceImage.width, bottom: sourceImage.height };
    targetImage.detach(true);
    const source = this.texture(sourceImage), target = this.texture(targetImage), gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer);
    gl.blitFramebuffer(rect.left, rect.top, rect.right, rect.bottom,
      rect.left, rect.top, rect.right, rect.bottom, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.commit(targetImage, target);
  }
  commit(image, entry) {
    image.gpu = entry;
    image.markGPUWritten();
    if (image.externallyWritable) image.materialize();
  }
  clip(image, rect = null) {
    rect ??= { left: 0, top: 0, right: image.width, bottom: image.height };
    return {
      left: Math.max(0, Math.floor(rect.left)),
      top: Math.max(0, Math.floor(rect.top)),
      right: Math.min(image.width, Math.ceil(rect.right)),
      bottom: Math.min(image.height, Math.ceil(rect.bottom))
    };
  }
  fill(image, rect, rgba, maskOnly = false) {
    const clip = this.clip(image, rect);
    if (clip.right <= clip.left || clip.bottom <= clip.top) return;
    const full = !maskOnly && clip.left === 0 && clip.top === 0 && clip.right === image.width && clip.bottom === image.height;
    image.detach(!full);
    const target = this.texture(image, full), gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(clip.left, clip.top, clip.right - clip.left, clip.bottom - clip.top);
    // TVPFillMask (tvpgl const_alpha_copy) writes only the alpha byte, which is
    // exactly what a colour-masked clear does; no shader pass is needed.
    gl.colorMask(!maskOnly, !maskOnly, !maskOnly, true);
    gl.clearColor(maskOnly ? 0 : rgba[0] / 255, maskOnly ? 0 : rgba[1] / 255, maskOnly ? 0 : rgba[2] / 255, rgba[3] / 255);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.colorMask(true, true, true, true);
    this.commit(image, target);
  }
  copy(targetImage, sourceImage) {
    // Copy replaces every target texel, so shared old content need not survive.
    targetImage.detach(false);
    const source = this.texture(sourceImage), target = this.texture(targetImage, true), gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source.framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target.framebuffer);
    gl.blitFramebuffer(0, 0, source.width, source.height, 0, 0, target.width, target.height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.commit(targetImage, target);
  }
  diagnostics() {
    return { ...this.stats, textureBytes: this.textureBytes, textureCount: this.imageTextures.size };
  }
  finalize() {
    for (const entry of this.imageTextures) this.releaseTexture(entry);
    this.textures = new WeakMap();
    const gl=this.gl;
    if (this.scratch) {
      gl.deleteTexture(this.scratch.texture);
      gl.deleteFramebuffer(this.scratch.framebuffer);
    }
    for (const dispose of this.disposers) dispose();
    this.disposers.clear();
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    if (device === this) device = null;
  }
}
