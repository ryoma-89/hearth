import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parse } from 'yaml'
import { DEFAULT_RAW_CONFIG } from '../../src/config/defaults.ts'
import { ConfigError, deepMerge, loadConfig, resolveConfig } from '../../src/config/load.ts'
import { buildTaskOverlay, providerKeyEnv } from '../../src/dsh/overlay.ts'

describe('config', () => {
  it('resolves built-in defaults', () => {
    const c = resolveConfig(DEFAULT_RAW_CONFIG, 'C:\\proj')
    assert.equal(c.defaultModel.provider, 'strata')
    assert.equal(c.queue.maxConcurrentInference, 1)
    assert.equal(c.modes.maximum.maxSteps > c.modes.low.maxSteps, true)
    assert.equal(c.providers.strata!.apiKey.kind, 'secret')
  })

  it('rejects literal API keys, unknown modes, and non-loopback daemon hosts', () => {
    const bad = deepMerge(DEFAULT_RAW_CONFIG, {
      providers: { strata: { apiKey: 'sk-literal' } },
      modes: { turbo: {} },
      daemon: { host: '0.0.0.0' },
    })
    assert.throws(() => resolveConfig(bad, '.'), (e: unknown) => {
      assert.ok(e instanceof ConfigError)
      const text = e.problems.join('\n')
      assert.match(text, /literal key/)
      assert.match(text, /unknown mode/)
      assert.match(text, /loopback/)
      return true
    })
  })

  it('loads a YAML file and merges it over defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hearth-cfg-'))
    try {
      const file = join(dir, 'hearth.yaml')
      writeFileSync(file, [
        'defaultModel: lmstudio/qwen',
        'defaultMode: high',
        'providers:',
        '  lmstudio:',
        '    baseURL: http://127.0.0.1:1234/v1',
        '    apiKey: none',
        '    models:',
        '      - { id: qwen, contextWindow: 32768, maxTokens: 4096 }',
        'modes:',
        '  high: { maxSteps: 12 }',
      ].join('\n'))
      const c = loadConfig({ path: file })
      assert.equal(c.defaultModel.provider, 'lmstudio')
      assert.equal(c.modes.high.maxSteps, 12)
      assert.equal(c.modes.high.verificationRounds, 2, 'unspecified mode fields keep defaults')
      assert.equal(c.stateDir, join(dir, '.hearth'))
      assert.ok(c.providers.strata, 'default provider still present')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildTaskOverlay', () => {
  const config = resolveConfig(DEFAULT_RAW_CONFIG, 'C:\\proj')
  const rowsFor = (mode: 'low' | 'high', brokerURL?: string) =>
    parse(buildTaskOverlay({ config, mode: config.modes[mode], taskId: 't1', workspace: 'C:\\ws', provider: 'strata', model: 'nvfp4-nvfp4', auditLog: 'C:\\a.jsonl', brokerURL }), {
      customTags: [{ tag: '!!js', resolve: (s: string) => ({ js: s }) }],
    }) as Array<Record<string, unknown>>

  it('routes the model and references keys only by env-var name', () => {
    const rows = rowsFor('high')
    const llm = rows.find(r => r.id === 'llm-pi-ai') as { config: { providers: Record<string, { apiKeyEnv?: string; baseURL: string }> } }
    assert.equal(llm.config.providers.strata!.apiKeyEnv, providerKeyEnv('strata'))
    assert.equal(llm.config.providers.strata!.baseURL, 'http://127.0.0.1:47831/v1')
    const def = rows.find(r => r.id === 'agent-default-model') as { config: { model: string; reasoningEffort: string } }
    assert.equal(def.config.reasoningEffort, 'high')
  })

  it('mode changes DSH composition, not just the prompt', () => {
    const low = rowsFor('low')
    const high = rowsFor('high')
    const disabled = (rows: Array<Record<string, unknown>>) => rows.filter(r => r.disabled === true).map(r => r.id)
    assert.ok(disabled(low).includes('tool-todo'))
    assert.ok(!disabled(high).includes('tool-todo'))
    const budget = (rows: Array<Record<string, unknown>>) => ((rows.find(r => Array.isArray(r.insert)) as { insert: Array<{ id: string; config: { maxSteps: number } }> }).insert.find(p => p.id === 'hearth-budget')!.config.maxSteps)
    assert.equal(budget(low), config.modes.low.maxSteps)
    assert.equal(budget(high), config.modes.high.maxSteps)
  })

  it('inserts the inference gate only when a broker is given', () => {
    const ids = (rows: Array<Record<string, unknown>>) => (rows.find(r => Array.isArray(r.insert)) as { insert: Array<{ id: string }> }).insert.map(p => p.id)
    assert.ok(!ids(rowsFor('low')).includes('hearth-inference-gate'))
    assert.ok(ids(rowsFor('low', 'http://127.0.0.1:1')).includes('hearth-inference-gate'))
  })

  it('configures the DSH tool-result pruner from the mode and validates its limits', () => {
    const rows = rowsFor('high')
    const pruner = rows.find(r => r.id === 'tool-result-pruner') as { config: { thresholdChars: number; headChars: number; tailChars: number } }
    assert.deepEqual(pruner.config, { thresholdChars: 24_000, headChars: 12_000, tailChars: 6_000 })
    assert.throws(() => resolveConfig(deepMerge(DEFAULT_RAW_CONFIG, { modes: { high: { toolResultPruneThresholdChars: 1000, toolResultPruneHeadChars: 800, toolResultPruneTailChars: 300 } } }), '.'), ConfigError)
  })

  it('keeps the system prompt identical across tasks (prefix-cache friendly)', async () => {
    const { taskMessage } = await import('../../src/dsh/overlay.ts')
    const persona = (ws: string, id: string) =>
      (parse(buildTaskOverlay({ config, mode: config.modes.medium, taskId: id, workspace: ws, provider: 'strata', model: 'nvfp4-nvfp4', auditLog: `C:\\a-${id}.jsonl` }), {
        customTags: [{ tag: '!!js', resolve: (s: string) => ({ js: s }) }],
      }) as Array<{ id?: string; config?: { personaPrefix?: string } }>).find(r => r.id === 'system-prompt')!.config!.personaPrefix
    assert.equal(persona('C:\\ws-one', 't1'), persona('D:\\other\\ws-two', 't2'))
    assert.doesNotMatch(persona('C:\\ws-one', 't1')!, /ws-one/)
    assert.match(taskMessage('C:\\ws-one', 'do it'), /^\[Hearth\] Task workspace: C:\/ws-one\n\ndo it$/)
  })

  it('keeps the headless sandbox grant expression', () => {
    const text = buildTaskOverlay({ config, mode: config.modes.low, taskId: 't', workspace: 'C:\\ws', provider: 'strata', model: 'nvfp4-nvfp4', auditLog: 'a' })
    assert.match(text, /additionalWritableRoots: !!js ctx\.headlessStartup\.additionalWritableRoots/)
    assert.doesNotMatch(text, /HEARTH_BROKER_TOKEN|Bearer/)
  })
})
