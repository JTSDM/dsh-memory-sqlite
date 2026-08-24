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
import type { MemoryCapability } from '../../service/capabilities.ts';
import type { Memory, MemoryCandidate, MemoryQuery, MemoryStatus, RecallResult, UpsertOutcome } from '../../service/types.ts';
import { type IMemoryProvider } from '../types.ts';
/** engine_state key: reinforcement events since the last reflect check. */
export declare const STATE_REINFORCE_DELTA = "pending_reinforce_delta";
/** engine_state key: last reflect gate evaluation (epoch ms). */
export declare const STATE_LAST_REFLECT = "last_reflect_at";
/** engine_state key: JSONL export sequence pointer. */
export declare const STATE_LAST_EXPORT_SEQ = "last_export_seq";
/** engine_state key: JSONL import sequence pointer. */
export declare const STATE_LAST_IMPORT_SEQ = "last_import_seq";
/** engine_state key: MEMORY.md render sequence pointer. */
export declare const STATE_LAST_RENDER_SEQ = "last_render_seq";
/** engine_state key: file-bridge status ('ok' | 'degraded' | 'disabled'). */
export declare const STATE_BRIDGE_STATUS = "bridge_status";
/** Default reinforcement window: same hash within 1h 鈫?reinforceCount++ (gotchas #3). */
export declare const DEFAULT_REINFORCE_WINDOW_MS: number;
/** Default TTL: memories expire to dormant after 90 days without confirmation. */
export declare const DEFAULT_TTL_MS: number;
/**
 * SQLite-backed provider. One DatabaseSync connection; WAL mode; FTS5 synced
 * by triggers. Synchronous by the M1 performance decision (see module docs).
 */
export declare class SQLiteLocalProvider implements IMemoryProvider {
    readonly name = "sqlite";
    private readonly db;
    private readonly reinforceWindowMs;
    constructor(dbPath: string, reinforceWindowMs?: number);
    private open;
    capabilities(): Set<MemoryCapability>;
    /** Write or reinforce per the P1-2 state-transition table. */
    upsert(candidate: MemoryCandidate): UpsertOutcome;
    /** P1-3: every reinforcement event atomically bumps the reflect delta. */
    private bumpDelta;
    recall(query: MemoryQuery): RecallResult;
    decay(): number;
    archive(id: string, reason?: string): Memory | null;
    restore(id: string): Memory | null;
    get(id: string): Memory | null;
    findByHash(contentHashValue: string): Memory | null;
    listByStatus(status: MemoryStatus): Memory[];
    graphQuery(_query: unknown): never;
    getState(key: string): string | null;
    setState(key: string, value: string): void;
    /** Reset the reflect delta (called by the gate after a pass). */
    resetReinforceDelta(): void;
    /** Current pending reflect delta. */
    getReinforceDelta(): number;
    /** Durable queue row. */
    outboxEnqueue(sessionId: string, payload: string | null): string;
    /**
     * Claim the next processable row: pending rows first, then failed rows under
     * the retry cap, then stale `processing` rows (crash recovery, 5 min).
     * Marks the row `processing`.
     */
    outboxClaim(maxAttempts: number): OutboxRow | null;
    outboxComplete(id: string): void;
    outboxFail(id: string, error: unknown, maxAttempts: number): void;
    outboxCount(status: OutboxStatus | 'pending'): number;
    /** Whether a session already has an unfinished outbox row (dedup enqueue). */
    outboxHasActive(sessionId: string): boolean;
    /** Record that a memory reached the JSONL with the given last action. */
    bridgeMarkExported(id: string, lastAction: 'upsert' | 'archive'): void;
    /** Last JSONL action for a memory, or null when never exported. */
    bridgeGetExported(id: string): 'upsert' | 'archive' | null;
    close(): void;
}
/** Outbox row shape. */
export interface OutboxRow {
    id: string;
    sessionId: string;
    payload: string | null;
    status: OutboxStatus;
    createdAt: number;
    updatedAt: number;
    attempts: number;
    lastError: string | null;
}
/** Outbox lifecycle status. */
export type OutboxStatus = 'pending' | 'processing' | 'done' | 'failed';
//# sourceMappingURL=local-provider.d.ts.map