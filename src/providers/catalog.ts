/**
 * Runtime model catalog owned by the daemon.
 *
 * It merges discovered models into the in-memory provider config (so task
 * overlays register them with DSH), tracks which models each discovering
 * provider serves right now, and resolves user choices — including
 * `<provider>/auto`, meaning "whatever the server currently serves first".
 */
import type { HearthConfig, ModelConfig } from '../config/types.ts'
import { fetchModelList, mergeDiscovered, type DiscoveredModel } from './discovery.ts'

export class CatalogError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CatalogError'
    this.code = code
  }
}

export interface CatalogEntry {
  id: string
  provider: string
  model: string
  name: string
  providerName: string
  /** true/false for discovering providers; null when the server is not asked. */
  available: boolean | null
  discovered: boolean
  contextWindow: number
  maxTokens: number
  reasoning: boolean
}

interface ProviderState {
  available: string[]
  refreshedAt: number
  error?: string
  discovered: Set<string>
}

export type ModelFetcher = (provider: HearthConfig['providers'][string]) => Promise<DiscoveredModel[]>

export class ModelCatalog {
  private readonly config: HearthConfig
  private readonly fetcher: ModelFetcher
  private readonly state = new Map<string, ProviderState>()
  private timer: NodeJS.Timeout | undefined
  private inflight: Promise<void> | undefined

  constructor(config: HearthConfig, fetcher: ModelFetcher = p => fetchModelList(p)) {
    this.config = config
    this.fetcher = fetcher
  }

  /** Refresh every discovering provider (concurrent calls share one refresh). */
  refresh(): Promise<void> {
    this.inflight ??= (async () => {
      await Promise.all(
        Object.values(this.config.providers)
          .filter(p => p.discoverModels)
          .map(async p => {
            const prev = this.state.get(p.name)
            const discoveredIds = prev?.discovered ?? new Set<string>()
            try {
              const found = await this.fetcher(p)
              const merged = mergeDiscovered(p, found)
              p.models = merged.models
              for (const id of merged.added) discoveredIds.add(id)
              this.state.set(p.name, { available: merged.available, refreshedAt: Date.now(), discovered: discoveredIds })
            } catch (error) {
              this.state.set(p.name, { available: prev?.available ?? [], refreshedAt: Date.now(), error: (error as Error).message, discovered: discoveredIds })
            }
          }),
      )
    })().finally(() => {
      this.inflight = undefined
    })
    return this.inflight
  }

  start(intervalMs: number): void {
    void this.refresh()
    if (intervalMs > 0) {
      this.timer = setInterval(() => void this.refresh(), intervalMs)
      this.timer.unref()
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }

  status(): Record<string, { available: string[]; refreshedAt: string | null; error?: string }> {
    const out: Record<string, { available: string[]; refreshedAt: string | null; error?: string }> = {}
    for (const p of Object.values(this.config.providers)) {
      if (!p.discoverModels) continue
      const s = this.state.get(p.name)
      out[p.name] = { available: s?.available ?? [], refreshedAt: s ? new Date(s.refreshedAt).toISOString() : null, ...(s?.error ? { error: s.error } : {}) }
    }
    return out
  }

  list(): CatalogEntry[] {
    return Object.values(this.config.providers).flatMap(p =>
      p.models.map((m: ModelConfig) => {
        const s = this.state.get(p.name)
        return {
          id: `${p.name}/${m.id}`,
          provider: p.name,
          model: m.id,
          name: m.displayName,
          providerName: p.displayName,
          // Unknown (null) unless the last discovery succeeded.
          available: p.discoverModels && s && !s.error ? s.available.includes(m.id) : null,
          discovered: s?.discovered.has(m.id) ?? false,
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          reasoning: m.reasoning,
        }
      }),
    )
  }

  /**
   * Turn a user choice into a concrete configured model.
   * @param provider - provider name.
   * @param model - model id or `auto`.
   * @returns the concrete model id.
   */
  async resolve(provider: string, model: string): Promise<string> {
    const p = this.config.providers[provider]
    if (!p) throw new CatalogError('BAD_MODEL', `provider ${provider} is not configured`)
    if (p.discoverModels && (!this.state.has(provider) || (model !== 'auto' && !p.models.some(m => m.id === model)))) await this.refresh()
    const s = this.state.get(provider)
    if (model === 'auto') {
      const served = s?.available.find(id => p.models.some(m => m.id === id))
      if (served) return served
      if (p.discoverModels && s?.error && p.models.length === 0) throw new CatalogError('NO_MODEL', `${provider} is unreachable (${s.error}) and has no configured models`)
      if (p.discoverModels && s && !s.error && s.available.length === 0) throw new CatalogError('NO_MODEL', `${provider} currently serves no model; load one in the server first`)
      const first = p.models[0]
      if (!first) throw new CatalogError('NO_MODEL', `${provider} has no models`)
      return first.id
    }
    if (!p.models.some(m => m.id === model)) {
      const served = s?.available.length ? ` (served now: ${s.available.join(', ')})` : ''
      throw new CatalogError('BAD_MODEL', `model ${provider}/${model} is not configured or served${served}`)
    }
    if (p.discoverModels && s && !s.error && !s.available.includes(model)) {
      throw new CatalogError('MODEL_NOT_LOADED', `model ${provider}/${model} is not loaded on ${p.displayName} right now (served: ${s.available.join(', ') || 'none'}). Load it there or choose ${provider}/auto.`)
    }
    return model
  }
}
