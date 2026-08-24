/**
 * File-bridge path resolution (plan §2-Step6, design §12).
 *
 * Workspace root comes from `ctx.workspaceRegistry` (canonical realpath) or
 * an explicit config path. When neither resolves, the bridge enters its
 * disabled state (SQLite-only) — never throws.
 * @module dsh-memory/bridge/paths
 */
import { join } from 'node:path';
/** Sentinel block markers (D11): everything between is DSH-owned. */
export const DSH_MEMORY_START = '<!-- DSH_MEMORY_START -->';
export const DSH_MEMORY_END = '<!-- DSH_MEMORY_END -->';
/** Marker on every DSH-written MEMORY.md entry (D10). */
export const DSH_WRITTEN_MARK = '> 本条记录由 DSH 写入';
/**
 * Resolve bridge paths from a workspace root (already canonical) and the
 * relative memory dir. Returns null when the workspace root is unusable
 * (disabled state).
 */
export function resolveBridgePaths(workspaceRoot, memoryDirRel) {
    if (!workspaceRoot)
        return null;
    const memoryDir = join(workspaceRoot, memoryDirRel);
    return {
        workspaceRoot,
        memoryDir,
        jsonlPath: join(memoryDir, 'dsh_sync.jsonl'),
        mdPath: join(memoryDir, 'MEMORY.md'),
    };
}
//# sourceMappingURL=paths.js.map