/**
 * Async lifecycle engine MVP (plan §2-Step5, hard constraint D9).
 *
 * Session end ONLY enqueues a durable outbox row (single ~11µs insert) and
 * returns immediately. A background job (`ctx.jobs`, kind `memory`) consumes
 * rows: heuristic extraction → idempotent upsert → decay → archive-state
 * sync → file-bridge export (when wired) → Reflect gate. Every step is
 * individually contained: one failure never aborts the row's later steps or
 * other rows. A periodic sweep (R4: mandatory in M1) re-runs failed rows and
 * crash-recovered `processing` rows.
 *
 * The engine NEVER calls an LLM in M1 (Reflect gate only records passes).
 * @module dsh-memory/engine
 */

import type { Context } from '@deepseek-ai/cordis'
// Side-effect-free type import: pulls @deepseek-ai/dsh-jobs into the program
// so the JobKindMap augmentation below resolves (and ctx.jobs typing applies).
import type {} from '@deepseek-ai/dsh-jobs'
import type { SQLiteLocalProvider } from '../provider/sqlite/local-provider.ts'
import type { MemoryCandidate } from '../service/types.ts'
import { extractCandidates, DEFAULT_INTENT_WORDS, type ExtractOptions, type SessionEventLike } from './extractor.ts'
import { DEFAULT_REFLECT_GATE_CONFIG, ReflectGate, type ReflectGateConfig } from './reflect-gate.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    memory: 'memory'
  }
}

/** Minimal session shape the engine observes (avoids dsh-session coupling). */
export interface SessionLike {
  id: string
}

/** Minimal logger surface used by the engine. */
export interface EngineLogger {
  warn(...args: unknown[]): void
  info(...args: unknown[]): void
}

/** Optional file-bridge seam (Step 6 wires the real bridge). */
export interface BridgeSeam {
  /** Export core memories + archive events, then incrementally render. */
  exportAndRender(): Promise<void>
}

/** Engine configuration (plan §3 engine group). */
export interface EngineConfig {
  outboxMaxAttempts: number
  reflect: ReflectGateConfig
  extract: ExtractOptions
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  outboxMaxAttempts: 3,
  reflect: DEFAULT_REFLECT_GATE_CONFIG,
  extract: { minLength: 200, maxContentChars: 2000, intentWords: [] },
}

/**
 * Lifecycle engine. Created by the plugin; `start()` wires the session-event
 * listeners (enqueue-only) and the periodic sweep.
 */
export class MemoryLifecycleEngine {
  private readonly perSessionMessages = new Map<string, string[]>()

  constructor(
    private readonly ctx: Context,
    private readonly provider: SQLiteLocalProvider,
    private readonly config: EngineConfig = DEFAULT_ENGINE_CONFIG,
    private readonly bridge: BridgeSeam | null = null,
    private readonly logger: EngineLogger = ctx.logger,
  ) {
    if (this.config.extract.intentWords.length === 0) {
      this.config.extract.intentWords = DEFAULT_INTENT_WORDS
    }
  }

  /** Wire session listeners (enqueue-only — never block, never LLM/IO). */
  start(): void {
    this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const text = eventMessageText(event)
      if (!text) return
      const bucket = this.perSessionMessages.get(session.id) ?? []
      bucket.push(text)
      this.perSessionMessages.set(session.id, bucket)
    })
    this.ctx.on('session/disposed', (session) => {
      this.flushSession(session)
    })
  }

  /** Session-end hook: durable enqueue, immediate return (D9). */
  flushSession(session: SessionLike): void {
    const messages = this.perSessionMessages.get(session.id) ?? []
    this.perSessionMessages.delete(session.id)
    if (this.provider.outboxHasActive(session.id)) return
    this.provider.outboxEnqueue(session.id, messages.length > 0 ? JSON.stringify(messages) : null)
  }

  /** Session-start import hook (Step 6 wires importer + retry). */
  onSessionStart(session: SessionLike): void {
    // M1: bridge import is driven by the sweep; nothing blocking here.
    void session
  }

  /** Drain every processable outbox row (invoked inside a background job). */
  async sweep(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const row = this.provider.outboxClaim(this.config.outboxMaxAttempts)
      if (!row) break
      try {
        await this.processRow(row)
        this.provider.outboxComplete(row.id)
      } catch (error) {
        this.provider.outboxFail(row.id, error, this.config.outboxMaxAttempts)
        this.logger.warn(`dsh-memory: outbox row ${row.id} failed: ${String(error)}`)
      }
    }
    // Periodic export even with an empty outbox: core memories must reach the
    // file bridge on the sweep cadence, not only after session end.
    if (this.bridge) {
      try {
        await this.bridge.exportAndRender()
      } catch (error) {
        this.logger.warn(`dsh-memory: bridge export failed: ${String(error)}`)
      }
    }
  }

  /** Serial engine pipeline for one outbox row. Each step is contained. */
  private async processRow(row: { id: string; payload: string | null; sessionId: string }): Promise<void> {
    // 1. heuristic candidate extraction (never LLM in M1). A malformed
    //    payload is a data problem: fail the row (retryable) instead of
    //    silently completing it. Later steps stay individually contained.
    const events: SessionEventLike[] = row.payload ? JSON.parse(row.payload) as SessionEventLike[] : []
    // P1 isolation: candidates inherit the source session id.
    const candidates = extractCandidates(events, this.config.extract, row.sessionId)

    // 2. idempotent upserts (P1-2 table), each contained
    for (const candidate of candidates) {
      try {
        this.provider.upsert(candidate)
      } catch (error) {
        this.logger.warn(`dsh-memory: upsert failed: ${String(error)}`)
      }
    }

    // 3. TTL decay scan
    try {
      const decayed = this.provider.decay()
      if (decayed > 0) this.logger.info(`dsh-memory: decayed ${decayed} memories`)
    } catch (error) {
      this.logger.warn(`dsh-memory: decay failed: ${String(error)}`)
    }

    // 4. archive-state sync (M1: explicit archives only — no auto-archive)
    //    The exporter consumes memory/changed for archive rows; nothing to
    //    scan here until M2 auto-archiving.

    // 5. file-bridge export + incremental render (Step 6; absent → skip)
    if (this.bridge) {
      try {
        await this.bridge.exportAndRender()
      } catch (error) {
        this.logger.warn(`dsh-memory: bridge export failed: ${String(error)}`)
      }
    }

    // 6. Reflect gate (M1: record pass only — token guard)
    try {
      const gate = new ReflectGate(this.provider, this.config.reflect)
      const result = gate.check()
      if (result.passed) {
        gate.recordPass()
        this.logger.info(
          `dsh-memory: reflect gate passed (${result.reason}, delta=${result.delta}); `
          + `reflect itself ships in M2 — no LLM call made`,
        )
      }
    } catch (error) {
      this.logger.warn(`dsh-memory: reflect gate failed: ${String(error)}`)
    }
  }
}

/**
 * Extract message text from a session event, tolerant of both the dsh-session
 * envelope (`data`) and the extractor's minimal shape (`message`/`text`).
 */
function eventMessageText(event: { type: string; data?: unknown; message?: unknown; text?: string }): string | null {
  const data = event.data as { content?: string; text?: string } | string | undefined
  if (typeof data === 'string') return data
  if (data && typeof data === 'object') {
    if (typeof data.content === 'string') return data.content
    if (typeof data.text === 'string') return data.text
  }
  const message = event.message as { content?: string } | string | undefined
  if (typeof message === 'string') return message
  if (message && typeof message === 'object' && typeof message.content === 'string') return message.content
  if (typeof event.text === 'string') return event.text
  return null
}
