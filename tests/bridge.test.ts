/**
 * Step 6 tests: file bridge — JSONL append-only + archive rows, sentinel
 * incremental rendering, JSONL-only import, one-time strict migration, and
 * the mandatory permission fallback (三自检 #1).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { SQLiteLocalProvider } from '../src/provider/sqlite/local-provider.ts'
import { MemoryService } from '../src/service/memory-service.ts'
import { appendArchiveRow, exportCoreMemories } from '../src/bridge/exporter.ts'
import { appendToSentinel, ensureSentinel, parseJsonl, renderIncremental, splitSentinel } from '../src/bridge/renderer.ts'
import { importJsonl, migrateSentinelOnce } from '../src/bridge/importer.ts'
import { FileBridge } from '../src/bridge/fs-bridge.ts'
import { DSH_MEMORY_END, DSH_MEMORY_START } from '../src/bridge/paths.ts'

let dir: string
const providers: SQLiteLocalProvider[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-memory-bridge-'))
})

afterEach(() => {
  for (const p of providers) {
    try { p.close() } catch { /* already closed */ }
  }
  providers.length = 0
  rmSync(dir, { recursive: true, force: true })
})

function createProvider(): SQLiteLocalProvider {
  const provider = new SQLiteLocalProvider(join(dir, 'memory.sqlite'))
  providers.push(provider)
  return provider
}

/** Access the private db handle for direct SQL manipulation in tests. */
function rawDb(provider: SQLiteLocalProvider): { exec(sql: string): void } {
  return (provider as unknown as { db: { exec(sql: string): void } }).db
}

describe('JSONL exporter (P0-2, 终审注意点 5)', () => {
  it('exports core memories as upsert rows (append-only)', async () => {
    const provider = createProvider()
    const jsonl = join(dir, 'dsh_sync.jsonl')
    provider.upsert({ content: '核心记忆甲', importance: 3, scope: 'user' })
    provider.upsert({ content: '普通记忆乙', importance: 1, scope: 'user' })
    // push 普通记忆乙 outside the 24h export window (fresh writes qualify)
    rawDb(provider).exec("UPDATE memories SET last_confirmed_at = last_confirmed_at - 100000000 WHERE content = '普通记忆乙'")
    const first = await exportCoreMemories(provider, jsonl)
    expect(first.appended).toBe(1) // only importance ≥ 2 (or recent)
    const rows = parseJsonl(await (await import('node:fs/promises')).readFile(jsonl, 'utf8'))
    expect(rows[0]?.action).toBe('upsert')
    expect(rows[0]?.content).toBe('核心记忆甲')
    // idempotent: second pass appends nothing
    const second = await exportCoreMemories(provider, jsonl)
    expect(second.appended).toBe(0)
    expect(rows.length).toBe(1)
  })

  it('archive rows append only for previously exported memories', async () => {
    const provider = createProvider()
    const jsonl = join(dir, 'dsh_sync.jsonl')
    const core = provider.upsert({ content: '要归档的核心', importance: 3 })
    const never = provider.upsert({ content: '从未导出的', importance: 1 })
    // push 从未导出的 outside the export window
    rawDb(provider).exec("UPDATE memories SET last_confirmed_at = last_confirmed_at - 100000000 WHERE content = '从未导出的'")
    await exportCoreMemories(provider, jsonl)
    const archivedCore = await appendArchiveRow(provider, jsonl, { id: core.id, contentHash: core.contentHash })
    expect(archivedCore).toBe(true)
    const orphan = await appendArchiveRow(provider, jsonl, { id: never.id, contentHash: never.contentHash })
    expect(orphan).toBe(false) // 终审注意点 5: no orphan archive rows
    const rows = parseJsonl(await (await import('node:fs/promises')).readFile(jsonl, 'utf8'))
    expect(rows.filter(r => r.action === 'archive')).toHaveLength(1)
  })

  it('restored core memory re-upserts after archive', async () => {
    const provider = createProvider()
    const jsonl = join(dir, 'dsh_sync.jsonl')
    const m = provider.upsert({ content: '起死回生', importance: 3 })
    await exportCoreMemories(provider, jsonl)
    await appendArchiveRow(provider, jsonl, { id: m.id, contentHash: m.contentHash })
    provider.restore(m.id)
    const again = await exportCoreMemories(provider, jsonl)
    expect(again.appended).toBe(1)
    const rows = parseJsonl(await (await import('node:fs/promises')).readFile(jsonl, 'utf8'))
    expect(rows[rows.length - 1]?.action).toBe('upsert')
  })
})

