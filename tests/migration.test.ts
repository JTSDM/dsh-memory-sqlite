/**
 * Schema migration tests (regression for the v1→v2 crash: CREATE INDEX on
 * session_id ran before ALTER TABLE ADD COLUMN).
 *
 * Builds a REAL v1 database (no session_id column), then opens it through
 * SQLiteLocalProvider and asserts the provider survives, the column exists,
 * and user_version advanced to 2.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQLiteLocalProvider } from '../src/provider/sqlite/local-provider.ts'

const { DatabaseSync } = await import('node:sqlite')

function createV1Database(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-migrate-'))
  const path = join(dir, 'memory.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      importance INTEGER NOT NULL DEFAULT 1,
      type TEXT NOT NULL DEFAULT 'world',
      scope TEXT NOT NULL DEFAULT 'session',
      status TEXT NOT NULL DEFAULT 'active',
      reinforce_count INTEGER NOT NULL DEFAULT 0,
      ttl_ms INTEGER,
      last_confirmed_at INTEGER NOT NULL,
      source_ref TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO memories (id, content, content_hash, importance, type, scope, status, reinforce_count, ttl_ms, last_confirmed_at, source_ref, created_at, updated_at)
    VALUES ('v1-1', '旧库记忆', 'abc123', 1, 'world', 'session', 'active', 0, NULL, 1, NULL, 1, 1);
    PRAGMA user_version = 1;
  `)
  db.close()
  return path
}

describe('schema migration v1 → v2', () => {
  it('opens a v1 database without crashing and migrates session_id', () => {
    const path = createV1Database()
    try {
      const provider = new SQLiteLocalProvider(path)
      // v1 row survived and is readable.
      const memory = provider.get('v1-1')
      expect(memory?.content).toBe('旧库记忆')
      expect(memory?.sessionId).toBeNull() // migrated column defaults to NULL
      // Migration artifacts present.
      const db = (provider as unknown as { db: { prepare(s: string): { all(...a: unknown[]): unknown } } }).db
      const cols = db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
      expect(cols.some(c => c.name === 'session_id')).toBe(true)
      const version = db.prepare('PRAGMA user_version').all() as unknown as { user_version: number }[]
      expect(version[0]?.user_version).toBe(2)
      // New writes carry session_id.
      provider.upsert({ content: '迁移后新写', scope: 'session', sessionId: 'sess-NEW' })
      expect(provider.recall({ scopes: ['session'], sessionId: 'sess-NEW' }).core.length).toBe(1)
      provider.close()
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })

  it('re-opening a migrated database is a no-op (idempotent)', () => {
    const path = createV1Database()
    try {
      new SQLiteLocalProvider(path).close()
      const again = new SQLiteLocalProvider(path)
      const memory = again.get('v1-1')
      expect(memory?.content).toBe('旧库记忆')
      again.close()
    } finally {
      rmSync(join(path, '..'), { recursive: true, force: true })
    }
  })
})
