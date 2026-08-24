/**
 * Memory service definition — `ctx.memory` (design doc §3/§4, D1/D4).
 *
 * A cordis Service exposing cognitive-vocabulary primitives
 * (remember/link/recall/reinforce/decay/archive/restore/consolidate) over the
 * injected provider. Unimplemented primitives throw NotSupportedError.
 * @module dsh-memory/service
 */
import type { Context } from '@deepseek-ai/cordis';
import { Service } from '@deepseek-ai/cordis';
import type { MemoryCapability } from './capabilities.ts';
import type { Memory, MemoryCandidate, MemoryChangedEvent, MemoryQuery, RecallResult, UpsertOutcome } from './types.ts';
import { type IMemoryProvider } from '../provider/types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** The memory service (provided by the dsh-memory plugin). */
        memory: MemoryService;
    }
    interface Events {
        /** Fired after every memory write/archive/restore (payload: MemoryChangedEvent). */
        'memory/changed'(event: MemoryChangedEvent): void;
    }
}
/**
 * The `ctx.memory` service. Construction registers the service on the
 * context immediately; unloading the owning fiber unregisters it.
 */
export declare class MemoryService extends Service {
    private readonly provider;
    static provide: string;
    constructor(ctx: Context, provider: IMemoryProvider);
    /** Provider name (diagnostics). */
    get providerName(): string;
    /** Capability tiers in canonical order (ADR D2). */
    capabilities(): MemoryCapability[];
    /** Whether the provider implements a given tier. */
    hasCapability(capability: MemoryCapability): boolean;
    /** Write or reinforce one memory (idempotent via content_hash, D12). */
    remember(candidate: MemoryCandidate): UpsertOutcome;
    /** Three-tier recall with scope filtering and token capping. */
    recall(query: MemoryQuery): RecallResult;
    /** Explicitly archive a memory (M1 has no automatic archiving). */
    archive(id: string, reason?: string): Memory | null;
    /** Restore an archived memory (reinforce count preserved). */
    restore(id: string): Memory | null;
    /** Run the TTL decay scan. Returns the number of memories decayed. */
    decay(): number;
    /** Get one memory by id. */
    get(id: string): Memory | null;
    /** Subscribe to `memory/changed` (returns the disposer). */
    onChanged(listener: (event: MemoryChangedEvent) => void): () => void;
    /** Not implemented in M1 — reserved for M3 Mnemon adapter (R1). */
    link(_from: string, _to: string, _relation: string): never;
    /** Not implemented in M1 — reserved for M3 Mnemon adapter (R1). */
    graphQuery(query: unknown): never;
    /** Not implemented in M1 — reserved for M2 consolidation (R1). */
    consolidate(): never;
    private emitChanged;
}
//# sourceMappingURL=memory-service.d.ts.map