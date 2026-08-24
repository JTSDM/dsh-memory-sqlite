/**
 * Step 2/3 tests: service definition, capability tiers, NotSupportedError,
 * and the P1-2 state-transition table over the real SQLite provider.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SQLiteLocalProvider } from '../src/provider/sqlite/local-provider.ts'
import { MemoryService } from '../src/service/memory-service.ts'
import { NotSupportedError } from '../src/provider/types.ts'

/** Each test gets a fresh context + in-memory provider (no shared state). */
function createService(reinforceWindowMs = 60 * 60 * 1000): { ctx: Context; service: MemoryService; provider: SQLiteLocalProvider } {
  const ctx = new Context()
  const provider = new SQLiteLocalProvider(':memory:', reinforceWindowMs)
  const service = new MemoryService(ctx, provider)
  return { ctx, service, provider }
}

/** Access the private db handle for direct SQL manipulation in tests. */
function rawDb(provider: SQLiteLocalProvider): { exec(sql: string): void } {
  return (provider as unknown as { db: { exec(sql: string): void } }).db
}

describe('MemoryService definition', () => {
  it('registers ctx.memory with the sqlite provider', () => {
    const { ctx, service } = createService()
    expect(ctx.memory).toEqual(service) // cordis wraps services in a proxy
    expect(ctx.memory.providerName).toBe('sqlite')
  })

  it('declares kv + ttl capabilities in canonical order', () => {
    const { ctx, service } = createService()
    expect(service.capabilities()).toEqual(['kv', 'ttl'])
    expect(service.hasCapability('kv')).toBe(true)
    expect(service.hasCapability('vector')).toBe(false)
    void ctx
  })

  it('emits memory/changed on writes', () => {
    const { ctx, service } = createService()
    const events: string[] = []
    const off = ctx.on('memory/changed', e => events.push(e.type))
    service.remember({ content: 'hello world', sourceRef: 's1' })
    expect(events).toEqual(['upsert'])
    off()
  })

  it('throws NotSupportedError for reserved primitives (R1)', () => {
    const { ctx, service } = createService()
    expect(() => service.link('a', 'b', 'c')).toThrow(NotSupportedError)
    expect(() => service.consolidate()).toThrow(NotSupportedError)
    expect(() => service.graphQuery({})).toThrow(NotSupportedError)
    void ctx
  })
})

