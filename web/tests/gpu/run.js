import fixturesURL from '../../../out/gpu-tests/fixtures.json?url';
import { Image, copy9Patch } from './bitmap-reference.js';
import { TEXT_BLEND } from '/tests/gpu/font-reference.js';
import { initializeGPU, getGPU } from './gpu-reference.js';
import { createLayerDrawing } from '/tests/gpu/layer-drawing-reference.js';
import { present } from '/tests/video/gpu-present-reference.js';

const tolerance = Number(new URL(location.href).searchParams.get('tolerance') ?? 1);
if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255) throw Error('tolerance must be an integer in 0..255');
const status = document.getElementById('status');
const results = [];
// Transition pixels are produced by the native renderer now; the JS oracle that
// used to answer these fixtures was removed with the remaining JS layer code.
const unported = new Set(['crossfade','universal']);
const skipped = [];
const checks = [];
const calls = {};
let fixtures;
function compare(expected, actual, width=fixtures.width) {
  if (expected.length !== actual.length) throw Error('Pixel length mismatch');
  let maxRGB = 0, maxAlpha = 0, differentPixels = 0, outsideTolerance = 0;
  const samples = [], histogram = Array(256).fill(0);
  for (let p = 0; p < expected.length; p += 4) {
    let delta = 0;
    for (let c = 0; c < 4; c++) {
      const error = Math.abs(actual[p+c] - expected[p+c]);
      histogram[error]++;
      if (c === 3) maxAlpha = Math.max(maxAlpha,error); else maxRGB = Math.max(maxRGB,error);
      delta = Math.max(delta,error);
    }
    if (delta) {
      differentPixels++;
      if (samples.length < 8) samples.push({ x:p/4%width,y:Math.floor(p/4/width),
        expected:expected.slice(p,p+4),actual:Array.from(actual.slice(p,p+4)),delta });
    }
    if (delta > tolerance) outsideTolerance++;
  }
  return { maxRGB,maxAlpha,differentPixels,outsideTolerance,histogram,samples };
}
function image(bytes,width=fixtures.width,height=fixtures.height) {
  return new Image(width,height,{pixels:Uint8ClampedArray.from({length:width*height*4},(_,i)=>bytes[i%bytes.length])});
}
function options(args) {
  const f=args.flags;
  return { mode:args.mode,opacity:args.opacity,holdAlpha:!!(f&1),destinationAlpha:!!(f&2),
    additiveDestination:!!(f&4),copySourceAlpha:!!(f&8),ignoreSourceAlpha:!!(f&16) };
}
async function execute(gpu,test) {
  const {width,height}=test.size??fixtures;
  const target=image(fixtures.inputs.d,width,height), source=test.self ? target : image(fixtures.inputs.a,width,height);
  const second=image(fixtures.inputs.b,width,height), rule=image(fixtures.inputs.rule,width,height);
  const rect={left:0,top:0,right:target.width,bottom:target.height};
  switch(test.method) {
    case 'imageBlendColor': target.blendColor(rect,test.colour,test.args.opacity,test.additive); break;
    case 'ninePatch': {
      const patch=new Image(11,11);
      for(let y=1;y<10;y++) for(let x=1;x<10;x++) patch.pixels.set([91,37,203,255],(y*11+x)*4);
      for(let x=4;x<4+test.centreWidth;x++)patch.pixels[(x*4)+3]=255;
      for(let y=4;y<4+test.centreHeight;y++)patch.pixels[(y*11*4)+3]=255;
      assert(copy9Patch(target,patch),'valid nine-patch rejected');
      break;
    }
    case 'draw': gpu.draw(target,source,options(test.args)); break;
    case 'geometry': gpu.draw(target,source,{...test.geometry,smooth:test.smooth,mode:1,copySourceAlpha:true}); break;
    case 'fill': {
      const p=test.fill;
      gpu.fill(target,test.clip??rect,[p>>>16&255,p>>>8&255,p&255,p>>>24],test.maskOnly);
      break;
    }
    case 'layer': {
      const sourceOwner={},targetOwner={};
      const sourceNode={image:source,type:2,drawFace:0,owner:sourceOwner};
      const targetNode={image:target,type:2,drawFace:0,holdAlpha:false,clip:rect,owner:targetOwner};
      const instances=new Map([[sourceOwner,{node:sourceNode}],[targetOwner,{node:targetNode}]]);
      const drawing=createLayerDrawing({document,getLayer:()=>({instances}),instanceOf:owner=>instances.get(owner).node,updateTree:()=>{}});
      const method=test.layerMethod,w=target.width,h=target.height;
      if(method==='operateRect')drawing[method].call(targetOwner,0,0,sourceOwner,0,0,w,h,test.args.mode,test.args.opacity);
      else if(method==='operateStretch')drawing[method].call(targetOwner,0,0,w,h,sourceOwner,0,0,w,h,test.args.mode,test.args.opacity);
      else if(method==='operateAffine')drawing[method].call(targetOwner,sourceOwner,0,0,w,h,true,1,0,0,1,0,0,test.args.mode,test.args.opacity);
      else if(method==='pileRect'||method==='blendRect')drawing[method].call(targetOwner,0,0,sourceOwner,0,0,w,h,test.args.opacity);
      else if(method.startsWith('stretch'))drawing[method].call(targetOwner,0,0,w,h,sourceOwner,0,0,w,h,...(method.endsWith('Copy')?[]:[test.args.opacity]));
      else drawing[method].call(targetOwner,sourceOwner,0,0,w,h,true,1,0,0,1,0,0,...(method.endsWith('Copy')?[]:[test.args.opacity]));
      break;
    }
    case 'copy': gpu.copy(target,source); break;
    case 'clone': gpu.texture(source); return source.clone().pixels;
    case 'assign': gpu.texture(source); target.assign(source); break;
    case 'read': return gpu.read(gpu.texture(source));
    case 'point': {
      gpu.texture(source);
      const pixels=[];
      for(let y=0;y<source.height;y++) for(let x=0;x<source.width;x++) {
        const p=source.point(x,y);
        pixels.push(p>>>16&255,p>>>8&255,p&255,p>>>24);
      }
      return pixels;
    }
    // LayerBitmapIntf FillColor / BlendColor / RemoveConstOpacity family.
    case 'colour': {
      const colour=test.args.mode|0, opacity=test.args.opacity;
      switch(test.colourOp) {
        case 0: target.fillColor(rect,colour,255); break;
        case 1: target.fillColor(rect,colour,opacity); break;
        case 2: target.blendColor(rect,colour,opacity,false); break;
        case 3: target.blendColor(rect,colour,opacity,true); break;
        case 4: target.fill(rect,colour); break;
        default: target.removeConstOpacity(rect,opacity); break;
      }
      break;
    }
    case 'transform': target.transform(rect,test.args.kind); break;
    case 'gaussian': target.gaussianBlur(test.args.mode,test.sigma); break;
    case 'lookup': {
      // Same formula as TVPInitGammaAdjustTempData: exp(log(i/255)*gamma).
      const tables=[0,1,2].map(channel => {
        const [g,floor,ceil]=[test.gamma[channel*3],test.gamma[channel*3+1],test.gamma[channel*3+2]];
        return Uint8Array.from({length:256},(_,i)=>{
          const value = Math.floor(Math.exp(Math.log(i/255)*(g===0?Number.MAX_VALUE:1/g))*(ceil-floor)+0.5+floor);
          return value<0?0:value>255?255:value;
        });
      });
      target.applyLookup(rect,tables,!!test.additive);
      break;
    }
    case 'blur': target.boxBlur(rect,{left:test.args.mode,top:test.args.opacity,right:test.args.phase,bottom:test.args.vague},!!test.blurAlpha); break;
    case 'present': {
      const canvas=document.createElement('canvas'); canvas.width=source.width;canvas.height=source.height;
      present(gpu,source,canvas);
      const capture=document.createElement('canvas');capture.width=source.width;capture.height=source.height;
      const context=capture.getContext('2d');context.drawImage(canvas,0,0);
      return context.getImageData(0,0,source.width,source.height).data;
    }
    default: throw Error(`Missing test executor: ${test.method}`);
  }
  return target.pixels;
}
function check(name,fn) {
  try { fn();checks.push({name,passed:true}); }
  catch(error) { checks.push({name,passed:false,error:error.stack}); }
}
async function checkAsync(name,fn) {
  try { await fn();checks.push({name,passed:true}); }
  catch(error) { checks.push({name,passed:false,error:error.stack}); }
}
function assert(value,message) { if(!value)throw Error(message); }
function show(index) {
  const result=results[index],test=fixtures.cases[index];
  document.getElementById('detail').textContent=JSON.stringify({...result,actual:undefined},null,2);
  const diff=result.actual?.map((v,i)=>i%4===3 ? 255 : Math.min(255,Math.abs(v-test.expected[i])*16));
  document.getElementById('images').replaceChildren();
  if(!result.actual)return;
  for(const [label,bytes] of [['原版 RGBA（显示 RGB，忽略 alpha）',test.expected],['GPU RGBA（显示 RGB，忽略 alpha）',result.actual],['RGB 差异 ×16；alpha 差异见样本',diff]]) {
    const section=document.createElement('section'),title=document.createElement('p'),canvas=document.createElement('canvas');
    title.textContent=label;canvas.width=test.size?.width??fixtures.width;canvas.height=test.size?.height??fixtures.height;
    const visible=new Uint8ClampedArray(bytes);for(let i=3;i<visible.length;i+=4)visible[i]=255;
    canvas.getContext('2d').putImageData(new ImageData(visible,canvas.width,canvas.height),0,0);
    section.append(title,canvas);document.getElementById('images').append(section);
  }
}
async function run() {
  const response=await fetch(fixturesURL);
  if(!response.ok)throw Error('Run node web/tests/gpu/prepare.mjs first');
  fixtures=await response.json();
  const gpu=initializeGPU(document,TEXT_BLEND), proto=Object.getPrototypeOf(gpu);
  const clearGlError=()=>{for(let i=0;i<16&&gpu.gl.getError()!==0;i++);};
  const renderer=gpu.gl.getParameter(gpu.gl.RENDERER);
  const methods=Object.getOwnPropertyNames(proto).filter(name=>name!=='constructor');
  const originals=new Map();
  for(const name of methods) {
    const original=proto[name];originals.set(name,original);
    proto[name]=function(...args){calls[name]=(calls[name]??0)+1;return original.apply(this,args);};
  }
  try {
    check('comparison/detect hidden RGB and alpha errors',()=>{
      const result=compare([91,37,203,0],[95,37,203,2]);
      assert(result.maxRGB===4&&result.maxAlpha===2&&result.differentPixels===1,'comparison missed an error');
    });
    for(const [i,test] of fixtures.cases.entries()) {
      if(unported.has(test.method)) { skipped.push(test.name); continue; }
      try {
        const actual=Array.from(await execute(gpu,test));
        const error=gpu.gl.getError();if(error)throw Error(`WebGL error ${error}`);
        const metrics=compare(test.expected,actual,test.size?.width??fixtures.width);
        // softwareKernel keeps the software renderer's TVPInterpLinTransCopy
        // result for archive comparison; it is not the pass criterion.
        const archive=test.softwareKernel?compare(test.softwareKernel,actual,test.size?.width??fixtures.width):null;
        results.push({name:test.name,method:test.method,...metrics,passed:metrics.outsideTolerance===0,actual,
          softwareKernel:archive?{maxRGB:archive.maxRGB,maxAlpha:archive.maxAlpha,differentPixels:archive.differentPixels}:null});
      } catch(error) { results.push({name:test.name,method:test.method,passed:false,error:error.stack}); }
      if(i%100===0){status.textContent=`运行 ${i+1}/${fixtures.cases.length}`;await new Promise(resolve=>document.hidden?setTimeout(resolve,0):requestAnimationFrame(resolve));}
    }
    check('initializeGPU/getGPU/duplicate initialization',()=>{
      assert(getGPU()===gpu,'device mismatch');let threw=false;
      try{initializeGPU(document);}catch{threw=true;}assert(threw,'duplicate init accepted');
    });
    check('compile',()=>{
      const program=gpu.compile('#version 300 es\nvoid main(){gl_Position=vec4(0);}',
        '#version 300 es\nprecision highp float;out vec4 c;void main(){c=vec4(1);}');gpu.gl.deleteProgram(program);
    });
    check('clip/outside bounds',()=>{
      assert(JSON.stringify(gpu.clip({width:8,height:8},{left:-2,top:-3,right:10,bottom:12}))===JSON.stringify({left:0,top:0,right:8,bottom:8}),'clip mismatch');
    });
    check('texture/reupload after CPU modification',()=>{
      const source=image(fixtures.inputs.a),entry=gpu.texture(source),reads=gpu.diagnostics().readbacks;
      source.pixels[0]^=255;
      // Direct byte edits enter the CPU-write contract explicitly, like
      // mainImageBufferForWrite; the GPU copy is then stale until next use.
      source.markCPUWritten();
      assert(gpu.diagnostics().readbacks===reads,'unchanged CPU pixels read back from GPU');
      assert(gpu.texture(source)===entry,'CPU modification replaced resident texture');
      assert(gpu.read(entry)[0]===source._pixels[0],'stale texture');
    });
    check('commit/externallyWritable buffer identity',()=>{
      const target=image(fixtures.inputs.d),buffer=target._pixels;target.externallyWritable=true;
      gpu.fill(target,{left:0,top:0,right:8,bottom:8},[91,37,203,0]);
      // The external view keeps its identity and is synchronized from the GPU;
      // the resident texture remains authoritative afterward.
      assert(target._pixels===buffer&&buffer[0]===91&&buffer[3]===0,'external buffer not updated');
    });
    check('snapshot/independent GPU copy',()=>{
      const source=image(fixtures.inputs.a),entry=gpu.texture(source);
      const scratch=gpu.snapshot(entry,{left:0,top:0,right:8,bottom:8});
      assert(compare(fixtures.inputs.a,gpu.read(scratch,{left:0,top:0,right:8,bottom:8})).outsideTolerance===0,'snapshot mismatch');
    });
    // LayerBitmapImpl.cpp tTVPNativeBaseBitmap::Assign shares the texture and
    // Independ copies only when a side is written.
    check('assign/shared storage until write',()=>{
      const source=image(fixtures.inputs.a),target=image(fixtures.inputs.d);
      const sourceEntry=gpu.texture(source);
      gpu.texture(target);
      target.assign(source);
      assert(target._storage===source._storage,'assign did not share storage');
      assert(gpu.texture(target)===sourceEntry,'assign copied the whole texture');
      target.fill({left:0,top:0,right:1,bottom:1},0x11223344);
      assert(target._storage!==source._storage,'write did not detach shared storage');
      assert(gpu.texture(source)===sourceEntry,'source texture was replaced');
      const expected=Uint8ClampedArray.from(fixtures.inputs.a);
      expected.set([0x22,0x33,0x44,0x11],0);
      assert(compare(expected,target.pixels).outsideTolerance===0,'detach did not preserve pixels');
      assert(compare(fixtures.inputs.a,gpu.read(sourceEntry)).outsideTolerance===0,'source pixels changed through assign');
    });
    check('assign/full overwrite detaches without copying',()=>{
      const source=image(fixtures.inputs.a),target=image(fixtures.inputs.d);
      const sourceEntry=gpu.texture(source);
      target.assign(source);
      gpu.fill(target,{left:0,top:0,right:8,bottom:8},[91,37,203,255]);
      assert(target._storage!==source._storage,'full fill did not detach');
      assert(target.pixels.every((v,i)=>v===[91,37,203,255][i%4]),'full fill content');
      assert(compare(fixtures.inputs.a,gpu.read(sourceEntry)).outsideTolerance===0,'source changed by overwrite');
    });
    check('assign/no-copy independ',()=>{
      const source=image(fixtures.inputs.a),target=image(fixtures.inputs.d);
      target.assign(source);
      target.detach(false);
      assert(target._storage!==source._storage,'no-copy detach kept sharing');
      assert(target.pixels.every(v=>v===0),'no-copy detach retained pixels');
      assert(compare(fixtures.inputs.a,gpu.read(gpu.texture(source))).outsideTolerance===0,'source changed by no-copy detach');
    });
    await checkAsync('canvas upload/composite/glyph methods',async()=>{
      const canvas=document.createElement('canvas');canvas.width=8;canvas.height=8;
      const uploaded=image(fixtures.inputs.a);
      gpu.uploadCanvas(uploaded,canvas);
      const composite=image(fixtures.inputs.d);
      gpu.compositeOffscreen(composite,[{source:uploaded,options:{mode:0,opacity:255}}]);
      const glyph=new Image(4,4,{pixels:Uint8ClampedArray.from({length:64},(_,i)=>
        i%4===3?[0,64,128,255][i>>2&3]:[200,30,90,0][i%4])});
      const batch=image(fixtures.inputs.d);
      clearGlError();
      gpu.drawGlyph(batch,glyph,1,1,{mode:100,opacity:255});
      const single=image(fixtures.inputs.d);
      gpu.drawGlyph(single,glyph,2,2,{mode:100,opacity:255});
      assert(gpu.gl.getError()===0,'canvas/composite/glyph path produced a WebGL error');
    });
    check('diagnostics',()=>{assert(gpu.diagnostics().readbacks>0,'missing counters');});
  } finally {
    check('finalize/releases device and textures',()=>{
      const entries=[...gpu.imageTextures];gpu.finalize();
      assert(getGPU()===null&&gpu.imageTextures.size===0&&gpu.diagnostics().textureBytes===0,'device not released');
      assert(entries.every(e=>!gpu.gl.isTexture(e.texture)),'texture not deleted');
    });
    for(const [name,original] of originals)proto[name]=original;
  }
  check('initialization failure/one alert and no fallback',()=>{
    const original=globalThis.OffscreenCanvas,alerts=[];
    try {
      globalThis.OffscreenCanvas=class {getContext(){return null;}};
      let rejected=false;
      try{initializeGPU({defaultView:{alert:message=>alerts.push(message)}});}catch{rejected=true;}
      assert(rejected&&alerts.length===1&&getGPU()===null,'failed initialization did not terminate');
    } finally {globalThis.OffscreenCanvas=original;}
  });
  const uncalled=methods.filter(name=>!calls[name]);
  check('coverage/all GPU methods exercised',()=>assert(!uncalled.length,`Uncalled GPU methods: ${uncalled.join(', ')}`));
  const gaps=[
    'Motion 特殊混合：尚未接入原版 Motion 渲染基准，不能以 TVP Layer 混合替代。',
    'bmAddAlphaOnAlpha：参考 PartialBlt 未实现，未伪造期望结果。',
    '几何覆盖使用测试端逆映射；尚未编译完整 LayerBitmapImpl 边缘扫描器。',
    '当前不覆盖仍在 CPU 的字体、滤镜、视频和 extrans；也不证明游戏全流程无回归。',
  ];
  const report={reference:fixtures.reference,geometryReference:fixtures.geometryReference,tolerance,skipped,
    total:results.length,failed:results.filter(r=>!r.passed).length,checks,calls,uncalled,gaps,
    coverageComplete:false,renderer,results};
  render(report);
  return report;
}
function render(report) {
  const failedChecks=checks.filter(c=>!c.passed).length;
  status.textContent=`${report.total} 项像素对比：${report.total-report.failed} 项容差内，${report.failed} 项超差；功能检查失败 ${failedChecks} 项。尚缺原版基准的项目见覆盖说明。`;
  status.className=report.failed||failedChecks ? 'fail':'pass';
  document.getElementById('coverage').textContent=JSON.stringify({calls,uncalled:report.uncalled,checks,gaps:report.gaps},null,2);
  const selection=document.getElementById('selection'),rows=document.getElementById('rows');
  for(const [i,result] of results.entries()) {
    const option=document.createElement('option');option.value=i;option.textContent=`${result.passed?'PASS':'FAIL'} ${result.name}`;selection.append(option);
    const row=document.createElement('tr');row.className=result.passed?'pass':'fail';
    const archive=result.softwareKernel?`${result.softwareKernel.maxRGB} / ${result.softwareKernel.maxAlpha}`:'-';
    for(const value of [result.name,result.error?'ERROR':result.passed?'容差内':'超差',`${result.maxRGB??'-'} / ${result.maxAlpha??'-'}`,`${result.differentPixels??'-'} / ${result.outsideTolerance??'-'}`,archive]) {
      const cell=document.createElement('td');cell.textContent=value;row.append(cell);
    }
    row.onclick=()=>{selection.value=i;show(i);};rows.append(row);
  }
  selection.onchange=()=>show(Number(selection.value));
  selection.value=Math.max(0,results.findIndex(r=>!r.passed));show(Number(selection.value));
  const download=document.getElementById('download');download.disabled=false;
  download.onclick=()=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='gpu-kirikiri-comparison.json';link.click();URL.revokeObjectURL(url);
  };
}
window.gpuTestResult=run().catch(error=>{status.textContent=error.stack;status.className='fail';throw error;});
