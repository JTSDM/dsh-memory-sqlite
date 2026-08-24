/**
 * Content normalization + idempotency hashing (D12).
 *
 * `content_hash` = SHA-256 of the NORMALIZED content. Normalization is
 * deliberately conservative: trim, Unicode NFKC, collapse whitespace runs —
 * enough to dedup "the same fact" across whitespace/width variants without
 * distorting the stored text (recall shows the original wording).
 * @module dsh-memory/provider/sqlite/normalize
 */
/** Normalize content for hashing and storage. */
export declare function normalizeContent(content: string): string;
/** SHA-256 of the normalized content — the idempotent dedup key (D12). */
export declare function contentHash(content: string): string;
//# sourceMappingURL=normalize.d.ts.map