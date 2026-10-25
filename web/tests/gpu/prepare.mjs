import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = path.join(root, 'out/gpu-tests');
mkdirSync(output, { recursive: true });
const compiler = process.env.CXX || (existsSync('C:/msys64/ucrt64/bin/g++.exe')
  ? 'C:/msys64/ucrt64/bin/g++.exe' : 'g++');
const env = { ...process.env, PATH: path.dirname(compiler) + path.delimiter + process.env.PATH };
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command} failed (${result.status}): ${result.stderr}`);
  return result.stdout;
}
const executable = path.join(output, process.platform === 'win32' ? 'oracle.exe' : 'oracle');
run(compiler, ['-std=c++17', '-O2', '-Ithird_party/kirikiroid2/cpp/core/tjs2', '-Ithird_party/kirikiroid2/cpp/core/visual',
  'web/tests/gpu/oracle.cpp', 'third_party/kirikiroid2/cpp/core/visual/gl/blend_function.cpp', '-o', executable]);

// Explicit boundary Cartesian product + deterministic colours. No Math.random.
const edge = [0, 1, 2, 127, 128, 253, 254, 255];
let seed = 0x13579bdf;
const byte = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed & 255; };
const pack = (r, g, b, a) => ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
const width = 8, height = 8, n = width * height;
const d = [], a = [], b = [], rule = [];
for (let i = 0; i < n; i++) {
  d.push(pack(edge[i % 8], byte(), byte(), edge[Math.floor(i / 8)]));
  a.push(pack(byte(), edge[Math.floor(i / 8)], byte(), edge[i % 8]));
  b.push(pack(byte(), byte(), edge[i % 8], edge[7 - i % 8]));
  rule.push(pack(edge[i % 8], 0, 0, 255));
}
const inputs = { d, a, b, rule };
const cases = [];
const jobs = [];
function add(name, method, op, args = {}, extra = {}) {
  const test = { name, method, args, ...extra };
  const count=extra.size ? extra.size.width*extra.size.height : n;
  const repeat = pixels => Array.from({length:count},(_,i)=>pixels[i%pixels.length]);
  const job = op => [op, count, args.mode ?? 0, args.opacity ?? 255, args.flags ?? 2, args.phase ?? 0, args.vague ?? 0,
    ...repeat(d), ...(extra.fill !== undefined ? Array(count).fill(extra.fill) : repeat(extra.self ? d : a)), ...repeat(b), ...repeat(rule),
    ...(extra.geometry ? [...extra.geometry.matrix, ...Object.values(extra.geometry.sourceRect), ...Object.values(extra.geometry.clip)] : []),
    ...(extra.numbers ?? [])].join(' ');
  cases.push(test);
  test.job = jobs.length;
  jobs.push(job(op));
  // Keep the software-renderer kernel as an archive expectation next to the
  // ideal bilinear reference the GL backend actually implements.
  if(extra.softwareKernel !== undefined) { test.softwareJob = jobs.length; jobs.push(job(extra.softwareKernel)); }
}
const modes = [0,1,2,3,4,5,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28];
// Valid public face/HDA combinations; copySourceAlpha and ignoreSourceAlpha
// additionally exercise the copy and opaque-source contracts.
for (const mode of modes) for (const opacity of [0,1,127,128,254,255]) {
  for (const flags of [2,3,0,1,6,10,18]) {
    // Portable PartialBlt explicitly leaves bmAddAlphaOnAlpha unimplemented.
    if(mode===12 && flags&2 && !(flags&4))continue;
    add(`draw/m${mode}/o${opacity}/f${flags}`, 'draw', 0, { mode, opacity, flags });
  }
}
for (const mode of [1,2,3,18]) add(`draw/self/m${mode}`, 'draw', 0, { mode, opacity: 128, flags: 2 }, { self: true });
for (const method of ['copy', 'clone', 'assign', 'read', 'point']) add(method, method, 3);
add('present/black-background', 'present', 7);
for(const method of ['operateRect','operateStretch','operateAffine','stretchCopy','stretchPile','stretchBlend','affineCopy','affinePile','affineBlend']) {
  const copy=method.endsWith('Copy'), blend=method.endsWith('Blend');
  add(`Layer.${method}/identity`, 'layer', 0,
    {mode:copy||blend?1:2,opacity:copy?255:128,flags:copy?10:2}, {layerMethod:method});
}
// LayerBitmapIntf FillColor / BlendColor / RemoveConstOpacity: the constant
// colour operators. op is the reference op code, colour is 0xAARRGGBB.
for(const [label,op,colour,opacity] of [
  ['fillColor/opaque',9,0x00112233,255],['fillColor/blend',10,0x00112233,128],
  ['fillColor/blend255',10,0x00112233,255],['blendColor/alpha',11,0x00112233,128],
  ['blendColor/additive',12,0x00112233,128],['fillARGB',13,0x80112233,255],
  ['removeConstOpacity',14,0,128],
]) {
  // colourOp is the shader sub-op (0..5), op is the oracle entry point.
  add(`colour/${label}`, 'colour', op, {mode:colour|0,opacity}, {colourOp:op-9});
}
// TVPDoGrayScale / TVPConvert(Additive)Alpha.
// Exercise the Image entry, including BlendColor's opaque FillARGB shortcut.
for(const additive of [false,true]) for(const opacity of [128,254,255]) {
  add(`Image.blendColor/${additive?'additive':'alpha'}/o${opacity}`, 'imageBlendColor',
    opacity===255?13:additive?12:11,
    {mode:opacity===255?0xff112233|0:0x112233,opacity}, {additive,colour:0x112233});
}
// A solid nine-patch interior must remain solid after resizing. The original
// software Copy9Patch copies corner rows and uses TVPFillARGB for a 1px centre;
// a constant interior is also invariant under its interpolation kernels.
// Generate the whole expected destination with that original FillARGB routine.
for(const [centreWidth,centreHeight] of [[1,1],[1,3],[3,1],[3,3]]) {
  add(`copy9Patch/centre${centreWidth}x${centreHeight}`, 'ninePatch', 1, {},
    {size:{width:15,height:13},fill:0xff5b25cb,centreWidth,centreHeight});
}

for(const [label,op,kind] of [['grayscale',15,0],['alphaToAdditive',16,1],['additiveToAlpha',17,2]]) {
  add(`transform/${label}`, 'transform', op, {kind});
}
// tTJSNI_BaseLayer::ApplyGaussianBlur: radius in mode, sigma as a trailing number.
for(const [radius,sigma] of [[1,1],[1,1.5],[2,1],[3,2],[2,0.8]]) {
  add(`blur/gaussian/r${radius}/s${sigma}`, 'gaussian', 22, {mode:radius}, {sigma, numbers:[sigma]});
}
// LayerIntf AdjustGamma: the gamma data is appended to the job line so the
// reference builds its table with TVPInitGammaAdjustTempData. R and B share the
// same triple: the portable TVPAdjustGamma_c maps the low byte (blue) through
// temp->R, so a symmetric table keeps the channel mapping out of the result.
for(const [label,op,additive,gamma] of [
  ['adjustGamma',20,false,[1.5,0,255]],
  ['adjustGamma/linear',20,false,[1,16,240]],
  ['adjustGamma/additive',21,true,[1.8,0,255]],
]) {
  const values = [gamma[0],gamma[1],gamma[2], 2.2,gamma[1],gamma[2], gamma[0],gamma[1],gamma[2]];
  add(`lookup/${label}`, 'lookup', op, {}, {gamma:values, additive, numbers:values});
}
// iTVPBaseBitmap::DoBoxBlur (op 18) and DoBoxBlurForAlpha (op 19).
for(const [label,op,alpha] of [['boxBlur',18,false],['boxBlur/alpha',19,true]]) {
  for(const radius of [1,3]) {
    add(`${label}/r${radius}`, 'blur', op, {mode:-radius,opacity:-radius,phase:radius,vague:radius}, {blurAlpha:alpha});
  }
}
// LayerIntf.cpp PileRect (bmAlphaOnAlpha) and BlendRect (bmCopyOnAlpha) on dfAlpha.
for(const method of ['pileRect','blendRect']) for(const opacity of [128,255]) {
  add(`Layer.${method}/o${opacity}`, 'layer', 0,
    {mode:method==='pileRect'?2:1,opacity,flags:2}, {layerMethod:method});
}
for (const maskOnly of [false,true]) for (const alpha of edge) {
  add(`fill/${maskOnly ? 'mask' : 'rgba'}/${alpha}`, 'fill', maskOnly ? 2 : 1, {}, { fill: pack(91,37,203,alpha), maskOnly });
}
for(const clip of [[-2,-2,4,5],[3,2,5,7],[8,0,9,8],[4,4,4,4]]) {
  for(const maskOnly of [false,true]) add(`fill/clip/${clip.join(',')}/${maskOnly}`, 'fill', maskOnly?2:1, {},
    {fill:pack(91,37,203,0),maskOnly,clip:{left:clip[0],top:clip[1],right:clip[2],bottom:clip[3]}});
}
for(const size of [{width:1,height:1},{width:3,height:5},{width:17,height:3}]) {
  const prefix=`size/${size.width}x${size.height}`;
  add(`${prefix}/copy`,'copy',3,{}, {size});
  add(`${prefix}/fill`,'fill',1,{}, {size,fill:pack(91,37,203,0)});
  add(`${prefix}/alpha`,'draw',0,{mode:2,opacity:128,flags:2},{size});
  add(`${prefix}/crossfade`,'crossfade',4,{mode:2,phase:128},{size});
  add(`${prefix}/universal`,'universal',5,{mode:2,phase:128,vague:64},{size});
}
for (const type of [1,2,12,13,28]) {
  for (const phase of [0,1,127,128,254,255]) add(`crossfade/t${type}/p${phase}`, 'crossfade', 4, { mode: type, phase });
  for (const vague of [0,1,64,255,511,512,513]) for (const phase of [0,1,127,255,256,255+vague]) {
    add(`universal/t${type}/p${phase}/v${vague}`, 'universal', 5, { mode: type, phase, vague });
  }
}
const rect = (left,top,right,bottom) => ({left,top,right,bottom});
for (const [name,matrix] of Object.entries({ identity:[1,0,0,1,0,0], translate:[1,0,0,1,-2,1],
  halfPixel:[1,0,0,1,0.5,-0.5], enlarge:[2,0,0,2,-1,-1], reduce:[0.5,0,0,0.5,1,1],
  mirror:[-1,0,0,1,8,0], rotate90:[0,1,-1,0,8,0], shear:[1,0.25,0,1,0,0], singular:[0,0,0,1,0,0] })) {
  for (const smooth of [false,true]) for (const cropped of [false,true]) {
    const geometry = {matrix,sourceRect:cropped ? rect(1,1,7,7) : rect(0,0,8,8),clip:cropped ? rect(2,1,6,7) : rect(0,0,8,8)};
    add(`geometry/${name}/${smooth ? 'linear' : 'nearest'}/${cropped ? 'crop' : 'full'}`, 'geometry', smooth ? 8 : 6,
      {mode:width,opacity:height,flags:Number(smooth)}, {geometry,smooth,softwareKernel: smooth ? 6 : undefined});
  }
}
add('geometry/self/overlap','geometry',6,{mode:width,opacity:height,flags:0},
  {self:true,smooth:false,geometry:{matrix:[1,0,0,1,1,1],sourceRect:rect(0,0,8,8),clip:rect(0,0,8,8)}});
const lines = run(executable, [], { input: jobs.join('\n') + '\n' }).trim().split('\n');
if (lines.length !== jobs.length) throw Error('Reference output count mismatch');
const pixel = p => [p >>> 16 & 255, p >>> 8 & 255, p & 255, p >>> 24];
cases.forEach(test => {
  const words=lines[test.job].trim().split(/\s+/).map(Number);
  delete test.job;
  const count=test.size ? test.size.width*test.size.height : n;
  if(words.length!==count||words.some(p=>!Number.isInteger(p)||p<0||p>0xffffffff))throw Error(`Invalid oracle output: ${test.name}`);
  test.expected = words.flatMap(pixel);
  if(test.softwareJob !== undefined) {
    const software=lines[test.softwareJob].trim().split(/\s+/).map(Number);
    if(software.length!==count)throw Error(`Invalid software-kernel output: ${test.name}`);
    test.softwareKernel=software.flatMap(pixel);
    delete test.softwareJob;
  }
  if(test.clip)for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    if(x<test.clip.left||y<test.clip.top||x>=test.clip.right||y>=test.clip.bottom) {
      test.expected.splice((y*width+x)*4,4,...pixel(d[y*width+x]));
    }
  }
});
writeFileSync(path.join(output,'fixtures.json'), JSON.stringify({
  reference: 'third_party/kirikiroid2/cpp/core/visual/tvpgl.cpp (portable C + native blend-slot overrides)',
  geometryReference: 'nearest: TVPLinTransCopy; linear: ideal double precision bilinear, i.e. the GL_LINEAR sampling the engine\'s GL render backend uses (software TVPInterpLinTransCopy kept as case.softwareKernel); test harness maps pixel centres, not the full LayerBitmap rasterizer',
  width,height,inputs:Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,v.flatMap(pixel)])),cases,
}));
console.log(`Generated ${cases.length} original-reference cases.\nStart pnpm dev:vite, then open:\nhttp://127.0.0.1:5173/tests/gpu/index.html`);
