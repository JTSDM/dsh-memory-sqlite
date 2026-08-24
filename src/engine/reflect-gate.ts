/**
 * Reflect frequency gate (red-team second round; M1 mandatory).
 *
 * Reflect itself ships in M2 — but the gate MUST exist in M1 so the engine
 * never sneaks an LLM call: when the gate passes in M1 the engine only
 * records the pass (resets the delta, stamps last_reflect_at) and logs.
 * @module dsh-memory/engine/reflect-gate
 */

import { STATE_LAST_REFLECT, type SQLiteLocalProvider } from '../provider/sqlite/local-provider.ts'

/** Gate thresholds (plan §3 engine config). */
export interface ReflectGateConfig {
  /** Pass when pending reinforcement events ≥ this. */
  minReinforceDelta: number
  /** Pass when now - last_reflect_at > this (ms). */
  maxIntervalMs: number
}

export const DEFAULT_REFLECT_GATE_CONFIG: ReflectGateConfig = {
  minReinforceDelta: 10,
  maxIntervalMs: 24 * 60 * 60 * 1000,
}

export interface ReflectGateResult {
  passed: boolean
  reason: 'delta' | 'interval' | 'skip'
  delta: number
  lastReflectAt: number | null
}

/** Pure gate evaluation over the provider state. */
export class ReflectGate {
  constructor(
    private readonly provider: SQLiteLocalProvider,
    private readonly config: ReflectGateConfig = DEFAULT_REFLECT_GATE_CONFIG,
  ) {}

  /** Evaluate the gate WITHOUT mutating state. */
  check(now = Date.now()): ReflectGateResult {
    const delta = this.provider.getReinforceDelta()
    const lastReflectRaw = this.provider.getState(STATE_LAST_REFLECT)
    const lastReflectAt = lastReflectRaw ? Number(lastReflectRaw) : null
    if (delta >= this.config.minReinforceDelta) {
      return { passed: true, reason: 'delta', delta, lastReflectAt }
    }
    if (lastReflectAt === null || now - lastReflectAt > this.config.maxIntervalMs) {
      return { passed: true, reason: 'interval', delta, lastReflectAt }
    }
    return { passed: false, reason: 'skip', delta, lastReflectAt }
  }

  /**
   * Record a passed gate: reset the delta and stamp last_reflect_at.
   * M1 does NOT run Reflect (logs only) — this is the token guard.
   */
  recordPass(now = Date.now()): void {
    this.provider.resetReinforceDelta()
    this.provider.setState(STATE_LAST_REFLECT, String(now))
  }
}
