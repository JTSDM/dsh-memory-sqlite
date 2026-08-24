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
import type { DatabaseSync } from 'node:sqlite';
export declare const MEMORY_SCHEMA_VERSION = 2;
/** 'dshm' — protects unrelated databases from derived resets. */
export declare const MEMORY_APPLICATION_ID = 1685284973;
export declare function createSchema(db: DatabaseSync): void;
//# sourceMappingURL=schema.d.ts.map