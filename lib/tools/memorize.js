/**
 * `memory_memorize` — write or reinforce one memory atom.
 *
 * Synchronous by decision (P0-1): normalizes content, computes content_hash,
 * dedups against the P1-2 state-transition table, and returns the canonical
 * outcome. Never queues, never calls an LLM.
 * @module dsh-memory/tools/memorize
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
export function defineMemorizeTool(memory) {
    return defineTool({
        name: 'memory_memorize',
        description: 'Write a fact or preference into the long-term memory store. Idempotent: '
            + 're-writing the same content reinforces the existing entry (deduped=true) '
            + 'instead of creating a duplicate. Optionally declare importance (1-3), type '
            + '(world/experience/mental_model), scope (session/user/global; default session), '
            + 'and sourceRef. Prefer this over free-text notes when the fact should survive '
            + 'across sessions.',
        parameters: {
            content: { type: 'string', description: 'The fact/preference to remember.' },
            importance: { type: 'integer', description: '1 (default) to 3; higher survives decay and recall capping.' },
            type: { type: 'string', enum: ['world', 'experience', 'mental_model'], description: 'Cognitive tier. Default world.' },
            scope: { type: 'string', enum: ['session', 'user', 'global'], description: 'Storage scope. Default session.' },
            sourceRef: { type: 'string', description: 'Source session/message id for verification.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    id: { type: 'string', required: true },
                    contentHash: { type: 'string', required: true, description: 'SHA-256 of the normalized content.' },
                    deduped: { type: 'boolean', required: true, description: 'True when the content already existed.' },
                    reinforced: { type: 'boolean', required: true, description: 'True when this write counted as a reinforcement event.' },
                    reinforceCount: { type: 'integer', required: true },
                    status: { type: 'string', required: true, enum: ['active', 'dormant', 'archived'] },
                    storedAt: { type: 'integer', required: true },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: value.deduped
                        ? `Memory ${value.deduped && value.reinforced ? 'reinforced' : 're-confirmed'} (id ${value.id}, reinforceCount ${value.reinforceCount}, ${value.status}).`
                        : `Memory stored (id ${value.id}, ${value.status}).`,
                }],
        },
        async execute(args, exec) {
            const outcome = memory.remember({
                content: args.content,
                importance: args.importance,
                type: args.type,
                scope: args.scope,
                // P1 isolation: the owning session rides along for session scope
                // (agent.id is the shared session identity).
                sessionId: exec.agent?.id,
                sourceRef: args.sourceRef,
            });
            return {
                id: outcome.id,
                contentHash: outcome.contentHash,
                deduped: outcome.deduped,
                reinforced: outcome.reinforced,
                reinforceCount: outcome.reinforceCount,
                status: outcome.status,
                storedAt: outcome.storedAt,
            };
        },
    });
}
//# sourceMappingURL=memorize.js.map