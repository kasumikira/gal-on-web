// AMV 专用 Worker 入口：把会话协议接到 worker 消息通道上。
// 解码本体在 amv.js（Rust/WASM），协议与容器策略见 amv-worker-core.js。
import { AMVDecoder } from './amv.js';
import { createAmvWorkerEndpoint } from './amv-worker-core.js';

const handle = createAmvWorkerEndpoint({
  createDecoder: () => new AMVDecoder(),
  postMessage: (message, transfer) => self.postMessage(message, transfer),
});

self.onmessage = ({ data }) => { handle(data); };
