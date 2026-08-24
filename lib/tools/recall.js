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
import { defineTool } from '@deepseek-ai/dsh-tools';
export function defineRecallTool(memory, defaultMaxTokens, fileRefs = null) {
    return defineTool({
        name: 'memory_recall',
        description: 'Search the long-term memory store by KEYWORD. Returns three tiers: core '
            + '(matches), related (same scope/type neighbors), divergent (archived or '
            + 'conflicting history). Unspecified scope searches session + user level '
            + '(global included when configured) weighted by scope priority. '
            + 'LIMITATION (M1): keyword retrieval only — no semantic or vector search; '
            + 'vague questions like "summarize my preferences from last week" work '
            + 'poorly. Output is capped to a token budget (default configurable) so '
            + 'results never flood the context.',
        parameters: {
            query: { type: 'string', description: 'Keyword(s) to match. Empty lists memories by importance.' },
            scope: { type: 'string', enum: ['session', 'user', 'global'], description: 'Restrict to one scope. Default: session + user (global per config).' },
            limit: { type: 'integer', description: 'Max items per tier. Default 10.' },
            includeArchive: { type: 'boolean', description: 'Include archived memories in divergent. Default false.' },
            maxTokens: { type: 'integer', description: 'Approximate token budget for core+related. Default from config.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    core: {
                        type: 'array', required: true,
                        items: { type: 'object', additionalProperties: false, properties: hitProps() },
                    },
                    related: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: hitProps() } },
                    divergent: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: hitProps() } },
                    truncated: { type: 'boolean', required: true, description: 'True when the token budget cut results.' },
                    capabilities: { type: 'array', required: true, items: { type: 'string' } },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: renderRecall(value),
                }],
        },
        async execute(args, exec) {
            // P1 isolation: scope=session memories are visible only to the caller's
            // own session (agent.id is the shared session identity).
            const result = memory.recall({
                text: args.query,
                scopes: args.scope ? [args.scope] : undefined,
                limit: args.limit,
                includeArchive: args.includeArchive,
                maxTokens: args.maxTokens ?? defaultMaxTokens,
                sessionId: exec.agent?.id,
            });
            return {
                core: result.core.map(item => hit(item, fileRefs)),
                related: result.related.map(item => hit(item, fileRefs)),
                divergent: result.divergent.map(item => hit(item, fileRefs)),
                truncated: result.truncated,
                capabilities: result.capabilities,
            };
        },
    });
}
function hitProps() {
    return {
        id: { type: 'string', required: true },
        content: { type: 'string', required: true },
        importance: { type: 'integer', required: true },
        type: { type: 'string', required: true },
        scope: { type: 'string', required: true },
        status: { type: 'string', required: true },
        reinforceCount: { type: 'integer', required: true },
        fileRef: { oneOf: [{ type: 'string' }, { type: 'null' }] },
    };
}
function hit(item, fileRefs) {
    const jsonl = fileRefs?.jsonlPath() ?? null;
    const exported = item.memory.id !== '' && fileRefs?.isExported(item.memory.id) === true;
    return {
        id: item.memory.id,
        content: item.memory.content,
        importance: item.memory.importance,
        type: item.memory.type,
        scope: item.memory.scope,
        status: item.memory.status,
        reinforceCount: item.memory.reinforceCount,
        fileRef: exported ? jsonl : null,
    };
}
function renderRecall(value) {
    const parts = [];
    if (value.core.length === 0 && value.related.length === 0 && value.divergent.length === 0) {
        return 'No memories found. (M1 recall is keyword-only; try a distinctive term.)';
    }
    if (value.core.length > 0) {
        parts.push(`core: ${value.core.map(m => `[${m.importance}] ${truncate(m.content)}`).join(' | ')}`);
    }
    if (value.related.length > 0) {
        parts.push(`related: ${value.related.map(m => truncate(m.content)).join(' | ')}`);
    }
    if (value.divergent.length > 0) {
        parts.push(`divergent(archived): ${value.divergent.map(m => truncate(m.content)).join(' | ')}`);
    }
    if (value.truncated)
        parts.push('(truncated to token budget)');
    return parts.join('; ');
}
function truncate(text) {
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
//# sourceMappingURL=recall.js.map