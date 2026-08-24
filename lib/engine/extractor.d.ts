/**
 * Deterministic heuristic candidate extraction (R3 resolution).
 *
 * M1 extracts memory candidates WITHOUT an LLM: user direct messages that are
 * long enough or carry explicit intent words become candidates. The rules are
 * deliberately simple and fully testable; `extractWithLLM()` is the reserved
 * M2 replacement seam (uses `ctx.llm.stream` then — zero LLM calls in M1).
 * @module dsh-memory/engine/extractor
 */
import type { MemoryCandidate } from '../service/types.ts';
/** Minimal shape of a session event the extractor understands. */
export interface SessionEventLike {
    type: string;
    message?: {
        content?: string;
    } | string;
    text?: string;
}
/** Intent words that mark a message as "worth remembering". */
export declare const DEFAULT_INTENT_WORDS: string[];
/** Heuristic extraction options. */
export interface ExtractOptions {
    /** Minimum message length (chars) to be a candidate without intent words. */
    minLength: number;
    /** Maximum candidate content length (chars). */
    maxContentChars: number;
    /** Words that mark explicit memory intent. */
    intentWords: string[];
}
export declare const DEFAULT_EXTRACT_OPTIONS: ExtractOptions;
/** Extract candidate memories from a session's user messages (deterministic). */
export declare function extractCandidates(events: SessionEventLike[], options?: ExtractOptions, sessionId?: string): MemoryCandidate[];
/**
 * Reserved M2 seam: LLM-based extraction over the session model. M1 returns
 * no candidates and never calls an LLM (Reflect gate is the only token guard;
 * this seam adds none until implemented).
 */
export declare function extractWithLLM(_events: SessionEventLike[], _options?: ExtractOptions): Promise<MemoryCandidate[]>;
//# sourceMappingURL=extractor.d.ts.map