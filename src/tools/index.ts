/**
 * Agent tool registration for the memory service.
 * @module dsh-memory/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineMemorizeTool } from './memorize.ts'
import { defineRecallTool, type FileRefResolver } from './recall.ts'

/** Tool registration options. */
export interface MemoryToolOptions {
  /** Default token budget for recall output (red-team ≤30% context rule). */
  recallDefaultMaxTokens: number
  /** Optional file-bridge resolver for recall fileRefs. */
  fileRefs?: FileRefResolver | null
}

/**
 * Register `memory_memorize` and `memory_recall` on `ctx.tools`.
 * Requires the `ctx.memory` service to be available.
 */
export function registerMemoryTools(ctx: Context, options: MemoryToolOptions): void {
  ctx.tools.register(defineMemorizeTool(ctx.memory))
  ctx.tools.register(defineRecallTool(ctx.memory, options.recallDefaultMaxTokens, options.fileRefs ?? null))
}
