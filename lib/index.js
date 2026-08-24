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
import z from '@deepseek-ai/schemastery';
import { MemoryService } from "./service/memory-service.js";
import { SQLiteLocalProvider } from "./provider/sqlite/local-provider.js";
import { registerMemoryTools } from "./tools/index.js";
import { DEFAULT_ENGINE_CONFIG, MemoryLifecycleEngine } from "./engine/engine.js";
import { DEFAULT_REFLECT_GATE_CONFIG } from "./engine/reflect-gate.js";
import { DEFAULT_BRIDGE_CONFIG, FileBridge } from "./bridge/fs-bridge.js";
export const name = 'dsh-memory';
export const inject = ['tools', 'jobs', 'timer', 'workspaceRegistry'];
/** Schemastery configuration schema for the plugin consumer. */
export const Config = z.object({
    dbPath: z.string().default(''),
    reinforceWindowMs: z.number().default(60 * 60 * 1000),
    recallDefaultMaxTokens: z.number().default(2000),
    engine: z.object({
        outboxMaxAttempts: z.number().default(DEFAULT_ENGINE_CONFIG.outboxMaxAttempts),
        reflect: z.object({
            minReinforceDelta: z.number().default(DEFAULT_REFLECT_GATE_CONFIG.minReinforceDelta),
            maxIntervalMs: z.number().default(DEFAULT_REFLECT_GATE_CONFIG.maxIntervalMs),
        }).default(DEFAULT_REFLECT_GATE_CONFIG),
        extract: z.object({
            minLength: z.number().default(DEFAULT_ENGINE_CONFIG.extract.minLength),
            maxContentChars: z.number().default(DEFAULT_ENGINE_CONFIG.extract.maxContentChars),
            intentWords: z.array(z.string()).default([]),
        }).default(DEFAULT_ENGINE_CONFIG.extract),
    }).default(DEFAULT_ENGINE_CONFIG),
    engineSweepIntervalMs: z.number().default(10 * 60 * 1000),
    bridge: z.object({
        enabled: z.boolean().default(DEFAULT_BRIDGE_CONFIG.enabled),
        memoryDir: z.string().default(DEFAULT_BRIDGE_CONFIG.memoryDir),
        workspaceRoot: z.string().default(''),
        export: z.object({
            exportMinImportance: z.number().default(DEFAULT_BRIDGE_CONFIG.export.exportMinImportance),
            exportRecentWindowMs: z.number().default(DEFAULT_BRIDGE_CONFIG.export.exportRecentWindowMs),
        }).default(DEFAULT_BRIDGE_CONFIG.export),
    }).default(DEFAULT_BRIDGE_CONFIG),
});
/**
 * Apply the plugin: provide `ctx.memory` over the SQLite provider, register
 * the memorize/recall agent tools, start the async lifecycle engine, and wire
 * the file bridge (all failures degrade, never throw).
 * @param ctx - registrant context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
    const dbPath = config.dbPath
        || `${process.env.DSH_HOME ?? `${process.env.USERPROFILE ?? '~'}/.dsh`}/memory/memory.sqlite`;
    const provider = new SQLiteLocalProvider(dbPath, config.reinforceWindowMs);
    // Constructing the service registers it as `ctx.memory` (cordis Service).
    new MemoryService(ctx, provider);
    // File bridge (design §12): resolved paths from workspace registry or
    // explicit config; degrades to SQLite-only when unavailable.
    const bridge = new FileBridge(ctx, provider, config.bridge);
    bridge.start();
    registerMemoryTools(ctx, {
        recallDefaultMaxTokens: config.recallDefaultMaxTokens,
        fileRefs: bridge,
    });
    // Async lifecycle engine: session end enqueues only; consumption runs in
    // background jobs (D9). The bridge feeds the export step of the pipeline.
    const engine = new MemoryLifecycleEngine(ctx, provider, config.engine, bridge);
    engine.start();
    ctx.jobs.attachController('dsh-memory');
    // R4: mandatory periodic sweep (default 10 min) — outbox retries + crash
    // recovery + failed bridge writes.
    const sweep = () => {
        ctx.jobs.start({
            kind: 'memory',
            label: 'dsh-memory lifecycle sweep',
            run: () => {
                const done = engine.sweep().then(() => ({ status: 'completed' }));
                return { cancel: () => { }, done, readOutput: () => '' };
            },
        });
    };
    ctx.setInterval(sweep, config.engineSweepIntervalMs);
}
//# sourceMappingURL=index.js.map