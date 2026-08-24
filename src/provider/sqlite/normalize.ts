/**
 * Content normalization + idempotency hashing (D12).
 *
 * `content_hash` = SHA-256 of the NORMALIZED content. Normalization is
 * deliberately conservative: trim, Unicode NFKC, collapse whitespace runs —
 * enough to dedup "the same fact" across whitespace/width variants without
 * distorting the stored text (recall shows the original wording).
 * @module dsh-memory/provider/sqlite/normalize
 */

import { createHash } from 'node:crypto'

/** Normalize content for hashing and storage. */
export function normalizeContent(content: string): string {
  return content.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

/** SHA-256 of the normalized content — the idempotent dedup key (D12). */
export function contentHash(content: string): string {
  return createHash('sha256').update(normalizeContent(content)).digest('hex')
}
