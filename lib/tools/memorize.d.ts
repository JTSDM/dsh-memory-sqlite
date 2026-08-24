/**
 * `memory_memorize` — write or reinforce one memory atom.
 *
 * Synchronous by decision (P0-1): normalizes content, computes content_hash,
 * dedups against the P1-2 state-transition table, and returns the canonical
 * outcome. Never queues, never calls an LLM.
 * @module dsh-memory/tools/memorize
 */
import type { MemoryService } from '../service/memory-service.ts';
export interface MemorizeArgs {
    content: string;
    importance?: 1 | 2 | 3;
    type?: 'world' | 'experience' | 'mental_model';
    scope?: 'session' | 'user' | 'global';
    sourceRef?: string;
}
export declare function defineMemorizeTool(memory: MemoryService): import("@deepseek-ai/dsh-tools").ToolDefinition;
//# sourceMappingURL=memorize.d.ts.map