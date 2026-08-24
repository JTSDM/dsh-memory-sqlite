/**
 * Importer (plan §2-Step6, P1-1 resolution).
 *
 * JSONL is the ONLY authoritative import source: rows after `last_import_seq`
 * are upserted (content_hash idempotency) or applied as archive state
 * transitions. MEMORY.md is a one-way view and does NOT participate in
 * regular import. The single exception: when SQLite is empty AND the sentinel
 * block already carries DSH-written entries (first adoption of an existing
 * workspace), a STRICT one-time migration parses exactly the
 * `> 本条记录由 DSH 写入` marked lines — anything unparseable is skipped with a
 * warning, never guessed.
 * @module dsh-memory/bridge/importer
 */
import type { SQLiteLocalProvider } from '../provider/sqlite/local-provider.ts';
/** Result of one import pass. */
export interface ImportResult {
    imported: number;
    archived: number;
    migrated: number;
}
/**
 * Import JSONL rows after the import pointer. Upsert rows merge idempotently
 * (P1-2 table); archive rows sync SQLite state (双向一致, P0-2).
 */
export declare function importJsonl(provider: SQLiteLocalProvider, jsonlText: string): Promise<ImportResult>;
/**
 * One-time strict migration from an existing MEMORY.md sentinel block.
 * Runs ONLY when SQLite is empty; parses DSH-written entry BLOCKS (a `- `
 * line plus its continuation lines until the next `- ` or the block end);
 * anything unparseable is skipped with a warning — never guessed.
 */
export declare function migrateSentinelOnce(provider: SQLiteLocalProvider, mdText: string, warn: (message: string) => void): Promise<number>;
/** Read a file that may not exist yet (empty string when absent). */
export declare function readMaybe(path: string): Promise<string>;
//# sourceMappingURL=importer.d.ts.map