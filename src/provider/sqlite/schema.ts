/**
 * SQLite schema for the LocalProvider (design doc §5/§6, plan v2.1).
 *
 * Tables: memories / relations / archive / engine_state / outbox /
 * bridge_exported, plus the FTS5 virtual table synced by triggers
 * (终审注意点 1: triggers only — never application-level sync).
 *
 * Pattern borrowed from @deepseek-ai/dsh-session-query-sqlite:
 * schema_version (user_version) + application_id guard.
 * @module dsh-memory/provider/sqlite/schema
 */

import type { DatabaseSync } from 'node:sqlite'

export const MEMORY_SCHEMA_VERSION = 2
/** 'dshm' — protects unrelated databases from derived resets. */
export const MEMORY_APPLICATION_ID = 0x6473_686d

export function createSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE,
      importance INTEGER NOT NULL DEFAULT 1,
      type TEXT NOT NULL DEFAULT 'world',
      scope TEXT NOT NULL DEFAULT 'session',
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      reinforce_count INTEGER NOT NULL DEFAULT 0,
      ttl_ms INTEGER,
      last_confirmed_at INTEGER NOT NULL,
      source_ref TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memories_scope_status ON memories(scope, status);
    CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance);
    CREATE INDEX IF NOT EXISTS idx_memories_lca ON memories(last_confirmed_at);
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    -- NOTE: idx_memories_session is created AFTER the migration block below —
    -- it references session_id, which v1 databases only gain via ALTER TABLE.

    CREATE TABLE IF NOT EXISTS relations (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL,
      to_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1.0,
      evidence_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_relations_from ON relations(from_id);
    CREATE INDEX IF NOT EXISTS idx_relations_to ON relations(to_id);

    CREATE TABLE IF NOT EXISTS archive (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      archived_at INTEGER NOT NULL,
      reason TEXT,
      snapshot TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_archive_memory ON archive(memory_id);

    CREATE TABLE IF NOT EXISTS engine_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);

    CREATE TABLE IF NOT EXISTS bridge_exported (
      id TEXT PRIMARY KEY,
      last_action TEXT NOT NULL,
      exported_at INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, content='');

    CREATE TRIGGER IF NOT EXISTS memories_fts_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_fts_au AFTER UPDATE OF content ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `)

  // v1 → v2 migration: add session_id for scope=session isolation (P1 fix).
  // Order matters: ALTER TABLE must precede any index referencing session_id.
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  if (version < 2) {
    const cols = db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]
    if (!cols.some(c => c.name === 'session_id')) {
      db.exec('ALTER TABLE memories ADD COLUMN session_id TEXT')
    }
  }
  // Index created for BOTH migrated (v1→v2) and fresh (v2) databases; safe
  // because the column now exists either way.
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id)')

  db.exec(`PRAGMA application_id = ${MEMORY_APPLICATION_ID}`)
  db.exec(`PRAGMA user_version = ${MEMORY_SCHEMA_VERSION}`)
}
