// layerex_draw/general/LayerExDraw.cpp: ordered Appearance brushes/pens.
import {
  nativeClass, nativeMethod, NativeProperty, nativeOwner, nativeDictionary,
  readScript, retainScriptValue, disposeScriptValue,
} from '#krkr/native';
import { number } from '#krkr/values';
import { Image, colorBytes } from '../bitmap.js';
import { getGPU } from '../gpu.js';
import { VERTEX, FRAGMENT } from './layerex-draw-shader.js';

async function field(object, key, use, fallback) {
  const value = await readScript(object, key, { optional: true });
  try { return value === undefined ? fallback : await use(value); }
  finally { await disposeScriptValue(value); }
}
const scalar = (object, key, fallback) => field(object, key, number, fallback);
async function array(object, use) {
  const count = await scalar(object, 'count', 0), values = [];
  for (let i = 0; i < count; i++) values.push(await field(object, String(i), use));
  return values;
}
async function point(object) {
  const x = await scalar(object, '0');
  return x === undefined
    ? [await scalar(object, 'x', 0), await scalar(object, 'y', 0)]
    : [x, await scalar(object, '1', 0)];
}
async function brush(value) {
  if (typeof value !== 'object' || value === null) return { type: 0, color: number(value) };
  const type = await scalar(value, 'type', 0);
  if (type === 0) return { type, color: await scalar(value, 'color', 0xffffffff) };
  if (type === 3) {
    const points = await field(value, 'points', value => array(value, point));
    if (!points?.length) throw new Error('GdiPlus path gradient requires points');
    return {
      type, points,
      colors: await field(value, 'surroundColors', value => array(value, number), [0xffffffff]),
      center: await field(value, 'centerPoint', point,
        points.reduce((c, p) => [c[0] + p[0] / points.length, c[1] + p[1] / points.length], [0, 0])),
      color: await scalar(value, 'centerColor', 0xffffffff),
    };
  }
  if (type === 4) return {
    type, a: await field(value, 'point1', point), b: await field(value, 'point2', point),
    color1: await scalar(value, 'color1', 0), color2: await scalar(value, 'color2', 0),
  };
  throw new Error(`GdiPlus brush type ${type} is not implemented`);
}
const cssColor = color => {
  const [r, g, b, a] = colorBytes(color);
  return `rgba(${r},${g},${b},${a / 255})`;
};

