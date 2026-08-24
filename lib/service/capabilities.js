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
export const MemoryCapabilities = [
    'kv',
    'ttl',
    'relations',
    'graphQuery',
    'vector',
    'consolidation',
];
/** Stable tier ordering: lower rank = more basic. */
export const CAPABILITY_RANK = {
    kv: 0,
    ttl: 1,
    relations: 2,
    graphQuery: 3,
    vector: 4,
    consolidation: 5,
};
/**
 * Sort a provider's capability set into canonical tier order (deduplicated).
 * @param caps - provider-declared capabilities.
 * @returns capabilities in ascending tier rank.
 */
export function rankCapabilities(caps) {
    return [...new Set(caps)].sort((a, b) => CAPABILITY_RANK[a] - CAPABILITY_RANK[b]);
}
//# sourceMappingURL=capabilities.js.map