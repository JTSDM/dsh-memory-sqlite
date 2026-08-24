# dsh-memory · NOTES（Step 0 API Spike 结论 + 实现备忘）

> 本文件是 M1 实现期速查。Spike 结论基于 DSH 0.1.0-rc.6 类型定义（`F:\node_global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` 下），实现时若 API 与下方不符，以实际类型定义为准并回写本文件。

## 1. 后台任务 API（`@deepseek-ai/dsh-jobs` + `dsh-jobs-local`）

- 服务：`ctx.jobs: JobRegistry`（cordis Service，dsh-jobs-local 实现）
- 启动：`jobs.start(spec: JobStart): JobId`
  ```ts
  interface JobStart {
    kind: JobKind            // 通过 declare module '@deepseek-ai/dsh-jobs' { interface JobKindMap { memory: 'memory' } } 扩展
    label: string            // 一行模型可见标签
    outputLimitBytes?: number
    owner?: Agent            // 省略 = unowned job（宿主插件后台任务用 unowned）
    run(): JobHooks          // 同步返回 hooks
  }
  interface JobHooks {
    cancel(reason?: string): void
    done: Promise<JobOutcome>   // { status: 'completed'|'killed'|'failed', detail?, output? }
    readOutput?(): string
  }
  ```
- 关键语义：
  - **`start` 拒绝当没有 attachController 服务于 owner** → 插件 apply 时从宿主（unscoped）上下文调用 `jobs.attachController('dsh-memory')`，unowned job 才能启动
  - unowned job：无 owner 时任何 caller 可读，服务销毁时清理
  - 完成通知：`jobs.onJobDone(listener)`，listener 收 `(snapshot, owner)`；效应作用域内注册
- 事件/状态：`JobStatus = running|stopping|completed|killed|failed`；`jobs.kill(id, caller?, reason?)`

## 2. 会话事件 API（`@deepseek-ai/dsh-session`）

- 服务：`ctx.sessions: SessionStore`；事件注册在 `@deepseek-ai/cordis` 的 `Context.Events` 上：
  ```ts
  ctx.on('session/disposed', (session: Session) => void)   // 会话销毁（M1 主挂载点）
  ctx.on('session/event', (session: Session, event: SessionEvent) => void)  // 事件流（turn/end、session/end-seed 等）
  ```
- `Session` 关键成员：`id: SessionId`、`header: SessionHeader`（含 `cwd?: string`）、`firstLiveSeq`
- `SessionEvent` 词汇表见 `dsh-session/lib/types/known-event-types.js`：`user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/end`、`session/end-seed`、`session/disposed` 等
- **策略**：`session/disposed` 主 + `session/end-seed`（event 流内）兜底 + 定时扫描（10min）兜底；事件回调内**只 enqueue，不做任何 LLM/文件 I/O**

## 3. LLM API（`@deepseek-ai/dsh-llm`）—— M1 只留占位

- 服务：`ctx.llm: LlmRuntime`；调用：`llm.stream(options: GenerateOptions): AsyncIterable<StreamChunk>`（异步迭代 + BlockAssembler 组装）
- M1 不实现 LLM 提取（R3 决议：确定性启发式）；`extractWithLLM()` 占位签名：
  ```ts
  extractWithLLM(events: SessionEvent[]): Promise<MemoryCandidate[]>  // M2 内部用 ctx.llm.stream
  ```

## 4. Workspace API（`@deepseek-ai/dsh-workspace`）—— 文件桥路径解析

- 服务：`ctx.workspaceRegistry: WorkspaceRegistry`
  - `list(): Workspace[]`（durable 顺序快照）
  - `Workspace { id, path /* canonical realpath */, title, sessionIds: readonly SessionId[] }`
- **文件桥路径解析优先级**（paths.ts 实现）：
  1. `ctx.workspaceRegistry.list()` 中 `sessionIds.includes(sessionId)` 的 workspace → `workspace.path`
  2. 兜底：`session.header.cwd`
  3. 都拿不到或目录不存在 → **bridge 禁用态**（仅写 SQLite，状态表记 bridge_status=disabled）
- `.workbuddy/memory/` 目录不存在时自动创建（mkdir -p，失败走 fallback）

## 5. 终审注意点速查（已落入 plan v2.1，实现时对照）

1. FTS5 用触发器同步（AFTER INSERT/DELETE/UPDATE OF content，rowid 关联），不做应用层同步
2. `restored` 是动作/事件名；`status` 仅 `active|dormant|archived`
3. recall 未指定 scope → session+user（global 可配含），按优先级加权排序
4. M1 无自动归档：仅显式 archive 调用 + importer archive 行同步
5. exporter 维护 `bridge_exported` 表，archive 行仅对曾 upsert 过的记录追加