describe('P1-2 state-transition table', () => {
  it('row 1: new hash inserts an active memory (reinforceCount 0)', () => {
    const { provider } = createService()
    const out = provider.upsert({ content: '第一 条 事实', scope: 'user' })
    expect(out.deduped).toBe(false)
    expect(out.reinforced).toBe(false)
    expect(out.reinforceCount).toBe(0)
    expect(out.status).toBe('active')
    expect(out.changeKind).toBe('upsert')
    const stored = provider.get(out.id)
    expect(stored?.content).toBe('第一 条 事实')
    expect(stored?.scope).toBe('user')
    expect(stored?.contentHash).toBe(out.contentHash)
  })

  it('row 1: normalization dedups whitespace/width variants', () => {
    const { provider } = createService()
    const a = provider.upsert({ content: '记住  CSS  弹窗铁律' })
    const b = provider.upsert({ content: '记住　CSS 弹窗铁律' }) // full-width space
    expect(b.deduped).toBe(true)
    expect(b.id).toBe(a.id)
    expect(provider.listByStatus('active')).toHaveLength(1)
  })

  it('row 2: same hash within window reinforces (+1, delta +1)', () => {
    const { provider } = createService()
    provider.upsert({ content: 'fact-a' })
    const second = provider.upsert({ content: 'fact-a' })
    expect(second.deduped).toBe(true)
    expect(second.reinforced).toBe(true)
    expect(second.reinforceCount).toBe(1)
    expect(provider.getReinforceDelta()).toBe(1)
  })

  it('row 3: same hash after window confirms only (no count, no delta)', () => {
    const { provider } = createService(0) // 0ms window → every hit is outside it
    provider.upsert({ content: 'fact-b' })
    const second = provider.upsert({ content: 'fact-b' })
    expect(second.deduped).toBe(true)
    expect(second.reinforced).toBe(false)
    expect(second.reinforceCount).toBe(0)
    expect(provider.getReinforceDelta()).toBe(0)
  })

  it('row 4: dormant memory re-confirmed → active + reinforce (+1, delta +1)', () => {
    const { provider } = createService()
    const first = provider.upsert({ content: 'fact-c' })
    rawDb(provider).exec(`UPDATE memories SET status='dormant' WHERE id = '${first.id}'`)
    const second = provider.upsert({ content: 'fact-c' })
    expect(second.status).toBe('active')
    expect(second.reinforced).toBe(true)
    expect(second.reinforceCount).toBe(1)
    expect(provider.get(first.id)?.status).toBe('active')
    expect(provider.getReinforceDelta()).toBe(1)
  })

  it('row 5: archived memory re-written → restored, count preserved +1', () => {
    const { provider } = createService()
    const first = provider.upsert({ content: 'fact-d' })
    const archived = provider.archive(first.id, 'test')
    expect(archived?.status).toBe('archived')
    const restored = provider.upsert({ content: 'fact-d' })
    expect(restored.deduped).toBe(true)
    expect(restored.status).toBe('active')
    expect(restored.reinforceCount).toBe(1)
    expect(restored.changeKind).toBe('restore')
    expect(provider.get(first.id)?.status).toBe('active')
  })

  it('explicit importance overwrites (max rule), implicit keeps old', () => {
    const { provider } = createService()
    provider.upsert({ content: 'fact-e', importance: 1 })
    const upgraded = provider.upsert({ content: 'fact-e', importance: 3 })
    expect(upgraded.reinforceCount).toBe(1)
    expect(provider.get(upgraded.id)?.importance).toBe(3)
    // implicit importance (undefined) keeps 3
    provider.upsert({ content: 'fact-e' })
    expect(provider.get(upgraded.id)?.importance).toBe(3)
  })

  it('decay: TTL expiry moves active → dormant', () => {
    const { provider } = createService()
    provider.upsert({ content: 'fact-f' })
    // default ttl is 90 days; push lastConfirmed beyond it
    rawDb(provider).exec('UPDATE memories SET last_confirmed_at = last_confirmed_at - 10000000000')
    expect(provider.decay()).toBe(1)
    expect(provider.listByStatus('dormant')).toHaveLength(1)
  })

  it('archive writes a snapshot row; restore keeps count and bumps delta', () => {
    const { provider } = createService()
    const first = provider.upsert({ content: 'fact-g', importance: 2 })
    provider.archive(first.id, 'reason-x')
    expect(provider.get(first.id)?.status).toBe('archived')
    const restored = provider.restore(first.id)
    expect(restored?.status).toBe('active')
    expect(restored?.reinforceCount).toBe(0) // restore preserves the count
    expect(provider.getReinforceDelta()).toBe(1) // restore counts as a recovery event
  })
})

describe('FTS5 recall', () => {
  it('keyword recall finds matching memories and filters scope', () => {
    const { provider } = createService()
    provider.upsert({ content: 'CSS 弹窗必须 Teleport 到 body', scope: 'user', importance: 3 })
    provider.upsert({ content: 'SSR 服务端渲染注意事项', scope: 'user' })
    const result = provider.recall({ text: 'Teleport', scopes: ['user'] })
    expect(result.core.length).toBe(1)
    expect(result.core[0]?.memory.content).toContain('Teleport')
    expect(result.capabilities).toEqual(['kv', 'ttl'])
  })

  it('recall without text lists by importance; token cap truncates', () => {
    const { provider } = createService()
    provider.upsert({ content: 'x'.repeat(200), importance: 1, scope: 'user' })
    provider.upsert({ content: 'y'.repeat(200), importance: 3, scope: 'user' })
    const all = provider.recall({ limit: 10 })
    expect(all.core.length).toBe(2)
    expect(all.core[0]?.memory.importance).toBe(3)
    const capped = provider.recall({ limit: 10, maxTokens: 30 }) // ~200 chars/4 = 50 tokens each
    expect(capped.truncated).toBe(true)
    expect(capped.core.length).toBeLessThan(2)
  })

  it('LIKE fallback matches Chinese substrings that FTS5 cannot tokenize', () => {
    const { provider } = createService()
    provider.upsert({ content: '测试记忆：M1 冒烟验证', scope: 'user', importance: 3 })
    // FTS5 unicode61 treats contiguous CJK runs as single tokens, so the
    // substring query only hits via the LIKE leg.
    const zh = provider.recall({ text: '冒烟', scopes: ['user'] })
    expect(zh.core.length).toBe(1)
    expect(zh.core[0]?.memory.content).toContain('冒烟')
    // FTS leg still covers ASCII tokens.
    const en = provider.recall({ text: 'M1', scopes: ['user'] })
    expect(en.core.length).toBe(1)
  })

  it('LIKE fallback escapes literal % and _ in the query (P2-1)', () => {
    const { provider } = createService()
    provider.upsert({ content: '进度 100% 完成_标记', scope: 'user' })
    // Unescaped, '%' would act as a wildcard and match everything.
    const literal = provider.recall({ text: '100%', scopes: ['user'] })
    expect(literal.core.length).toBe(1)
    expect(literal.core[0]?.memory.content).toBe('进度 100% 完成_标记')
    // A lone '%' is escaped to a literal percent → matches only content that
    // actually contains '%' (this row does).
    const lone = provider.recall({ text: '%', scopes: ['user'] })
    expect(lone.core.length).toBe(1)
    // A pattern absent from the content must NOT wildcard-match everything.
    const absent = provider.recall({ text: '50%', scopes: ['user'] })
    expect(absent.core.length).toBe(0)
  })

  it('CJK + special chars mixed query stays stable (P2-2 regression)', () => {
    const { provider } = createService()
    provider.upsert({ content: '弹窗规则: z-index 1000 (Teleport)', scope: 'user' })
    const mixed = provider.recall({ text: '弹窗规则', scopes: ['user'] })
    expect(mixed.core.length).toBe(1)
  })
})

