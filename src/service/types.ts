/**
 * Core memory domain vocabulary: the memory atom, queries, recall output, and
 * the change-event contract (design doc §5 + plan v2.1).
 * @module dsh-memory/service/types
 */

import type { MemoryCapability } from './capabilities.ts'

/** Storage scope, aligned with mnemon storage scope and LivingMemory scopes. */
export type MemoryScope = 'session' | 'user' | 'global'

/** Hindsight three-tier cognitive classification. */
export type MemoryType = 'world' | 'experience' | 'mental_model'

/**
 * Persisted memory state. `restored` is an EVENT name (see
 * {@link MemoryChangeKind}), never a persisted status — plan v2.1 终审注意点 2.
 */
export type MemoryStatus = 'active' | 'dormant' | 'archived'

/** Change/action vocabulary emitted through `memory/changed`. */
export type MemoryChangeKind = 'upsert' | 'archive' | 'restore'

/** One memory atom (design doc §5 atomic attributes). */
export interface Memory {
  /** Stable unique id. */
  id: string
  /** Human-readable content (normalized for hashing). */
  content: string
  /** SHA-256 of the normalized content — idempotent dedup key (D12). */
  contentHash: string
  /** 1-3 importance level. */
  importance: 1 | 2 | 3
  type: MemoryType
  scope: MemoryScope
  /**
   * Owning session id — set ONLY for `scope=session` memories; null otherwise
   * (P1 scope-isolation: session memories visible only to their own session).
   */
  sessionId: string | null
  status: MemoryStatus
  /** Reinforcement count: same fact re-confirmed → +1 (within window). */
  reinforceCount: number
  /** Time-to-live in ms; null = no expiry. */
  ttlMs: number | null
  /** Last confirmation instant (epoch ms). */
  lastConfirmedAt: number
  /** Source session/message id for verification and re-summarization. */
  sourceRef: string | null
  /** Epoch ms created. */
  createdAt: number
  /** Epoch ms last mutated. */
  updatedAt: number
}

/** Input for a remember/write request. */
export interface MemoryCandidate {
  content: string
  /** Explicit importance overrides; implicit default never overwrites (P1-2). */
  importance?: 1 | 2 | 3
  type?: MemoryType
  scope?: MemoryScope
  /**
   * Owning session id. Stored only when scope=session (isolation, P1);
   * ignored for user/global scopes.
   */
  sessionId?: string
  sourceRef?: string
}

/** Input for a recall request. */
export interface MemoryQuery {
  /** Keyword text (FTS5 match + LIKE substring fallback; M1 has no semantic retrieval). */
  text?: string
  /**
   * Scope filter. When omitted: session + user (global governed by config).
   * Results are weighted by scope priority (session > user > global).
   * `scope=session` memories additionally require {@link sessionId} to match
   * their owner (cross-session isolation, P1).
   */
  scopes?: MemoryScope[]
  types?: MemoryType[]
  /** Include archived memories in `divergent`. */
  includeArchive?: boolean
  /** Max items per tier before token capping. */
  limit?: number
  /** Approximate token budget cap (chars/4). */
  maxTokens?: number
  /** Only memories confirmed after this epoch ms. */
  sinceMs?: number
  /**
   * Caller's session id. Required to see `scope=session` memories; when
   * absent, session-scoped memories are NEVER returned (conservative
   * isolation — no cross-session leakage).
   */
  sessionId?: string
}

/** One recall hit with its score and optional file-bridge reference. */
export interface RecallItem {
  memory: Memory
  /** Retrieval score (FTS rank / importance weighting). */
  score: number
  /** JSONL line / MEMORY.md location when the file bridge is active. */
  fileRef?: string | null
}

/**
 * Three-tier recall output (Plastic Promise context_supply + Hindsight fusion,
 * red-team capped): `core` hits, `related` same-scope/type neighbors,
 * `divergent` archived or conflicting history. `truncated` reports token capping.
 */
export interface RecallResult {
  core: RecallItem[]
  related: RecallItem[]
  divergent: RecallItem[]
  truncated: boolean
  /** Capabilities the provider actually used for this recall. */
  capabilities: MemoryCapability[]
}

/** Payload of the `memory/changed` service event (plan v2 其他2). */
export interface MemoryChangedEvent {
  type: MemoryChangeKind
  memory: Memory
}

/** Result of one upsert/reinforce write (idempotency contract, P1-2). */
export interface UpsertOutcome {
  id: string
  contentHash: string
  /** True when the hash already existed (dedup path, not a new row). */
  deduped: boolean
  /** True when this write counted as a reinforcement event (delta +1). */
  reinforced: boolean
  reinforceCount: number
  status: MemoryStatus
  /** Change event emitted for this write, if any. */
  changeKind: MemoryChangeKind | null
  /** Epoch ms of the write. */
  storedAt: number
}