## 6. 实现备忘

- 插件命名：`export const name = 'dsh-memory'`；inject: `['tools', 'jobs', 'timer', 'workspaceRegistry']`（服务名以实际注入为准，workspaceRegistry 是服务键名）
- `node:sqlite` 动态 import（`await import('node:sqlite')`），与官方一致
- 状态表键：last_reflect_at / pending_reinforce_delta / last_render_seq / last_export_seq / last_import_seq / bridge_status
- 状态转移表（P1-2 定案，5 行）与 delta 规则（P1-3 定案）见 `plan-m1-dsh-memory.md` §2-Step3/Step5
- 基准：`bench-sqlite.mjs`（10k 行 5.5μs/写、0.7ms/扫描、FTS5 0.2ms）

## 7. M1 实现期决策记录（2026-08-22，开发中拍板，均已在代码注释落点）

| 决策 | 内容 | 理由 |
|---|---|---|
| 构建管线 | 纯 tsc（NodeNext + rewriteRelativeImportExtensions），不用 tsdown | 官方包模式；少一个工具链；`.ts` 后缀源码 + 输出 `.js` |
| pnpm 构建脚本 | `allowBuilds: esbuild: false` 跳过 postinstall | 沙箱下 pnpm 捕获 postinstall 子进程输出 EPERM；esbuild 二进制在平台包，功能不受影响 |
| 候选提取输入 | outbox 行 payload = 会话期间缓存的 user/message 文本 JSON | 事件回调零 IO（D9）；outbox 自包含可重放（durable admission）；崩溃后仍可处理 |
| 提取失败语义 | payload JSON.parse 失败 → 行 failed（可重试） | 数据问题不静默完成；其他步骤仍各自 try/catch |
| bridge 工作区 | M1 取 workspaceRegistry 第一个 workspace；config.workspaceRoot 可覆盖 | 后台无 session 上下文；显式配置优先 |
| bridge_exported | provider 表 + `bridgeMarkExported/bridgeGetExported` 方法 | 终审注意点 5 落点；查询走索引 |
| jobs 集成 | `kind: 'memory'`（JobKindMap 增强）+ unowned job + attachController | 宿主插件后台任务；访问控制按文档语义 |
| apply 装配顺序 | provider → MemoryService（构造即注册）→ bridge → tools → engine → jobs → timer | Service 构造自注册（cordis 模式），不需要 ctx.provide |

## 8. M1 部署验证记录（2026-08-22，已完成）

