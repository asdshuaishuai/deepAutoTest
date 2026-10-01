# deepAutoTest

> 源码驱动的 API 自动化测试工作台 · 设计稿 v1.0
> **状态：引擎层全部落地（基座/分析/合成/执行/PRD/UI 测试/采样/db_check/Agent），159 项验收测试（W1 已验证：libfx 子进程加载 + native 后端 + refused 失败形态）。**
> **UI 壳（桌面应用）是独立的另一个项目**，不在本仓库——引擎层只暴露 `kernel.call` 单一入口，任何壳（webview 桌面 / CLI / 未来形态）都是它的传输适配层。
> 独立项目，与 deepStudio 共享哲学，不共享代码。
> 前身设计稿名 `autoTestStudio`，本稿更名为 **deepAutoTest**。

---

## 一句话

**把被测服务的源码变成可执行、可追溯、可复现的测试资产。**

从源码里发现 API、从源码里提炼测试数据设计原则、从测试库采样真实数据形态，由内嵌 fx Agent 把三者合成为可执行用例；执行过程产生一条**追加式事件日志**，一切结论（通过/失败/变慢/不稳定）都是这条日志的投影，因此永远可以回答"这个结果基于什么"并可重新判定。

上一代平台以 OpenAPI 文档为输入。deepAutoTest 以**源码本身**为输入——文档会过期，源码不会。

---

## 与 deepStudio 的关系：哲学同源，工程独立

deepAutoTest 不依赖 deepStudio 的任何代码、产物或运行时。两者只共享一套已经验证过的设计哲学：

| 哲学 | deepStudio 的落地 | deepAutoTest 的落地 |
|---|---|---|
| **唯一事实源** | 一份 `.mbt.md` 是项目真相 | **被测源码**是资产源头；**追加式执行事件日志**是结果真相 |
| **派生只做缓存** | SVG / RenderPlan / 内存 Project 都不可持久化 | 结果表 / 通过率 / 趋势图都是事件日志的投影，可重建 |
| **双向提交边界相同** | 人类画布操作与 Agent 操作都经引擎 Gate 写回同一份 MBT | 人类编辑与 Agent 合成产出同一用例模型、写同一事件日志 |
| **AI 不越权** | Agent 只能调 `moonviz_op`，AgentGate 更严格 | Agent 产物一律 `proposed`，人工裁决才 `adopted` |
| **一切可回放** | MBT 重新解析后画布才更新；操作可重放 | 日志可重放、判定可重算（re-judge）、结果可对账（diff） |
| **只读查看器独立** | `ddpView` 只解密渲染，不调 Agent、不写文件 | **归档浏览器**只读回放历史运行，不触发执行、不改用例 |

一句话概括这条哲学：**真相只有一个，其余都是投影；改变真相必须过门；任何状态都必须能被重新解释。**

---

## 产品形态

跨平台桌面应用。**系统 WebView 壳 + 内置 Node（不捆绑 Chromium、不依赖 Electron/Tauri）**。

架构是**三层两个进程**：

```
① Node 主线程    仅 UI 壳（webview 窗口 + RPC 路由），不做任何 IO
② Worker 池      全部业务：AST 分析 / HTTP 执行 / 数据库 / 判定 / 存储
③ 系统 WebView   React 界面，通过 window.rpc.* 调用 Node
```

关键判断：本产品的 S/A 级需求（TS/JS 源码 AST 分析、真实 HTTP 执行、多数据库只读采样、AI Agent 集成）**全部指向 Node 生态**——`ts-morph` / `undici` / `mysql2` / `libfx` 都是 Node 包。因此必须内置 Node。

**为什么不用 Electron**：它捆绑完整 Chromium，分发体积 ~124 MB，过重。
**为什么不用 Tauri**：后端是 Rust，会丢掉 Node 生态。
**体积对比**：本方案约 55–70 MB，约为 Electron 的一半。

