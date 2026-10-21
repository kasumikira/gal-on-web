import { getGPU } from './gpu.js';
import { Image } from './bitmap.js';

const programs = new WeakMap();
const VERTEX = `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0,1);}`;
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D sourceTexture;
uniform highp isampler2D kernelTexture;
uniform ivec2 sourceSize;
uniform int kernelWidth;
uniform int kernelCount;
uniform int radius;
uniform int level;
out vec4 colour;
void main(){
 ivec2 p=ivec2(gl_FragCoord.xy);
 if(radius==0){uvec4 v=uvec4(round(texelFetch(sourceTexture,p,0)*255.0));v.a=(v.a*uint(level))>>8u;colour=vec4(v)/255.0;return;}
 uint alpha=0u;vec3 rgb=vec3(0);bool found=false;
 for(int i=kernelCount-1;i>=0;--i){
  ivec3 k=texelFetch(kernelTexture,ivec2(i%kernelWidth,i/kernelWidth),0).xyz;
  ivec2 q=p-k.xy-ivec2(radius);
  if(any(lessThan(q,ivec2(0)))||any(greaterThanEqual(q,sourceSize)))continue;
  vec4 v=texelFetch(sourceTexture,q,0);
  if(!found){rgb=v.rgb;found=true;}
  alpha=min(255u,alpha+((uint(round(v.a*255.0))*uint(k.z))>>18u));
 }
 colour=vec4(rgb,float(alpha)/255.0);
}`;

export function blurGlyphGPU(source, blurWidth, level, kernel) {
  const radius=Math.abs(Math.trunc(blurWidth));
  const image=new Image(source.width+radius*2,source.height+radius*2,{defer:true});
  const result={image,offsetX:-Math.trunc(blurWidth),offsetY:-Math.trunc(blurWidth)};
  // Empty glyphs (e.g. spaces) have an advance but no bitmap. The original
  // blur produces transparent padding; no source texture is needed.
  if (!source.width || !source.height) return result;
  const gpu=getGPU(), gl=gpu.gl;
  let state=programs.get(gpu);
  if(!state){state={program:gpu.compile(VERTEX,FRAGMENT),texture:gl.createTexture(),key:null,locations:new Map()};programs.set(gpu,state);}
  const {program,texture}=state;
  const input=gpu.texture(source), target=gpu.texture(image,true);
  const width=Math.min(gpu.maxTextureSize,Math.max(1,kernel.length)), height=Math.max(1,Math.ceil(kernel.length/width));
  try{
    gl.useProgram(program);gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER,target.framebuffer);gl.viewport(0,0,image.width,image.height);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,input.texture);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,texture);
    const key=radius+':'+level;
    if(state.key!==key){
      const data=new Int32Array(width*height*4);
      kernel.forEach(([x,y,weight],i)=>data.set([x,y,weight,0],i*4));
      gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA32I,width,height,0,gl.RGBA_INTEGER,gl.INT,data);
      gpu.stats.uploads++;gpu.stats.uploadedBytes+=data.byteLength;state.key=key;
    }
    const u=(name,method,...args)=>{
      if(!state.locations.has(name))state.locations.set(name,gl.getUniformLocation(program,name));
      gl[method](state.locations.get(name),...args);
    };
    u('sourceTexture','uniform1i',0);u('kernelTexture','uniform1i',1);u('sourceSize','uniform2i',source.width,source.height);
    u('kernelWidth','uniform1i',width);u('kernelCount','uniform1i',kernel.length);u('radius','uniform1i',radius);u('level','uniform1i',level);
    gl.drawArrays(gl.TRIANGLES,0,3);gpu.stats.draws++;gpu.commit(image,target);
  }finally{gl.useProgram(gpu.program);}
  return result;
}
