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

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SQLiteLocalProvider } from '../provider/sqlite/local-provider.ts'
import { STATE_LAST_EXPORT_SEQ } from '../provider/sqlite/local-provider.ts'
import { DSH_WRITTEN_MARK } from './paths.ts'

export const DEFAULT_EXPORT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000

/** Export thresholds. */
export interface ExportConfig {
  /** Core memories need importance ≥ this. */
  exportMinImportance: number
  /** Core memories confirmed within this window also export. */
  exportRecentWindowMs: number
}

export const DEFAULT_EXPORT_CONFIG: ExportConfig = {
  exportMinImportance: 2,
  exportRecentWindowMs: DEFAULT_EXPORT_RECENT_WINDOW_MS,
}

/** One JSONL row as written (gotchas line shape). */
export interface JsonlRow {
  id: string
  content_hash: string
  ts: number
  action: 'upsert' | 'archive'
  content?: string
  importance?: number
  sourceRef?: string | null
  scope?: string
  /** Owning session (only for scope=session rows; P1 isolation). */
  session_id?: string | null
}

/** Result of one export pass. */
export interface ExportResult {
  appended: number
  jsonlPath: string
}

/** Read the current JSONL line count (cheap for append-only semantics). */
export async function jsonlLineCount(path: string): Promise<number> {
  try {
    const text = await readFile(path, 'utf8')
    if (text.length === 0) return 0
    return text.split('\n').filter(line => line.trim().length > 0).length
  } catch {
    return 0
  }
}

/**
 * Append one JSONL row (never rewriting history). Failure propagates to the
 * caller, which applies the permission fallback.
 */
export async function appendJsonlRow(path: string, row: JsonlRow): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(row)}\n`, 'utf8')
}

/**
 * Export pass: append `upsert` rows for core memories not yet exported, and
 * `archive` rows for memories archived since their last upsert. Idempotent:
 * re-running with no changes appends nothing.
 */
export async function exportCoreMemories(
  provider: SQLiteLocalProvider,
  jsonlPath: string,
  config: ExportConfig = DEFAULT_EXPORT_CONFIG,
): Promise<ExportResult> {
  const now = Date.now()
  const seq = Number(provider.getState(STATE_LAST_EXPORT_SEQ) ?? '0')
  const currentLines = await jsonlLineCount(jsonlPath)
  // Trust the file when it is longer than our pointer (e.g. first run on an
  // existing file); never trust a pointer beyond the file.
  const baseSeq = Math.min(seq, currentLines)

  const core = provider.listByStatus('active').filter(m =>
    m.importance >= config.exportMinImportance
    || now - m.lastConfirmedAt <= config.exportRecentWindowMs,
  )

  let appended = 0
  for (const memory of core) {
    const exported = provider.bridgeGetExported(memory.id)
    if (exported === 'archive') {
      // Was archived then restored and still core → re-upsert.
      await appendJsonlRow(jsonlPath, {
        id: memory.id,
        content_hash: memory.contentHash,
        ts: now,
        action: 'upsert',
        content: memory.content,
        importance: memory.importance,
        sourceRef: memory.sourceRef,
        scope: memory.scope,
        session_id: memory.sessionId,
      })
      provider.bridgeMarkExported(memory.id, 'upsert')
      appended += 1
    } else if (exported === null) {
      await appendJsonlRow(jsonlPath, {
        id: memory.id,
        content_hash: memory.contentHash,
        ts: now,
        action: 'upsert',
        content: memory.content,
        importance: memory.importance,
        sourceRef: memory.sourceRef,
        scope: memory.scope,
        session_id: memory.sessionId,
      })
      provider.bridgeMarkExported(memory.id, 'upsert')
      appended += 1
    }
    // exported === 'upsert' → already on the file, skip.
  }

  provider.setState(STATE_LAST_EXPORT_SEQ, String(baseSeq + appended))
  return { appended, jsonlPath }
}

/**
 * Append an `archive` row for a memory that was previously exported
 * (终审注意点 5: no orphan rows for never-exported memories).
 */
export async function appendArchiveRow(
  provider: SQLiteLocalProvider,
  jsonlPath: string,
  memory: { id: string; contentHash: string },
): Promise<boolean> {
  const exported = provider.bridgeGetExported(memory.id)
  if (exported !== 'upsert') return false
  await appendJsonlRow(jsonlPath, {
    id: memory.id,
    content_hash: memory.contentHash,
    ts: Date.now(),
    action: 'archive',
  })
  provider.bridgeMarkExported(memory.id, 'archive')
  const seq = Number(provider.getState(STATE_LAST_EXPORT_SEQ) ?? '0')
  provider.setState(STATE_LAST_EXPORT_SEQ, String(seq + 1))
  return true
}

/** Human marker used on MEMORY.md rows (re-exported here to keep one source). */
export function dshWrittenMark(): string {
  return DSH_WRITTEN_MARK
}
