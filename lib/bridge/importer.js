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
import { readFile } from 'node:fs/promises';
import { STATE_LAST_IMPORT_SEQ } from "../provider/sqlite/local-provider.js";
import { DSH_WRITTEN_MARK } from "./paths.js";
import { parseJsonl, splitSentinel } from "./renderer.js";
/**
 * Import JSONL rows after the import pointer. Upsert rows merge idempotently
 * (P1-2 table); archive rows sync SQLite state (双向一致, P0-2).
 */
export async function importJsonl(provider, jsonlText) {
    const rows = parseJsonl(jsonlText);
    const seq = Number(provider.getState(STATE_LAST_IMPORT_SEQ) ?? '0');
    if (rows.length <= seq)
        return { imported: 0, archived: 0, migrated: 0 };
    const fresh = rows.slice(seq);
    let imported = 0;
    let archived = 0;
    for (const row of fresh) {
        if (row.action === 'upsert' && row.content) {
            provider.upsert({
                content: row.content,
                importance: (row.importance ?? 1),
                scope: (row.scope ?? 'session'),
                // P1 isolation: session ownership survives the JSONL round-trip.
                sessionId: row.session_id ?? undefined,
                sourceRef: row.sourceRef ?? undefined,
            });
            imported += 1;
        }
        else if (row.action === 'archive') {
            const existing = provider.findByHash(row.content_hash);
            if (existing && existing.status !== 'archived') {
                provider.archive(existing.id, 'jsonl archive row');
                archived += 1;
            }
        }
    }
    provider.setState(STATE_LAST_IMPORT_SEQ, String(rows.length));
    return { imported, archived, migrated: 0 };
}
/**
 * One-time strict migration from an existing MEMORY.md sentinel block.
 * Runs ONLY when SQLite is empty; parses DSH-written entry BLOCKS (a `- `
 * line plus its continuation lines until the next `- ` or the block end);
 * anything unparseable is skipped with a warning — never guessed.
 */
export async function migrateSentinelOnce(provider, mdText, warn) {
    if (provider.listByStatus('active').length > 0 || provider.listByStatus('dormant').length > 0) {
        return 0;
    }
    const split = splitSentinel(mdText);
    if (split.inside === null)
        return 0;
    let migrated = 0;
    const lines = split.inside.split('\n');
    let block = [];
    const flush = () => {
        if (block.length === 0)
            return;
        const joined = block.join(' ');
        if (joined.includes(DSH_WRITTEN_MARK)) {
            const first = block[0]?.trim() ?? '';
            if (first.startsWith('- ')) {
                const content = first.slice(2).trim();
                if (content) {
                    try {
                        provider.upsert({ content, scope: 'user', importance: 1, sourceRef: 'MEMORY.md-migration' });
                        migrated += 1;
                    }
                    catch (error) {
                        warn(`dsh-memory: migration skipped an entry: ${String(error)}`);
                    }
                }
            }
        }
        block = [];
    };
    for (const line of lines) {
        if (line.trimStart().startsWith('- ')) {
            flush();
            block = [line];
        }
        else if (block.length > 0) {
            block.push(line);
        }
    }
    flush();
    return migrated;
}
/** Read a file that may not exist yet (empty string when absent). */
export async function readMaybe(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch {
        return '';
    }
}
//# sourceMappingURL=importer.js.map