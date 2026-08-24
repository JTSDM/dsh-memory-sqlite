/**
 * Agent tool registration for the memory service.
 * @module dsh-memory/tools
 */
import { defineMemorizeTool } from "./memorize.js";
import { defineRecallTool } from "./recall.js";
/**
 * Register `memory_memorize` and `memory_recall` on `ctx.tools`.
 * Requires the `ctx.memory` service to be available.
 */
export function registerMemoryTools(ctx, options) {
    ctx.tools.register(defineMemorizeTool(ctx.memory));
    ctx.tools.register(defineRecallTool(ctx.memory, options.recallDefaultMaxTokens, options.fileRefs ?? null));
}
//# sourceMappingURL=index.js.map