**一个实测发现的关键约束**：系统 WebView 的 `show()` 会阻塞 Node 事件循环（定时器、`fetch`、`await` 全部失效），因此**所有 IO 必须走 Worker**，跨线程用 `SharedArrayBuffer` + `Atomics` 同步通信。此方案已本机实测跑通。

完整推导与实测证据见 [设计文档/10-技术选型.md](设计文档/10-技术选型.md)。

---

## 设计文档导航

按此顺序阅读，01→05 是主体，06→10 是支撑。

| # | 文档 | 内容 | 读者 |
|---|---|---|---|
| — | **README.md**（本文） | 定位、哲学继承、关键决策摘要 | 所有人 |
| 01 | [设计文档/01-定位与原则.md](设计文档/01-定位与原则.md) | 定位、五条原则、底座核实、与前稿差异 | 决策者 |
| 02 | [设计文档/02-架构.md](设计文档/02-架构.md) | 两层架构、IPC 契约、并发模型 | 架构 |
| 03 | **[设计文档/03-测试流程.md](设计文档/03-测试流程.md)** | ★ 测试流程：用例模型、执行计划、执行引擎、事件流 | 实现 |
| 04 | **[设计文档/04-结果模型.md](设计文档/04-结果模型.md)** | ★ 结果模型：事件日志为真源、判定纯函数、投影与重判 | 实现 |
| 05 | **[设计文档/05-结果呈现.md](设计文档/05-结果呈现.md)** | ★ 结果呈现：视图结构、组件映射、实时刷新 | 前端 |
| 06 | [设计文档/06-数据模型.md](设计文档/06-数据模型.md) | SQLite schema、迁移、查询、artifact 分层 | 实现 |
| 07 | [设计文档/07-Agent与人机门.md](设计文档/07-Agent与人机门.md) | libfx 集成、Agent 工具集、人机确认门 | 实现 |
| 08 | [设计文档/08-安全基线.md](设计文档/08-安全基线.md) | SSRF 分档、只读采样、凭据、沙箱、写时脱敏 | 安全 |
| 09 | [设计文档/09-路线图.md](设计文档/09-路线图.md) | M0–M6 里程碑、出口标准、**待验证项** | 项目管理 |
| 10 | **[设计文档/10-技术选型.md](设计文档/10-技术选型.md)** | ★ 技术选型推导与最终清单 | 决策者/架构 |

---

## 关键决策摘要（TL;DR）

相对最初始的 v0.3 稿，本设计有六处实质性推进：

1. **结果的真源是事件日志，不是结果表**（04）。执行过程产生 append-only 的 `run_event`；`case_result` / `step_result` 是它的投影。因此判定逻辑可以演进并**对历史运行重新判定**（re-judge）而无需重跑。

2. **判定（verdict）是纯函数**（04）。`verdict = reduce(events, policy)`。改判定规则不改数据；`flaky` 是一等状态而非重试的副产物；`errored`（没测成）与 `failed`（被测不符合预期）严格区分。

3. **技术栈：系统 WebView + 内置 Node，不捆绑浏览器**（10）。Electron 因体积被排除，Tauri 因后端是 Rust 会丢 Node 生态被排除。结论是**把系统 WebView 直接绑定进 Node 进程**——体积减半，且页面天然无 Node 权限（隔离是结构性的，不是配置的）。

4. **测试用例是步骤树，不是"一次 HTTP 调用"**（03）。支持前置步骤、步骤间传值（extract）、副作用侧证（db_check，防假通过）、参数化（边界/成对/矩阵）、五级断言严重度。

5. **实时 UI 由页面轮询驱动**（02/05）。因主线程事件循环被 `show()` 占用，worker 无法主动推送；而**渲染进程是唯一有正常事件循环的地方**，因此由页面每 100ms 经 RPC 拉取增量，配合定期全量对账。

6. **所有 IO 与重计算都在 Worker**（02）。这不是优化而是硬约束：`show()` 阻塞主线程事件循环。AST 分析另起 analysis-worker（CPU 密集），断言沙箱另起 assert-worker（需可强制终止），Agent 用独立子进程（隔离崩溃）。

---

## 基座（已实现 · headless kernel）

