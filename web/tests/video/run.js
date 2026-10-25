// 视频管线浏览器验证：真实 Worker、真实 WASM 解码、真实 WebGL2 上传与真实时钟。
//
// 两个后端各走一条消费路径：
//   AlphaMovie  脚本驱动：AmvWorkerSource（专用 Worker）+ VideoPipeline + showNextImage 式取帧
//   VideoOverlay 时钟驱动：video.js 的 Player（libav/WebCodecs 后端 + 有界队列）
// 素材都在页面内合成：AMV 用已知的块 alpha 位流（解码结果恒为 128,128,128,128），
// WebM 用 MediaRecorder 录制一块逐帧变色的画布。
import { initializeGPU, getGPU } from '/engine-js/gpu.js';
import { TEXT_BLEND } from '/engine-js/font.js';
import { Image } from '/engine-js/bitmap.js';
import { VideoPipeline, presentVideoFrame } from '/engine-js/video-pipeline.js';
import { probeLibavVideo } from '/engine-js/video-libav.js';
import { Player } from '/engine-js/video.js';
import { VideoAudio } from '/engine-js/video-audio.js';
import { AmvWorkerSource } from '/engine-js/plugins/amv-source.js';
import { buildAmv } from '../fixtures/amv-fixture.mjs';

const status = document.getElementById('status');
const rows = document.getElementById('rows');
const results = [];

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, label, timeout = 5000) => {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await wait(20);
  }
  throw new Error(`等待超时：${label}`);
};
const assert = (value, message) => { if (!value) throw new Error(message ?? 'assertion failed'); };
const assertEqual = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`${message ?? 'assertEqual'}: ${actual} !== ${expected}`);
};

async function check(label, fn) {
  try {
    const detail = await fn();
    results.push({ label, ok: true, detail: detail ?? '' });
    console.log(`ok   ${label}`);
  } catch (error) {
    results.push({ label, ok: false, detail: error?.message ?? String(error) });
    console.error(`fail ${label}:`, error);
  }
  render();
}

function render() {
  rows.innerHTML = '';
  for (const result of results) {
    const row = document.createElement('tr');
    row.innerHTML = `<td>${result.label}</td><td class="${result.ok ? 'pass' : 'fail'}">${result.ok ? '通过' : '失败'}</td><td></td>`;
    row.lastChild.textContent = result.detail;
    rows.append(row);
  }
  const failed = results.filter(result => !result.ok).length;
  status.textContent = `完成：${results.length - failed} 通过 / ${failed} 失败`;
  window.videoTestResult = { passed: results.length - failed, failed, results };
}

