import { Webview } from 'webview-nodejs';
import http from 'node:http';
import fs from 'node:fs';

const LOG = '/tmp/wvtest/probe2.log';
const lines = [];
const t0 = Date.now();
const mark = s => { const l=`[${String(Date.now()-t0).padStart(5)}ms] ${s}`; lines.push(l); fs.writeFileSync(LOG, lines.join('\n')); };

const server = http.createServer((_q,r)=>r.end('pong'));
server.listen(0,'127.0.0.1',()=>mark(`HTTP 就绪 :${server.address().port}`));

const w = new Webview(true);
w.title('probe2'); w.size(480,300); w.html('<h1>probe2</h1>');

let ticks=0;
setInterval(()=>{ ticks++; mark(`tick #${ticks}`); }, 400);

setTimeout(()=>{
  const port = server.address().port;
  mark('发起 fetch…');
  fetch(`http://127.0.0.1:${port}/`).then(async r=>mark(`✅ fetch OK: ${await r.text()}`))
                                       .catch(e=>mark(`❌ fetch 失败: ${e.message}`));
}, 1000);

setTimeout(()=>{ mark(`tick 总数=${ticks}`); server.close(); w.terminate(); }, 3000);

mark('调用 show() 之前');
w.show();
mark('show() 返回后');
fs.writeFileSync(LOG, lines.join('\n'));
console.log(lines.join('\n'));
