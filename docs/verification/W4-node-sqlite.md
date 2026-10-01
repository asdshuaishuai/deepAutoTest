# W4 · `node:sqlite` 是否够用 —— 验证结论

> 验证日期：2026-09-17 · 环境：macOS (Apple Silicon) / Node v22.20.0 / SQLite 3.50.4（Node 内置）
> 对应待验证项：[09-路线图 §1 W4](../../设计文档/09-路线图.md)。**结论：够用，基座已直接采用，零原生依赖。**

## 实测内容与结果

| # | 验证点 | 方法 | 结果 |
|---|---|---|---|
| 1 | 基本可用性 | `require('node:sqlite')` 加载 `DatabaseSync` | ✅（仍标 experimental，有警告，无功能影响） |
| 2 | 事务 | `BEGIN/COMMIT/ROLLBACK` 包装函数；事件+投影同事务写入；失败回滚 | ✅（基座全部写入路径依赖它，63 项测试覆盖） |
| 3 | `STRICT` 表 | 文本值插入 INTEGER 列 | ✅ 拒绝：`cannot store TEXT value in INTEGER column ...`。注意：**数字→TEXT 列会被列亲和性先转换**（`123` → `'123'`），这是 SQLite 语义而非 bug |
| 4 | WAL + 外键 | `PRAGMA journal_mode=WAL` / `foreign_keys=ON` | ✅ 级联删除测试通过（`isolation.test.ts`） |
| 5 | 复合主键 + 覆盖写入 | `run_event (run_id, seq)`、`case_result ON CONFLICT ... DO UPDATE` | ✅ |
| 6 | 大事件流 | 单 run 20+ 事件、批量 append、逐 entry 投影重算 | ✅ 毫秒级；重判/重建为全表扫，当前规模无压力 |
| 7 | 参数绑定 | 位置参数 `?`（避免命名参数在 22.x 的兼容歧义） | ✅ |
| 8 | BLOB 读写 | artifact 内联 `Uint8Array` 存取 | ✅ |

## 未验证（如实列出）

- **多 worker 并发读写同一库文件**——基座是单连接同步模型（所有写经同一写入门），并发场景属于 W5（SAB 桥 / worker 池）的验证范围，届时补测。SQLite WAL 模式下单写多读是文档保证的，风险低。
- `incremental_vacuum` / 事件表百万级行的性能——M6（归档与保留）前不构成问题。

## 对设计的影响

- 06 §1 的四条迁移纪律**不变**：只增不改、编号连续、STRICT、checksum 校验（已实现：已应用迁移被编辑 → 拒绝启动）。
- `better-sqlite3` 保留为**兜底**而非首选：基座对 `node:sqlite` 的使用收敛在 `store/db.ts` 一个文件内，若将来需要切换，封装层可吸收 API 差异（06 §W4 假设成立）。
- 打包收益：基座运行时**零 npm 依赖**（仅 `node:sqlite` + `node:crypto` + `node:fs`），分发不涉及原生模块编译。
