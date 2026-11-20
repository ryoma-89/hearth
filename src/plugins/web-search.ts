/**
 * DSH plugin: a web search provider that needs no DeepSeek account.
 *
 * DSH's `web_search` tool searches through whichever provider is registered on
 * `ctx.web`; the shipped ones need a DeepSeek API key. This plugin registers
 * `hearth-search`, backed by either
 *  - a SearXNG instance (JSON API; self-hosted, the most private option), or
 *  - DuckDuckGo's HTML endpoint (no key; queries go to DuckDuckGo).
 * Bot-detection pages are reported as errors; they are never worked around.
 */
import type { Context } from '@deepseek-ai/cordis'
import { emitTelemetry } from './telemetry.ts'

export const name = 'hearth-web-search'
export const inject = ['web']

export interface Config {
  backend: 'duckduckgo' | 'searxng'
  searxngURL: string
  timeoutMs: number
  userAgent: string
}

export interface SearchSource {
  url: string
  title?: string
  snippet?: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' }

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    const lower = e.toLowerCase()
    if (ENTITIES[lower]) return ENTITIES[lower]!
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10))
    return m
  })
}

const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()

/** Resolve DuckDuckGo's redirect links (`//duckduckgo.com/l/?uddg=...`). */
function unwrapDdgLink(href: string): string | undefined {
  const raw = decodeEntities(href)
  try {
    const u = new URL(raw, 'https://duckduckgo.com')
    const target = u.searchParams.get('uddg')
    const final = target ? decodeURIComponent(target) : u.href
    const parsed = new URL(final)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined
    if (parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname.startsWith('/y.js')) return undefined // ads
    return parsed.href
  } catch {
    return undefined
  }
}

/**
 * Parse DuckDuckGo's HTML result page.
 * @param html - response body.
 * @returns sources in page order.
 */
export function parseDuckDuckGoHtml(html: string): SearchSource[] {
  if (/anomaly-modal|captcha|challenge-form/i.test(html)) throw new Error('DuckDuckGo returned a bot-detection page instead of results; try again later or configure a SearXNG instance (web.search: searxng)')
  const out: SearchSource[] = []
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/i).slice(1)
  for (const block of blocks) {
    const a = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block) ?? /<a[^>]+href="([^"]+)"[^>]+class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>/i.exec(block)
    if (!a) continue
    const url = unwrapDdgLink(a[1]!)
    if (!url || out.some(s => s.url === url)) continue
    const snippet = /<(?:a|div)[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div)>/i.exec(block)
    out.push({ url, title: stripTags(a[2]!), ...(snippet ? { snippet: stripTags(snippet[1]!) } : {}) })
  }
  return out
}

/**
 * Parse a SearXNG JSON response.
 * @param body - parsed JSON.
 * @returns sources.
 */
export function parseSearxng(body: unknown): SearchSource[] {
  const results = (body as { results?: Array<{ url?: string; title?: string; content?: string }> })?.results ?? []
  return results.filter(r => typeof r.url === 'string').map(r => ({ url: r.url!, ...(r.title ? { title: r.title } : {}), ...(r.content ? { snippet: r.content } : {}) }))
}

async function fetchText(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<{ status: number; text: string }> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const res = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
  return { status: res.status, text: await res.text() }
}

/**
 * Plugin entry.
 * @param ctx - Cordis context.
 * @param config - backend selection.
 */
export function apply(ctx: Context, config: Config): void {
  const web = (ctx as unknown as { web: { registerSearchProvider(p: unknown): () => void } }).web
  ctx.effect(() =>
    web.registerSearchProvider({
      id: 'hearth-search',
      title: config.backend === 'searxng' ? 'SearXNG (Hearth)' : 'DuckDuckGo (Hearth)',
      available: () => config.backend !== 'searxng' || Boolean(config.searxngURL),
      async search(request: { query: string; maxResults?: number }, signal?: AbortSignal) {
        const started = Date.now()
        let sources: SearchSource[]
        if (config.backend === 'searxng') {
          const url = new URL('/search', config.searxngURL)
          url.searchParams.set('q', request.query)
          url.searchParams.set('format', 'json')
          const r = await fetchText(url.href, { headers: { accept: 'application/json', 'user-agent': config.userAgent } }, config.timeoutMs, signal)
          if (r.status !== 200) throw new Error(`SearXNG returned HTTP ${r.status} (is format=json enabled in its settings?)`)
          sources = parseSearxng(JSON.parse(r.text))
        } else {
          const r = await fetchText(
            'https://html.duckduckgo.com/html/',
            { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': config.userAgent }, body: new URLSearchParams({ q: request.query }).toString() },
            config.timeoutMs,
            signal,
          )
          if (r.status !== 200) throw new Error(`DuckDuckGo returned HTTP ${r.status}`)
          sources = parseDuckDuckGoHtml(r.text)
        }
        const limit = request.maxResults ?? sources.length
        emitTelemetry({ event: 'web-search', backend: config.backend, results: sources.length, ms: Date.now() - started })
        return { sources: sources.slice(0, limit), truncated: sources.length > limit }
      },
    }),
  )
  emitTelemetry({ event: 'plugin-ready', plugin: name })
}
