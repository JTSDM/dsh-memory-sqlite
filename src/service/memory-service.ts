/**
 * Memory service definition — `ctx.memory` (design doc §3/§4, D1/D4).
 *
 * A cordis Service exposing cognitive-vocabulary primitives
 * (remember/link/recall/reinforce/decay/archive/restore/consolidate) over the
 * injected provider. Unimplemented primitives throw NotSupportedError.
 * @module dsh-memory/service
 */

import type { Context } from '@deepseek-ai/cordis'
import { Service } from '@deepseek-ai/cordis'
import type { MemoryCapability } from './capabilities.ts'
import { rankCapabilities } from './capabilities.ts'
import type {
  Memory,
  MemoryCandidate,
  MemoryChangedEvent,
  MemoryQuery,
  RecallResult,
  UpsertOutcome,
} from './types.ts'
import { NotSupportedError, type IMemoryProvider } from '../provider/types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The memory service (provided by the dsh-memory plugin). */
    memory: MemoryService
  }
  interface Events {
    /** Fired after every memory write/archive/restore (payload: MemoryChangedEvent). */
    'memory/changed'(event: MemoryChangedEvent): void
  }
}

/**
 * The `ctx.memory` service. Construction registers the service on the
 * context immediately; unloading the owning fiber unregisters it.
 */
export class MemoryService extends Service {
  static provide = 'memory'

  constructor(
    ctx: Context,
    private readonly provider: IMemoryProvider,
  ) {
    super(ctx, 'memory')
  }

  /** Provider name (diagnostics). */
  get providerName(): string {
    return this.provider.name
  }

  /** Capability tiers in canonical order (ADR D2). */
  capabilities(): MemoryCapability[] {
    return rankCapabilities(this.provider.capabilities())
  }

  /** Whether the provider implements a given tier. */
  hasCapability(capability: MemoryCapability): boolean {
    return this.provider.capabilities().has(capability)
  }

  /** Write or reinforce one memory (idempotent via content_hash, D12). */
  remember(candidate: MemoryCandidate): UpsertOutcome {
    const outcome = this.provider.upsert(candidate)
    this.emitChanged(outcome.changeKind, outcome)
    return outcome
  }

  /** Three-tier recall with scope filtering and token capping. */
  recall(query: MemoryQuery): RecallResult {
    return this.provider.recall(query)
  }

  /** Explicitly archive a memory (M1 has no automatic archiving). */
  archive(id: string, reason?: string): Memory | null {
    const memory = this.provider.archive(id, reason)
    if (memory) this.ctx.emit('memory/changed', { type: 'archive', memory })
    return memory
  }

  /** Restore an archived memory (reinforce count preserved). */
  restore(id: string): Memory | null {
    const memory = this.provider.restore(id)
    if (memory) this.ctx.emit('memory/changed', { type: 'restore', memory })
    return memory
  }

  /** Run the TTL decay scan. Returns the number of memories decayed. */
  decay(): number {
    return this.provider.decay()
  }

  /** Get one memory by id. */
  get(id: string): Memory | null {
    return this.provider.get(id)
  }

  /** Subscribe to `memory/changed` (returns the disposer). */
  onChanged(listener: (event: MemoryChangedEvent) => void): () => void {
    return this.ctx.on('memory/changed', listener)
  }

  /** Not implemented in M1 — reserved for M3 Mnemon adapter (R1). */
  link(_from: string, _to: string, _relation: string): never {
    throw new NotSupportedError('relations', this.provider.name)
  }

  /** Not implemented in M1 — reserved for M3 Mnemon adapter (R1). */
  graphQuery(query: unknown): never {
    return this.provider.graphQuery(query)
  }

  /** Not implemented in M1 — reserved for M2 consolidation (R1). */
  consolidate(): never {
    throw new NotSupportedError('consolidation', this.provider.name)
  }

  private emitChanged(kind: MemoryChangedEvent['type'] | null, outcome: UpsertOutcome): void {
    if (!kind) return
    const memory = this.provider.get(outcome.id)
    if (!memory) return
    this.ctx.emit('memory/changed', { type: kind, memory })
  }
}
