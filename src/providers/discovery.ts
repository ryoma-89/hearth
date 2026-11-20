/**
 * Model discovery for OpenAI-compatible servers.
 *
 * GET {baseURL}/models is parsed leniently: the OpenAI `data` list, STRATA's
 * `meta.label`, and llama.cpp's `meta.n_ctx_train` are understood. The
 * catalog keeps every model it has ever seen (configured or discovered):
 * a model STRATA unloads stays registered as "not available" so resumed
 * sessions that used it still have an adapter route (DSH may need it to
 * summarize history on a model switch).
 */
import type { ModelConfig, ProviderConfig } from '../config/types.ts'
import { resolveApiKey } from '../security/secrets.ts'

export interface DiscoveredModel {
  id: string
  label?: string
  contextWindow?: number
}

/**
 * Parse a /models response body.
 * @param body - parsed JSON.
 * @returns models in server order.
 */
export function parseModelList(body: unknown): DiscoveredModel[] {
  const data = (body as { data?: unknown[] })?.data
  if (!Array.isArray(data)) return []
  const out: DiscoveredModel[] = []
  for (const item of data) {
    if (typeof item !== 'object' || item === null) continue
    const m = item as { id?: unknown; meta?: { label?: unknown; n_ctx_train?: unknown; n_ctx?: unknown }; context_length?: unknown; max_context_length?: unknown }
    if (typeof m.id !== 'string' || !m.id) continue
    const ctx = [m.meta?.n_ctx, m.meta?.n_ctx_train, m.context_length, m.max_context_length].find(v => typeof v === 'number' && Number.isInteger(v) && v >= 1024) as number | undefined
    out.push({ id: m.id, ...(typeof m.meta?.label === 'string' ? { label: m.meta.label } : {}), ...(ctx ? { contextWindow: ctx } : {}) })
  }
  return out
}

/**
 * Ask one provider which models it serves.
 * @param provider - provider config (discoverModels should be true).
 * @param timeoutMs - request deadline.
 * @returns discovered models.
 */
export async function fetchModelList(provider: ProviderConfig, timeoutMs = 10_000): Promise<DiscoveredModel[]> {
  if (provider.api !== 'openai-completions' && provider.api !== 'openai-responses') throw new Error(`model discovery supports OpenAI-compatible APIs only (provider uses ${provider.api})`)
  const headers: Record<string, string> = { accept: 'application/json', ...provider.headers }
  const key = resolveApiKey(provider.apiKey)
  if (key) headers.authorization = `Bearer ${key}`
  const res = await fetch(`${provider.baseURL.replace(/\/$/, '')}/models`, { headers, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`GET /models returned HTTP ${res.status}`)
  return parseModelList(await res.json())
}

/** Build the model entry for a discovered id using the provider's defaults. */
export function modelFromDiscovery(provider: ProviderConfig, d: DiscoveredModel): ModelConfig {
  const defaults = provider.discoveredModelDefaults
  const contextWindow = d.contextWindow ?? defaults.contextWindow
  return {
    id: d.id,
    displayName: d.label ?? d.id,
    contextWindow,
    maxTokens: Math.min(defaults.maxTokens, Math.max(256, Math.floor(contextWindow / 2))),
    reasoning: defaults.reasoning,
    toolCalling: defaults.toolCalling,
    input: [...defaults.input],
  }
}

export interface MergeResult {
  models: ModelConfig[]
  added: string[]
  available: string[]
}

/**
 * Merge discovered models into a provider's list. Configured entries win
 * (their capabilities are authoritative); nothing is ever removed.
 * @param provider - provider whose `models` are the current catalog.
 * @param discovered - what the server reports now.
 * @returns the new list, newly added ids, and the ids currently served.
 */
export function mergeDiscovered(provider: ProviderConfig, discovered: DiscoveredModel[]): MergeResult {
  const models = [...provider.models]
  const added: string[] = []
  for (const d of discovered) {
    if (models.some(m => m.id === d.id)) continue
    models.push(modelFromDiscovery(provider, d))
    added.push(d.id)
  }
  return { models, added, available: discovered.map(d => d.id) }
}
