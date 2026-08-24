/**
 * Memory service definition — `ctx.memory` (design doc §3/§4, D1/D4).
 *
 * A cordis Service exposing cognitive-vocabulary primitives
 * (remember/link/recall/reinforce/decay/archive/restore/consolidate) over the
 * injected provider. Unimplemented primitives throw NotSupportedError.
 * @module dsh-memory/service
 */
import { Service } from '@deepseek-ai/cordis';
import { rankCapabilities } from "./capabilities.js";
import { NotSupportedError } from "../provider/types.js";
/**
 * The `ctx.memory` service. Construction registers the service on the
 * context immediately; unloading the owning fiber unregisters it.
 */
export class MemoryService extends Service {
    provider;
    static provide = 'memory';
    constructor(ctx, provider) {
        super(ctx, 'memory');
        this.provider = provider;
    }
    /** Provider name (diagnostics). */
    get providerName() {
        return this.provider.name;
    }
    /** Capability tiers in canonical order (ADR D2). */
    capabilities() {
        return rankCapabilities(this.provider.capabilities());
    }
    /** Whether the provider implements a given tier. */
    hasCapability(capability) {
        return this.provider.capabilities().has(capability);
    }
    /** Write or reinforce one memory (idempotent via content_hash, D12). */
    remember(candidate) {
        const outcome = this.provider.upsert(candidate);
        this.emitChanged(outcome.changeKind, outcome);
        return outcome;
    }
    /** Three-tier recall with scope filtering and token capping. */
    recall(query) {
        return this.provider.recall(query);
    }
    /** Explicitly archive a memory (M1 has no automatic archiving). */
    archive(id, reason) {
        const memory = this.provider.archive(id, reason);
        if (memory)
            this.ctx.emit('memory/changed', { type: 'archive', memory });
        return memory;
    }
    /** Restore an archived memory (reinforce count preserved). */
    restore(id) {
        const memory = this.provider.restore(id);
        if (memory)
            this.ctx.emit('memory/changed', { type: 'restore', memory });
        return memory;
    }
    /** Run the TTL decay scan. Returns the number of memories decayed. */
    decay() {
        return this.provider.decay();
    }
    /** Get one memory by id. */
    get(id) {
        return this.provider.get(id);
    }
    /** Subscribe to `memory/changed` (returns the disposer). */
    onChanged(listener) {
        return this.ctx.on('memory/changed', listener);
    }
    /** Not implemented in M1 — reserved for M3 Mnemon adapter (R1). */
    link(_from, _to, _relation) {
        throw new NotSupportedError('relations', this.provider.name);
    }
    /** Not implemented in M1 — reserved for M3 Mnemon adapter (R1). */
    graphQuery(query) {
        return this.provider.graphQuery(query);
    }
    /** Not implemented in M1 — reserved for M2 consolidation (R1). */
    consolidate() {
        throw new NotSupportedError('consolidation', this.provider.name);
    }
    emitChanged(kind, outcome) {
        if (!kind)
            return;
        const memory = this.provider.get(outcome.id);
        if (!memory)
            return;
        this.ctx.emit('memory/changed', { type: kind, memory });
    }
}
//# sourceMappingURL=memory-service.js.map