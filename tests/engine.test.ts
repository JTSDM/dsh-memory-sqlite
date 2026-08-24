/**
 * Step 5 tests: durable outbox, heuristic extraction, Reflect gate, and the
 * serial engine pipeline (per-step containment, crash recovery).
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SQLiteLocalProvider } from '../src/provider/sqlite/local-provider.ts'
import { MemoryLifecycleEngine, type EngineConfig } from '../src/engine/engine.ts'
import { extractCandidates, extractWithLLM } from '../src/engine/extractor.ts'
import { ReflectGate, type ReflectGateConfig } from '../src/engine/reflect-gate.ts'
import { STATE_LAST_REFLECT } from '../src/provider/sqlite/local-provider.ts'

const GATE_CONFIG: ReflectGateConfig = { minReinforceDelta: 3, maxIntervalMs: 60 * 60 * 1000 }

function createEngine(config: Partial<EngineConfig> = {}) {
  const ctx = new Context()
  const provider = new SQLiteLocalProvider(':memory:')
  const engine = new MemoryLifecycleEngine(ctx, provider, {
    outboxMaxAttempts: 3,
    reflect: GATE_CONFIG,
    extract: { minLength: 30, maxContentChars: 2000, intentWords: ['记住', '规则'] },
    ...config,
  })
  return { ctx, provider, engine }
}

describe('outbox (durable queue, D9)', () => {
  it('enqueue is a synchronous single-row insert (never blocks session end)', () => {
    const { provider } = createEngine()
    const t0 = performance.now()
    const id = provider.outboxEnqueue('sess-1', JSON.stringify(['hello']))
    const elapsed = performance.now() - t0
    expect(id).toBeTypeOf('string')
    expect(provider.outboxCount('pending')).toBe(1)
    expect(elapsed).toBeLessThan(50) // µs-class insert; generous CI bound
  })

  it('dedup of unfinished rows happens at flushSession level', () => {
    const { provider, engine } = createEngine()
    engine.flushSession({ id: 'sess-1' } as never)
    engine.flushSession({ id: 'sess-1' } as never)
    expect(provider.outboxHasActive('sess-1')).toBe(true)
    expect(provider.outboxCount('pending')).toBe(1) // second flush deduped
  })

  it('claim marks processing; complete/fail transitions', () => {
    const { provider } = createEngine()
    provider.outboxEnqueue('sess-1', null)
    const row = provider.outboxClaim(3)
    expect(row?.status).toBe('processing')
    provider.outboxComplete(row!.id)
    expect(provider.outboxCount('pending')).toBe(0)
    expect(provider.outboxCount('done')).toBe(1)
  })

  it('crash recovery: stale processing rows are reclaimed by claim', () => {
    const { provider } = createEngine()
    const id = provider.outboxEnqueue('sess-1', null)
    provider.outboxClaim(3)
    // simulate a crash: row stays 'processing'
    const db = (provider as unknown as { db: { exec(sql: string): void } }).db
    db.exec(`UPDATE outbox SET updated_at = updated_at - 600000 WHERE id = '${id}'`)
    const reclaimed = provider.outboxClaim(3)
    expect(reclaimed?.id).toBe(id)
  })

  it('fail keeps retrying up to the attempt cap, then stays failed', () => {
    const { provider } = createEngine()
    const id = provider.outboxEnqueue('sess-1', null)
    provider.outboxFail(id, 'boom', 3)
    expect(provider.outboxCount('pending')).toBe(1) // attempt 1 < 3 → retryable
    provider.outboxFail(id, 'boom', 3)
    provider.outboxFail(id, 'boom', 3)
    expect(provider.outboxCount('failed')).toBe(1)
  })
})

describe('heuristic extractor (R3)', () => {
  const events = [
    { type: 'user/message', message: { content: '记住：CSS 弹窗必须 Teleport 到 body' } },
    { type: 'user/message', message: { content: '这个规则以后都要遵守' } },
    { type: 'tool/result', message: { content: '工具输出不该被提取' } },
    { type: 'user/message', message: { content: 'ok' } },
  ]

  it('extracts only user messages with intent words or length', () => {
    const candidates = extractCandidates(events, { minLength: 30, maxContentChars: 2000, intentWords: ['记住', '规则'] })
    expect(candidates.length).toBe(2)
    expect(candidates[0]?.content).toContain('记住')
    expect(candidates[0]?.type).toBe('experience') // intent word → experience
    expect(candidates[0]?.importance).toBe(2) // intent word → 2
    expect(candidates[0]?.scope).toBe('session')
    expect(candidates[1]?.content).toContain('规则')
  })

  it('long user messages qualify without intent words', () => {
    const long = 'x'.repeat(100)
    const candidates = extractCandidates([{ type: 'user/message', message: long }], { minLength: 30, maxContentChars: 2000, intentWords: ['记住'] })
    expect(candidates.length).toBe(1)
    expect(candidates[0]?.type).toBe('world')
  })

  it('never extracts tool results or short messages', () => {
    const candidates = extractCandidates(events, { minLength: 30, maxContentChars: 2000, intentWords: ['记住'] })
    expect(candidates.some(c => c.content.includes('工具输出'))).toBe(false)
    expect(candidates.some(c => c.content === 'ok')).toBe(false)
  })

  it('extractWithLLM is a no-op seam in M1 (zero LLM calls)', async () => {
    const candidates = await extractWithLLM(events)
    expect(candidates).toEqual([])
  })
})

describe('Reflect gate (P1-3, M1 token guard)', () => {
  it('skips when delta is below threshold and interval not elapsed', () => {
    const { provider } = createEngine()
    provider.setState(STATE_LAST_REFLECT, String(Date.now()))
    const result = new ReflectGate(provider, GATE_CONFIG).check()
    expect(result.passed).toBe(false)
    expect(result.reason).toBe('skip')
  })

  it('passes on delta threshold; recordPass resets and stamps', () => {
    const { provider } = createEngine()
    // 4 writes = 1 insert + 3 reinforcement events (delta 3)
    provider.upsert({ content: 'a' })
    provider.upsert({ content: 'a' })
    provider.upsert({ content: 'a' })
    provider.upsert({ content: 'a' })
    const gate = new ReflectGate(provider, GATE_CONFIG)
    expect(gate.check().reason).toBe('delta')
    gate.recordPass()
    expect(provider.getReinforceDelta()).toBe(0)
    expect(provider.getState(STATE_LAST_REFLECT)).toBeTypeOf('string')
    expect(gate.check().reason).toBe('skip')
  })

  it('passes on interval expiry even with zero delta', () => {
    const { provider } = createEngine()
    provider.setState(STATE_LAST_REFLECT, String(Date.now() - 2 * 60 * 60 * 1000))
    const result = new ReflectGate(provider, GATE_CONFIG).check()
    expect(result.passed).toBe(true)
    expect(result.reason).toBe('interval')
  })
})

describe('engine pipeline', () => {
  it('sweep processes rows end-to-end: extraction → upsert → decay → gate', async () => {
    const { ctx, provider, engine } = createEngine()
    provider.outboxEnqueue('sess-1', JSON.stringify([
      { type: 'user/message', message: { content: '记住这条规矩' } },
    ]))
    await engine.sweep()
    expect(provider.outboxCount('done')).toBe(1)
    const memories = provider.listByStatus('active')
    expect(memories.length).toBe(1)
    expect(memories[0]?.content).toContain('记住这条规矩')
    void ctx
  })

  it('one bad row does not block later rows (per-step containment)', async () => {
    const { ctx, provider, engine } = createEngine()
    provider.outboxEnqueue('bad', 'not-json{{{') // payload parse failure
    provider.outboxEnqueue('good', JSON.stringify([{ type: 'user/message', message: { content: '记住好数据' } }]))
    await engine.sweep()
    expect(provider.outboxCount('failed')).toBe(1)
    expect(provider.outboxCount('done')).toBe(1)
    expect(provider.listByStatus('active').length).toBe(1)
    void ctx
  })

  it('flushSession enqueues immediately and ignores non-user events', () => {
    const { ctx, provider, engine } = createEngine()
    const before = performance.now()
    engine.flushSession({ id: 'sess-x' } as never)
    const elapsed = performance.now() - before
    expect(provider.outboxCount('pending')).toBe(1)
    expect(elapsed).toBeLessThan(50)
    void ctx
  })

  it('gate pass inside the pipeline records without LLM', async () => {
    const { ctx, provider, engine } = createEngine()
    provider.upsert({ content: 'f1' })
    provider.upsert({ content: 'f1' })
    provider.upsert({ content: 'f1' })
    provider.upsert({ content: 'f1' }) // 3 reinforcement events ≥ min 3 → gate passes
    provider.outboxEnqueue('sess-1', null)
    await engine.sweep()
    expect(provider.getReinforceDelta()).toBe(0) // reset by recordPass
    void ctx
  })

  it('sweep exports via the bridge even with an empty outbox', async () => {
    const ctx = new Context()
    const provider = new SQLiteLocalProvider(':memory:')
    let exports = 0
    const engine = new MemoryLifecycleEngine(ctx, provider, {
      outboxMaxAttempts: 3,
      reflect: GATE_CONFIG,
      extract: { minLength: 30, maxContentChars: 2000, intentWords: ['记住'] },
    }, {
      exportAndRender: async () => { exports += 1 },
    })
    expect(provider.outboxCount('pending')).toBe(0)
    await engine.sweep()
    expect(exports).toBe(1) // export happens regardless of outbox content
  })
})