describe('sentinel renderer (D10/D11, lastRenderSeq)', () => {
  it('creates the sentinel block when missing', () => {
    expect(ensureSentinel('## 人工区\n内容')).toContain(DSH_MEMORY_START)
    expect(ensureSentinel('## 人工区\n内容')).toContain(DSH_MEMORY_END)
  })

  it('appends inside the block and preserves outside content verbatim', () => {
    const md = '## 人工区\n\n<!-- DSH_MEMORY_START -->\n<!-- DSH_MEMORY_END -->\n\n## 结尾人工区\n'
    const out = appendToSentinel(md, ['- 新条目  \n  > 本条记录由 DSH 写入'])
    expect(out).toContain('## 人工区')
    expect(out).toContain('## 结尾人工区')
    const split = splitSentinel(out)
    expect(split.inside).toContain('新条目')
    expect(split.inside).toContain('新条目')
  })

  it('incremental render only appends new JSONL rows (never redraws)', async () => {
    const provider = createProvider()
    const mdPath = join(dir, 'MEMORY.md')
    const jsonl = join(dir, 'dsh_sync.jsonl')
    // build 5000 rows
    let text = ''
    for (let i = 0; i < 5000; i++) {
      text += `${JSON.stringify({ id: `id${i}`, content_hash: `h${i}`, ts: i, action: 'upsert', content: `条目${i}`, importance: 2 })}\n`
    }
    const { writeFile } = await import('node:fs/promises')
    await writeFile(jsonl, text)
    const rendered = await renderIncremental(provider, mdPath, text)
    expect(rendered).toBe(5000)
    const md1 = await (await import('node:fs/promises')).readFile(mdPath, 'utf8')
    expect(md1.split('本条记录由 DSH 写入').length - 1).toBe(5000)
    // second pass: nothing new
    const again = await renderIncremental(provider, mdPath, text)
    expect(again).toBe(0)
    const md2 = await (await import('node:fs/promises')).readFile(mdPath, 'utf8')
    expect(md2).toBe(md1)
  })

  it('parses JSONL tolerantly (malformed lines skipped)', () => {
    const rows = parseJsonl('{"id":"a","content_hash":"h","ts":1,"action":"upsert"}\nnot-json\n{"id":"b","content_hash":"h2","ts":2,"action":"archive"}\n')
    expect(rows).toHaveLength(2)
  })
})

describe('importer (P1-1: JSONL is the only authoritative source)', () => {
  it('imports upsert rows idempotently and syncs archive state', async () => {
    const provider = createProvider()
    provider.upsert({ content: '已有记忆', scope: 'user' })
    const jsonl = [
      { id: 'x1', content_hash: 'h1', ts: 1, action: 'upsert', content: '已有记忆', scope: 'user' },
      { id: 'x2', content_hash: 'h2', ts: 2, action: 'upsert', content: '新导入记忆', scope: 'user' },
    ].map(r => JSON.stringify(r)).join('\n')
    const result = await importJsonl(provider, jsonl)
    expect(result.imported).toBe(2)
    // 已有记忆 deduped (reinforced), 新导入记忆 added
    expect(provider.listByStatus('active').length).toBe(2)
    // second import: nothing new
    const again = await importJsonl(provider, jsonl)
    expect(again.imported).toBe(0)
  })

  it('applies archive rows as state sync (双向一致)', async () => {
    const provider = createProvider()
    const m = provider.upsert({ content: '要归档的', importance: 3 })
    const jsonl = JSON.stringify({ id: 'a', content_hash: m.contentHash, ts: 1, action: 'archive' })
    const result = await importJsonl(provider, jsonl)
    expect(result.archived).toBe(1)
    expect(provider.get(m.id)?.status).toBe('archived')
  })
})

