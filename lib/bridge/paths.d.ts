/**
 * File-bridge path resolution (plan §2-Step6, design §12).
 *
 * Workspace root comes from `ctx.workspaceRegistry` (canonical realpath) or
 * an explicit config path. When neither resolves, the bridge enters its
 * disabled state (SQLite-only) — never throws.
 * @module dsh-memory/bridge/paths
 */
/** Resolved bridge file locations. */
export interface BridgePaths {
    /** Canonical workspace root. */
    workspaceRoot: string;
    /** `.workbuddy/memory` directory under the workspace. */
    memoryDir: string;
    /** Append-only DSH exchange truth source. */
    jsonlPath: string;
    /** Human view (sentinel-rendered). */
    mdPath: string;
}
/** Sentinel block markers (D11): everything between is DSH-owned. */
export declare const DSH_MEMORY_START = "<!-- DSH_MEMORY_START -->";
export declare const DSH_MEMORY_END = "<!-- DSH_MEMORY_END -->";
/** Marker on every DSH-written MEMORY.md entry (D10). */
export declare const DSH_WRITTEN_MARK = "> \u672C\u6761\u8BB0\u5F55\u7531 DSH \u5199\u5165";
/**
 * Resolve bridge paths from a workspace root (already canonical) and the
 * relative memory dir. Returns null when the workspace root is unusable
 * (disabled state).
 */
export declare function resolveBridgePaths(workspaceRoot: string | null, memoryDirRel: string): BridgePaths | null;
//# sourceMappingURL=paths.d.ts.map