/**
 * Environment and model diagnostics.
 *
 * Checks are reported as pass / warn / fail with the exact reason. The model
 * probe sends one small non-streaming request that offers a tool, and checks
 * whether the reply contains a native tool call with parseable JSON
 * arguments — local models and quantizations differ here, so Hearth never
 * assumes support.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { HearthConfig, ProviderConfig } from '../config/types.ts'
import { repairToolArguments } from '../plugins/json-repair.ts'
import { resolveDshEntry } from '../runner/dsh-runner.ts'
import { resolveApiKey } from '../security/secrets.ts'

export interface Check {
  name: string
  status: 'pass' | 'warn' | 'fail'
  detail: string
}

function which(cmd: string, versionArgs: string[] = ['--version']): Check {
  const r = spawnSync(cmd, versionArgs, { encoding: 'utf8', windowsHide: true, timeout: 20_000 })
  if (r.error) return { name: cmd, status: 'fail', detail: r.error.message }
  const first = `${r.stdout ?? ''}${r.stderr ?? ''}`.split(/\r?\n/).find(l => l.trim()) ?? ''
  return { name: cmd, status: r.status === 0 ? 'pass' : 'warn', detail: first.trim().slice(0, 120) }
}

const ACL_SCRIPT = fileURLToPath(new URL('../security/acl-check.ps1', import.meta.url))

/**
 * Check that a workspace can host DSH's Windows ACL sandbox (needs WRITE_OWNER,
 * i.e. Full Control, for the current user). Read-only.
 * @param dir - workspace directory.
 * @param sandbox - configured sandbox mode.
 * @returns one check.
 */
export function workspaceAclCheck(dir: string, sandbox: string): Check {
  const name = `workspace ${dir}`
  if (process.platform !== 'win32' || sandbox === 'danger-full-access') return { name, status: 'pass', detail: 'no ACL sandbox in use' }
  if (!existsSync(dir)) return { name, status: 'fail', detail: 'directory does not exist' }
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ACL_SCRIPT, '-Path', dir], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
  try {
    const v = JSON.parse(r.stdout.trim()) as { writeOwner: boolean; owner: string; user: string }
    if (v.writeOwner) return { name, status: 'pass', detail: `sandbox can label it (${v.user} has Full Control)` }
    return {
      name,
      status: 'fail',
      detail: `${v.user} lacks Full Control (WRITE_OWNER) here, so the DSH ACL sandbox cannot prepare it and every pwsh/python_run/latex_compile call will fail. Grant it yourself (this changes folder permissions): icacls "${dir}" /grant "${v.user}:(OI)(CI)F"  — or use a workspace under your user profile.`,
    }
  } catch {
    return { name, status: 'warn', detail: `could not check ACL: ${(r.stderr || r.error?.message || '').trim().slice(0, 200)}` }
  }
}

/** Check the configured web search backend (one real query). */
export async function webSearchCheck(config: HearthConfig): Promise<Check> {
  const name = 'web search'
  if (config.web.search === 'none') return { name, status: 'warn', detail: 'disabled (web.search: none); web_fetch still works. Configure SearXNG to enable web_search' }
  const { parseDuckDuckGoHtml, parseSearxng } = await import('../plugins/web-search.ts')
  try {
    if (config.web.search === 'searxng') {
      const url = new URL('/search', config.web.searxngURL)
      url.searchParams.set('q', 'test')
      url.searchParams.set('format', 'json')
      const r = await fetch(url, { signal: AbortSignal.timeout(config.web.timeoutMs) })
      if (!r.ok) return { name, status: 'fail', detail: `SearXNG HTTP ${r.status} at ${config.web.searxngURL} (enable the json format in settings.yml)` }
      return { name, status: 'pass', detail: `SearXNG returned ${parseSearxng(await r.json()).length} results` }
    }
    const r = await fetch('https://html.duckduckgo.com/html/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': config.web.userAgent }, body: 'q=test', signal: AbortSignal.timeout(config.web.timeoutMs) })
    return { name, status: 'pass', detail: `DuckDuckGo returned ${parseDuckDuckGoHtml(await r.text()).length} results` }
  } catch (error) {
    return { name, status: 'fail', detail: (error as Error).message }
  }
}

export function localChecks(config: HearthConfig): Check[] {
  const checks: Check[] = []
  const major = Number(process.versions.node.split('.')[0])
  checks.push({ name: 'node', status: major >= 24 ? 'pass' : 'fail', detail: `v${process.versions.node} (DSH needs >= 24.9)` })
  try {
    const entry = resolveDshEntry(config)
    checks.push({ name: 'deepseek-harness', status: existsSync(entry) ? 'pass' : 'fail', detail: entry })
  } catch (error) {
    checks.push({ name: 'deepseek-harness', status: 'fail', detail: `not installed: ${(error as Error).message} (run npm install)` })
  }
  checks.push(which(config.tools.pythonExecutable))
  checks.push(which(config.tools.latexEngine))
  checks.push(which(config.tools.dvipdfmx))
  checks.push(which(config.tools.pdfinfo, ['-v']))
  checks.push(which(config.tools.pdffonts, ['-v']))
  checks.push(which(config.tools.pdftotext, ['-v']))
  checks.push(which(config.tools.gitExecutable))
  checks.push(which('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']))
  return checks
}

