import { parentPort, workerData } from 'node:worker_threads';
import http from 'node:http';

const sab = workerData.sab;
const ctrl = new Int32Array(sab, 0, 2);
const data = new Uint8Array(sab, 8);
const enc = new TextEncoder();

// worker 有自己独立的事件循环：起一个 HTTP 服务
const server = http.createServer((_q, r) => r.end('pong-from-worker'));
server.listen(38471, '127.0.0.1', () => {
  ctrl[0] = 100; ctrl[1] = 0;
  Atomics.notify(ctrl, 0);
});

parentPort.on('message', async (msg) => {
  if (msg.type === 'fetch') {
    try {
      const res = await fetch('http://127.0.0.1:38471/?n=' + msg.n);
      const text = await res.text();
      const b = enc.encode(text);
      data.set(b.subarray(0, 4096));
      ctrl[1] = b.length; ctrl[0] = 1;
    } catch (e) {
      const b = enc.encode('ERR:' + e.message);
      data.set(b.subarray(0, 4096));
      ctrl[1] = b.length; ctrl[0] = -1;
    }
    Atomics.notify(ctrl, 0);
  }
});
