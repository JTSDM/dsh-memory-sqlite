/**
 * Provider seam for the memory service (ADR D4 + plan v2.1).
 *
 * `IMemoryProvider` is the interface every storage backend implements
 * (SQLite LocalProvider now; Mnemon/Mem0 later). Unimplemented primitives
 * throw {@link NotSupportedError} — never silently return empty (R1).
 *
 * M1 is synchronous by decision (P0-1: measured 5.5µs/write on 10k rows), so
 * the interface is synchronous. A future async provider can adapt.
 * @module dsh-memory/provider/types
 */

import type { MemoryCapability } from '../service/capabilities.ts'
import type {
  Memory,
  MemoryCandidate,
  MemoryQuery,
  MemoryStatus,
  RecallResult,
  UpsertOutcome,
} from '../service/types.ts'

/** Thrown by declared-but-unimplemented primitives (R1, 终审注意点 2). */
export class NotSupportedError extends Error {
  readonly capability: MemoryCapability
  readonly provider: string

  constructor(capability: MemoryCapability, provider: string) {
    super(`memory capability '${capability}' is not implemented by provider '${provider}'`)
    this.name = 'NotSupportedError'
    this.capability = capability
    this.provider = provider
  }
}

/**
 * The storage contract behind `ctx.memory`. Implementations must honor the
 * P1-2 state-transition table (see plan §2-Step3): content_hash dedup,
 * reinforcement window, dormant/archived recovery.
 */
export interface IMemoryProvider {
  readonly name: string
  /** Self-declared capability tiers (ADR D2). */
  capabilities(): Set<MemoryCapability>
  /** Write or reinforce one candidate per the state-transition table. */
  upsert(candidate: MemoryCandidate): UpsertOutcome
  /** Three-tier recall with scope filtering and token capping. */
  recall(query: MemoryQuery): RecallResult
  /** Decay scan: active entries past TTL → dormant. Returns count decayed. */
  decay(): number
  /** Explicit archive (M1: no automatic archiving — plan 终审注意点 4). */
  archive(id: string, reason?: string): Memory | null
  /** Restore an archived memory to active (reinforce count preserved). */
  restore(id: string): Memory | null
  get(id: string): Memory | null
  /**
   * Reserved graph traversal (M3 Mnemon adapter). Throws NotSupportedError
   * on every provider until implemented.
   */
  graphQuery(_query: unknown): never
  /** Close the underlying store. */
  close(): void
  /** Internal state key read (engine_state). */
  getState(key: string): string | null
  /** Internal state key write (engine_state). */
  setState(key: string, value: string): void
  /** Look up a memory by its content hash (dedup support). */
  findByHash(contentHash: string): Memory | null
  /** List memories in one status (engine scans). */
  listByStatus(status: MemoryStatus): Memory[]
}