/**
 * Probe one provider: model list and native tool calling.
 * @param provider - provider config.
 * @param modelId - model to probe (default: first configured).
 * @returns checks for reachability, model presence, and tool calling.
 */
export async function probeProvider(provider: ProviderConfig, modelId?: string): Promise<Check[]> {
  const checks: Check[] = []
  let key: string | undefined
  try {
    key = resolveApiKey(provider.apiKey)
  } catch (error) {
    return [{ name: `${provider.name}: api key`, status: 'fail', detail: (error as Error).message }]
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', ...provider.headers }
  if (key) headers.authorization = `Bearer ${key}`
  if (provider.api !== 'openai-completions') {
    return [{ name: `${provider.name}: probe`, status: 'warn', detail: `probe implemented for openai-completions only (provider uses ${provider.api})` }]
  }
  let served: string[] = []
  try {
    const res = await fetch(`${provider.baseURL}/models`, { headers, signal: AbortSignal.timeout(10_000) })
    if (!res.ok) {
      checks.push({ name: `${provider.name}: GET /models`, status: 'fail', detail: `HTTP ${res.status} ${(await res.text()).slice(0, 200)}` })
      return checks
    }
    const body = (await res.json()) as { data?: Array<{ id: string }> }
    served = (body.data ?? []).map(m => m.id)
    checks.push({ name: `${provider.name}: GET /models`, status: 'pass', detail: served.join(', ') || '(empty list)' })
  } catch (error) {
    checks.push({ name: `${provider.name}: GET /models`, status: 'fail', detail: `${provider.baseURL} unreachable: ${(error as Error).message}` })
    return checks
  }
  const model = modelId && modelId !== 'auto' ? modelId : (served[0] ?? provider.models[0]?.id)
  if (!model) return [...checks, { name: `${provider.name}: tool calling`, status: 'fail', detail: 'no model configured or served' }]
  if (served.length && !served.includes(model)) {
    checks.push({ name: `${provider.name}: model ${model}`, status: 'warn', detail: `not in the served list; configured ids should match one of: ${served.join(', ')}` })
  }
  const started = Date.now()
  try {
    const res = await fetch(`${provider.baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(provider.probeTimeoutMs),
      body: JSON.stringify({
        model,
        max_tokens: 512,
        temperature: 0,
        messages: [
          { role: 'system', content: 'You are a tool-calling test. Always answer by calling the provided tool.' },
          { role: 'user', content: 'Call get_weather for the city Tokyo with unit "celsius".' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get the weather for a city.',
              parameters: { type: 'object', properties: { city: { type: 'string' }, unit: { type: 'string', enum: ['celsius', 'fahrenheit'] } }, required: ['city'] },
            },
          },
        ],
        chat_template_kwargs: { enable_thinking: false },
      }),
    })
    const ms = Date.now() - started
    if (!res.ok) {
      checks.push({ name: `${provider.name}: tool calling`, status: 'fail', detail: `HTTP ${res.status} ${(await res.text()).slice(0, 200)}` })
      return checks
    }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }>; usage?: { completion_tokens?: number } }
    const call = body.choices?.[0]?.message?.tool_calls?.[0]
    const tps = body.usage?.completion_tokens ? ` ~${((body.usage.completion_tokens / ms) * 1000).toFixed(1)} tok/s` : ''
    if (!call?.function) {
      checks.push({ name: `${provider.name}: tool calling`, status: 'fail', detail: `no native tool call returned (${ms} ms). Reply: ${(body.choices?.[0]?.message?.content ?? '').slice(0, 160)}` })
    } else {
      const parsed = repairToolArguments(call.function.arguments ?? '')
      if (!parsed.ok) checks.push({ name: `${provider.name}: tool calling`, status: 'fail', detail: `tool call with unparseable arguments: ${parsed.error}` })
      else if (parsed.repaired) checks.push({ name: `${provider.name}: tool calling`, status: 'warn', detail: `arguments needed repair (${parsed.fixes.join(', ')}); Hearth will repair these at runtime (${ms} ms${tps})` })
      else if (call.function.name !== 'get_weather' || String(parsed.value.city ?? '').toLowerCase() !== 'tokyo') checks.push({ name: `${provider.name}: tool calling`, status: 'warn', detail: `unexpected call ${call.function.name}(${call.function.arguments}) (${ms} ms)` })
      else checks.push({ name: `${provider.name}: tool calling`, status: 'pass', detail: `${call.function.name}(${call.function.arguments}) in ${ms} ms${tps}` })
    }
  } catch (error) {
    checks.push({ name: `${provider.name}: tool calling`, status: 'fail', detail: (error as Error).message })
  }
  return checks
}
