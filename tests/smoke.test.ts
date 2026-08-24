import { describe, expect, it } from 'vitest'
import { Config, name } from '../src/index.ts'

describe('dsh-memory plugin', () => {
  it('exports the plugin name used by cordis.patch.yml', () => {
    expect(name).toBe('dsh-memory')
  })

  it('validates config with default dbPath', () => {
    const config = Config({
      dbPath: '',
      reinforceWindowMs: 0,
      recallDefaultMaxTokens: 0,
      engine: { outboxMaxAttempts: 3, reflect: { minReinforceDelta: 10, maxIntervalMs: 1 }, extract: { minLength: 200, maxContentChars: 2000, intentWords: [] } },
      engineSweepIntervalMs: 600000,
      bridge: { enabled: false, memoryDir: '.workbuddy/memory', workspaceRoot: '', export: { exportMinImportance: 2, exportRecentWindowMs: 86400000 } },
    })
    expect(config.dbPath).toBe('')
  })
})
