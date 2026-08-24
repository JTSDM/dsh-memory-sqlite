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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { STATE_LAST_RENDER_SEQ } from "../provider/sqlite/local-provider.js";
import { DSH_MEMORY_END, DSH_MEMORY_START, DSH_WRITTEN_MARK } from "./paths.js";
/** Render one JSONL row as a Markdown entry (upsert or archive marker). */
export function renderRowToMarkdown(row) {
    const when = new Date(row.ts).toISOString().slice(0, 10);
    if (row.action === 'archive') {
        return `- ~~已归档~~ ${row.content_hash.slice(0, 12)} (id ${row.id}) · ${when}`;
    }
    return `- ${row.content}  \n  ${DSH_WRITTEN_MARK} · importance ${row.importance ?? 1} · ${when}`;
}
/**
 * Split MEMORY.md into { before, inside, after } around the sentinel block.
 * A missing block returns inside = null (caller decides how to create it).
 */
export function splitSentinel(text) {
    const startIdx = text.indexOf(DSH_MEMORY_START);
    const endIdx = text.indexOf(DSH_MEMORY_END);
    if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
        return { before: text, inside: null, after: '' };
    }
    return {
        before: text.slice(0, startIdx + DSH_MEMORY_START.length),
        inside: text.slice(startIdx + DSH_MEMORY_START.length, endIdx),
        after: text.slice(endIdx),
    };
}
/** Ensure the sentinel block exists; creates it at the file end when missing. */
export function ensureSentinel(text) {
    const split = splitSentinel(text);
    if (split.inside !== null)
        return text;
    const trimmed = split.before.replace(/\s+$/, '');
    return `${trimmed}\n\n${DSH_MEMORY_START}\n${DSH_MEMORY_END}\n`;
}
/** Append rendered rows before the END marker (incremental, never a redraw). */
export function appendToSentinel(text, entries) {
    const split = splitSentinel(text);
    if (split.inside === null) {
        // Fallback: no sentinel (should not happen after ensureSentinel) — build one.
        return ensureSentinel(text) + entries.map(e => `${e}\n`).join('');
    }
    const body = split.inside.replace(/\s+$/, '');
    const addition = entries.map(e => `\n${e}`).join('');
    return `${split.before}${body}${addition}\n${split.after}`;
}
/** Parse JSONL text into rows, skipping malformed lines (never throw). */
export function parseJsonl(text) {
    const rows = [];
    for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        try {
            const row = JSON.parse(trimmed);
            if (row && typeof row.id === 'string' && (row.action === 'upsert' || row.action === 'archive')) {
                rows.push(row);
            }
        }
        catch {
            // malformed line: skip, keep append-only integrity
        }
    }
    return rows;
}
/**
 * Incremental render pass: read JSONL rows after `lastRenderSeq`, append them
 * to the sentinel block, advance the pointer. Returns the number of entries
 * rendered.
 */
export async function renderIncremental(provider, mdPath, jsonlText) {
    const rows = parseJsonl(jsonlText);
    const seq = Number(provider.getState(STATE_LAST_RENDER_SEQ) ?? '0');
    if (rows.length <= seq)
        return 0;
    const fresh = rows.slice(seq);
    const entries = fresh.map(renderRowToMarkdown);
    let md = '';
    try {
        md = await readFile(mdPath, 'utf8');
    }
    catch {
        md = '';
    }
    md = ensureSentinel(md);
    md = appendToSentinel(md, entries);
    await mkdir(dirname(mdPath), { recursive: true });
    await writeFile(mdPath, md, 'utf8');
    provider.setState(STATE_LAST_RENDER_SEQ, String(rows.length));
    return entries.length;
}
//# sourceMappingURL=renderer.js.map