let gradientRenderer;
function renderer() {
  if (gradientRenderer) return gradientRenderer;
  const canvas = new OffscreenCanvas(1, 1), gl = canvas.getContext('webgl2', {
    alpha: true, premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error('GdiPlus path gradient requires WebGL 2');
  const compile = (type, source) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gradientRenderer = { canvas, gl, program, buffer: gl.createBuffer() };
  return gradientRenderer;
}

// Interpolate from the brush center to each pair of boundary vertices on GPU.
// This preserves distinct surround colors (Canvas radial gradients cannot).
function pathGradient(width, height, brush) {
  const { canvas, gl, program, buffer } = renderer();
  canvas.width = width; canvas.height = height;
  const vertices = [];
  const put = (point, color) => vertices.push(point[0], point[1], ...colorBytes(color).map(channel => channel / 255));
  for (let i = 0; i < brush.points.length; i++) {
    const a = brush.points[i], b = brush.points[(i + 1) % brush.points.length];
    put(brush.center, brush.color);
    put(a, brush.colors[i % brush.colors.length]);
    put(b, brush.colors[(i + 1) % brush.colors.length]);
  }
  gl.viewport(0, 0, width, height);
  gl.disable(gl.BLEND); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(program);
  gl.uniform2f(gl.getUniformLocation(program, 'targetSize'), width, height);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STREAM_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);
  gl.drawArrays(gl.TRIANGLES, 0, vertices.length / 6);
  return canvas;
}

export function registerLayerExDraw({ global, registerGlobal }) {
  @nativeClass('Appearance')
  class Appearance {
    constructor() { this.entries = []; }
    @nativeMethod clear() { this.entries.length = 0; }
    @nativeMethod async addBrush(value, ox = 0, oy = 0) {
      const held = retainScriptValue(value);
      try { this.entries.push({ brush: await brush(held), ox: number(ox), oy: number(oy) }); }
      finally { await disposeScriptValue(held); }
    }
    @nativeMethod async addPen(value, width = 1, ox = 0, oy = 0) {
      const held = retainScriptValue(value), options = retainScriptValue(width);
      try {
        const penWidth = typeof options === 'object' ? await scalar(options, 'width', 1) : number(options);
        this.entries.push({ brush: await brush(held), width: penWidth, ox: number(ox), oy: number(oy) });
      } finally { await disposeScriptValue(options); await disposeScriptValue(held); }
    }
  }
  registerGlobal('GdiPlus', {
    Appearance, BrushTypeSolidColor: 0, BrushTypePathGradient: 3, BrushTypeLinearGradient: 4,
    WrapModeTile: 0, WrapModeTileFlipX: 1, WrapModeTileFlipY: 2, WrapModeTileFlipXY: 3, WrapModeClamp: 4,
  });
  const Layer = global.Layer;
  const changed = state => {
    state.node.imageModified = true;
    if (state.drawUpdate !== false) Layer.members.get('update').call(state);
  };
  Layer.defineMember('updateWhenDraw', new NativeProperty(state => state.drawUpdate !== false, (state, value) => { state.drawUpdate = !!number(value); }));
  Layer.defineMember('clear', function(color = 0) {
    const image = this.node.image;
    if (!image) throw new Error('TJS not drawable layer type');
    image.fill({ left: 0, top: 0, right: image.width, bottom: image.height }, number(color));
    changed(this);
  });
  async function draw(state, entries, path, bounds) {
    const node = state.node, image = node.image;
    if (!image) throw new Error('TJS not drawable layer type');
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const entry of entries) {
      const outset = (entry.width ?? 0) / 2;
      left = Math.min(left, bounds.left + entry.ox - outset);
      top = Math.min(top, bounds.top + entry.oy - outset);
      right = Math.max(right, bounds.right + entry.ox + outset);
      bottom = Math.max(bottom, bounds.bottom + entry.oy + outset);
      const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d');
      context.translate(entry.ox, entry.oy);
      const b = entry.brush;
      let style;
      if (b.type === 0) style = cssColor(b.color);
      else if (b.type === 4) {
        if (!b.a || !b.b) throw new Error('GdiPlus linear gradient requires point1 and point2');
        style = context.createLinearGradient(...b.a, ...b.b);
        style.addColorStop(0, cssColor(b.color1)); style.addColorStop(1, cssColor(b.color2));
      } else style = context.createPattern(pathGradient(image.width, image.height, b), 'no-repeat');
      if (entry.width === undefined) { context.fillStyle = style; context.fill(path, 'evenodd'); }
      else { context.strokeStyle = style; context.lineWidth = entry.width; context.stroke(path); }
      const gpu = getGPU(), source = new Image(image.width, image.height);
      gpu.uploadCanvas(source, canvas);
      gpu.draw(image, source, {
        clip: node.clip ?? { left: 0, top: 0, right: image.width, bottom: image.height },
        mode: 2, destinationAlpha: true,
      });
      gpu.releaseTexture(source.gpu);
    }
    changed(state);
    return nativeDictionary(nativeOwner(state), entries.length
      ? [['x', left], ['y', top], ['width', right - left], ['height', bottom - top]]
      : [['x', 0], ['y', 0], ['width', 0], ['height', 0]]);
  }
  Layer.defineMember('drawEllipse', function(app, x, y, width, height) {
    const path = new Path2D();
    path.ellipse(number(x) + number(width) / 2, number(y) + number(height) / 2, number(width) / 2, number(height) / 2, 0, 0, Math.PI * 2);
    return draw(this, Appearance.of(app).entries, path, {
      left: number(x), top: number(y), right: number(x) + number(width), bottom: number(y) + number(height),
    });
  });
  Layer.defineMember('drawPolygon', async function(app, points) {
    const entries = Appearance.of(app).entries, held = retainScriptValue(points);
    try {
      const vertices = await array(held, point), path = new Path2D();
      vertices.forEach(([x, y], i) => i ? path.lineTo(x, y) : path.moveTo(x, y));
      path.closePath();
      return await draw(this, entries, path, {
        left: Math.min(...vertices.map(p => p[0])), top: Math.min(...vertices.map(p => p[1])),
        right: Math.max(...vertices.map(p => p[0])), bottom: Math.max(...vertices.map(p => p[1])),
      });
    } finally { await disposeScriptValue(held); }
  });
}
