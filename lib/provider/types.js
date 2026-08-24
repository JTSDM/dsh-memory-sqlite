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
/** Thrown by declared-but-unimplemented primitives (R1, 终审注意点 2). */
export class NotSupportedError extends Error {
    capability;
    provider;
    constructor(capability, provider) {
        super(`memory capability '${capability}' is not implemented by provider '${provider}'`);
        this.name = 'NotSupportedError';
        this.capability = capability;
        this.provider = provider;
    }
}
//# sourceMappingURL=types.js.map