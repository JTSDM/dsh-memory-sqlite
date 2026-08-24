# dsh-memory-sqlite

**DSH（DeepSeek Harness）原生记忆服务层**：跨会话、跨工具、可演化的长期记忆，纯本地 SQLite 存储，零额外依赖。

> 包名 `dsh-memory-sqlite`，插件运行时注册名仍为 `dsh-memory`（`ctx.memory` 服务、`memory_memorize` / `memory_recall` 工具均不变）。

## 为什么是 dsh-memory-sqlite

DSH 生态里已有多个同名/近义记忆插件，本插件聚焦以下差异化组合：

| 维度 | dsh-memory-sqlite | 常见 JSON/自动注入类记忆插件 |
|---|---|---|
| 存储 | **SQLite**（`node:sqlite`，Node 内置驱动，**零 npm 依赖**） | JSON 原子存储或外部服务 |
| 记忆写入 | **显式工具化**（`memory_memorize`，agent 自主决定存什么） | 自动提取/自动注入（上下文开销不可控） |
| 检索 | FTS5 关键词 + LIKE 中文子串双轨 | 全量扫描或语义模型（需下载模型） |
| 幂等 | `content_hash`(SHA-256) 去重 + 1h 强化窗口 | 无或按文本相等 |
| 跨工具 | **WorkBuddy 文件桥**：JSONL 交换真相源 + MEMORY.md 哨兵区增量渲染，DSH ↔ WorkBuddy 双工具共享记忆 | 无 |
| 生命周期 | 异步引擎：会话结束仅入队，后台 job 提取/强化/衰减/导出，事件回调零 IO | 同步处理 |

## 能力总览

- **服务**：`ctx.memory`（cordis Service，能力分级协商）
- **存储**：SQLite LocalProvider（content_hash SHA-256 幂等去重 + FTS5 关键词检索 + LIKE 中文兜底）
- **工具**：`memory_memorize` / `memory_recall`（agent 可直接调用）
- **生命周期**：异步引擎 MVP（会话结束仅入队 → 后台 job 提取/强化/衰减/归档/导出；Reflect 频率门控，M1 绝不擅自调 LLM）
- **文件桥**：与 WorkBuddy 共享记忆（append-only JSONL 真相源 + MEMORY.md 哨兵区增量渲染 + 权限 fallback）

> 设计经过两轮红队评审与专家评审 v2.1 定案（详见 `NOTES.md` 决策记录）。

## 安装

```bash
# 方式 A：从本地路径安装（开发/内网）
dsh plugin --profile web add file:F:\Agentwork\DSH优化项目\dsh-memory

# 方式 B：从 GitHub 安装（发布后，clone 即用，lib/ 已入库无需构建）
dsh plugin --profile web add github:mochengfeng/dsh-memory-sqlite
```

> 提示：`dsh plugin add file:<path>` 是拷贝式安装——源码或 `lib/` 更新后需删除 profile 内 `dsh-memory` 目录并 `pnpm add --force` 重装，否则运行时加载旧代码。

## 能力分级（provider 自声明）

| 层级 | 能力 | M1 状态 |
|---|---|---|
| kv | 记忆 CRUD + content_hash 幂等 | ✅ SQLite |
| ttl | 衰减（active → dormant） | ✅ SQLite |
| relations | link 原语 | 🔒 NotSupportedError（M3 Mnemon） |
| graphQuery | 图谱查询占位 | 🔒 NotSupportedError（M3） |
| vector | 语义检索 | 🔒 预留（M3+） |
| consolidation | 压缩/归档轮转 | 🔒 NotSupportedError（M2） |

## 配置（schemastery schema）

```ts
{
  dbPath: '',                     // 默认 $DSH_HOME/memory/memory.sqlite（自动建目录）
  reinforceWindowMs: 3600000,     // 幂等窗口：1h 内重复 → reinforceCount++
  recallDefaultMaxTokens: 2000,   // recall 默认 token 预算（红队 ≤30% 上下文规则）
  engine: {
    outboxMaxAttempts: 3,
    reflect: { minReinforceDelta: 10, maxIntervalMs: 86400000 },  // 门控：增量≥10 或 >24h
    extract: { minLength: 200, maxContentChars: 2000, intentWords: [] },  // 启发式（无 LLM）
  },
  engineSweepIntervalMs: 600000,  // 定时兜底扫描（10min）
  bridge: {
    enabled: true,
    memoryDir: '.workbuddy/memory',
    workspaceRoot: '',            // 空 = workspaceRegistry 第一个工作区
    export: { exportMinImportance: 2, exportRecentWindowMs: 86400000 },
  },
}
```

