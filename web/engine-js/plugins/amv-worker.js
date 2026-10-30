// Entry point for the AMV-specific Worker: connect the session protocol to the Worker message channel.
// Decoding itself is in amv.js (Rust/WASM); see amv-worker-core.js for the protocol and container policy.
import { AMVDecoder } from './amv.js';
import { createAmvWorkerEndpoint } from './amv-worker-core.js';

const handle = createAmvWorkerEndpoint({
  createDecoder: () => new AMVDecoder(),
  postMessage: (message, transfer) => self.postMessage(message, transfer),
});

self.onmessage = ({ data }) => { handle(data); };
