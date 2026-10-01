# 验证脚本

这些是最小探测脚本，用于验证 [设计文档/10-技术选型.md](../设计文档/10-技术选型.md) 中记录的**关键架构约束**。
运行环境：macOS / Node 20.19 / Apple Silicon（实测日期 2026-09-14）。

## 前置

```bash
mkdir -p /tmp/wvtest && cd /tmp/wvtest && npm init -y && npm install webview-nodejs
# 需要 cmake 与 Xcode Command Line Tools
```

## 脚本与结论

| 脚本 | 验证什么 | 实测结论 |
|---|---|---|
| `probe-01-show阻塞.mjs` | `show()` 期间主线程事件循环是否可用 | ❌ **被阻塞**：定时器不触发、`fetch` 不执行 |
| `probe-02-SAB绕过阻塞.mjs` + `probe-02-worker.mjs` | SAB + Atomics 能否在阻塞期间完成跨线程 IO | ✅ **成功**：页面发起 13 次真实 HTTP 请求全部返回 |
| `probe-03-async-bind挂起.mjs` | `async` 的 `bind` 回调能否 resolve | ❌ **挂起**：Promise 永不 resolve（故 RPC 必须用同步 + `Atomics.wait`） |
| `probe-04-worker能力.mjs` | worker 内的异步 IO 与内置模块可用性 | ✅ worker 内 `fetch` 正常；⚠️ Node 20 无 `node:sqlite`（需 22+） |

## 这些结论如何影响架构

见 [设计文档/02-架构.md §2](../设计文档/02-架构.md) —— 主线程只做 UI 壳，所有 IO 走 Worker，
跨线程用 `SharedArrayBuffer` + `Atomics.wait` 同步通信。

> **注意**：这些脚本是**一次性探测**，用于确认架构可行性，不是项目的测试套件。
> 真正的测试见 [设计文档/02-架构.md §9](../设计文档/02-架构.md) 的测试策略。
