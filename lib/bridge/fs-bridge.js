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
import { mkdir } from 'node:fs/promises';
import { STATE_BRIDGE_STATUS } from "../provider/sqlite/local-provider.js";
import { appendArchiveRow, exportCoreMemories } from "./exporter.js";
import { importJsonl, migrateSentinelOnce, readMaybe } from "./importer.js";
import { resolveBridgePaths } from "./paths.js";
import { renderIncremental } from "./renderer.js";
export const DEFAULT_BRIDGE_CONFIG = {
    enabled: true,
    memoryDir: '.workbuddy/memory',
    workspaceRoot: '',
    export: { exportMinImportance: 2, exportRecentWindowMs: 24 * 60 * 60 * 1000 },
};
/**
 * The file bridge. `importAndExport` is the sweep entry; `onMemoryChanged`
 * feeds archive/restore rows; `importSessionStart` retries failed writes
 * (设计 §12.4). All failures are contained and recorded.
 */
export class FileBridge {
    ctx;
    provider;
    config;
    paths;
    constructor(ctx, provider, config = DEFAULT_BRIDGE_CONFIG) {
        this.ctx = ctx;
        this.provider = provider;
        this.config = config;
        this.paths = resolveBridgePaths(this.config.workspaceRoot || this.firstWorkspace(), this.config.memoryDir);
        if (!this.config.enabled || !this.paths) {
            this.setStatus('disabled');
        }
    }
    /** Whether the bridge can reach its files. */
    isActive() {
        return this.config.enabled && this.paths !== null;
    }
    /** JSONL path for tool fileRefs, or null when inactive. */
    jsonlPath() {
        return this.paths?.jsonlPath ?? null;
    }
    /** Whether this memory reached the JSONL (tool fileRef support). */
    isExported(id) {
        return this.provider.bridgeGetExported(id) !== null;
    }
    /** Import (session start) then export + render (sweep). Contained. */
    async importAndExport() {
        if (!this.isActive() || !this.paths)
            return;
        try {
            await mkdir(this.paths.memoryDir, { recursive: true });
            const jsonl = await readMaybe(this.paths.jsonlPath);
            const md = await readMaybe(this.paths.mdPath);
            const imported = await importJsonl(this.provider, jsonl);
            const migrated = await migrateSentinelOnce(this.provider, md, m => this.ctx.logger.warn(m));
            const exported = await exportCoreMemories(this.provider, this.paths.jsonlPath, this.config.export);
            const jsonlAfter = await readMaybe(this.paths.jsonlPath);
            const rendered = await renderIncremental(this.provider, this.paths.mdPath, jsonlAfter);
            if (imported.imported > 0 || imported.archived > 0 || migrated > 0) {
                this.ctx.logger.info(`dsh-memory: bridge imported ${imported.imported} upsert, ${imported.archived} archive, ${migrated} migrated`);
            }
            if (exported.appended > 0 || rendered > 0) {
                this.ctx.logger.info(`dsh-memory: bridge exported ${exported.appended} rows, rendered ${rendered} entries`);
            }
            this.setStatus('ok');
        }
        catch (error) {
            // 三自检 #1: degrade, never throw.
            this.setStatus('degraded');
            this.ctx.logger.warn(`dsh-memory: bridge degraded (SQLite-only): ${String(error)}`);
        }
    }
    /** BridgeSeam entry used by the engine pipeline (step 5). */
    exportAndRender() {
        return this.importAndExport();
    }
    /** Subscribe to memory/changed for archive/restore rows. */
    start() {
        if (!this.isActive())
            return () => { };
        return this.ctx.on('memory/changed', (event) => {
            if (event.type !== 'archive' || !this.paths)
                return;
            void appendArchiveRow(this.provider, this.paths.jsonlPath, {
                id: event.memory.id,
                contentHash: event.memory.contentHash,
            }).catch(error => {
                // Contained: the sweep retries the full export later.
                this.setStatus('degraded');
                this.ctx.logger.warn(`dsh-memory: bridge archive row failed: ${String(error)}`);
            });
        });
    }
    /** Current bridge status ('ok' | 'degraded' | 'disabled'). */
    status() {
        return this.provider.getState(STATE_BRIDGE_STATUS) ?? 'ok';
    }
    setStatus(status) {
        this.provider.setState(STATE_BRIDGE_STATUS, status);
    }
    /** First registered workspace (M1 simplification; explicit config wins). */
    firstWorkspace() {
        try {
            const registry = this.ctx.workspaceRegistry;
            const workspaces = registry?.list?.() ?? [];
            return workspaces[0]?.path ?? null;
        }
        catch {
            return null;
        }
    }
}
//# sourceMappingURL=fs-bridge.js.map