describe('P1 scope isolation (cross-session)', () => {
  it('session-scoped memories are visible ONLY to their owning session', () => {
    const { provider } = createService()
    provider.upsert({ content: '会话A的临时事实', scope: 'session', sessionId: 'sess-A' })
    provider.upsert({ content: '会话B的临时事实', scope: 'session', sessionId: 'sess-B' })
    provider.upsert({ content: '全局偏好', scope: 'user' })

    // Owner session sees its own session memory + user memories.
    const fromA = provider.recall({ scopes: ['session', 'user'], sessionId: 'sess-A' })
    const contentsA = fromA.core.map(h => h.memory.content)
    expect(contentsA).toContain('会话A的临时事实')
    expect(contentsA).not.toContain('会话B的临时事实')
    expect(contentsA).toContain('全局偏好')

    // Other session never sees session-A memories.
    const fromB = provider.recall({ scopes: ['session', 'user'], sessionId: 'sess-B' })
    const contentsB = fromB.core.map(h => h.memory.content)
    expect(contentsB).toContain('会话B的临时事实')
    expect(contentsB).not.toContain('会话A的临时事实')

    // No session context: session memories are NEVER returned (conservative).
    const anonymous = provider.recall({ scopes: ['session', 'user'] })
    const contentsAnon = anonymous.core.map(h => h.memory.content)
    expect(contentsAnon).not.toContain('会话A的临时事实')
    expect(contentsAnon).not.toContain('会话B的临时事实')
    expect(contentsAnon).toContain('全局偏好')
  })

  it('explicit scope=session also requires the owner sessionId', () => {
    const { provider } = createService()
    provider.upsert({ content: '私有笔记', scope: 'session', sessionId: 'sess-X' })
    expect(provider.recall({ scopes: ['session'], sessionId: 'sess-X' }).core.length).toBe(1)
    expect(provider.recall({ scopes: ['session'], sessionId: 'sess-Y' }).core.length).toBe(0)
    expect(provider.recall({ scopes: ['session'] }).core.length).toBe(0)
  })

  it('user/global memories remain cross-session visible', () => {
    const { provider } = createService()
    provider.upsert({ content: '用户级习惯', scope: 'user' })
    provider.upsert({ content: '全局事实', scope: 'global' })
    for (const sessionId of ['sess-1', 'sess-2', undefined]) {
      const result = provider.recall({ scopes: ['user', 'global'], sessionId })
      const contents = result.core.map(h => h.memory.content)
      expect(contents).toContain('用户级习惯')
      expect(contents).toContain('全局事实')
    }
  })

  it('memorize tool attaches the caller session to session-scope writes', async () => {
    const { ctx, service } = createService()
    const exec = { agent: { id: 'tool-sess-1' } } as never
    const memorize = (await import('../src/tools/memorize.ts')).defineMemorizeTool(service)
    await memorize.execute({ content: '工具写入的会话事实' }, exec)
    const hits = service.recall({ scopes: ['session'], sessionId: 'tool-sess-1' })
    expect(hits.core.length).toBe(1)
    expect(service.recall({ scopes: ['session'], sessionId: 'other' }).core.length).toBe(0)
    void ctx
  })
})