## 性能边界（P0-1 实测，2026-08-22，SQLite 3.53.4 / Node 26）

`node:sqlite` 是**同步 API**（与官方 dsh-session-query-sqlite 同款驱动）。本机实测：

| 操作（10k 条） | 实测 | 门禁阈值 |
|---|---|---|
| 单次写入 | 5.5~70µs | 50ms |
| 衰减扫描 | 0.7~1.4ms | 200ms |
| outbox 入队 | 11~17µs | 会话结束秒回 |
| FTS5 检索 | 0.2~0.6ms | — |
| 事件循环阻塞 | **0ms**（探针实测） | <50ms |

个人记忆库规模（数千条）下同步 API 完全可接受。若未来库超 10 万条触发门禁，降级方案（worker_threads 封装或异步化）按 `bench-sqlite.mjs` 评估后实施。压测门禁：`node bench-sqlite.mjs`。

## 能力边界（M1 如实声明）

- `memory_recall` 仅**关键词检索**（FTS5 + LIKE），无语义/向量召回；"总结我上周的偏好"类模糊问题效果有限
- 自动归档（dormant 超期）未实现——M1 仅显式 archive 与 JSONL archive 行状态同步（M2 提供）
- 候选提取为**确定性启发式**（无 LLM 调用）；`extractWithLLM()` 是 M2 预留接缝

## 文件桥（DSH ↔ WorkBuddy）

```
SQLite（真相） ──导出──▶ dsh_sync.jsonl（append-only 交换真相） ──增量渲染──▶ MEMORY.md 哨兵区
   ▲                                                                              │
   └──────────────导入（content_hash 去重合并）◀──────── 读 MEMORY.md 全文 ◀──────┘
```

- **JSONL 是 DSH 侧唯一交换真相源**（行格式 `{id, content_hash, ts, action, content, importance, sourceRef, scope, session_id}`，action ∈ `upsert|archive`，只 append 永不改写）
- **MEMORY.md 是单向视图**：DSH 只写哨兵区 `<!-- DSH_MEMORY_START -->…<!-- DSH_MEMORY_END -->`，区外人工内容只读不写；条目带 `> 本条记录由 DSH 写入` 标注。**手工编辑 MEMORY.md 不会自动同步回 SQLite**；JSONL 是权威导入源
- **MEMORY.md 可能含已归档条目**直至 M2 consolidation 压缩（append-only 红线）
- **权限 fallback（强制）**：任何写失败（文件锁/只读/磁盘满/工作区未打开）→ 降级"仅写 SQLite + 日志告警 + bridge_status"，绝不抛未捕获异常、绝不阻塞；定时扫描重试补写

## 备份 / 恢复

- 记忆库：`$DSH_HOME/memory/memory.sqlite`（WAL 模式，备份时同时备份 `-wal`/`-shm` 或先 `PRAGMA wal_checkpoint(TRUNCATE)`）
- 文件桥文件：工作区 `.workbuddy/memory/`（JSONL + MEMORY.md 可整体复制）
- 恢复：复制回原路径即可；JSONL 可用作跨机迁移源（导入侧 content_hash 去重）

## 开发

```bash
pnpm install     # 依赖安装（node_modules 已就绪时确认 lockfile 一致）
pnpm build       # tsc 编译到 lib/
pnpm typecheck   # src + tests 双配置
pnpm test        # vitest（65 用例：状态机/provider/tools/engine/bridge/migration）
node bench-sqlite.mjs  # 压测门禁（仓库根）
```

## M1 三自检清单（提交门禁，红队产出）— 2026-08-22 实测通过

1. ✅ **文件桥 fallback**：`fs-bridge.ts` 全路径 try/catch；测试覆盖文件占用→degraded、disabled、archive 行失败 contained（`tests/bridge.test.ts`）
2. ✅ **引擎异步**：会话结束仅入队（17µs 实测）；sweep 在 `ctx.jobs` 后台 job；事件回调零 LLM/文件 I/O（`tests/engine.test.ts`）
3. ✅ **content_hash 幂等**：P1-2 状态转移表 5 行单测全覆盖（`tests/service.test.ts`）
4. ✅ **lastRenderSeq 增量渲染**：5000 行 JSONL 只追加不重绘，二次 pass 零变更（`tests/bridge.test.ts`）
5. ✅ **Reflect 门控**：delta≥10 或 >24h 才过；未达标 skip；M1 达标仅 recordPass 绝不调 LLM（`tests/engine.test.ts`）

## License

MIT