describe('one-time strict migration (P1-1 exception)', () => {
  it('migrates only DSH-written sentinel entries when SQLite is empty', async () => {
    const provider = createProvider()
    const md = `## 人工区\n- 手写条目不该迁移\n<!-- DSH_MEMORY_START -->\n- 迁移条目一  \n  > 本条记录由 DSH 写入 · importance 2 · 2026-08-22\n- 损坏条目（无标记）\n<!-- DSH_MEMORY_END -->\n`
    const migrated = await migrateSentinelOnce(provider, md, () => {})
    expect(migrated).toBe(1)
    const memories = provider.listByStatus('active')
    expect(memories[0]?.content).toBe('迁移条目一')
  })

  it('skips migration when SQLite already has memories', async () => {
    const provider = createProvider()
    provider.upsert({ content: '已有', scope: 'user' })
    const md = `<!-- DSH_MEMORY_START -->\n- 迁移条目  \n  > 本条记录由 DSH 写入\n<!-- DSH_MEMORY_END -->\n`
    const migrated = await migrateSentinelOnce(provider, md, () => {})
    expect(migrated).toBe(0)
  })
})

describe('FileBridge fallback (三自检 #1 — never throw, never block)', () => {
  function makeCtx(): Context {
    const ctx = new Context()
    // fake workspaceRegistry with a temp workspace
    ;(ctx as unknown as { workspaceRegistry: unknown }).workspaceRegistry = {
      list: () => [{ path: dir }],
    }
    return ctx
  }

  it('writes JSONL + MEMORY.md end-to-end via importAndExport', async () => {
    const ctx = makeCtx()
    const provider = createProvider()
    provider.upsert({ content: '桥接记忆', importance: 3, scope: 'user' })
    const bridge = new FileBridge(ctx, provider, { enabled: true, memoryDir: '.workbuddy/memory', workspaceRoot: '', export: { exportMinImportance: 2, exportRecentWindowMs: 86400000 } })
    await bridge.importAndExport()
    expect(bridge.status()).toBe('ok')
    const { readFileSync } = await import('node:fs')
    const jsonl = readFileSync(join(dir, '.workbuddy', 'memory', 'dsh_sync.jsonl'), 'utf8')
    expect(jsonl).toContain('桥接记忆')
    const md = readFileSync(join(dir, '.workbuddy', 'memory', 'MEMORY.md'), 'utf8')
    expect(md).toContain(DSH_MEMORY_START)
    expect(md).toContain('桥接记忆')
  })

  it('degrades to SQLite-only when the memory dir is a read-only file (no throw)', async () => {
    const ctx = makeCtx()
    const provider = createProvider()
    provider.upsert({ content: '降级测试', importance: 3, scope: 'user' })
    // make .workbuddy a FILE so mkdir fails
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, '.workbuddy'), 'occupied')
    const bridge = new FileBridge(ctx, provider, { enabled: true, memoryDir: '.workbuddy/memory', workspaceRoot: '', export: { exportMinImportance: 2, exportRecentWindowMs: 86400000 } })
    await expect(bridge.importAndExport()).resolves.toBeUndefined()
    expect(bridge.status()).toBe('degraded')
    // SQLite still intact
    expect(provider.listByStatus('active').length).toBe(1)
  })

  it('archive event appends a row; failure is contained', async () => {
    const ctx = makeCtx()
    const provider = createProvider()
    const service = new MemoryService(ctx, provider)
    provider.upsert({ content: '归档桥接', importance: 3 })
    const bridge = new FileBridge(ctx, provider, { enabled: true, memoryDir: '.workbuddy/memory', workspaceRoot: '', export: { exportMinImportance: 2, exportRecentWindowMs: 86400000 } })
    bridge.start()
    await bridge.importAndExport()
    const m = provider.upsert({ content: '归档桥接' })
    service.archive(m.id, 'test')
    await new Promise(r => setTimeout(r, 50))
    const jsonl = await (await import('node:fs/promises')).readFile(join(dir, '.workbuddy', 'memory', 'dsh_sync.jsonl'), 'utf8')
    expect(jsonl).toContain('"action":"archive"')
  })

  it('disabled state when bridge config is off', () => {
    const ctx = makeCtx()
    const provider = createProvider()
    const bridge = new FileBridge(ctx, provider, { enabled: false, memoryDir: '.workbuddy/memory', workspaceRoot: '', export: { exportMinImportance: 2, exportRecentWindowMs: 86400000 } })
    expect(bridge.isActive()).toBe(false)
    expect(bridge.status()).toBe('disabled')
  })
})