// --- 素材合成 -------------------------------------------------------------
// AMV 素材来自 web/tests/fixtures/amv-fixture.mjs：中性块 alpha 位流解码结果恒为
// (128,128,128,128)，因此可以把“Worker 解出的字节”和“写进图层的字节”逐字节对照。
const COLORS = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]];
async function recordClip() {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 48;
  const context = canvas.getContext('2d');
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  const chunks = [];
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  const stopped = new Promise(resolve => { recorder.onstop = resolve; });
  recorder.start();
  for (let index = 0; index < 20; index++) {
    const [r, g, b] = COLORS[index % COLORS.length];
    context.fillStyle = `rgb(${r},${g},${b})`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    await wait(50);
  }
  recorder.stop();
  await stopped;
  for (const track of stream.getTracks()) track.stop();
  return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

// --- 图层桩：真实 Image + 共享 GPU，只有状态查询被替换 ---------------------
function createLayerTarget(width, height) {
  const node = { image: new Image(width, height), width: 0, height: 0, left: 0, top: 0, imageModified: false };
  const Layer = {
    peekState: () => ({ node }),
    peekNode: () => node,
    // 真实 Layer::SetSize 只增不减；这里保持同样语义，便于验证行距写入。
    resizeNode: (target, w, h) => { target.width = w; target.height = h; },
  };
  return { node, Layer };
}

function preview(id, node) {
  const canvas = document.getElementById(id);
  canvas.width = node.image.width;
  canvas.height = node.image.height;
  const context = canvas.getContext('2d');
  context.putImageData(new ImageData(new Uint8ClampedArray(node.image.pixels), node.image.width, node.image.height), 0, 0);
}

// --- 检查 -----------------------------------------------------------------
async function main() {
  const info = document.createElement('div');
  info.id = 'gpu';
  document.body.append(info);
  initializeGPU(document, TEXT_BLEND);
  const gpu = getGPU();
  assert(gpu, 'WebGL2 初始化失败');

  await check('Web Audio PCM: native resampling, pause/resume and rate', async () => {
    for (const rate of [1, 2]) {
      const context = new OfflineAudioContext(2, 12000, 48000);
      let index = 0;
      const source = { info: { duration: .2 }, async nextAudio() {
        if (index === 2) return null;
        return { timestamp: index++ / 10, sampleRate: 44100,
          channels: [new Float32Array(4410).fill(.25), new Float32Array(4410).fill(.5)] };
      } };
      const audio = new VideoAudio(context, source, error => { throw error; });
      try {
        audio.node.connect(context.destination);
        await audio.play(); audio.pause(); audio.setRate(rate); await audio.play();
        const rendered = await context.startRendering();
        for (const time of [.05, .15]) {
          const index = Math.round(time * 48000 / rate);
          assert(Math.abs(rendered.getChannelData(0)[index] - .25) < .001, 'left PCM');
          assert(Math.abs(rendered.getChannelData(1)[index] - .5) < .001, 'right PCM');
        }
        assert(rendered.getChannelData(0).slice(Math.ceil(.22 * 48000 / rate)).every(value => Math.abs(value) < .001), 'silence after EOF');
        assert(audio.ended, 'audio clock reaches EOF');
      } finally { await audio.dispose(); }
    }
    return '44.1kHz to 48kHz, pause/resume, rate=1 and 2: native PCM output correct';
  });

  await check('GPU tiled linear sampling matches unsplit textures', () => {
    const source = new Image(8, 2), normal = new Image(16, 4), tiled = new Image(16, 4);
    const limit = gpu.maxTextureSize;
    try {
      const pixels = source.writablePixels;
      for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) {
        pixels[(y * 8 + x) * 4] = x * 32; pixels[(y * 8 + x) * 4 + 3] = 255;
      }
      gpu.texture(normal); gpu.texture(tiled);
      const options = { matrix: [2,0,0,2,0,0], mode: 1, copySourceAlpha: true, smooth: true };
      gpu.draw(normal, source, options);
      gpu.maxTextureSize = 4;
      gpu.draw(tiled, source, options);
      const expected = normal.pixels, actual = tiled.pixels;
      const error = expected.reduce((max, value, i) => Math.max(max, Math.abs(value - actual[i])), 0);
      assertEqual(error, 0, 'tile borders participate in linear sampling');
      return 'all RGBA pixels identical, maximum error=0';
    } finally { gpu.maxTextureSize = limit; source.release(); normal.release(); tiled.release(); }
  });

  await check('AMV Worker 后端：脚本驱动逐帧取帧，图层字节与 Worker 解出一致', async () => {
    const bytes = await buildAmv({ frames: 4 });
    const storage = { transferOwnership: true, read: async () => bytes };
    const source = new AmvWorkerSource({ storage });
    const error = await source.open('synthetic.amv');
    assertEqual(error, null, 'open');
    assertEqual(source.info.numOfFrame, 4, 'numOfFrame');
    assertEqual(source.info.screenWidth, 16, 'screenWidth');
    await source.setLoop(false);
    let decodeError = null;
    const pipeline = new VideoPipeline(source, { capacity: 2, onError: error => { decodeError = error; } });
    pipeline.start();
    await waitFor(() => pipeline.length === 2, '预解码填满有界队列');
    assert(pipeline.length <= 2, '预解码不得超过 preloadSamples');

    const { node, Layer } = createLayerTarget(16, 16);
    for (let index = 0; index < 4; index++) {
      const frame = pipeline.shift();
      assertEqual(frame.frame, index, `第 ${index} 帧帧号`);
      assertEqual(frame.left, 2 * index, '帧左偏移');
      assertEqual(frame.top, index, '帧上偏移');
      await presentVideoFrame([{}], frame, { Layer, left: frame.left, top: frame.top, repaint: () => {} });
      const pixels = node.image.pixels;
      assertEqual(pixels.length, frame.rgba.length, '图层像素长度');
      for (let byte = 0; byte < frame.rgba.length; byte++) {
        if (pixels[byte] !== frame.rgba[byte]) {
          throw new Error(`第 ${index} 帧第 ${byte} 字节：图层 ${pixels[byte]} != 解码 ${frame.rgba[byte]}`);
        }
      }
      assertEqual(pixels[0], 128, '解码结果（中性位流）');
      assertEqual(node.imageModified, true, '图层脏标记');
      assertEqual(node.left, frame.left, '图层位置');
      frame.close?.();
      await waitFor(() => pipeline.length === Math.min(2, 3 - index) || pipeline.drained, '剩余帧进入队列');
    }
    await waitFor(() => pipeline.drained, '片尾解完并取空');
    assert(!decodeError, `解码错误：${decodeError?.message ?? decodeError}`);
    preview('amv', node);
    document.getElementById('amvInfo').textContent =
      `4 帧 16x16，队列容量 2，片尾 drained=${pipeline.drained}`;
    await pipeline.dispose();
    return '帧号/偏移/像素与解码结果逐字节一致';
  });

  await check('AMV 呈现入口：图像大于帧时按图像行距写入，帧外保持原值', async () => {
    const bytes = await buildAmv({ frames: 1 });
    const source = new AmvWorkerSource({ storage: { transferOwnership: true, read: async () => bytes } });
    assertEqual(await source.open('one.amv'), null, 'open');
    const pipeline = new VideoPipeline(source, { capacity: 1 });
    pipeline.start();
    await waitFor(() => pipeline.length === 1, '解出唯一一帧');
    const frame = pipeline.shift();
    const { node, Layer } = createLayerTarget(24, 24);   // 图像大于帧
    node.image.pixels.fill(7);
    await presentVideoFrame([{}], frame, { Layer, left: 0, top: 0, repaint: () => {} });
    const pixels = node.image.pixels;
    assertEqual(pixels[0], 128, '帧内写入');
    assertEqual(pixels[16 * 4], 7, '帧右侧的图像列未被写入');
    assertEqual(pixels[24 * 4 * 16], 7, '帧下方的图像行未被写入');
    assertEqual(pixels[24 * 4 * 1], 128, '第二行按图像行距写入');
    frame.close?.();
    await pipeline.dispose();
    return '行距写入与帧外保留正确';
  });

  await check('libav/WebCodecs：保留帧通知，停顿后跳过过期画面上传', async () => {
    const bytes = await recordClip();
    assert(bytes.length > 0, 'MediaRecorder 未产出数据');
    const probed = await probeLibavVideo(bytes);
    assertEqual(probed.width, 64, '显示宽度');
    assertEqual(probed.height, 48, '显示高度');
    assert(probed.duration > 0.3, `时长 ${probed.duration}`);
    assert(probed.numberOfFrame >= 5, `帧数 ${probed.numberOfFrame}`);

    const { node, Layer } = createLayerTarget(64, 48);
    // 无音轨片段：时钟走 performance.now()，AudioContext 只需提供 resume/currentTime。
    const context = { currentTime: 0, resume: async () => {} };
    const player = new Player(probed, () => context, window);
    const presented = [];
    let ended = false, failure = null;
    player.onUpdate = async (frame, render) => {
      presented.push({ frame: frame.frame, timestamp: frame.timestamp, render });
      if (render) await presentVideoFrame([{}], frame, { Layer, repaint: () => {} });
    };
    player.onEnded = () => { ended = true; };
    player.onError = error => { failure = error; };
    const uploadsBefore = gpu.diagnostics().uploads;
    await player.play(0);
    await waitFor(() => player.pts > 0.2 || failure, '播放至暂停点');
    if (failure) throw failure;
    player.pause();
    const pausedAt = player.pts;
    await wait(80);
    assertEqual(player.pts, pausedAt, '暂停后时钟冻结');
    await player.play();
    assert(player.pts >= pausedAt, '恢复播放不得回到先前起点');
    await waitFor(() => player.pipeline.length === 2 || failure, '积累两帧以模拟主线程停顿');
    if (failure) throw failure;
    const blockedUntil = performance.now() + 150;
    while (performance.now() < blockedUntil) {} // Deliberate stall in this regression check only.
    await waitFor(() => ended || failure, '时钟推进至片尾');
    if (failure) throw failure;
    assert(presented.length >= 8, `呈现帧数 ${presented.length}`);
    for (let index = 1; index < presented.length; index++) {
      assert(presented[index].timestamp >= presented[index - 1].timestamp, '帧时间戳必须非递减');
    }
    assertEqual(node.image.width, 64, '图层宽度');
    assertEqual(node.image.height, 48, '图层高度');
    assert(gpu.diagnostics().uploads > uploadsBefore, '画布帧必须直接上传共享 WebGL2 纹理');
    assert(presented.some(frame => !frame.render), '停顿后应跳过已被替代的到期画面');
    assert(gpu.diagnostics().uploads - uploadsBefore < presented.length, '事件帧数应大于实际纹理上传次数');
    assert(player.pts > 0.1, `播放时钟未推进：${player.pts}`);
    preview('movie', node);
    document.getElementById('movieInfo').textContent =
      `帧通知 ${presented.length} 次，画面上传 ${gpu.diagnostics().uploads - uploadsBefore} 次，pts=${player.pts.toFixed(2)}s，结束=${ended}`;
    await player.dispose();
    return `通知 ${presented.length} 帧，上传 ${gpu.diagnostics().uploads - uploadsBefore} 次`;
  });

  await check('有界队列：消费端不取帧时生产者停在容量上', async () => {
    const bytes = await buildAmv({ frames: 6 });
    const source = new AmvWorkerSource({ storage: { transferOwnership: true, read: async () => bytes } });
    assertEqual(await source.open('queue.amv'), null, 'open');
    const pipeline = new VideoPipeline(source, { capacity: 3 });
    pipeline.start();
    await waitFor(() => pipeline.length === 3, '队列填满');
    await wait(200);
    assertEqual(pipeline.length, 3, '未取帧时队列长度');
    assertEqual(pipeline.peek().frame, 0, '队头帧');
    pipeline.stop();
    assertEqual(pipeline.length, 3, 'stop 保留已解码帧');
    pipeline.clear();
    assertEqual(pipeline.length, 0, 'clear 丢弃已解码帧');
    await pipeline.dispose();
    return '容量、stop 保留与 clear 丢弃均符合参考语义';
  });

  await check('共享 AMV Worker：会话隔离、转移缓冲接管与空帧清屏', async () => {
    const a = await buildAmv({ frames: 3 }), b = await buildAmv({ frames: 5 });
    const header = new DataView(a.buffer).getUint32(12, true);
    new DataView(a.buffer).setUint16(header + 16, 0, true);
    new DataView(a.buffer).setUint16(header + 18, 0, true);
    const sources = [a, b].map(bytes => new AmvWorkerSource({
      storage: { transferOwnership: true, read: async () => bytes },
    }));
    try {
      const errors = await Promise.all(sources.map(source => source.open('parallel.amv')));
      assert(errors.every(error => error === null), '两个会话都应成功打开');
      assertEqual(sources[0].info.numOfFrame, 3, '会话 A');
      assertEqual(sources[1].info.numOfFrame, 5, '会话 B');
      await Promise.all(sources.map(source => source.setLoop(false)));
      const frames = await Promise.all(sources.map(source => source.next()));
      assertEqual(frames[0].width, 0, '会话 A 首帧为空');
      assertEqual(frames[1].width, 16, '会话 B 首帧非空');
      const { node, Layer } = createLayerTarget(16, 16);
      await presentVideoFrame([{}], frames[1], { Layer });
      assert(node.image.pixels === frames[1].rgba, '整图覆盖应接管转移缓冲');
      let updates = 0;
      await presentVideoFrame([{}], frames[0], {
        Layer, left: 9, top: 10, repaint: () => { updates++; },
      });
      assertEqual(node.width, 0, '空帧宽度');
      assertEqual(node.height, 0, '空帧高度');
      assertEqual(node.left, 9, '空帧仍设置位置');
      assertEqual(updates, 1, '空帧仍请求重绘');
      await Promise.all(sources.map(source => source.seek(1)));
      const next = await Promise.all(sources.map(source => source.next()));
      assert(next.every(frame => frame.frame === 1 && frame.rgba[0] === 128), '定位后两会话继续正确解码');
      return '相同请求编号互不串帧，真实转移缓冲直接成为 Image 像素';
    } finally { await Promise.all(sources.map(source => source.dispose())); }
  });

  render();
}

main().catch(error => {
  results.push({ label: '页面执行', ok: false, detail: error?.stack ?? String(error) });
  render();
});
