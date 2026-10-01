# W1 · libfx 能否在子进程中加载运行 —— 验证结论

> 验证日期：2026-10-01 · 环境：macOS (Apple Silicon) / Node v22.20.0 / libfx（npm 最新）
> 对应待验证项：[09-路线图 §1 W1](../../设计文档/09-路线图.md)。**结论：子进程路径成立（推荐路径），Agent 层按 child_process 架构落地。**

## 实测内容与结果

| # | 验证点 | 方法 | 结果 |
|---|---|---|---|
| 1 | libfx 可安装 | `npm i --save-optional libfx` | ✅（N-API 原生模块随包分发，无需本地编译） |
| 2 | **子进程加载** | 独立 `.mjs` 进程 `createRequire('libfx')` | ✅ exports: `createFxAgent / createFxTerminal / getBackendInfo / listModels / fxSdkApiVersion …` |
| 3 | 后端探测（无需凭据） | `getBackendInfo({ surface:'agent', backend:'auto' })` | ✅ `{ backend: 'native', attempts: [{ backend:'native', available:true }] }` |
| 4 | 无效密钥的失败形态 | `createFxAgent({ apiKey:'sk-invalid-probe', … })` + `prompt` | ✅ **干净拒绝**：会话可创建、流结束 `stopReason:'refused'`——对应设计的 `fx_auth_refused` 错误码，**不是 native 崩溃**（隔离设计的前提成立） |
| 5 | 真实凭据的流式输出 + checkpoint 往返 | 需有效 API Key | ⏳ **未实测**（本机无可用凭据）。`stopReason:'refused'` 路径已证明失败不伤宿主；真实往返留待首次配置凭据后补测 |

## 对设计的影响

- 07 §1.2 的选择（**独立 child_process**）确认为正确路径：加载、探测、失败形态全部符合预期。
- `stopReason:'refused'` → 界面引导检查 Key/额度（07 §2.2 `fx_auth_refused` 的处置路径）。
- 真实流式/checkpoint 的补测不需要改架构——宿主协议（stdio 4 命令）已按"流式事件会到达"设计，届时只需换上有效凭据跑一轮。
- libfx 为 **optionalDependencies**：不可用（平台/ABI 不符）时 Agent 层整体降级（07 §1.4），其余功能不受影响。
