/**
 * Step 4 tests: memorize/recall tool schemas, idempotent writes, three-tier
 * recall output, token capping, and the scope default behavior.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SQLiteLocalProvider } from '../src/provider/sqlite/local-provider.ts'
import { MemoryService } from '../src/service/memory-service.ts'
import { defineMemorizeTool } from '../src/tools/memorize.ts'
import { defineRecallTool } from '../src/tools/recall.ts'

interface MemorizeView {
  id: string
  contentHash: string
  deduped: boolean
  reinforced: boolean
  reinforceCount: number
  status: string
  storedAt: number
}

interface RecallHitView {
  id: string
  content: string
  importance: number
  type: string
  scope: string
  status: string
  reinforceCount: number
  fileRef?: string | null
}

interface RecallView {
  core: RecallHitView[]
  related: RecallHitView[]
  divergent: RecallHitView[]
  truncated: boolean
  capabilities: string[]
}

const NO_EXEC = {} as never

async function runMemorize(tool: ReturnType<typeof defineMemorizeTool>, args: Parameters<ReturnType<typeof defineMemorizeTool>['execute']>[0]) {
  return await tool.execute(args, NO_EXEC) as unknown as MemorizeView
}

async function runRecall(tool: ReturnType<typeof defineRecallTool>, args: Parameters<ReturnType<typeof defineRecallTool>['execute']>[0], agentId = 'caller-sess') {
  return await tool.execute(args, { agent: { id: agentId } } as never) as unknown as RecallView
}

function createTools() {
  const ctx = new Context()
  const provider = new SQLiteLocalProvider(':memory:')
  const memory = new MemoryService(ctx, provider)
  const memorize = defineMemorizeTool(memory)
  const recall = defineRecallTool(memory, 2000)
  return { ctx, memory, provider, memorize, recall }
}

describe('memory_memorize', () => {
  it('registers a valid tool definition', () => {
    const { memorize } = createTools()
    expect(memorize.name).toBe('memory_memorize')
    expect(memorize.description).toContain('Idempotent')
    expect(memorize.execute).toBeTypeOf('function')
  })

  it('stores content and returns the canonical outcome', async () => {
    const { memorize } = createTools()
    const value = await runMemorize(memorize, { content: '记住这条铁律', importance: 3, scope: 'user' })
    expect(value.id).toBeTypeOf('string')
    expect(value.contentHash).toHaveLength(64)
    expect(value.deduped).toBe(false)
    expect(value.status).toBe('active')
  })

  it('is idempotent: same content reinforces instead of duplicating', async () => {
    const { memorize } = createTools()
    const a = await runMemorize(memorize, { content: 'CSS 弹窗铁律', scope: 'user' })
    const b = await runMemorize(memorize, { content: 'CSS 弹窗铁律', scope: 'user' })
    expect(b.deduped).toBe(true)
    expect(b.reinforced).toBe(true)
    expect(b.reinforceCount).toBe(1)
    expect(b.id).toBe(a.id)
  })
})

describe('memory_recall', () => {
  it('returns three tiers with strict schema', async () => {
    const { recall, memory } = createTools()
    memory.remember({ content: 'Teleport 到 body 的弹窗规范', scope: 'user', importance: 3 })
    memory.remember({ content: '弹窗 z-index 1000', scope: 'user' })
    const value = await runRecall(recall, { query: 'Teleport', scope: 'user' })
    expect(value.core.length).toBe(1)
    expect(value.core[0]?.content).toContain('Teleport')
    expect(value.core[0]?.importance).toBe(3)
    expect(Array.isArray(value.related)).toBe(true)
    expect(Array.isArray(value.divergent)).toBe(true)
    expect(value.truncated).toBe(false)
    expect(value.capabilities).toEqual(['kv', 'ttl'])
  })

  it('default scope searches session + user levels; session requires the caller id', async () => {
    const { recall, memory } = createTools()
    memory.remember({ content: 'session-scoped fact', scope: 'session', sessionId: 'caller-sess' })
    memory.remember({ content: 'other-session fact', scope: 'session', sessionId: 'other-sess' })
    memory.remember({ content: 'user-scoped fact', scope: 'user' })
    memory.remember({ content: 'global-scoped fact', scope: 'global' })
    // The tool passes exec.agent.id as the session context (P1 isolation).
    const value = await runRecall(recall, {})
    const contents = [...value.core, ...value.related].map(h => h.content)
    expect(contents).toContain('session-scoped fact') // caller's own session memory
    expect(contents).not.toContain('other-session fact') // isolated
    expect(contents).toContain('user-scoped fact')
    expect(contents).toContain('global-scoped fact') // provider default includes global; config can exclude
  })

  it('caps output to the token budget and reports truncation', async () => {
    const { recall, memory } = createTools()
    memory.remember({ content: 'x'.repeat(400), scope: 'user' })
    memory.remember({ content: 'y'.repeat(400), scope: 'user' })
    const value = await runRecall(recall, { maxTokens: 40 }) // 400/4 = 100 tokens each
    expect(value.truncated).toBe(true)
    expect(value.core.length).toBeLessThan(2)
  })

  it('recall description honestly declares keyword-only capability (M1 boundary)', () => {
    const { recall } = createTools()
    expect(recall.description).toContain('keyword')
    expect(recall.description).toContain('no semantic or vector search')
  })
})