1. **备份**：`backups\20260822-231805-pre-m1-deploy\`（profile 的 package.json / pnpm-workspace.yaml / .npmrc / cordis.patch.yml）
2. **安装**：`dsh plugin --profile web add file:F:\Agentwork\DSH优化项目\dsh-memory` → dependencies 含 dsh-memory；**bundles 自动追加 `dsh-memory`**（reconcile）
3. **重启**：dsh web 重启（注意：Start-Process 继承沙箱受限权限会导致新实例 EPERM 写 cordis.yml，需在非沙箱环境重启）
4. **验证**：
   - GUI 插件列表：`memory 已启用`（bundle 生效，apply 全程无异常 → 工具注册成功）
   - 生产库已创建：`$DSH_HOME/memory/memory.sqlite`（WAL），schema 完整（6 表 + FTS5 + 3 触发器 + schema_version=1 + application_id + engine_state 6 键初始化）
5. **工具冒烟**：新会话验证通过（见 §10）
6. **压测门禁**：`node bench-sqlite.mjs` → 10k upserts 70μs/op、decay 1.4ms、outbox 17μs、FTS 0.6ms、事件循环阻塞 0ms —— 三灯全 PASS（口径说明见 §11）

## 9. 遗留（M2/M3 入口）

- 真实文件桥写入：**已确认落点 = DSH优化项目 工作区**（00:40 sweep 自动导出，见 §12）；yfzh-st 生产记忆未被触碰；未来如需切换工作区用 config.workspaceRoot 显式指定
- M2：consolidation（含 JSONL 归档轮转 + 哨兵区全量压缩 + 归档条目移除）、Reflect LLM、WebUI 管理页、自动归档
- M3：MnemonProvider（graphQuery 占位就绪）、vector 能力、Mem0Provider 接口

## 10. 执行阶段终审验收记录（2026-08-23）

### 10.1 终审 5 条注意点 Q&A（实现确认）

| # | 注意点 | 实现确认 |
|---|---|---|
| 1 | FTS5 同步机制 | **触发器覆盖三种变更**：`memories_fts_ai`（AFTER INSERT）、`memories_fts_ad`（AFTER DELETE，`'delete'` 指令）、`memories_fts_au`（AFTER UPDATE OF content，先 delete 旧行再 insert 新行）；以 `rowid` 关联；生产库实测三触发器存在（sqlite_master 验证）。无应用层手动同步路径 |
| 2 | restored 状态语义 | **status 仅 `active\|dormant\|archived`**（`service/types.ts` 枚举）；`restored` 只作为 `MemoryChangeKind` 动作名（`'upsert'\|'archive'\|'restore'`）与 `memory/changed` 事件 type，绝不落库 |
| 3 | recall scope 默认行为 | 未指定 scope 时 provider 检索 **session + user + global**（三档全查，按 scope 优先级加权排序 session>user>global；global 可通过未来 config 排除）；工具 description 明示"Unspecified scope searches session + user level (global included when configured)"；冒烟验证：无 scope 的 "弹窗" 查询命中 session 级记忆 |
| 4 | 归档扫描触发条件 | **M1 无自动归档**：只有①显式 `archive()` 原语/工具调用（同步落库 + memory/changed 事件驱动 JSONL archive 行）②importer 从 JSONL 收到 archive 行后的状态同步；engine 流水线第 4 步注释显式声明"no auto-archive until M2" |
| 5 | archive 行导出边界 | **`bridge_exported` 表（id, last_action, exported_at）**：仅 `last_action='upsert'` 的记忆才会追加 archive 行；从未导出的记忆 archive 事件返回 false 不写行；restore 后重新满足核心条件 → 再次 upsert 并更新记录（`tests/bridge.test.ts` "no orphan archive rows" 用例） |

### 10.2 真实新会话工具冒烟（P0-1，三轮，证据齐）

**第一轮**（发现 recall 中文缺陷）：`memory_memorize` ×2 成功（"Memory stored (id 4ece4208-…, active)" / "Memory stored (id 3f1df6b6-…, active)"）；`memory_recall query="M1 冒烟"` 未命中 → 暴露 **FTS5 unicode61 对连续 CJK 分词缺陷**（中文串成单 token，子串查询全失配；probe 实测 `MATCH '冒烟'/'测试'` 均无命中）。

**修复**：recall 检索改为 **FTS5 + LIKE 双轨**（LIKE 子串兜底，ESCAPE 转义 `%_\`，10k 行实测 0.7ms）；新增中文单测（`LIKE fallback matches Chinese substrings`）→ 57/57 全绿。

**第二轮**（同步问题）：profile 内是**安装时复制的旧 lib**（file: 依赖不跟随源目录）→ 强制重装 + 重启后仍不命中（重启发生在重装前）→ 第三轮验证通过。

**第三轮**（全通过，新会话实测输出）：
```
调用 1：memory_recall query="冒烟" scope="user"
  → core: [3] 测试记忆:M1 冒烟验证
调用 2：memory_recall query="弹窗"（默认 scope）
  → core: [1] CSS 弹窗铁律:Teleport 到 body
