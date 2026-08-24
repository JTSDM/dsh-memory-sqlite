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

import type { Context } from '@deepseek-ai/cordis'
import { mkdir } from 'node:fs/promises'
import type { SQLiteLocalProvider } from '../provider/sqlite/local-provider.ts'
import { STATE_BRIDGE_STATUS } from '../provider/sqlite/local-provider.ts'
import type { BridgeSeam } from '../engine/engine.ts'
import type { MemoryChangedEvent } from '../service/types.ts'
import { appendArchiveRow, exportCoreMemories, type ExportConfig } from './exporter.ts'
import { importJsonl, migrateSentinelOnce, readMaybe } from './importer.ts'
import { resolveBridgePaths } from './paths.ts'
import { renderIncremental } from './renderer.ts'

/** Bridge configuration (plan §3 bridge group). */
export interface BridgeConfig {
  enabled: boolean
  /** Relative memory dir under the workspace root. */
  memoryDir: string
  /** Explicit workspace root override (canonical path); empty = registry. */
  workspaceRoot: string
  export: ExportConfig
}

export const DEFAULT_BRIDGE_CONFIG: BridgeConfig = {
  enabled: true,
  memoryDir: '.workbuddy/memory',
  workspaceRoot: '',
  export: { exportMinImportance: 2, exportRecentWindowMs: 24 * 60 * 60 * 1000 },
}

export type BridgeStatus = 'ok' | 'degraded' | 'disabled'

/**
 * The file bridge. `importAndExport` is the sweep entry; `onMemoryChanged`
 * feeds archive/restore rows; `importSessionStart` retries failed writes
 * (设计 §12.4). All failures are contained and recorded.
 */
export class FileBridge implements BridgeSeam {
  private readonly paths: ReturnType<typeof resolveBridgePaths>

  constructor(
    private readonly ctx: Context,
    private readonly provider: SQLiteLocalProvider,
    private readonly config: BridgeConfig = DEFAULT_BRIDGE_CONFIG,
  ) {
    this.paths = resolveBridgePaths(
      this.config.workspaceRoot || this.firstWorkspace(),
      this.config.memoryDir,
    )
    if (!this.config.enabled || !this.paths) {
      this.setStatus('disabled')
    }
  }

  /** Whether the bridge can reach its files. */
  isActive(): boolean {
    return this.config.enabled && this.paths !== null
  }

  /** JSONL path for tool fileRefs, or null when inactive. */
  jsonlPath(): string | null {
    return this.paths?.jsonlPath ?? null
  }

  /** Whether this memory reached the JSONL (tool fileRef support). */
  isExported(id: string): boolean {
    return this.provider.bridgeGetExported(id) !== null
  }

  /** Import (session start) then export + render (sweep). Contained. */
  async importAndExport(): Promise<void> {
    if (!this.isActive() || !this.paths) return
    try {
      await mkdir(this.paths.memoryDir, { recursive: true })
      const jsonl = await readMaybe(this.paths.jsonlPath)
      const md = await readMaybe(this.paths.mdPath)

      const imported = await importJsonl(this.provider, jsonl)
      const migrated = await migrateSentinelOnce(this.provider, md, m => this.ctx.logger.warn(m))
      const exported = await exportCoreMemories(this.provider, this.paths.jsonlPath, this.config.export)
      const jsonlAfter = await readMaybe(this.paths.jsonlPath)
      const rendered = await renderIncremental(this.provider, this.paths.mdPath, jsonlAfter)

      if (imported.imported > 0 || imported.archived > 0 || migrated > 0) {
        this.ctx.logger.info(`dsh-memory: bridge imported ${imported.imported} upsert, ${imported.archived} archive, ${migrated} migrated`)
      }
      if (exported.appended > 0 || rendered > 0) {
        this.ctx.logger.info(`dsh-memory: bridge exported ${exported.appended} rows, rendered ${rendered} entries`)
      }
      this.setStatus('ok')
    } catch (error) {
      // 三自检 #1: degrade, never throw.
      this.setStatus('degraded')
      this.ctx.logger.warn(`dsh-memory: bridge degraded (SQLite-only): ${String(error)}`)
    }
  }

  /** BridgeSeam entry used by the engine pipeline (step 5). */
  exportAndRender(): Promise<void> {
    return this.importAndExport()
  }

  /** Subscribe to memory/changed for archive/restore rows. */
  start(): () => void {
    if (!this.isActive()) return () => {}
    return this.ctx.on('memory/changed', (event: MemoryChangedEvent) => {
      if (event.type !== 'archive' || !this.paths) return
      void appendArchiveRow(this.provider, this.paths.jsonlPath, {
        id: event.memory.id,
        contentHash: event.memory.contentHash,
      }).catch(error => {
        // Contained: the sweep retries the full export later.
        this.setStatus('degraded')
        this.ctx.logger.warn(`dsh-memory: bridge archive row failed: ${String(error)}`)
      })
    })
  }

  /** Current bridge status ('ok' | 'degraded' | 'disabled'). */
  status(): BridgeStatus {
    return (this.provider.getState(STATE_BRIDGE_STATUS) as BridgeStatus) ?? 'ok'
  }

  private setStatus(status: BridgeStatus): void {
    this.provider.setState(STATE_BRIDGE_STATUS, status)
  }

  /** First registered workspace (M1 simplification; explicit config wins). */
  private firstWorkspace(): string | null {
    try {
      const registry = (this.ctx as unknown as { workspaceRegistry?: { list?(): { path: string }[] } }).workspaceRegistry
      const workspaces = registry?.list?.() ?? []
      return workspaces[0]?.path ?? null
    } catch {
      return null
    }
  }
}
