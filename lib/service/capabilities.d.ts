/**
 * Capability tiers for the memory service (ADR D2).
 *
 * Providers self-declare the capabilities they implement; the protocol only
 * defines the minimal intersection (`kv`) plus optional tiers. Consumers
 * negotiate through {@link rankCapabilities} instead of assuming the richest
 * provider.
 *
 * Tiers:  kv → ttl → relations → graphQuery → vector → consolidation.
 * `graphQuery` is a reserved placeholder (M3 Mnemon adapter avoids refactor);
 * `vector` and `consolidation` are reserved for M2/M3.
 * @module dsh-memory/service/capabilities
 */
export declare const MemoryCapabilities: readonly ["kv", "ttl", "relations", "graphQuery", "vector", "consolidation"];
/** One capability tier a memory provider can implement. */
export type MemoryCapability = (typeof MemoryCapabilities)[number];
/** Stable tier ordering: lower rank = more basic. */
export declare const CAPABILITY_RANK: Record<MemoryCapability, number>;
/**
 * Sort a provider's capability set into canonical tier order (deduplicated).
 * @param caps - provider-declared capabilities.
 * @returns capabilities in ascending tier rank.
 */
export declare function rankCapabilities(caps: Iterable<MemoryCapability>): MemoryCapability[];
//# sourceMappingURL=capabilities.d.ts.map