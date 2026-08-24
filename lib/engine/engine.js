/**
 * Async lifecycle engine MVP (plan §2-Step5, hard constraint D9).
 *
 * Session end ONLY enqueues a durable outbox row (single ~11µs insert) and
 * returns immediately. A background job (`ctx.jobs`, kind `memory`) consumes
 * rows: heuristic extraction → idempotent upsert → decay → archive-state
 * sync → file-bridge export (when wired) → Reflect gate. Every step is
 * individually contained: one failure never aborts the row's later steps or
 * other rows. A periodic sweep (R4: mandatory in M1) re-runs failed rows and
 * crash-recovered `processing` rows.
 *
 * The engine NEVER calls an LLM in M1 (Reflect gate only records passes).
 * @module dsh-memory/engine
 */
import { extractCandidates, DEFAULT_INTENT_WORDS } from "./extractor.js";
import { DEFAULT_REFLECT_GATE_CONFIG, ReflectGate } from "./reflect-gate.js";
export const DEFAULT_ENGINE_CONFIG = {
    outboxMaxAttempts: 3,
    reflect: DEFAULT_REFLECT_GATE_CONFIG,
    extract: { minLength: 200, maxContentChars: 2000, intentWords: [] },
};
/**
 * Lifecycle engine. Created by the plugin; `start()` wires the session-event
 * listeners (enqueue-only) and the periodic sweep.
 */
export class MemoryLifecycleEngine {
    ctx;
    provider;
    config;
    bridge;
    logger;
    perSessionMessages = new Map();
    constructor(ctx, provider, config = DEFAULT_ENGINE_CONFIG, bridge = null, logger = ctx.logger) {
        this.ctx = ctx;
        this.provider = provider;
        this.config = config;
        this.bridge = bridge;
        this.logger = logger;
        if (this.config.extract.intentWords.length === 0) {
            this.config.extract.intentWords = DEFAULT_INTENT_WORDS;
        }
    }
    /** Wire session listeners (enqueue-only — never block, never LLM/IO). */
    start() {
        this.ctx.on('session/event', (session, event) => {
            if (event.type !== 'user/message')
                return;
            const text = eventMessageText(event);
            if (!text)
                return;
            const bucket = this.perSessionMessages.get(session.id) ?? [];
            bucket.push(text);
            this.perSessionMessages.set(session.id, bucket);
        });
        this.ctx.on('session/disposed', (session) => {
            this.flushSession(session);
        });
    }
    /** Session-end hook: durable enqueue, immediate return (D9). */
    flushSession(session) {
        const messages = this.perSessionMessages.get(session.id) ?? [];
        this.perSessionMessages.delete(session.id);
        if (this.provider.outboxHasActive(session.id))
            return;
        this.provider.outboxEnqueue(session.id, messages.length > 0 ? JSON.stringify(messages) : null);
    }
    /** Session-start import hook (Step 6 wires importer + retry). */
    onSessionStart(session) {
        // M1: bridge import is driven by the sweep; nothing blocking here.
        void session;
    }
    /** Drain every processable outbox row (invoked inside a background job). */
    async sweep() {
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const row = this.provider.outboxClaim(this.config.outboxMaxAttempts);
            if (!row)
                break;
            try {
                await this.processRow(row);
                this.provider.outboxComplete(row.id);
            }
            catch (error) {
                this.provider.outboxFail(row.id, error, this.config.outboxMaxAttempts);
                this.logger.warn(`dsh-memory: outbox row ${row.id} failed: ${String(error)}`);
            }
        }
        // Periodic export even with an empty outbox: core memories must reach the
        // file bridge on the sweep cadence, not only after session end.
        if (this.bridge) {
            try {
                await this.bridge.exportAndRender();
            }
            catch (error) {
                this.logger.warn(`dsh-memory: bridge export failed: ${String(error)}`);
            }
        }
    }
    /** Serial engine pipeline for one outbox row. Each step is contained. */
    async processRow(row) {
        // 1. heuristic candidate extraction (never LLM in M1). A malformed
        //    payload is a data problem: fail the row (retryable) instead of
        //    silently completing it. Later steps stay individually contained.
        const events = row.payload ? JSON.parse(row.payload) : [];
        // P1 isolation: candidates inherit the source session id.
        const candidates = extractCandidates(events, this.config.extract, row.sessionId);
        // 2. idempotent upserts (P1-2 table), each contained
        for (const candidate of candidates) {
            try {
                this.provider.upsert(candidate);
            }
            catch (error) {
                this.logger.warn(`dsh-memory: upsert failed: ${String(error)}`);
            }
        }
        // 3. TTL decay scan
        try {
            const decayed = this.provider.decay();
            if (decayed > 0)
                this.logger.info(`dsh-memory: decayed ${decayed} memories`);
        }
        catch (error) {
            this.logger.warn(`dsh-memory: decay failed: ${String(error)}`);
        }
        // 4. archive-state sync (M1: explicit archives only — no auto-archive)
        //    The exporter consumes memory/changed for archive rows; nothing to
        //    scan here until M2 auto-archiving.
        // 5. file-bridge export + incremental render (Step 6; absent → skip)
        if (this.bridge) {
            try {
                await this.bridge.exportAndRender();
            }
            catch (error) {
                this.logger.warn(`dsh-memory: bridge export failed: ${String(error)}`);
            }
        }
        // 6. Reflect gate (M1: record pass only — token guard)
        try {
            const gate = new ReflectGate(this.provider, this.config.reflect);
            const result = gate.check();
            if (result.passed) {
                gate.recordPass();
                this.logger.info(`dsh-memory: reflect gate passed (${result.reason}, delta=${result.delta}); `
                    + `reflect itself ships in M2 — no LLM call made`);
            }
        }
        catch (error) {
            this.logger.warn(`dsh-memory: reflect gate failed: ${String(error)}`);
        }
    }
}
/**
 * Extract message text from a session event, tolerant of both the dsh-session
 * envelope (`data`) and the extractor's minimal shape (`message`/`text`).
 */
function eventMessageText(event) {
    const data = event.data;
    if (typeof data === 'string')
        return data;
    if (data && typeof data === 'object') {
        if (typeof data.content === 'string')
            return data.content;
        if (typeof data.text === 'string')
            return data.text;
    }
    const message = event.message;
    if (typeof message === 'string')
        return message;
    if (message && typeof message === 'object' && typeof message.content === 'string')
        return message.content;
    if (typeof event.text === 'string')
        return event.text;
    return null;
}
//# sourceMappingURL=engine.js.map