**基座是上层无关的**：不含 GUI、不含 webview、不含 React、不出站网络。它只承载「真相与门」——
未来任何 UI 壳（系统 WebView 桌面壳 / CLI / 任意前端重设计）都只是 `kernel.call(method, params)` 的传输适配层。

| 落地内容 | 对应设计 | 验收 |
|---|---|---|
| 项目域 + `ProjectScope` 铸造 | 01 P5 / 02 §3 | 跨项目查询返回空、级联删除无残留（`isolation.test.ts`） |
| 追加式事件日志（seq 单调 / 写时脱敏 / 事件+投影同事务 / chainHash） | 03 §6 / 04 §2 | 篡改（删行 / 改 payload）被检出（`eventlog.test.ts`） |
| **判定纯函数** `verdict = reduce(events, policy)` | 04 §3 | 04 §3.5 十用例 + 边界穷举（`judge.test.ts`） |
| **投影可从事件重建** | 04 §1 / 06 §4.1 | ★ 旗舰测试：删投影→重建→逐字段一致（`projection-rebuild.test.ts`） |
| 重判 preview/apply + RunDiff | 04 §5 | apply 后从事件重建与投影一致（`rejudge.test.ts` / `run-diff.test.ts`） |
| P3 人机门（proposed→adopted/rejected + diff 留痕） | 07 §5 | AI 无路径产出 adopted（`review.test.ts`） |
| 写时脱敏（手机号/邮箱/证件/凭据字段） | 08 §4 | 库内明文零命中（`redact.test.ts`） |
| SQLite（`node:sqlite`，零原生依赖）+ 只增迁移 + checksum | 06 §1 | 已发布迁移被改→拒绝启动（`migrations.test.ts`） |
| Kernel 单一入口 + 方法白名单 + 运行时校验 | 02 §4 / §7.1 | 未知方法拒绝（`contract.test.ts`） |
| 判定模块纯度守卫（禁 IO import / 时钟 / 随机） | 02 §3 | `purity.test.ts` |

```bash
npm install
npm test        # 159 项验收测试（Vitest；含真浏览器 UI / 真库采样 / 真子进程 Agent probe）
npm run demo    # 基座 headless 全生命周期（提议→人机门→留痕→判定→重建→重判→脱敏）
npm run demo:exec # 执行层全闭环（mock 服务 + 真实 HTTP）
npm run demo:e2e  # ★ 全链路（源码→原则→用例→执行→反馈）
npm run demo:prd  # ★ PRD→用例 + 真浏览器 UI 流（需系统 Chrome）
npm run demo:dbcheck # ★ 防假通过：db_check 侧证抓"回 201 不写库"
npm run demo:agent  # ★ Agent 层（无凭据=演示模式；DAT_AGENT_KEY 走真 libfx）
npm run typecheck
```

> 实现说明一处对 03 §6.1 的修正：`entry_finished` **不携带 verdict**（只带 attempts/durationMs 观测）。
> 若执行期写结论，重判（04 §5）将自相矛盾——事件只记观测，结论永远是 reduce 的输出。

---

## 执行层（已实现 · 仍 headless）

基座之上的第一层：**合成计划与执行**。分层纪律不变——runner 只产生观测（事件），
结论（verdict）永远由判定纯函数从事件算出。`src/execution/`：

| 模块 | 内容 | 对应设计 |
|---|---|---|
| `urlguard.ts` | SSRF 分档（strict 拒绝私有/环回/链路本地；permissive 允许——测试就是要打内网）；DNS 逐 IP 校验；重定向每跳再验 | 08 §2 |
| `template.ts` | `{{env.x}}/{{var.x}}/{{secret.x}}/{{param.x}}`；编译期存在性校验；secret 值只进内存 | 03 §3.4 |
| `plan-compiler.ts` | 用例集 → RunPlan；**一律拒绝编译而非跳过**：非 adopted 用例、var 引用晚于定义、目标 URL 在 env 域名外（防注入用例）、matrix 超限、db_check（M3 前明确不支持）；entry 内嵌步骤快照（04 §2.2 同源） | 03 §3 |
| `evaluate.ts` | 断言求值纯函数（12 种操作符 / body_json 路径 / 数值优先比较） | 03 §2.4 |
| `sandbox.ts` | script 步骤 vm 沙箱（超时强杀、无 require/process；诚实声明：非安全边界，M6 升级） | 08 §6 |
| `runner.ts` | undici 引擎：精确超时（AbortController——undici parser 超时粒度约 1s，实测）、重试→flaky、大报文 artifact 外置、自签 TLS per-env、secret 全链路不落库（URL/断言 actual/提取值三处掩码） | 03 §5 |

