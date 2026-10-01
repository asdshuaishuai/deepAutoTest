import { Webview } from 'webview-nodejs';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';

const LOG = '/tmp/wvtest/probe5.log';
let lines = [];
const mark = s => { lines.push(s); fs.writeFileSync(LOG, lines.join('\n')); };

const sab = new SharedArrayBuffer(65536);
const ctrl = new Int32Array(sab, 0, 2);
const data = new Uint8Array(sab, 8);
const dec = new TextDecoder();

const worker = new Worker('/tmp/wvtest/worker.mjs', { workerData: { sab } });
worker.on('error', e => mark('worker 错误: ' + e.message));

const wr = Atomics.wait(ctrl, 0, 0, 8000);
mark('worker 就绪: wait=' + wr + ' ctrl0=' + ctrl[0]);

const w = new Webview(true);
w.title('probe5'); w.size(500, 320);
w.bind('log', (_w, s) => { mark('页面: ' + s); return 'ok'; });
w.bind('doFetch', (_w, n) => {
  ctrl[0] = 0; ctrl[1] = 0;
  try { worker.postMessage({ type: 'fetch', n }); } catch (e) { return 'POST_ERR:' + e.message; }
  const r = Atomics.wait(ctrl, 0, 0, 5000);
  if (ctrl[0] === 1) return dec.decode(data.subarray(0, ctrl[1]));
  return 'FAILED(wait=' + r + ',state=' + ctrl[0] + ')';
});
w.init(`
  window.__n = 0;
  setInterval(async () => {
    window.__n++;
    try { const r = await window.doFetch(window.__n); await window.log('第' + window.__n + '次: ' + r); }
    catch (e) { await window.log('第' + window.__n + '次异常: ' + e.message); }
  }, 600);
`);
w.html('<h1>probe5</h1>');
mark('调用 show()');
w.show();
mark('show() 返回');
