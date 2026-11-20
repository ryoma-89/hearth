import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DEFAULT_RAW_CONFIG } from '../../src/config/defaults.ts'
import { ConfigError, deepMerge, resolveConfig } from '../../src/config/load.ts'
import { CatalogError, ModelCatalog } from '../../src/providers/catalog.ts'
import { mergeDiscovered, parseModelList } from '../../src/providers/discovery.ts'

const config = () =>
  resolveConfig(
    deepMerge(DEFAULT_RAW_CONFIG, {
      providers: {
        strata: { apiKey: 'none' },
        lmstudio: { baseURL: 'http://127.0.0.1:1234/v1', apiKey: 'none', models: [{ id: 'fixed', contextWindow: 8192, maxTokens: 1024 }] },
      },
    }),
    'C:\\proj',
  )

describe('parseModelList', () => {
  it('understands OpenAI, STRATA, and llama.cpp shapes', () => {
    const models = parseModelList({
      data: [
        { id: 'nvfp4-nvfp4', object: 'model', meta: { label: 'Qwen3.8-Flash-Next (NVFP4) NVFP4', aliases: ['nvfp4-nvfp4'] } },
        { id: 'llama', meta: { n_ctx_train: 32768 } },
        { id: 'plain' },
        { nope: true },
      ],
    })
    assert.deepEqual(models, [{ id: 'nvfp4-nvfp4', label: 'Qwen3.8-Flash-Next (NVFP4) NVFP4' }, { id: 'llama', contextWindow: 32768 }, { id: 'plain' }])
    assert.deepEqual(parseModelList({ error: 'x' }), [])
  })
})

describe('mergeDiscovered', () => {
  it('adds new models with provider defaults, keeps configured entries, never removes', () => {
    const p = config().providers.strata!
    const r = mergeDiscovered(p, [{ id: 'iq3_s', label: 'Qwen IQ3_S' }, { id: 'nvfp4-nvfp4' }])
    assert.deepEqual(r.added, ['iq3_s'])
    assert.deepEqual(r.available, ['iq3_s', 'nvfp4-nvfp4'])
    const added = r.models.find(m => m.id === 'iq3_s')!
    assert.equal(added.displayName, 'Qwen IQ3_S')
    assert.equal(added.contextWindow, 131072)
    assert.equal(added.reasoning, true)
    const r2 = mergeDiscovered({ ...p, models: r.models }, [])
    assert.equal(r2.models.length, r.models.length, 'unloaded models stay registered')
  })
})

describe('ModelCatalog', () => {
  it('resolves auto to the served model and follows a server-side switch', async () => {
    const c = config()
    let served = [{ id: 'nvfp4-nvfp4' }]
    const catalog = new ModelCatalog(c, async p => (p.name === 'strata' ? served : []))
    assert.equal(await catalog.resolve('strata', 'auto'), 'nvfp4-nvfp4')
    served = [{ id: 'iq3_s' }]
    await catalog.refresh()
    assert.equal(await catalog.resolve('strata', 'auto'), 'iq3_s')
    assert.ok(c.providers.strata!.models.some(m => m.id === 'iq3_s'), 'discovered model merged into the live config')
    const list = catalog.list()
    assert.equal(list.find(m => m.id === 'strata/iq3_s')!.available, true)
    assert.equal(list.find(m => m.id === 'strata/nvfp4-nvfp4')!.available, false)
    assert.equal(list.find(m => m.id === 'lmstudio/fixed')!.available, null, 'non-discovering providers are not probed')
  })

  it('refuses a configured model the server is not serving, and unknown models', async () => {
    const catalog = new ModelCatalog(config(), async () => [{ id: 'iq3_s' }])
    await assert.rejects(catalog.resolve('strata', 'nvfp4-nvfp4'), (e: unknown) => e instanceof CatalogError && e.code === 'MODEL_NOT_LOADED')
    await assert.rejects(catalog.resolve('strata', 'nope'), (e: unknown) => e instanceof CatalogError && e.code === 'BAD_MODEL')
    await assert.rejects(catalog.resolve('missing', 'x'), (e: unknown) => e instanceof CatalogError)
    assert.equal(await catalog.resolve('lmstudio', 'auto'), 'fixed')
  })

  it('falls back to configured models when the server is unreachable', async () => {
    const catalog = new ModelCatalog(config(), async () => {
      throw new Error('ECONNREFUSED')
    })
    assert.equal(await catalog.resolve('strata', 'auto'), 'nvfp4-nvfp4')
    assert.equal(await catalog.resolve('strata', 'nvfp4-nvfp4'), 'nvfp4-nvfp4', 'availability unknown: allowed')
    assert.match(catalog.status().strata!.error!, /ECONNREFUSED/)
  })
})

describe('config for discovery', () => {
  it('accepts auto and discovering providers without listed models', () => {
    const c = resolveConfig(deepMerge(DEFAULT_RAW_CONFIG, { defaultModel: 'local/auto', providers: { local: { baseURL: 'http://127.0.0.1:8081/v1', apiKey: 'none', discoverModels: true, models: [] } } }), '.')
    assert.equal(c.defaultModel.model, 'auto')
    assert.equal(c.providers.local!.discoverModels, true)
  })
  it('still requires models for providers that do not discover', () => {
    assert.throws(() => resolveConfig(deepMerge(DEFAULT_RAW_CONFIG, { providers: { x: { baseURL: 'http://h/v1', apiKey: 'none', models: [] } } }), '.'), ConfigError)
  })
})
