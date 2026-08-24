/**
 * JSONL exporter (plan §2-Step6, design §12 D10).
 *
 * Append-only DSH-side exchange truth: `dsh_sync.jsonl` under
 * `.workbuddy/memory/`. Lines are self-contained:
 * `{id, content_hash, ts, action, content, importance, sourceRef, scope}`.
 *
 * Action enum: `upsert` | `archive` (P0-2). Archive rows are appended ONLY
 * for memories previously upserted (终审注意点 5, `bridge_exported` table) —
 * no orphan state rows. Rows are never rewritten; `last_export_seq`
 * (engine_state) tracks the append pointer.
 * @module dsh-memory/bridge/exporter
 */
import type { SQLiteLocalProvider } from '../provider/sqlite/local-provider.ts';
export declare const DEFAULT_EXPORT_RECENT_WINDOW_MS: number;
/** Export thresholds. */
export interface ExportConfig {
    /** Core memories need importance ≥ this. */
    exportMinImportance: number;
    /** Core memories confirmed within this window also export. */
    exportRecentWindowMs: number;
}
export declare const DEFAULT_EXPORT_CONFIG: ExportConfig;
/** One JSONL row as written (gotchas line shape). */
export interface JsonlRow {
    id: string;
    content_hash: string;
    ts: number;
    action: 'upsert' | 'archive';
    content?: string;
    importance?: number;
    sourceRef?: string | null;
    scope?: string;
    /** Owning session (only for scope=session rows; P1 isolation). */
    session_id?: string | null;
}
/** Result of one export pass. */
export interface ExportResult {
    appended: number;
    jsonlPath: string;
}
/** Read the current JSONL line count (cheap for append-only semantics). */
export declare function jsonlLineCount(path: string): Promise<number>;
/**
 * Append one JSONL row (never rewriting history). Failure propagates to the
 * caller, which applies the permission fallback.
 */
export declare function appendJsonlRow(path: string, row: JsonlRow): Promise<void>;
/**
 * Export pass: append `upsert` rows for core memories not yet exported, and
 * `archive` rows for memories archived since their last upsert. Idempotent:
 * re-running with no changes appends nothing.
 */
export declare function exportCoreMemories(provider: SQLiteLocalProvider, jsonlPath: string, config?: ExportConfig): Promise<ExportResult>;
/**
 * Append an `archive` row for a memory that was previously exported
 * (终审注意点 5: no orphan rows for never-exported memories).
 */
export declare function appendArchiveRow(provider: SQLiteLocalProvider, jsonlPath: string, memory: {
    id: string;
    contentHash: string;
}): Promise<boolean>;
/** Human marker used on MEMORY.md rows (re-exported here to keep one source). */
export declare function dshWrittenMark(): string;
//# sourceMappingURL=exporter.d.ts.map