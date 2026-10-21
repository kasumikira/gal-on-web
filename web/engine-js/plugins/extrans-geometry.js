import { getGPU, QUAD_VERTEX } from '../gpu.js';
import { mat2d } from 'gl-matrix';
import { turnTransParam } from './extrans-turn-table.js';

const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D sourceTexture;
uniform sampler2D secondTexture;
uniform highp isampler2D turnTable;
uniform int kind;
uniform int phase;
uniform ivec2 imageSize;
uniform vec4 background;
uniform vec3 inverseX;
uniform vec3 inverseY;
out vec4 colour;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (kind == 0) {
    vec3 v = vec3(vec2(p), 1.0);
    vec2 q = vec2(dot(inverseX,v), dot(inverseY,v));
    if (any(lessThan(q,vec2(0))) || any(greaterThan(q,vec2(imageSize-1)))) discard;
    colour = texelFetch(sourceTexture,ivec2(floor(q+0.5)),0);
    return;
  }
  ivec2 tile = p / 64;
  int step = clamp(phase-(tile.x-tile.y)*2,0,63);
  if (step == 0) { colour = texelFetch(sourceTexture,p,0); return; }
  if (step == 63) { colour = texelFetch(secondTexture,p,0); return; }
  ivec4 a = texelFetch(turnTable,ivec2((p.y%64)*2,step),0);
  ivec4 b = texelFetch(turnTable,ivec2((p.y%64)*2+1,step),0);
  int local = p.x%64;
  if (local < max(0,a.x) || local >= min(64,a.x+a.y)) { colour=background; return; }
  ivec2 q = tile*64 + ((a.zw+b.zw*(local-a.x)) >> 16);
  if (any(lessThan(q,ivec2(0))) || any(greaterThanEqual(q,imageSize))) { colour=background; return; }
  vec4 value = step < 32 ? texelFetch(sourceTexture,q,0) : texelFetch(secondTexture,q,0);
  int gloss = step == 4 ? 16 : step == 5 ? 48 : step == 6 ? 80 : step == 7 ? 128 : step == 8 ? 192 : step == 9 ? 128 : step == 10 ? 80 : step == 11 ? 48 : step == 12 ? 16 : 0;
  ivec4 bytes = ivec4(round(value*255.0));
  colour = vec4(bytes+((ivec4(255,255,255,0)-bytes)*gloss >> 8))/255.0;
}`;

const resources = new WeakMap();
function resource(gpu) {
  let value = resources.get(gpu);
  if (value) return value;
  const gl=gpu.gl, program=gpu.compile(QUAD_VERTEX,FRAGMENT);
  const table=gl.createTexture(), data=new Int32Array(64*64*8);
  for(let p=0;p<64;p++) for(let y=0;y<64;y++) data.set(turnTransParam(p,y),(p*64+y)*8);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D,table);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32I,128,64,0,gl.RGBA_INTEGER,gl.INT,data);
  value={program,table}; resources.set(gpu,value);
  gpu.onDispose(()=>{gl.deleteProgram(program);gl.deleteTexture(table);resources.delete(gpu);});
  return value;
}

function render(frame, first, second, kind, configure) {
  const gpu=getGPU(), gl=gpu.gl, state=resource(gpu);
  frame.detach(false);
  const input=gpu.texture(first), other=gpu.texture(second), target=gpu.texture(frame,true);
  const full={left:0,top:0,right:frame.width,bottom:frame.height};
  gpu.setup(target,input,full,[1,0,0,1,0,0],full,other,state.program);
  gpu.bind(other,1,'secondTexture');
  gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D,state.table);
  gpu.uniform('turnTable','uniform1i',3);
  gpu.uniform('kind','uniform1i',kind);
  gpu.uniform('imageSize','uniform2i',first.width,first.height);
  configure(gpu,state);
  gl.drawArrays(gl.TRIANGLES,0,6); gpu.stats.draws++; gpu.commit(frame,target);
}

export function renderTurn(frame,first,second,phase,background) {
  render(frame,first,second,1,(gpu,state)=>{
    gpu.uniform('phase','uniform1i',phase);
    gpu.uniform('background','uniform4f',...background.map(v=>v/255));
  });
}

export function drawQuad(frame,source,points) {
  const [p0,p1,p2]=points;
  const inverse=mat2d.invert(new Float64Array(6),[
    (p1[0]-p0[0])/(source.width-1),(p1[1]-p0[1])/(source.width-1),
    (p2[0]-p0[0])/(source.height-1),(p2[1]-p0[1])/(source.height-1),p0[0],p0[1]]);
  if(!inverse) return;
  render(frame,source,source,0,gpu=>{
    gpu.uniform('inverseX','uniform3f',inverse[0],inverse[2],inverse[4]);
    gpu.uniform('inverseY','uniform3f',inverse[1],inverse[3],inverse[5]);
  });
}
