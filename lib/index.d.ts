/**
 * dsh-memory — native memory service layer for DeepSeek Harness.
 *
 * M1 scope (see plan-m1-dsh-memory.md v2.1):
 * - `ctx.provide('memory')` service definition with capability tiers
 * - SQLite LocalProvider (node:sqlite, content_hash idempotency, FTS5)
 * - `memory_memorize` / `memory_recall` agent tools
 * - async lifecycle engine MVP (outbox + heuristic extraction + state
 *   transitions + Reflect gate + periodic sweep)
 * - WorkBuddy file bridge (append-only JSONL + sentinel-rendered MEMORY.md
 *   with permission fallback)
 *
 * @module dsh-memory
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type EngineConfig } from './engine/engine.ts';
import { type BridgeConfig } from './bridge/fs-bridge.ts';
export declare const name = "dsh-memory";
export declare const inject: string[];
/** dsh-memory plugin configuration. */
export interface Config {
    /** SQLite database path. Empty = default `$DSH_HOME/memory/memory.sqlite`. */
    dbPath: string;
    /** Reinforcement idempotency window in ms (gotchas #3, default 1h). */
    reinforceWindowMs: number;
    /** Default token budget for recall output (red-team ≤30% context rule). */
    recallDefaultMaxTokens: number;
    /** Engine lifecycle configuration (D9 async constraints). */
    engine: EngineConfig;
    /** Periodic sweep interval in ms (R4 mandatory, default 10 min). */
    engineSweepIntervalMs: number;
    /** WorkBuddy file bridge configuration (design §12). */
    bridge: BridgeConfig;
}
/** Schemastery configuration schema for the plugin consumer. */
export declare const Config: z<Config>;
/**
 * Apply the plugin: provide `ctx.memory` over the SQLite provider, register
 * the memorize/recall agent tools, start the async lifecycle engine, and wire
 * the file bridge (all failures degrade, never throw).
 * @param ctx - registrant context.
 * @param config - validated plugin configuration.
 */
export declare function apply(ctx: Context, config: Config): void;
//# sourceMappingURL=index.d.ts.map