```bash
npm run demo:exec   # mock 服务全闭环：编译→执行→判定（边界失败定位/flaky）→对账→重建
```

> 执行层唯一运行时依赖是 `undici`（基座仍零依赖，纯度守卫测试分别断言）。

---

## 分析层（已实现 · S1-local / S2 / S3）

源码驱动的落地面：**从源码发现 API、提炼数据设计原则**——文档会过期，源码不会。
仍然 headless、只读被测仓库（永不修改，09 §5）。`src/analysis/`：

| 模块 | 内容 | 对应设计 |
|---|---|---|
| `routes.ts` | ts-morph 路由提取：Express/Fastify/Koa（`app\|router.get('/x', handler)`，惯例接收者+处理器→high 置信度）+ NestJS（`@Controller` 前缀 + `@Get` 合成，high）；数组 `.get()` 类误报被结构排除 | S2 / M1 |
| `principles.ts` | 原则提取：**zod / joi** 校验链（`z.number().int().max(50000)` → `{type:'number',integer:true,max:50000}`，subject 带 schema 限定 `CreateOrderSchema.amount`）；**class-validator** 装饰器（`@Max/@Min/@Length/@IsEmail/@IsIn` → `ClassName.field`）；**Prisma** schema（`@db.VarChar(20)`、`@unique`、`@@unique` → 持久层）；每条强制 `file:line` 溯源 + 机读 value_json（S3→S5 唯一接口） | S3 / M2 |
| `scan.ts` | 本地源码索引编排：walk（跳 node_modules/dist）→ ts-morph Project → 提取 → 经 kernel `route:proposeBatch` / `principle:proposeBatch` 落库；幂等重索引（同键去重）；5000 文件上限（超限明确报错，要求缩小范围） | S1-local |

分析产物一律 `proposed`（P3 人机门）；幂等重索引不产生重复；跨项目隔离由基座保证（测试覆盖）。

```bash
# 用法（shell / 测试 / 未来 UI 同一入口）
const scan = await indexLocalSource(kernel, projectId, '/path/to/repo');
// → { sourceIndexId, fileCount, frameworks, routesInserted, principlesInserted }
```

> 已知边界（诚实声明）：`app.use('/prefix', router)` 的挂载前缀合成暂未展开（路由按字面路径记录，diff 复核时人工确认）；git/zip 接入与 OpenAPI 对账（doc_drift/doc_missing 标记）属后续层。

---

## 合成层与反馈回路（已实现 · S3→S5 确定性通道 + S6→S3 反馈）

**原则的机器可读形态直接变成测试**，并把执行结果反馈回原则——价值链闭环。`src/synthesis/`：

| 模块 | 内容 | 对应设计 |
|---|---|---|
| `boundary.ts` | `value_json` → 边界参数行：数值（`max:50000` → 49999/50000 合法 + 50001 越界）、字符串长度、枚举、邮箱、可逆向正则（手机号）。**语义严格对齐约束方向**；不可逆向的正则**不臆造**（返回空并上报） | 03 §2.3 |
| `case-synth.ts` | 路由 × adopted 原则 → 用例草稿：**分「应通过 / 应拒绝」两个意图**（同一套断言步骤无法同时表达两种期望）；断言携带 `principleId` + `sourceFile:line`（三步追问的链条）；POST/PUT 走 JSON body、GET/DELETE 走 query | 03 §2.5 / 04 §4.3 |
| `index.ts` | 编排：拉 adopted 数据 → 合成 → 经 `case:propose` 落库（一律 proposed，P3） | S5 |

