// 关键验证：worker 里能否加载 N-API 原生模块（libfx / better-sqlite3 类）
import { Worker, isMainThread } from 'node:worker_threads';

const code = `
const { parentPort } = require('node:worker_threads');
const results = [];
try {
  // 1) Node 内置 sqlite（Node 22+；20 无）
  try { require('node:sqlite'); results.push('node:sqlite: 可用'); }
  catch (e) { results.push('node:sqlite: 不可用 (' + e.code + ')'); }
  // 2) worker 里的异步 IO
  const http = require('node:http');
  const s = http.createServer((q,r)=>r.end('ok'));
  s.listen(0, '127.0.0.1', () => {
    fetch('http://127.0.0.1:' + s.address().port + '/')
      .then(r=>r.text())
      .then(t => { results.push('worker 异步 HTTP: ' + t); s.close(); parentPort.postMessage(results); })
      .catch(e => { results.push('worker HTTP 失败: ' + e.message); parentPort.postMessage(results); });
  });
} catch (e) { results.push('异常: ' + e.message); parentPort.postMessage(results); }
`;
new Worker(code, { eval: true })
  .on('message', m => { m.forEach(x=>console.log('  '+x)); process.exit(0); })
  .on('error', e => { console.log('  worker 错误: ' + e.message); process.exit(1); });
