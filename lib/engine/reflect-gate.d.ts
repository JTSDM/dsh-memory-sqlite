/**
 * Reflect frequency gate (red-team second round; M1 mandatory).
 *
 * Reflect itself ships in M2 — but the gate MUST exist in M1 so the engine
 * never sneaks an LLM call: when the gate passes in M1 the engine only
 * records the pass (resets the delta, stamps last_reflect_at) and logs.
 * @module dsh-memory/engine/reflect-gate
 */
import { type SQLiteLocalProvider } from '../provider/sqlite/local-provider.ts';
/** Gate thresholds (plan §3 engine config). */
export interface ReflectGateConfig {
    /** Pass when pending reinforcement events ≥ this. */
    minReinforceDelta: number;
    /** Pass when now - last_reflect_at > this (ms). */
    maxIntervalMs: number;
}
export declare const DEFAULT_REFLECT_GATE_CONFIG: ReflectGateConfig;
export interface ReflectGateResult {
    passed: boolean;
    reason: 'delta' | 'interval' | 'skip';
    delta: number;
    lastReflectAt: number | null;
}
/** Pure gate evaluation over the provider state. */
export declare class ReflectGate {
    private readonly provider;
    private readonly config;
    constructor(provider: SQLiteLocalProvider, config?: ReflectGateConfig);
    /** Evaluate the gate WITHOUT mutating state. */
    check(now?: number): ReflectGateResult;
    /**
     * Record a passed gate: reset the delta and stamp last_reflect_at.
     * M1 does NOT run Reflect (logs only) — this is the token guard.
     */
    recordPass(now?: number): void;
}
//# sourceMappingURL=reflect-gate.d.ts.map