**反馈回路**（kernel `metrics:*`，查询期派生，P2 不落聚合表）：

| 指标 | 用途 |
|---|---|
| `metrics:coverage` | 未覆盖接口列表（eligible = adopted 或 high 置信度） |
| `metrics:principleEffectiveness` | 每原则的引用数 / 违反检出数 / **零检出标记**（adopted 且有引用但从未失败 = 可疑：约束写错或测试值没打到位，03 §7.4） |

```bash
npm run demo:e2e   # ★ 全链路：源码仓库 → 索引 → 人机门 → 合成 → 采纳 → 执行 → 抓到实现 bug → 指标
```

> demo:e2e 里的被测服务故意有 bug（源码写 `≤50000`，实现只在 `>60000` 拒绝）——
> 全链路的终点就是把它变成一条带 `src/schemas.ts:3` 溯源的红色断言。

---

---

## PRD 输入与 UI 测试（引擎层 · 范围变更 ADR-1）

设计稿曾把「UI 测试」列为不做；本轮按引擎层哲学将其纳入（决策记录见 09 §5 ADR-1）——
**不另起产品，只加步骤族与输入源**，判定/事件日志/flaky/人机门全部复用。

### PRD → 用例（`src/prd/`，确定性解析，无 LLM）

PRD 是与源码并列的真相源。解析器只认**结构化形态**，认不出的如实上报（prose 需求留给 Agent 层）：

```markdown
## 下单接口
接口: POST /orders
| 字段 | 类型 | 约束 |
|------|------|------|
| amount | 整数 | 0 ≤ amount ≤ 50000 |     ← 约束文本 → value_json（与原则同构）→ 边界用例

### 管理员登录成功                              ← UI 流协议（人类可读可写）
- 打开 /login
- 填写 #username = "admin"
- 点击 button[type=submit]
- 应看到 "欢迎回来, admin"
- 截图 after-login
```

`indexPrd(kernel, projectId, prdDir)`：解析 → 合成 → `case:propose`（proposed）；幂等重跑零重复；
每条用例 `provenance.prd = { file, line, requirement }`。

### UI 测试（`src/execution/ui/`）

| 件 | 内容 |
|---|---|
| 步骤族 | `ui_navigate / ui_click / ui_fill / ui_press / ui_wait_for / ui_see / ui_screenshot`；一个用例的步骤必须同族（HTTP 或 UI，编译期强制）；导航目标同源校验（与 HTTP 同一 SSRF 纪律） |
| 判定 | `ui_see` 产出 `assert_evaluated` → **verdict/flaky/degraded 语义零改动复用**；动作产出 `ui_action` 事件；新错误码 `ui_driver_unavailable / ui_navigation_failed / ui_selector_not_found / ui_timeout` |
| 驱动 | `UiDriver` 接口 + Playwright 工厂（optionalDependency：playwright-core + **系统 Chrome**，不捆绑浏览器，与体积决策一致）；`DAT_UI_BROWSER` 可换 channel；**不可用时 UI 用例 errored，HTTP 用例不受影响**（诚实拒绝） |
| 截图 | `ui_screenshot` → `artifact:put`（内容寻址，与报文同一 artifact 层）；每 entry 独立驱动实例（页面隔离） |

```bash
npm run demo:prd   # PRD → 边界用例 + 真浏览器登录流；抓到 PRD 违反 + 真截图落 artifact
```

> 已知边界：UI 流协议是**行协议**（人写人读，确定性解析）；自由 prose → 步骤的转换属 Agent 层。
> UI 驱动每 entry 启动一次浏览器（隔离优先），连接池/复用是后续优化。

---

## 采样层与 db_check（已实现 · S4 / M3，防假通过闭环）

`src/sampling/`。被测系统"返回 200 不代表写对了"——db_check 让响应与副作用同时对账（03 §2.4）。

