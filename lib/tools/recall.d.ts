/**
 * `memory_recall` — three-tier recall with scope filtering and token capping.
 *
 * M1 capability boundary (honest declaration): keyword (FTS5) retrieval only —
 * NO semantic/vector search. Returns core / related / divergent tiers
 * (Plastic Promise context_supply shape), capped to a token budget so
 * memories never flood the context (red-team ≤30% rule; the caller or config
 * sets the budget).
 * @module dsh-memory/tools/recall
 */
import type { MemoryService } from '../service/memory-service.ts';
export interface RecallArgs {
    query?: string;
    scope?: 'session' | 'user' | 'global';
    limit?: number;
    includeArchive?: boolean;
    maxTokens?: number;
}
/** Resolves the JSONL file reference for a memory (file-bridge seam). */
export interface FileRefResolver {
    /** JSONL path when the bridge is active, else null. */
    jsonlPath(): string | null;
    /** Whether this memory reached the JSONL. */
    isExported(id: string): boolean;
}
export declare function defineRecallTool(memory: MemoryService, defaultMaxTokens: number, fileRefs?: FileRefResolver | null): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=recall.d.ts.map