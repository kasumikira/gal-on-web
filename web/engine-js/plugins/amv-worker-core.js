// Decode session for the AMV-specific Worker: each session owns one AMVDecoder.
//
// As in the reference, the Worker only decodes the next frame from the current position,
// seeks, and resets. Container policy (Loop and NextMovieFile switching) stays on the main
// thread because it needs storage reads (the reference Decoder opens files by name, while
// storage reads on the Web are asynchronous).
// Decouple sessions from Worker transport so Node checks can use a fake decoder with the same protocol.

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
    // Return { reply, transfer }; transfer is the list of ArrayBuffers whose ownership should move.
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
          // DecodeNext_guess: at end of media, loop to the beginning or let the main thread switch files.
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

// await lets the Worker process later messages. Serialize each session explicitly so seek/dispose
// cannot modify a decoder that is still waiting for initialization or alpha decompression.
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