| 件 | 内容 |
|---|---|
| `guard.ts` | **四层只读防护**第③④层：语句白名单（仅 SELECT/WITH/EXPLAIN/SHOW/DESCRIBE；拒绝写/DDL/`FOR UPDATE`/`INTO OUTFILE`/多语句/注释藏匿）+ 标识符字符白名单（表采样接口不接受任意 SQL）；第②层会话只读语句生成；第①层（只读账号）为配置责任，文档明示 |
| `sampler.ts` | sqlite 走内置 node:sqlite（**零依赖，双重只读：`readOnly: true` 打开 + 会话 `query_only`**）；mysql2/pg 可选依赖，不可用诚实拒绝；`sampleTable`（limit 硬上限 20、等值 where、**结果写时脱敏**）/ `runReadOnlyQuery` / `introspectSchema`（sqlite 用 SELECT 形态 `pragma_table_info`——白名单对内省自身也生效） |
| `drift.ts` | 内省 vs 已采纳持久层原则对账：长度/类型族不一致 → 漂移（迁移没跑/代码与库不同步的信号） |
| DSN | AES-256-GCM 加密落库（keyfile 0600）；`dbconn:getDsn` 揭示时**诚实标注保护级别**「受文件权限保护（非系统钥匙串）」——不静默降级（08 §5.4） |
| db_check | 步骤 `{ connection, query, expectRows: { eq/gte/lte } }`；编译期 + 运行期双过白名单；观测 `db_checked` 事件 + `assert_evaluated`（判定语义复用）；`dbChecker` 未配置 → errored（诚实拒绝）；连接按名在项目内解析（P5） |

```bash
npm run demo:dbcheck   # 防假通过演示：/fake-orders 回 201 不写库 → 被侧证抓成红色
```

> 已知边界：mysql/pg 路径已实现且类型级验证，但**未接真实服务器实测**（本机无 MySQL/PG；sqlite 路径全链路真测）。每次 db_check 独立开闭连接（隔离优先，连接池是后续优化）。

---

## Agent 层（已实现 · M5，W1 已验证）

`src/agent/`。Agent 是**加速器不是前提**（07 §1.4）：驱动不可用时仅 Agent 功能不可用，其余全部可用。

| 件 | 内容 |
|---|---|
| W1 验证 | libfx 在**子进程**加载 ✅、`getBackendInfo` → `native` ✅、无效密钥 → `stopReason:'refused'`（干净拒绝，非崩溃）✅；真实凭据的流式/checkpoint 往返待首次配置凭据后补测（文档如实标注）——见 `docs/verification/W1-libfx.md` |
| `manager.ts` | 会话生命周期 + **同会话串行**（libfx 约束）+ 流式文本**脱敏后**落库 + checkpoint 往返（空闲时保存、下轮注入）+ `stopReason → 封闭错误码`（`fx_auth_refused` 等）+ 启动探测（"Agent 不能用"从点了没反应变成启动即知原因） |
| `tools.ts` | 七工具（`read_source / list_routes / get_principles / sample_db / draft_case / draft_principle / list_uncovered`）；**pid 是会话常量**——Agent 传来的 pid 被覆盖，越权传参 → `fx_tool_denied` 并留痕（07 §3.2 结构防越权）；`draft_*` 一律 `proposed`（P3） |
| `libfx-driver.ts` + `host.ts` | 子进程宿主（stdio JSON lines 协议）；libfx 崩溃 → 会话错误，已提交历史都在库中；libfx 为 optionalDependency，不可加载整体降级 |
| `scripted-driver.ts` | 同一 `FxDriver` 契约的进程内脚本驱动（测试 + 无凭据演示模式，**如实标注**） |
| `prd-task.ts` | 第一个真实任务：prose PRD → 结构化需求 JSON → **严格校验**（未知步骤/缺 api/非 JSON 整批拒绝，绝不部分采纳）→ 复用 prd/synth → proposed |

```bash
DAT_AGENT_KEY=sk-xxx DAT_AGENT_MODEL=gpt-5-mini npm run demo:agent   # 真实链路
npm run demo:agent                                                    # 演示模式（脚本驱动，如实标注）
```

