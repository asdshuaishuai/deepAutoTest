// 验证 bind 是否支持 async（返回 Promise）——这决定 IPC 实现是同步阻塞还是干净的异步
import { Webview } from 'webview-nodejs';
import fs from 'node:fs';

const LOG='/tmp/wvtest/probe6.log';
let lines=[]; const mark=s=>{lines.push(s);fs.writeFileSync(LOG,lines.join('\n'));};

const w=new Webview(true);
w.title('probe6'); w.size(460,300);

// A) 同步 bind
w.bind('syncCall', (_w, n) => { mark(`syncCall(${n})`); return 'sync-' + n; });

// B) 异步 bind：返回 Promise
w.bind('asyncCall', async (_w, n) => {
  mark(`asyncCall(${n}) 开始`);
  // 用原生 setTimeout（不依赖 Node 事件循环是否被阻塞的问题——bind 由原生同步调用，但 Promise 微任务呢？）
  const v = await new Promise(res => setTimeout(() => res('async-' + n), 1200));
  mark(`asyncCall(${n}) 完成`);
  return v;
});

// C) 抛异常的 bind
w.bind('failCall', (_w, n) => { throw new Error('故意的错误 ' + n); });

w.init(`
  window.__log = [];
  setTimeout(async () => {
    // 1) 同步调用
    try { window.__log.push('A:' + await window.syncCall(1)); } catch(e){ window.__log.push('A:ERR'); }
    // 2) 异步调用（关键：能否等待到结果）
    try { window.__log.push('B:' + await window.asyncCall(2)); } catch(e){ window.__log.push('B:ERR:' + e.message); }
    // 3) 异常传播
    try { window.__log.push('C:' + await window.failCall(3)); } catch(e){ window.__log.push('C:捕获到异常 ✓'); }
    // 4) 页面自身能否 fetch（系统 WebView 的网络能力）
    try { const r = await fetch('http://127.0.0.1:38471/'); window.__log.push('D:' + await r.text()); }
    catch(e){ window.__log.push('D:ERR:' + e.message); }
    console.log('RESULT=' + JSON.stringify(window.__log));
  }, 300);
`);
w.html('<h1>probe6</h1>');
w.show();
