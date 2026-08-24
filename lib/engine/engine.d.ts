/**
 * Async lifecycle engine MVP (plan §2-Step5, hard constraint D9).
 *
 * Session end ONLY enqueues a durable outbox row (single ~11µs insert) and
 * returns immediately. A background job (`ctx.jobs`, kind `memory`) consumes
 * rows: heuristic extraction → idempotent upsert → decay → archive-state
 * sync → file-bridge export (when wired) → Reflect gate. Every step is
 * individually contained: one failure never aborts the row's later steps or
 * other rows. A periodic sweep (R4: mandatory in M1) re-runs failed rows and
 * crash-recovered `processing` rows.
 *
 * The engine NEVER calls an LLM in M1 (Reflect gate only records passes).
 * @module dsh-memory/engine
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SQLiteLocalProvider } from '../provider/sqlite/local-provider.ts';
import { type ExtractOptions } from './extractor.ts';
import { type ReflectGateConfig } from './reflect-gate.ts';
declare module '@deepseek-ai/dsh-jobs' {
    interface JobKindMap {
        memory: 'memory';
    }
}
/** Minimal session shape the engine observes (avoids dsh-session coupling). */
export interface SessionLike {
    id: string;
}
/** Minimal logger surface used by the engine. */
export interface EngineLogger {
    warn(...args: unknown[]): void;
    info(...args: unknown[]): void;
}
/** Optional file-bridge seam (Step 6 wires the real bridge). */
export interface BridgeSeam {
    /** Export core memories + archive events, then incrementally render. */
    exportAndRender(): Promise<void>;
}
/** Engine configuration (plan §3 engine group). */
export interface EngineConfig {
    outboxMaxAttempts: number;
    reflect: ReflectGateConfig;
    extract: ExtractOptions;
}
export declare const DEFAULT_ENGINE_CONFIG: EngineConfig;
/**
 * Lifecycle engine. Created by the plugin; `start()` wires the session-event
 * listeners (enqueue-only) and the periodic sweep.
 */
export declare class MemoryLifecycleEngine {
    private readonly ctx;
    private readonly provider;
    private readonly config;
    private readonly bridge;
    private readonly logger;
    private readonly perSessionMessages;
    constructor(ctx: Context, provider: SQLiteLocalProvider, config?: EngineConfig, bridge?: BridgeSeam | null, logger?: EngineLogger);
    /** Wire session listeners (enqueue-only — never block, never LLM/IO). */
    start(): void;
    /** Session-end hook: durable enqueue, immediate return (D9). */
    flushSession(session: SessionLike): void;
    /** Session-start import hook (Step 6 wires importer + retry). */
    onSessionStart(session: SessionLike): void;
    /** Drain every processable outbox row (invoked inside a background job). */
    sweep(): Promise<void>;
    /** Serial engine pipeline for one outbox row. Each step is contained. */
    private processRow;
}
//# sourceMappingURL=engine.d.ts.map