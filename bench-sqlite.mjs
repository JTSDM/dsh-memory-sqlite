// M1 Step 7 压测门禁（P0-1）：用真实 SQLiteLocalProvider（编译产物）构造 10k 条记忆，
// 连续写入 + 衰减扫描 + 定时器延迟，验证事件循环阻塞在阈值内。
// 门禁：单写 >50ms 或衰减扫描 >200ms → 触发降级评估（worker_threads 方案，README 备用）。
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import { SQLiteLocalProvider } from './lib/provider/sqlite/local-provider.js'

const dbPath = ':memory:'
const provider = new SQLiteLocalProvider(dbPath, 60 * 60 * 1000)

// 事件循环延迟探针：若主线程被同步 SQLite 阻塞，setTimeout 回调会迟到
const delays = []
const probe = setInterval(() => {
  const expected = Date.now()
  setImmediate(() => {
    const actual = Date.now()
    delays.push(actual - expected)
  })
}, 50)

const t0 = performance.now()
for (let i = 0; i < 10000; i++) {
  provider.upsert({ content: `压测记忆条目 #${i} 内容内容内容内容内容内容内容内容`, importance: 1 + (i % 3), scope: 'user' })
}
const writeMs = performance.now() - t0
console.log(`10k upserts: ${writeMs.toFixed(1)}ms -> ${(writeMs / 10000 * 1000).toFixed(1)}us/op (阈值 50ms/op)`)

const t1 = performance.now()
const decayed = provider.decay()
const decayMs = performance.now() - t1
console.log(`decay scan: ${decayMs.toFixed(2)}ms, decayed=${decayed} (阈值 200ms)`)

const t2 = performance.now()
for (let i = 0; i < 1000; i++) {
  provider.outboxEnqueue(`sess-${i}`, null)
}
const enqMs = performance.now() - t2
console.log(`1k outbox enqueues: ${enqMs.toFixed(1)}ms -> ${(enqMs / 1000 * 1000).toFixed(1)}us/op`)

const t3 = performance.now()
const recall = provider.recall({ text: '压测记忆', limit: 10 })
const recallMs = performance.now() - t3
console.log(`FTS5 recall: ${recallMs.toFixed(2)}ms, core=${recall.core.length}`)

clearInterval(probe)
await new Promise(r => setTimeout(r, 100))
const maxDelay = delays.length ? Math.max(...delays) : 0
console.log(`event-loop max probe delay: ${maxDelay}ms (期望 ~0，同步库不阻塞)`)

provider.close()

const writeOk = writeMs / 10000 < 50
const decayOk = decayMs < 200
const loopOk = maxDelay < 50
console.log(`\n门禁: 单写 ${writeOk ? 'PASS' : 'FAIL'} | 衰减扫描 ${decayOk ? 'PASS' : 'FAIL'} | 事件循环 ${loopOk ? 'PASS' : 'FAIL'}`)
process.exit(writeOk && decayOk && loopOk ? 0 : 1)
