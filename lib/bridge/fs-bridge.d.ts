/**
 * File bridge orchestrator (plan §2-Step6, design §12).
 *
 * DSH ↔ WorkBuddy sharing layer. Every step is individually contained: a
 * failure (file lock, read-only, missing dir, disk full, workspace not open)
 * degrades to "SQLite only + warn + bridge_status" — NEVER an uncaught
 * exception, NEVER blocking (三自检 #1). The periodic sweep retries.
 *
 * Pipeline: exportCoreMemories → append JSONL → incremental render →
 * import (session start) → migration (first adoption).
 * @module dsh-memory/bridge/fs-bridge
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SQLiteLocalProvider } from '../provider/sqlite/local-provider.ts';
import type { BridgeSeam } from '../engine/engine.ts';
import { type ExportConfig } from './exporter.ts';
/** Bridge configuration (plan §3 bridge group). */
export interface BridgeConfig {
    enabled: boolean;
    /** Relative memory dir under the workspace root. */
    memoryDir: string;
    /** Explicit workspace root override (canonical path); empty = registry. */
    workspaceRoot: string;
    export: ExportConfig;
}
export declare const DEFAULT_BRIDGE_CONFIG: BridgeConfig;
export type BridgeStatus = 'ok' | 'degraded' | 'disabled';
/**
 * The file bridge. `importAndExport` is the sweep entry; `onMemoryChanged`
 * feeds archive/restore rows; `importSessionStart` retries failed writes
 * (设计 §12.4). All failures are contained and recorded.
 */
export declare class FileBridge implements BridgeSeam {
    private readonly ctx;
    private readonly provider;
    private readonly config;
    private readonly paths;
    constructor(ctx: Context, provider: SQLiteLocalProvider, config?: BridgeConfig);
    /** Whether the bridge can reach its files. */
    isActive(): boolean;
    /** JSONL path for tool fileRefs, or null when inactive. */
    jsonlPath(): string | null;
    /** Whether this memory reached the JSONL (tool fileRef support). */
    isExported(id: string): boolean;
    /** Import (session start) then export + render (sweep). Contained. */
    importAndExport(): Promise<void>;
    /** BridgeSeam entry used by the engine pipeline (step 5). */
    exportAndRender(): Promise<void>;
    /** Subscribe to memory/changed for archive/restore rows. */
    start(): () => void;
    /** Current bridge status ('ok' | 'degraded' | 'disabled'). */
    status(): BridgeStatus;
    private setStatus;
    /** First registered workspace (M1 simplification; explicit config wins). */
    private firstWorkspace;
}
//# sourceMappingURL=fs-bridge.d.ts.map