```
SQLite 侧验证（只读探针）：两行数据在库，content_hash 为 64 位 hex，scope/importance/status 正确。

### 10.3 部署同步机制（重要运维知识）

`dsh plugin add file:<path>` 是**拷贝式安装**（profile node_modules 内为实体目录）——源码/`lib` 更新后必须**删除 profile 内 dsh-memory 目录并 `pnpm add --force` 重装**，否则运行时加载旧代码。bundles 与依赖清单不受重装影响（package.json 的 file: 路径与 bundles 条目保留）。

## 11. 压测数据口径说明（终审疑点回应）

`bench-sqlite.mjs`（工作区根，可复跑）口径：
- **70μs/op 是 10k 条连续写入的批量平均**（含 WAL 页增长/检查点/索引维护的累计效应；`writeMs/10000`），非单条事务耗时。单次 upsert 事务本身 5.5µs（初版基准，纯内存库无增长）。差异来自：①同库连续插入 10k 行后页分裂与 WAL 增长 ②集成版用编译产物 + `:memory:` 换真实 `DatabaseSync` 默认同步模式。**单条写入从未接近 50ms 阈值**（最坏单条 <5ms）
- **事件循环阻塞 0ms 的度量方法**：定时 50ms 探针 `setInterval` → 回调内 `setImmediate` 记录 `Date.now()` 与期望时间差的最大值（若主线程被同步 SQLite 阻塞，回调会迟到）。实测 max delay = 0ms
- 结论：10k 规模（个人记忆库 10 倍于目标）下同步 SQLite 有**数量级裕量**；超标降级方案（worker_threads）仍按 README 记录备用

## 12. 冒烟暴露的真实缺陷（修复记录）

1. **FTS5 中文分词缺陷**（见 §10.2）：unicode61 把连续 CJK 当单 token → LIKE 双轨修复 → 单测 + 运行时冒烟验证
2. **空 outbox 永不导出**（P0-2 前置）：sweep 仅在处理 outbox 行时调用 bridge → 核心记忆在无会话结束时永不落文件 → **sweep 末尾无条件执行 `bridge.exportAndRender()`**（新增单测 "sweep exports via the bridge even with an empty outbox"）→ 57/57 全绿

### 12.1 LIKE 双轨 ESCAPE 转义规则（终审 P2-1）

实现于 `local-provider.ts` recall()：
- 转义：`query.text.replace(/[\\%_]/g, m => '\\' + m)` —— 用户查询中的 `\`、`%`、`_` 全部加反斜杠前缀
- SQL：`WHERE content LIKE ? ESCAPE '\'`（SQLite 标准 ESCAPE 子句）
- 语义：`%`/`_` 在用户查询中始终是**字面字符**，绝不充当通配符——用户查 `100%` 只匹配含字面 `100%` 的内容，不会泛化匹配所有行
- FTS 容错：含 FTS 语法特殊字符（`% _ ( ) : "` 等）的查询在 MATCH 阶段 try/catch 降级为仅 LIKE（不抛错）
- 单测：`LIKE fallback escapes literal % and _ in the query (P2-1)`（字面命中 + 缺失模式不泛化）

## 13. P1 scope 隔离修复（终审 P1 疑点 = B 可能性，真实缺陷）

**取证**：三轮冒烟为三个独立会话（GUI 会话列表实证）；`memories` 无 session_id 列、source_ref 空 → session 级记忆无归属 → 第三轮新会话命中第一轮的 session 记忆（跨会话泄露）。

**修复（schema v2）**：
- `memories` 加 `session_id TEXT` 列 + `idx_memories_session` 索引；`MEMORY_SCHEMA_VERSION = 2`
- upsert：仅 `scope=session` 存 session_id（其他 scope 强制 null）；scope 转换时同步重置归属
- recall：隔离过滤——无 `query.sessionId` → session 记忆**绝不返回**（保守）；有 → `scope != 'session' OR session_id = ?`；related/divergent 同规则
- 工具层：`exec.agent.id`（Agent 与 Session 共享同一身份）传入 query/candidate
- 引擎：extractor 候选带来源 sessionId（outbox 行 session_id）
- 桥：JSONL 行加 `session_id` 字段（仅 session 级），导入往返保留

**单测**：+4 用例（同会话可见/异会话不可见/匿名不可见/user·global 跨会话可见/工具传参会话归属）→ 63/63。

**运行时验证（最终轮）**：新会话 `弹窗` → **No memories found**（修复前命中）；`冒烟`（user）→ 仍命中 ✅。

## 14. v1→v2 迁移崩溃（P1 修复引入的回归 + 修复 + 归因）

**现象**：旧库（v1）打开即崩 `no such column: session_id`（WorkBuddy 实测定位；用户重启后 web 起不来）。

**根因**：`schema.ts` 主 DDL 块含 `CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id)`（引用 v1 库不存在的列），而 `ALTER TABLE ADD COLUMN` 在迁移块里**主 DDL 之后**才执行 → 旧库崩。新库（CREATE TABLE 含列）无恙。

**修复**：索引从主 DDL 移出，统一在迁移块后创建（先 ALTER 保证列存在，新旧库幂等）。部署产物 lib/schema.js 已核验顺序：`ALTER TABLE`(pos 4232) → `CREATE INDEX`(pos 4439)。

**回归单测**（tests/migration.test.ts ×2）：构造真实 v1 库（无列 + 旧数据 + user_version=1）→ 打开 provider → 不崩、列已加、user_version=2、旧数据可读、新写带 session_id；二次打开幂等。

**归因（为什么没被抓住）**：全部单测都用新库（:memory: 或新文件），**无旧库迁移路径覆盖**。教训：schema 变更必须带"上一版本结构迁移"单测——M2 测试策略据此补强。

**生产处置**：WorkBuddy 曾用"旧库改名 .bak + 新库重建"规避；源码修复后迁移路径已兜底，`.bak-20260823` 保留（内含两条冒烟记忆，未恢复）。
