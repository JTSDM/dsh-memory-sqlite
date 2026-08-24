/**
 * MEMORY.md sentinel renderer (plan §2-Step6, design §12 D10/D11).
 *
 * One-way view: DSH entries are appended INSIDE the sentinel block
 * (`<!-- DSH_MEMORY_START --> … <!-- DSH_MEMORY_END -->`); everything outside
 * is user/WorkBuddy territory and is NEVER rewritten. Incremental only
 * (`lastRenderSeq`): each pass renders the JSONL rows after the pointer and
 * appends them before the END marker — never a full redraw (red-team #2).
 * Full compression + JSONL rotation belong to M2 consolidation.
 *
 * Archive rows render as a strikethrough marker line; removing archived
 * entries from the block is M2 compression's job (append-only red line).
 * @module dsh-memory/bridge/renderer
 */
import type { SQLiteLocalProvider } from '../provider/sqlite/local-provider.ts';
import type { JsonlRow } from './exporter.ts';
/** Render one JSONL row as a Markdown entry (upsert or archive marker). */
export declare function renderRowToMarkdown(row: JsonlRow): string;
/**
 * Split MEMORY.md into { before, inside, after } around the sentinel block.
 * A missing block returns inside = null (caller decides how to create it).
 */
export declare function splitSentinel(text: string): {
    before: string;
    inside: string | null;
    after: string;
};
/** Ensure the sentinel block exists; creates it at the file end when missing. */
export declare function ensureSentinel(text: string): string;
/** Append rendered rows before the END marker (incremental, never a redraw). */
export declare function appendToSentinel(text: string, entries: string[]): string;
/** Parse JSONL text into rows, skipping malformed lines (never throw). */
export declare function parseJsonl(text: string): JsonlRow[];
/**
 * Incremental render pass: read JSONL rows after `lastRenderSeq`, append them
 * to the sentinel block, advance the pointer. Returns the number of entries
 * rendered.
 */
export declare function renderIncremental(provider: SQLiteLocalProvider, mdPath: string, jsonlText: string): Promise<number>;
//# sourceMappingURL=renderer.d.ts.map