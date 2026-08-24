/**
 * Reflect frequency gate (red-team second round; M1 mandatory).
 *
 * Reflect itself ships in M2 — but the gate MUST exist in M1 so the engine
 * never sneaks an LLM call: when the gate passes in M1 the engine only
 * records the pass (resets the delta, stamps last_reflect_at) and logs.
 * @module dsh-memory/engine/reflect-gate
 */
import { STATE_LAST_REFLECT } from "../provider/sqlite/local-provider.js";
export const DEFAULT_REFLECT_GATE_CONFIG = {
    minReinforceDelta: 10,
    maxIntervalMs: 24 * 60 * 60 * 1000,
};
/** Pure gate evaluation over the provider state. */
export class ReflectGate {
    provider;
    config;
    constructor(provider, config = DEFAULT_REFLECT_GATE_CONFIG) {
        this.provider = provider;
        this.config = config;
    }
    /** Evaluate the gate WITHOUT mutating state. */
    check(now = Date.now()) {
        const delta = this.provider.getReinforceDelta();
        const lastReflectRaw = this.provider.getState(STATE_LAST_REFLECT);
        const lastReflectAt = lastReflectRaw ? Number(lastReflectRaw) : null;
        if (delta >= this.config.minReinforceDelta) {
            return { passed: true, reason: 'delta', delta, lastReflectAt };
        }
        if (lastReflectAt === null || now - lastReflectAt > this.config.maxIntervalMs) {
            return { passed: true, reason: 'interval', delta, lastReflectAt };
        }
        return { passed: false, reason: 'skip', delta, lastReflectAt };
    }
    /**
     * Record a passed gate: reset the delta and stamp last_reflect_at.
     * M1 does NOT run Reflect (logs only) — this is the token guard.
     */
    recordPass(now = Date.now()) {
        this.provider.resetReinforceDelta();
        this.provider.setState(STATE_LAST_REFLECT, String(now));
    }
}
//# sourceMappingURL=reflect-gate.js.map