> 已知边界：真实凭据的完整流式 + checkpoint 往返未实测（无凭据；失败形态已实证不伤宿主）。libfx 工具桥的具体 tools 契约在首次真实运行时对齐（桥协议两端已就位）。


## 待验证项（阻断 M1 的未知）

诚实列出**未能证实**、需在 M1 动手前用最小实验确认的事项。详见 [09-路线图.md](设计文档/09-路线图.md#1-待验证项阻断-m1)。

| # | 未知 | 影响 |
|---|---|---|
| **W1** | **`libfx` 能否在子进程中加载运行**（N-API + 流式 + checkpoint 往返） | **阻断 Agent 功能**；有三级备选（worker → wasm → 云端） |
| W2 | `ts-morph` 在真实仓库的分析准确率与耗时 | S2 出口标准（路由提取 ≥90%） |
| W3 | `ts-morph` 提取 zod/joi/class-validator/Prisma 约束的覆盖率 | S3 的能力边界 |
| W4 | `better-sqlite3` 在 worker 的表现，或 Node 22 `node:sqlite` 是否够用 | 存储层 |
| W5 | SAB/Atomics 桥的吞吐与延迟、轮询的 CPU 占用 | 架构细节 |
| W6 | **跨平台 WebView 差异**（Windows WebView2 / Linux GTK-WebKit） | 跨平台可行性（可能只支持 macOS） |
| W7 | 原生插件能否 CI 预编译随包分发 | 分发体验（用户不该被要求装 cmake） |

> **W1 优先级最高**——它决定 Agent 的部署方式。建议第一件事就花半小时验证它。

### 已经实测确认的（本机 macOS / Node 20.19）

| 项 | 结论 |
|---|---|
| `webview-nodejs` 可安装 | ✅ 10 秒完成（需 cmake + Xcode CLT） |
| 原生插件可加载 | ✅ 编译成功并 `require` 成功 |
| 插件依赖 | ✅ **只依赖系统框架**，可随包分发 |
| **`show()` 阻塞事件循环** | ✅ **已确认**（定时器/`fetch`/`await` 全部失效） |
| **SAB + Atomics 绕过阻塞** | ✅ **成功**（页面发起 13 次真实 HTTP 全成功） |
| `bind` 双向调用 + 异常传播 | ✅ 同步可用；⚠️ `async` bind 会挂起 |

---

## 目录结构

```
deepStudio/deepAutoTest/          ← 位于 deepStudio 工作区内（纯目录，非独立 git 仓库）
├─ README.md                      # 本文
├─ 设计文档/                       # 设计文档（10 篇）
│  ├─ 01-定位与原则.md  … 10-技术选型.md
├─ 设计稿/
│  └─ run-detail.html             # 运行详情视图设计稿（浏览器打开）
├─ 验证脚本/                       # 架构约束实测探针（show() 阻塞 / SAB 绕过等）
├─ docs/verification/             # Wn 验证结论文档（09 §1 的验收物；目前仅 W4）
├─ src/kernel/                    # ★ 基座（已实现，headless，零运行时依赖）
│  ├─ service.ts                  #   Kernel 单一入口 + 方法契约（未来 RPC 的内核形态）
│  ├─ shared/                     #   领域类型 / ProjectScope / 工具
│  ├─ store/                      #   node:sqlite + 迁移器 + 仓储（首参恒为 scope）
│  └─ domain/                     #   事件日志 / 判定纯函数 / 投影派生 / 人机门 / 脱敏
├─ src/agent/                     # ★ Agent 层（libfx 子进程；W1 已验证）
│  ├─ manager.ts                  #   会话生命周期/串行/脱敏落库/checkpoint
│  ├─ tools.ts                    #   七工具（pid 会话常量 + 越权留痕）
│  ├─ host.ts / libfx-driver.ts   #   子进程宿主 + stdio 协议
│  └─ prd-task.ts                 #   prose PRD 提取（严格校验 → proposed）
├─ src/sampling/                  # ★ 采样层（sqlite 零依赖；mysql/pg 可选）
│  ├─ guard.ts                    #   四层只读防护（白名单/会话只读/多语句/标识符）
│  ├─ sampler.ts                  #   采样（脱敏）/原始查询/内省
│  └─ drift.ts                    #   schema 漂移检测（vs Prisma 原则）
├─ src/agent/                     # ★ Agent 层（libfx 子进程；W1 已验证）
│  ├─ manager.ts                  #   会话生命周期/串行/脱敏落库/checkpoint
│  ├─ tools.ts                    #   七工具（pid 会话常量 + 越权留痕）
│  ├─ host.ts / libfx-driver.ts   #   子进程宿主 + stdio 协议
│  └─ prd-task.ts                 #   prose PRD 提取（严格校验 → proposed）
├─ src/sampling/                  # ★ 采样层（sqlite 零依赖；mysql/pg 可选）
│  ├─ guard.ts                    #   四层只读防护
│  ├─ sampler.ts                  #   采样（脱敏）/查询/内省
│  └─ drift.ts                    #   schema 漂移检测
├─ src/prd/                       # ★ PRD 输入源（已实现，headless，零依赖）
│  ├─ parse.ts                    #   markdown 解析：字段约束表 / UI 流协议 / prose 上报
│  └─ synth.ts                    #   约束 → 边界用例 + UI 流 → UI 用例（溯源 PRD file:line）
├─ src/execution/ui/              # ★ UI 测试族（驱动抽象 + Playwright 工厂 + 步骤执行器）
├─ src/synthesis/                 # ★ 合成层（已实现，headless，零依赖）
│  ├─ boundary.ts                 #   value_json → 边界参数行
│  └─ case-synth.ts               #   路由×原则 → 用例草稿（proposed）
├─ src/analysis/                  # ★ 分析层（已实现，headless，仅依赖 ts-morph）
│  ├─ routes.ts                   #   S2：Express/Fastify/Koa/NestJS 路由提取
│  ├─ principles.ts               #   S3：zod/joi/class-validator/Prisma 原则提取
│  └─ scan.ts                     #   S1-local：源码索引编排（产物经人机门落库）
├─ src/execution/                 # ★ 执行层（已实现，headless，仅依赖 undici）
│  ├─ urlguard.ts / template.ts   #   SSRF 分档 / 模板变量
│  ├─ plan-compiler.ts            #   计划编译（拒绝式校验 + 快照语义）
│  ├─ evaluate.ts / sandbox.ts    #   断言求值 / 脚本沙箱
│  └─ runner.ts                   #   undici 执行引擎（事件经 kernel 写入门落库）
├─ tests/                         # 159 项验收测试（判定穷举 / 投影重建 / 全链路 e2e / PRD / UI 真浏览器 / 采样 / Agent…）
├─ scripts/demo.ts                # 基座 headless 演示
├─ scripts/demo-exec.ts           # 执行层全闭环演示
├─ scripts/demo-e2e.ts            # 全链路演示（含抓到实现 bug 的情节）
├─ scripts/demo-prd.ts            # PRD→用例 + UI 流演示（真浏览器）
├─ scripts/demo-dbcheck.ts        # db_check 防假通过演示
├─ scripts/demo-agent.ts          # Agent 层演示（真/脚本双模式）
├─ scripts/demo-dbcheck.ts        # db_check 防假通过演示
├─ scripts/demo-agent.ts          # Agent 层演示（真/脚本双模式）
├─ scripts/preflight.mjs          # Node 22 版本闸（防 nvm 旧版本抢跑）
└─（UI 壳为独立项目，另行创建——经 kernel.call 接入本引擎）
```

<!-- deepgit:begin progress -->
## 项目进度

> 本区域由 **deepGit** 自动维护（浅更新）· 更新于 2026-09-30 11:58
> 非 git 项目 · 82 个文件 · 基于文件活动追踪

_暂无进度记录，运行 `deepgit update` 生成。_\n
<!-- deepgit:end progress -->
