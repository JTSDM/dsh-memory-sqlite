/**
 * Deterministic heuristic candidate extraction (R3 resolution).
 *
 * M1 extracts memory candidates WITHOUT an LLM: user direct messages that are
 * long enough or carry explicit intent words become candidates. The rules are
 * deliberately simple and fully testable; `extractWithLLM()` is the reserved
 * M2 replacement seam (uses `ctx.llm.stream` then — zero LLM calls in M1).
 * @module dsh-memory/engine/extractor
 */

import type { MemoryCandidate } from '../service/types.ts'

/** Minimal shape of a session event the extractor understands. */
export interface SessionEventLike {
  type: string
  message?: { content?: string } | string
  text?: string
}

/** Intent words that mark a message as "worth remembering". */
export const DEFAULT_INTENT_WORDS = [
  '记住', '偏好', '总是', '每次', '规则', '不要', '必须', '习惯',
  'remember', 'prefer', 'always', 'never', 'rule', 'habit',
]

/** Heuristic extraction options. */
export interface ExtractOptions {
  /** Minimum message length (chars) to be a candidate without intent words. */
  minLength: number
  /** Maximum candidate content length (chars). */
  maxContentChars: number
  /** Words that mark explicit memory intent. */
  intentWords: string[]
}

export const DEFAULT_EXTRACT_OPTIONS: ExtractOptions = {
  minLength: 200,
  maxContentChars: 2000,
  intentWords: DEFAULT_INTENT_WORDS,
}

/** Extract candidate memories from a session's user messages (deterministic). */
export function extractCandidates(
  events: SessionEventLike[],
  options: ExtractOptions = DEFAULT_EXTRACT_OPTIONS,
  sessionId?: string,
): MemoryCandidate[] {
  const candidates: MemoryCandidate[] = []
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const text = messageText(event)
    if (!text) continue
    const trimmed = text.trim()
    if (trimmed.length === 0) continue
    const content = trimmed.slice(0, options.maxContentChars)
    const hasIntent = options.intentWords.some(word => trimmed.includes(word))
    if (!hasIntent && trimmed.length < options.minLength) continue
    candidates.push({
      content,
      scope: 'session',
      // P1 isolation: engine-extracted candidates belong to their source session.
      sessionId,
      type: hasIntent ? 'experience' : 'world',
      importance: hasIntent || trimmed.length >= 500 ? 2 : 1,
    })
  }
  return candidates
}

/**
 * Reserved M2 seam: LLM-based extraction over the session model. M1 returns
 * no candidates and never calls an LLM (Reflect gate is the only token guard;
 * this seam adds none until implemented).
 */
export async function extractWithLLM(_events: SessionEventLike[], _options: ExtractOptions = DEFAULT_EXTRACT_OPTIONS): Promise<MemoryCandidate[]> {
  // M2: use ctx.llm.stream(GenerateOptions) + BlockAssembler, gated by the
  // same frequency rules as Reflect. Deliberately not implemented in M1.
  return []
}

function messageText(event: SessionEventLike): string | null {
  const message = event.message
  if (typeof message === 'string') return message
  if (message && typeof message === 'object' && typeof message.content === 'string') return message.content
  if (typeof event.text === 'string') return event.text
  return null
}
