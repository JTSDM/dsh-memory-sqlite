/**
 * SQLite LocalProvider (ADR D3, plan §2-Step3).
 *
 * Zero-dependency store via `node:sqlite` DatabaseSync (the same driver the
 * official dsh-session-query-sqlite uses). Synchronous by decision — P0-1
 * measured 5.5µs/write and 0.7ms/decay-scan on 10k rows.
 *
 * Honors the P1-2 state-transition table (5 rows) and the P1-3 delta rule
 * (every reinforcement event atomically bumps engine_state
 * `pending_reinforce_delta` in the same transaction).
 * @module dsh-memory/provider/sqlite/local-provider
 */

import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { MemoryCapability } from '../../service/capabilities.ts'
import type {
  Memory,
  MemoryCandidate,
  MemoryQuery,
  MemoryScope,
  MemoryStatus,
  MemoryType,
  RecallItem,
  RecallResult,
  UpsertOutcome,
} from '../../service/types.ts'
import { NotSupportedError, type IMemoryProvider } from '../types.ts'
import { contentHash, normalizeContent } from './normalize.ts'
import { createSchema } from './schema.ts'

// node:sqlite is dynamically imported (official pattern from
// dsh-session-query-sqlite); top-level await keeps construction synchronous.
const { DatabaseSync: DatabaseSyncCtor } = await import('node:sqlite')

/** engine_state key: reinforcement events since the last reflect check. */
export const STATE_REINFORCE_DELTA = 'pending_reinforce_delta'
/** engine_state key: last reflect gate evaluation (epoch ms). */
export const STATE_LAST_REFLECT = 'last_reflect_at'
/** engine_state key: JSONL export sequence pointer. */
export const STATE_LAST_EXPORT_SEQ = 'last_export_seq'
/** engine_state key: JSONL import sequence pointer. */
export const STATE_LAST_IMPORT_SEQ = 'last_import_seq'
/** engine_state key: MEMORY.md render sequence pointer. */
export const STATE_LAST_RENDER_SEQ = 'last_render_seq'
/** engine_state key: file-bridge status ('ok' | 'degraded' | 'disabled'). */
export const STATE_BRIDGE_STATUS = 'bridge_status'

const STATE_KEYS = [
  STATE_REINFORCE_DELTA,
  STATE_LAST_REFLECT,
  STATE_LAST_EXPORT_SEQ,
  STATE_LAST_IMPORT_SEQ,
  STATE_LAST_RENDER_SEQ,
  STATE_BRIDGE_STATUS,
] as const

type StateKey = (typeof STATE_KEYS)[number]

/** Default reinforcement window: same hash within 1h 鈫?reinforceCount++ (gotchas #3). */
export const DEFAULT_REINFORCE_WINDOW_MS = 60 * 60 * 1000

/** FTS5 rowid 鈫?memory row mapping (kept in sync by triggers). */
interface FtsRow {
  rowid: number
}

/** Default TTL: memories expire to dormant after 90 days without confirmation. */
export const DEFAULT_TTL_MS = 90 * 24 * 60 * 60 * 1000

const SCOPE_PRIORITY: Record<MemoryScope, number> = { session: 0, user: 1, global: 2 }

