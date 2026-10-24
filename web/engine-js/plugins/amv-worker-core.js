// AMV 专用 Worker 的解码会话：一个会话持有一个 AMVDecoder。
//
// 与参考实现的分工一致：Worker 只负责“从当前位置解下一帧 / seek / 重置”，
// 容器策略（Loop、NextMovieFile 切换）留在主线程，因为它需要 storage 读取
// （参考实现的 Decoder 直接按名字打开文件，Web 侧存储读取是异步的）。
// 会话与 Worker 传输层解耦，便于在 Node 检查里用假解码器驱动同一套协议。

const frameReply = (header, width, height) => ({
  frame: {
    frame: header.frame, left: header.left, top: header.top,
    width, height,
  },
});

export function createAmvSession(createDecoder) {
  let decoder = null;
  const info = () => ({
    numOfFrame: decoder.numOfFrame,
    fpsScale: decoder.fpsScale,
    fpsRate: decoder.fpsRate,
    screenWidth: decoder.screenWidth,
    screenHeight: decoder.screenHeight,
    separateAlpha: decoder.separateAlpha,
  });
  return {
    get decoder() { return decoder; },
    // 返回 { reply, transfer }；transfer 是需要转移所有权的 ArrayBuffer 列表。
    async handle(message) {
      switch (message.type) {
        case 'open': {
          decoder?.dispose();
          decoder = null;
          const next = createDecoder();
          const error = next.open(message.bytes);
          if (error) { next.dispose(); return { reply: { ok: false, error } }; }
          decoder = next;
          return { reply: { ok: true, info: info() } };
        }
        case 'decode': {
          if (!decoder?.bytes) return { reply: { ok: true, end: true } };
          // DecodeNext_guess：片尾时循环回到开头，或交由主线程切换下一个文件。
          if (decoder.advance() === 'next') return { reply: { ok: true, end: true } };
          const decoded = await decoder.decodeNext({ transferable: true });
          if (!decoded) return { reply: { ok: true, end: true } };
          const { header, width, height, rgba } = decoded;
          const reply = { ok: true, ...frameReply(header, width, height) };
          if (!(width > 0 && height > 0) || !rgba) return { reply };
          reply.pixels = rgba;
          return { reply, transfer: [rgba.buffer] };
        }
        case 'rewind': {
          if (decoder) { decoder.position = decoder.firstPosition; decoder.frame = 0; }
          return { reply: { ok: true } };
        }
        case 'seek': {
          const found = decoder ? decoder.seekFrame(message.frame) : false;
          return { reply: { ok: true, found } };
        }
        case 'loop': {
          if (decoder) decoder.loop = !!message.loop;
          return { reply: { ok: true } };
        }
        case 'dispose': {
          decoder?.dispose();
          decoder = null;
          return { reply: { ok: true } };
        }
        default:
          return { reply: { ok: false, error: `unknown request ${message.type}` } };
      }
    },
  };
}

// await 会让 Worker 处理后续消息；每个会话显式串行，避免 seek/dispose
// 修改尚在等待初始化或 alpha 解压的 decoder。
export function createAmvWorkerEndpoint({ createDecoder, postMessage }) {
  const sessions = new Map();
  return message => {
    const { session: id, request } = message;
    let entry = sessions.get(id);
    if (!entry) {
      entry = { session: createAmvSession(createDecoder), tail: Promise.resolve() };
      sessions.set(id, entry);
    }
    const task = entry.tail.then(async () => {
      let result;
      try { result = await entry.session.handle(request); }
      catch (error) { result = { reply: { ok: false, error: error?.message ?? String(error) } }; }
      postMessage({ session: id, id: request.id, ...result.reply }, result.transfer ?? []);
      if (request.type === 'dispose') sessions.delete(id);
    });
    entry.tail = task.catch(() => {});
    return task;
  };
}