function toMemory(row: Record<string, unknown>): Memory {
  return {
    id: String(row.id),
    content: String(row.content),
    contentHash: String(row.content_hash),
    importance: row.importance as 1 | 2 | 3,
    type: row.type as MemoryType,
    scope: row.scope as MemoryScope,
    sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
    status: row.status as MemoryStatus,
    reinforceCount: Number(row.reinforce_count),
    ttlMs: row.ttl_ms === null || row.ttl_ms === undefined ? null : Number(row.ttl_ms),
    lastConfirmedAt: Number(row.last_confirmed_at),
    sourceRef: row.source_ref === null || row.source_ref === undefined ? null : String(row.source_ref),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/**
 * SQLite-backed provider. One DatabaseSync connection; WAL mode; FTS5 synced
 * by triggers. Synchronous by the M1 performance decision (see module docs).
 */
export class SQLiteLocalProvider implements IMemoryProvider {
  readonly name = 'sqlite'
  private readonly db: DatabaseSync
  private readonly reinforceWindowMs: number

  constructor(dbPath: string, reinforceWindowMs = DEFAULT_REINFORCE_WINDOW_MS) {
    const isMemory = dbPath === ':memory:'
    const resolved = isMemory ? ':memory:' : resolve(dbPath)
    if (!isMemory) mkdirSync(dirname(resolved), { recursive: true })
    this.db = this.open(resolved)
    createSchema(this.db)
    this.reinforceWindowMs = reinforceWindowMs
    for (const key of STATE_KEYS) {
      if (this.getState(key) === null) this.setState(key, key === STATE_REINFORCE_DELTA ? '0' : '')
    }
  }

  private open(path: string): DatabaseSync {
    return new DatabaseSyncCtor(path)
  }

  capabilities(): Set<MemoryCapability> {
    return new Set(['kv', 'ttl'])
  }

  /** Write or reinforce per the P1-2 state-transition table. */
  upsert(candidate: MemoryCandidate): UpsertOutcome {
    const content = normalizeContent(candidate.content)
    if (!content) throw new Error('memory content must not be empty after normalization')
    const hash = contentHash(content)
    const now = Date.now()

    const existing = this.db.prepare('SELECT * FROM memories WHERE content_hash = ?').get(hash) as
      | Record<string, unknown>
      | undefined

    if (!existing) {
      const id = randomUUID()
      const importance = clampImportance(candidate.importance ?? 1)
      const type = candidate.type ?? 'world'
      const scope = candidate.scope ?? 'session'
      // P1 isolation: session_id stored ONLY for scope=session memories.
      const sessionId = scope === 'session' ? (candidate.sessionId ?? null) : null
      this.db.prepare(
        `INSERT INTO memories (id, content, content_hash, importance, type, scope, session_id, status,
           reinforce_count, ttl_ms, last_confirmed_at, source_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?, ?)`,
      ).run(id, content, hash, importance, type, scope, sessionId, DEFAULT_TTL_MS, now, candidate.sourceRef ?? null, now, now)
      return {
        id, contentHash: hash, deduped: false, reinforced: false,
        reinforceCount: 0, status: 'active', changeKind: 'upsert', storedAt: now,
      }
    }

    const status = existing.status as MemoryStatus
    const lastConfirmed = Number(existing.last_confirmed_at)
    const withinWindow = now - lastConfirmed < this.reinforceWindowMs
    const importance = clampImportance(candidate.importance ?? (existing.importance as number))

    // P1-2 table rows 2-5 share the property-merge rules:
    // explicit values overwrite, implicit defaults keep the old value,
    // importance takes max.
    const nextImportance = Math.max(
      Number(existing.importance),
      importance,
    ) as 1 | 2 | 3
    const nextType = (candidate.type ?? existing.type) as MemoryType
    const nextScope = (candidate.scope ?? existing.scope) as MemoryScope
    const nextSourceRef = candidate.sourceRef ?? (existing.source_ref as string | null)
    // P1 isolation: scope transitions reset ownership; session scope takes the
    // candidate's (or keeps the existing) session id.
    const nextSessionId = nextScope === 'session'
      ? (candidate.sessionId ?? (existing.session_id as string | null))
      : null

    if (status === 'archived') {
      // Row 5: archived → restore, reinforceCount = old + 1.
      this.db.prepare(
        `UPDATE memories SET status = 'active', reinforce_count = reinforce_count + 1,
           importance = ?, type = ?, scope = ?, session_id = ?, last_confirmed_at = ?, source_ref = ?, updated_at = ?
         WHERE id = ?`,
      ).run(nextImportance, nextType, nextScope, nextSessionId, now, nextSourceRef, now, String(existing.id))
      this.bumpDelta()
      return {
        id: String(existing.id), contentHash: hash, deduped: true, reinforced: true,
        reinforceCount: Number(existing.reinforce_count) + 1, status: 'active',
        changeKind: 'restore', storedAt: now,
      }
    }

    if (status === 'dormant' || withinWindow) {
      // Rows 1 (dormant) and 2 (active within window): reinforceCount++.
      this.db.prepare(
        `UPDATE memories SET status = 'active', reinforce_count = reinforce_count + 1,
           importance = ?, type = ?, scope = ?, session_id = ?, last_confirmed_at = ?, source_ref = ?, updated_at = ?
         WHERE id = ?`,
      ).run(nextImportance, nextType, nextScope, nextSessionId, now, nextSourceRef, now, String(existing.id))
      this.bumpDelta()
      return {
        id: String(existing.id), contentHash: hash, deduped: true, reinforced: true,
        reinforceCount: Number(existing.reinforce_count) + 1, status: 'active',
        changeKind: 'upsert', storedAt: now,
      }
    }

    // Row 3: active, ≥ reinforceWindowMs → confirm only (no count, no delta).
    this.db.prepare(
      `UPDATE memories SET importance = ?, type = ?, scope = ?, session_id = ?,
         last_confirmed_at = ?, source_ref = ?, updated_at = ? WHERE id = ?`,
    ).run(nextImportance, nextType, nextScope, nextSessionId, now, nextSourceRef, now, String(existing.id))
    return {
      id: String(existing.id), contentHash: hash, deduped: true, reinforced: false,
      reinforceCount: Number(existing.reinforce_count), status: 'active',
      changeKind: 'upsert', storedAt: now,
    }
  }

  /** P1-3: every reinforcement event atomically bumps the reflect delta. */
  private bumpDelta(): void {
    this.db.prepare(
      `INSERT INTO engine_state (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
    ).run(STATE_REINFORCE_DELTA)
  }

  recall(query: MemoryQuery): RecallResult {
    const scopes = query.scopes ?? (['session', 'user', 'global'] as MemoryScope[])
    const limit = query.limit ?? 10
    const maxTokens = query.maxTokens ?? Number.MAX_SAFE_INTEGER

    const scopeClause = `scope IN (${scopes.map(() => '?').join(',')})`
    const scopeArgs: MemoryScope[] = [...scopes]
    // P1 isolation: session-scoped memories are visible ONLY to their owning
    // session. Without a caller sessionId they are never returned; with one,
    // `session_id` must match. user/global memories are always visible.
    const wantsSession = scopes.includes('session')
    const isolationClause = wantsSession
      ? (query.sessionId ? `(scope != 'session' OR session_id = ?)` : `scope != 'session'`)
      : '1=1'
    const isolationArg = wantsSession && query.sessionId ? query.sessionId : null
    const scopeAndIsolation = `${scopeClause} AND ${isolationClause}`
    const isoArgs = isolationArg === null ? scopeArgs : [...scopeArgs, isolationArg]
    const statusClause = query.includeArchive ? '1=1' : "status IN ('active','dormant')"

    // core: FTS5 keyword hits PLUS a LIKE substring fallback. FTS5's
    // unicode61 tokenizer treats contiguous CJK runs as single tokens, so
    // Chinese substrings (e.g. "冒烟") never match as phrases — the LIKE
    // leg covers them (measured 0.7ms on 10k rows). FTS hits rank higher.
    let core: RecallItem[] = []
    if (query.text) {
      const seen = new Set<string>()
      // FTS5 MATCH is a query language: % _ ( ) : " etc. raise syntax errors.
      // Contained — a bad MATCH degrades to the LIKE leg only (P2-1).
      let fts: FtsRow[] = []
      try {
        fts = this.db.prepare(
          `SELECT f.rowid FROM memories_fts f WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?`,
        ).all(query.text, Math.max(limit * 5, 50)) as unknown as FtsRow[]
      } catch {
        fts = []
      }
      if (fts.length > 0) {
        const ids = new Set(fts.map(r => r.rowid))
        const rows = this.db.prepare(
          `SELECT * FROM memories WHERE rowid IN (${[...ids].join(',')})
             AND ${scopeAndIsolation} AND ${statusClause}
             AND (? IS NULL OR last_confirmed_at >= ?)
           ORDER BY importance DESC, last_confirmed_at DESC`,
        ).all(...isoArgs, query.sinceMs ?? null, query.sinceMs ?? null) as Record<string, unknown>[]
        for (const row of rows) {
          const memory = toMemory(row)
          seen.add(memory.id)
          core.push({ memory, score: 20 + scopeWeight(memory.scope) + memory.importance * 10 })
        }
      }
      // LIKE substring fallback (ESCAPE for literal %/_ in the query).
      const like = `%${query.text.replace(/[\\%_]/g, m => `\\${m}`)}%`
      const rows = this.db.prepare(
        `SELECT * FROM memories
         WHERE content LIKE ? ESCAPE '\\' AND ${scopeAndIsolation} AND ${statusClause}
           AND (? IS NULL OR last_confirmed_at >= ?)
         ORDER BY importance DESC, last_confirmed_at DESC LIMIT ?`,
      ).all(like, ...isoArgs, query.sinceMs ?? null, query.sinceMs ?? null, Math.max(limit * 5, 50)) as Record<string, unknown>[]
      for (const row of rows) {
        const memory = toMemory(row)
        if (seen.has(memory.id)) continue
        core.push({ memory, score: 10 + scopeWeight(memory.scope) + memory.importance * 10 })
      }
    } else {
      const rows = this.db.prepare(
        `SELECT * FROM memories WHERE ${scopeAndIsolation} AND ${statusClause}
           AND (? IS NULL OR last_confirmed_at >= ?)
         ORDER BY importance DESC, last_confirmed_at DESC LIMIT ?`,
      ).all(...isoArgs, query.sinceMs ?? null, query.sinceMs ?? null, limit) as Record<string, unknown>[]
      core = rows.map(row => ({
        memory: toMemory(row),
        score: scopeWeight(row.scope as MemoryScope) + Number(row.importance) * 10,
      }))
    }

    // related: same scope/type as the top core hits (excluding core ids).
    const coreIds = new Set(core.map(item => item.memory.id))
    let related: RecallItem[] = []
    const anchor = core[0]?.memory
    if (anchor && core.length > 0) {
      const rows = this.db.prepare(
        `SELECT * FROM memories
         WHERE scope = ? AND type = ? AND status IN ('active','dormant')
           AND (scope != 'session' OR session_id = ?)
           AND id NOT IN (${[...coreIds].map(() => '?').join(',')})
         ORDER BY importance DESC, last_confirmed_at DESC LIMIT ?`,
      ).all(anchor.scope, anchor.type, query.sessionId ?? '', ...coreIds, limit) as Record<string, unknown>[]
      related = rows.map(row => ({
        memory: toMemory(row),
        score: scopeWeight(row.scope as MemoryScope) + Number(row.importance) * 5,
      }))
    }

    // divergent: archived memories matching the same content hash, or
    // conflicts (same normalized content hash as a core hit).
    let divergent: RecallItem[] = []
    if (query.includeArchive || query.text) {
      const archived = this.db.prepare(
        `SELECT * FROM memories WHERE status = 'archived' AND ${scopeAndIsolation}
         ORDER BY updated_at DESC LIMIT ?`,
      ).all(...isoArgs, limit) as Record<string, unknown>[]
      divergent = archived.map(row => ({
        memory: toMemory(row),
        score: 0,
      }))
    }

    // Token capping: approximate tokens = chars / 4 (red-team ≤30% context).
    const truncated = capByTokens(core, maxTokens) || capByTokens(related, maxTokens)

    return {
      core: core.slice(0, limit),
      related: related.slice(0, limit),
      divergent: divergent.slice(0, query.includeArchive ? limit : Math.max(limit, 3)),
      truncated,
      capabilities: ['kv', 'ttl'],
    }
  }

  decay(): number {
    const now = Date.now()
    const result = this.db.prepare(
      `UPDATE memories SET status = 'dormant', updated_at = ?
       WHERE status = 'active' AND ttl_ms IS NOT NULL AND last_confirmed_at < ? - ttl_ms`,
    ).run(now, now)
    return Number(result.changes)
  }

  archive(id: string, reason?: string): Memory | null {
    const existing = this.get(id)
    if (!existing || existing.status === 'archived') return null
    const now = Date.now()
    this.db.prepare(
      `UPDATE memories SET status = 'archived', updated_at = ? WHERE id = ?`,
    ).run(now, id)
    this.db.prepare(
      `INSERT INTO archive (id, memory_id, archived_at, reason, snapshot) VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID(), id, now, reason ?? null, JSON.stringify(existing))
    return this.get(id)
  }

  restore(id: string): Memory | null {
    const existing = this.get(id)
    if (!existing || existing.status !== 'archived') return null
    const now = Date.now()
    this.db.prepare(
      `UPDATE memories SET status = 'active', last_confirmed_at = ?, updated_at = ? WHERE id = ?`,
    ).run(now, now, id)
    this.bumpDelta()
    return this.get(id)
  }

  get(id: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined
    return row ? toMemory(row) : null
  }

  findByHash(contentHashValue: string): Memory | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE content_hash = ?').get(contentHashValue) as
      | Record<string, unknown>
      | undefined
    return row ? toMemory(row) : null
  }

  listByStatus(status: MemoryStatus): Memory[] {
    const rows = this.db.prepare('SELECT * FROM memories WHERE status = ?').all(status) as Record<string, unknown>[]
    return rows.map(toMemory)
  }

  graphQuery(_query: unknown): never {
    throw new NotSupportedError('graphQuery', this.name)
  }

  getState(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM engine_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  }

  setState(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO engine_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value)
  }

  /** Reset the reflect delta (called by the gate after a pass). */
  resetReinforceDelta(): void {
    this.setState(STATE_REINFORCE_DELTA, '0')
  }

  /** Current pending reflect delta. */
  getReinforceDelta(): number {
    return Number(this.getState(STATE_REINFORCE_DELTA) ?? '0')
  }

  // ---------------------------------------------------------------------------
  // Outbox: durable async-lifecycle queue (plan §2-Step5, D9). Enqueue is a
  // synchronous single-row insert (~11µs measured) — never blocks session end.
  // ---------------------------------------------------------------------------

  /** Durable queue row. */
  outboxEnqueue(sessionId: string, payload: string | null): string {
    const id = randomUUID()
    const now = Date.now()
    this.db.prepare(
      `INSERT INTO outbox (id, session_id, payload, status, created_at, updated_at, attempts, last_error)
       VALUES (?, ?, ?, 'pending', ?, ?, 0, NULL)`,
    ).run(id, sessionId, payload, now, now)
    return id
  }

  /**
   * Claim the next processable row: pending rows first, then failed rows under
   * the retry cap, then stale `processing` rows (crash recovery, 5 min).
   * Marks the row `processing`.
   */
  outboxClaim(maxAttempts: number): OutboxRow | null {
    const now = Date.now()
    const stale = now - 5 * 60 * 1000
    this.db.prepare(
      `UPDATE outbox SET status = 'pending'
       WHERE status = 'processing' AND updated_at < ?`,
    ).run(stale)
    const row = this.db.prepare(
      `SELECT * FROM outbox
       WHERE status = 'pending' OR (status = 'failed' AND attempts < ?)
       ORDER BY created_at ASC LIMIT 1`,
    ).get(maxAttempts) as Record<string, unknown> | undefined
    if (!row) return null
    this.db.prepare(
      `UPDATE outbox SET status = 'processing', updated_at = ? WHERE id = ?`,
    ).run(now, String(row.id))
    return { ...toOutboxRow(row), status: 'processing' }
  }

  outboxComplete(id: string): void {
    this.db.prepare(
      `UPDATE outbox SET status = 'done', updated_at = ? WHERE id = ?`,
    ).run(Date.now(), id)
  }

  outboxFail(id: string, error: unknown, maxAttempts: number): void {
    const attempts = this.db.prepare('SELECT attempts FROM outbox WHERE id = ?').get(id) as { attempts: number } | undefined
    const next = (attempts?.attempts ?? 0) + 1
    this.db.prepare(
      `UPDATE outbox SET status = ?, attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    ).run(next >= maxAttempts ? 'failed' : 'pending', next, String(error), Date.now(), id)
  }

  outboxCount(status: OutboxStatus | 'pending'): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE status = ?').get(status) as { n: number }
    return Number(row.n)
  }

  /** Whether a session already has an unfinished outbox row (dedup enqueue). */
  outboxHasActive(sessionId: string): boolean {
    const row = this.db.prepare(
      `SELECT 1 AS x FROM outbox WHERE session_id = ? AND status IN ('pending','processing') LIMIT 1`,
    ).get(sessionId) as { x: number } | undefined
    return row !== undefined
  }

  // ---------------------------------------------------------------------------
  // bridge_exported: which memories reached the JSONL (终审注意点 5).
  // ---------------------------------------------------------------------------

  /** Record that a memory reached the JSONL with the given last action. */
  bridgeMarkExported(id: string, lastAction: 'upsert' | 'archive'): void {
    this.db.prepare(
      `INSERT INTO bridge_exported (id, last_action, exported_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_action = excluded.last_action, exported_at = excluded.exported_at`,
    ).run(id, lastAction, Date.now())
  }

  /** Last JSONL action for a memory, or null when never exported. */
  bridgeGetExported(id: string): 'upsert' | 'archive' | null {
    const row = this.db.prepare('SELECT last_action FROM bridge_exported WHERE id = ?').get(id) as
      | { last_action: 'upsert' | 'archive' }
      | undefined
    return row?.last_action ?? null
  }

  close(): void {
    this.db.close()
  }
}

/** Outbox row shape. */
export interface OutboxRow {
  id: string
  sessionId: string
  payload: string | null
  status: OutboxStatus
  createdAt: number
  updatedAt: number
  attempts: number
  lastError: string | null
}

/** Outbox lifecycle status. */
export type OutboxStatus = 'pending' | 'processing' | 'done' | 'failed'

function toOutboxRow(row: Record<string, unknown>): OutboxRow {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    payload: row.payload === null || row.payload === undefined ? null : String(row.payload),
    status: row.status as OutboxStatus,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    attempts: Number(row.attempts),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
  }
}

function clampImportance(value: number): 1 | 2 | 3 {
  if (value >= 3) return 3
  if (value <= 1) return 1
  return 2
}

function scopeWeight(scope: MemoryScope): number {
  return 10 - SCOPE_PRIORITY[scope] * 3
}

/** Cap a tier by approximate token budget; returns true when truncated. */
function capByTokens(items: RecallItem[], maxTokens: number): boolean {
  let used = 0
  let kept = 0
  for (const item of items) {
    const approx = Math.ceil(item.memory.content.length / 4)
    if (used + approx > maxTokens) break
    used += approx
    kept += 1
  }
  const truncated = kept < items.length
  if (truncated) items.length = kept
  return truncated
}
