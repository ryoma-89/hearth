/**
 * Load, merge, and validate Hearth configuration.
 *
 * Precedence: built-in defaults < config file < explicit overrides (CLI).
 * Validation collects every problem and fails loudly with field paths.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { DEFAULT_MODES, DEFAULT_RAW_CONFIG, HEARTH_TOOL_NAMES } from './defaults.ts'
import {
  MODE_NAMES,
  type ApiKeySource,
  type HearthConfig,
  type ModeConfig,
  type ModeName,
  type ModelConfig,
  type ProviderConfig,
} from './types.ts'

export class ConfigError extends Error {
  readonly problems: string[]
  constructor(problems: string[], source: string) {
    super(`Invalid Hearth configuration (${source}):\n  - ${problems.join('\n  - ')}`)
    this.name = 'ConfigError'
    this.problems = problems
  }
}

type Raw = Record<string, unknown>

function isRecord(value: unknown): value is Raw {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Deep-merge plain objects; arrays and scalars from `over` replace `base`. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (over === undefined) return base
  if (isRecord(base) && isRecord(over)) {
    const out: Raw = { ...base }
    for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v)
    return out
  }
  return over
}

class Validator {
  readonly problems: string[] = []
  str(obj: Raw, key: string, path: string): string {
    const v = obj[key]
    if (typeof v !== 'string' || v.length === 0) {
      this.problems.push(`${path}.${key} must be a non-empty string`)
      return ''
    }
    return v
  }
  num(obj: Raw, key: string, path: string, min = 0, integer = true): number {
    const v = obj[key]
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || (integer && !Number.isInteger(v))) {
      this.problems.push(`${path}.${key} must be ${integer ? 'an integer' : 'a number'} >= ${min}`)
      return min
    }
    return v
  }
  bool(obj: Raw, key: string, path: string): boolean {
    const v = obj[key]
    if (typeof v !== 'boolean') {
      this.problems.push(`${path}.${key} must be true or false`)
      return false
    }
    return v
  }
  strList(obj: Raw, key: string, path: string): string[] {
    const v = obj[key]
    if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
      this.problems.push(`${path}.${key} must be a list of strings`)
      return []
    }
    return v as string[]
  }
  oneOf<T extends string>(obj: Raw, key: string, path: string, allowed: readonly T[]): T {
    const v = obj[key]
    if (typeof v !== 'string' || !allowed.includes(v as T)) {
      this.problems.push(`${path}.${key} must be one of ${allowed.join(', ')} (got ${JSON.stringify(v)})`)
      return allowed[0]!
    }
    return v as T
  }
  record(obj: Raw, key: string, path: string): Raw {
    const v = obj[key]
    if (!isRecord(v)) {
      this.problems.push(`${path}.${key} must be a mapping`)
      return {}
    }
    return v
  }
}

function parseApiKey(v: Validator, raw: unknown, path: string): ApiKeySource {
  if (raw === undefined || raw === null || raw === 'none') return { kind: 'none' }
  if (typeof raw === 'string') {
    v.problems.push(`${path} must not contain a literal key; use { env: NAME } or { secret: NAME }`)
    return { kind: 'none' }
  }
  if (isRecord(raw)) {
    if (typeof raw.env === 'string' && raw.env) return { kind: 'env', name: raw.env }
    if (typeof raw.secret === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(raw.secret)) return { kind: 'secret', name: raw.secret }
  }
  v.problems.push(`${path} must be "none", { env: NAME }, or { secret: NAME }`)
  return { kind: 'none' }
}

function parseModel(v: Validator, raw: unknown, path: string): ModelConfig {
  if (!isRecord(raw)) {
    v.problems.push(`${path} must be a mapping`)
    return { id: '', displayName: '', contextWindow: 0, maxTokens: 0, reasoning: false, toolCalling: 'unknown', input: ['text'] }
  }
  const id = v.str(raw, 'id', path)
  const contextWindow = v.num(raw, 'contextWindow', path, 1024)
  const maxTokens = v.num(raw, 'maxTokens', path, 16)
  if (maxTokens >= contextWindow) v.problems.push(`${path}.maxTokens must be smaller than contextWindow`)
  const input = raw.input === undefined ? ['text'] : v.strList(raw, 'input', path)
  for (const kind of input) if (kind !== 'text' && kind !== 'image') v.problems.push(`${path}.input entries must be text or image`)
  return {
    id,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : id,
    contextWindow,
    maxTokens,
    reasoning: raw.reasoning === undefined ? false : v.bool(raw, 'reasoning', path),
    toolCalling: raw.toolCalling === undefined ? 'unknown' : v.oneOf(raw, 'toolCalling', path, ['native', 'unknown'] as const),
    input: input as Array<'text' | 'image'>,
  }
}

function parseProvider(v: Validator, name: string, raw: unknown): ProviderConfig {
  const path = `providers.${name}`
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) v.problems.push(`${path}: provider names must be lowercase letters, digits, and hyphens`)
  const r = isRecord(raw) ? raw : (v.problems.push(`${path} must be a mapping`), {})
  const baseURL = v.str(r, 'baseURL', path)
  if (baseURL) {
    try {
      const u = new URL(baseURL)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') v.problems.push(`${path}.baseURL must be http(s)`)
    } catch {
      v.problems.push(`${path}.baseURL is not a valid URL`)
    }
  }
  const modelsRaw = r.models
  const models = Array.isArray(modelsRaw) ? modelsRaw.map((m, i) => parseModel(v, m, `${path}.models[${i}]`)) : []
  const discoverModels = r.discoverModels === undefined ? false : v.bool(r, 'discoverModels', path)
  if (models.length === 0 && !discoverModels) v.problems.push(`${path}.models must list at least one model (or set discoverModels: true)`)
  const defaultsRaw = isRecord(r.discoveredModelDefaults) ? r.discoveredModelDefaults : {}
  const discoveredDefaults = parseModel(v, { id: 'discovered', contextWindow: 32768, maxTokens: 4096, ...defaultsRaw }, `${path}.discoveredModelDefaults`)
  const headers = r.headers === undefined ? {} : v.record(r, 'headers', path)
  for (const [hk, hv] of Object.entries(headers)) if (typeof hv !== 'string') v.problems.push(`${path}.headers.${hk} must be a string`)
  return {
    name,
    api: r.api === undefined ? 'openai-completions' : v.oneOf(r, 'api', path, ['openai-completions', 'openai-responses', 'anthropic-messages'] as const),
    displayName: typeof r.displayName === 'string' ? r.displayName : name,
    baseURL,
    apiKey: parseApiKey(v, r.apiKey, `${path}.apiKey`),
    timeoutMs: r.timeoutMs === undefined ? 600_000 : v.num(r, 'timeoutMs', path, 1000),
    probeTimeoutMs: r.probeTimeoutMs === undefined ? 120_000 : v.num(r, 'probeTimeoutMs', path, 1000),
    compat: r.compat === undefined ? {} : v.record(r, 'compat', path),
    headers: headers as Record<string, string>,
    maxRetries: r.maxRetries === undefined ? 3 : v.num(r, 'maxRetries', path, 0),
    models,
    discoverModels,
    discoveredModelDefaults: { contextWindow: discoveredDefaults.contextWindow, maxTokens: discoveredDefaults.maxTokens, reasoning: discoveredDefaults.reasoning, toolCalling: discoveredDefaults.toolCalling, input: discoveredDefaults.input },
  }
}

function parseMode(v: Validator, name: ModeName, raw: unknown): ModeConfig {
  const base = DEFAULT_MODES[name]
  const r = deepMerge(base, raw) as Raw
  const path = `modes.${name}`
  const mode: ModeConfig = {
    name,
    description: typeof r.description === 'string' ? r.description : base.description,
    maxSteps: v.num(r, 'maxSteps', path, 1),
    maxWallTimeMs: v.num(r, 'maxWallTimeMs', path, 1000),
    maxTotalTokens: v.num(r, 'maxTotalTokens', path, 1000),
    maxConsecutiveToolFailures: v.num(r, 'maxConsecutiveToolFailures', path, 1),
    malformedToolCallRetries: v.num(r, 'malformedToolCallRetries', path, 0),
    verificationRounds: v.num(r, 'verificationRounds', path, 0),
    strictVerification: v.bool(r, 'strictVerification', path),
    reasoningEffort: v.oneOf(r, 'reasoningEffort', path, ['off', 'low', 'medium', 'high'] as const),
    requirePlan: v.bool(r, 'requirePlan', path),
    hearthTools: v.strList(r, 'hearthTools', path),
    disabledDshRows: v.strList(r, 'disabledDshRows', path),
    compactionThresholdRatio: v.num(r, 'compactionThresholdRatio', path, 0.1, false),
    compactionHeadroomTokens: v.num(r, 'compactionHeadroomTokens', path, 0),
    toolResultPruneThresholdChars: v.num(r, 'toolResultPruneThresholdChars', path, 256),
    toolResultPruneHeadChars: v.num(r, 'toolResultPruneHeadChars', path, 0),
    toolResultPruneTailChars: v.num(r, 'toolResultPruneTailChars', path, 0),
    repeatReminderThresholds: Array.isArray(r.repeatReminderThresholds) ? (r.repeatReminderThresholds as number[]) : [],
  }
  if (mode.compactionThresholdRatio >= 1) v.problems.push(`${path}.compactionThresholdRatio must be below 1`)
  // DSH requires head + marker (~40 chars) + tail to fit within the threshold.
  if (mode.toolResultPruneHeadChars + mode.toolResultPruneTailChars + 64 > mode.toolResultPruneThresholdChars) v.problems.push(`${path}.toolResultPruneHeadChars + toolResultPruneTailChars must be at least 64 below toolResultPruneThresholdChars`)
  for (const t of mode.hearthTools) {
    if (!(HEARTH_TOOL_NAMES as readonly string[]).includes(t)) v.problems.push(`${path}.hearthTools: unknown tool ${t}`)
  }
  if (mode.repeatReminderThresholds.some(n => !Number.isInteger(n) || n < 1)) v.problems.push(`${path}.repeatReminderThresholds must be positive integers`)
  return mode
}

function absolutize(baseDir: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(baseDir, p)
}

/**
 * Validate a merged raw document into a resolved config.
 * @param raw - defaults already merged with user values.
 * @param baseDir - directory that relative paths resolve against.
 * @param source - label used in error messages.
 * @returns the resolved configuration.
 */
export function resolveConfig(raw: unknown, baseDir: string, source = 'config'): HearthConfig {
  const v = new Validator()
  const r = isRecord(raw) ? raw : {}
  const dshRaw = v.record(r, 'dsh', '')
  const providersRaw = v.record(r, 'providers', '')
  const providers: Record<string, ProviderConfig> = {}
  for (const [name, p] of Object.entries(providersRaw)) {
    if (p === null) continue // allow removing a default provider with `name: null`
    providers[name] = parseProvider(v, name, p)
  }
  const modesRaw = r.modes === undefined ? {} : v.record(r, 'modes', '')
  for (const key of Object.keys(modesRaw)) {
    if (!(MODE_NAMES as readonly string[]).includes(key)) v.problems.push(`modes.${key}: unknown mode (allowed: ${MODE_NAMES.join(', ')})`)
  }
  const modes = Object.fromEntries(MODE_NAMES.map(m => [m, parseMode(v, m, modesRaw[m])])) as Record<ModeName, ModeConfig>

  const defaultModelStr = typeof r.defaultModel === 'string' ? r.defaultModel : ''
  const slash = defaultModelStr.indexOf('/')
  const defaultModel = { provider: defaultModelStr.slice(0, slash), model: defaultModelStr.slice(slash + 1) }
  if (slash <= 0) v.problems.push('defaultModel must be "<provider>/<model-id>"')
  else if (!providers[defaultModel.provider]) v.problems.push(`defaultModel: provider ${defaultModel.provider} is not configured`)
  else if (defaultModel.model !== 'auto' && !providers[defaultModel.provider]!.discoverModels && !providers[defaultModel.provider]!.models.some(m => m.id === defaultModel.model)) {
    v.problems.push(`defaultModel: model ${defaultModel.model} is not listed under providers.${defaultModel.provider}.models (use "${defaultModel.provider}/auto" or enable discoverModels)`)
  } else if (defaultModel.model === 'auto' && !providers[defaultModel.provider]!.discoverModels && providers[defaultModel.provider]!.models.length === 0) {
    v.problems.push(`defaultModel: ${defaultModel.provider}/auto needs listed models or discoverModels: true`)
  }

  const queueRaw = v.record(r, 'queue', '')
  const securityRaw = v.record(r, 'security', '')
  const toolsRaw = v.record(r, 'tools', '')
  const daemonRaw = v.record(r, 'daemon', '')
  const webRaw = v.record(r, 'web', '')

  const config: HearthConfig = {
    baseDir,
    stateDir: absolutize(baseDir, v.str(r, 'stateDir', '')),
    dsh: {
      entry: v.str(dshRaw, 'entry', 'dsh'),
      home: absolutize(baseDir, v.str(dshRaw, 'home', 'dsh')),
      nodeExecutable: v.str(dshRaw, 'nodeExecutable', 'dsh'),
      extraPatches: v.strList(dshRaw, 'extraPatches', 'dsh').map(p => absolutize(baseDir, p)),
      titleGeneration: v.bool(dshRaw, 'titleGeneration', 'dsh'),
    },
    defaultModel,
    defaultMode: v.oneOf(r, 'defaultMode', '', MODE_NAMES),
    defaultWorkspace: absolutize(baseDir, v.str(r, 'defaultWorkspace', '')),
    providers,
    modes,
    queue: {
      maxConcurrentInference: v.num(queueRaw, 'maxConcurrentInference', 'queue', 1),
      maxConcurrentTasks: v.num(queueRaw, 'maxConcurrentTasks', 'queue', 1),
      leaseTtlMs: v.num(queueRaw, 'leaseTtlMs', 'queue', 1000),
      maxLeaseMs: v.num(queueRaw, 'maxLeaseMs', 'queue', 1000),
      leaseWaitTimeoutMs: v.num(queueRaw, 'leaseWaitTimeoutMs', 'queue', 1000),
      taskTimeoutMs: v.num(queueRaw, 'taskTimeoutMs', 'queue', 1000),
    },
    security: {
      sandbox: v.oneOf(securityRaw, 'sandbox', 'security', ['read-only', 'workspace-write', 'danger-full-access'] as const),
      allowedWorkspaceRoots: v.strList(securityRaw, 'allowedWorkspaceRoots', 'security').map(p => absolutize(baseDir, p)),
      protectedPaths: v.strList(securityRaw, 'protectedPaths', 'security'),
      allowOverwrite: v.bool(securityRaw, 'allowOverwrite', 'security'),
      allowDangerousCommands: v.bool(securityRaw, 'allowDangerousCommands', 'security'),
      extraDangerousCommands: v.strList(securityRaw, 'extraDangerousCommands', 'security').map(s => s.toLowerCase()),
      trustedCommands: v.strList(securityRaw, 'trustedCommands', 'security').map(s => s.toLowerCase()),
      deleteMode: v.oneOf(securityRaw, 'deleteMode', 'security', ['backup', 'deny', 'allow'] as const),
      backupMaxBytes: v.num(securityRaw, 'backupMaxBytes', 'security', 0),
    },
    tools: {
      pythonExecutable: v.str(toolsRaw, 'pythonExecutable', 'tools'),
      pythonTimeoutMs: v.num(toolsRaw, 'pythonTimeoutMs', 'tools', 1000),
      latexEngine: v.str(toolsRaw, 'latexEngine', 'tools'),
      bibtex: v.str(toolsRaw, 'bibtex', 'tools'),
      dvipdfmx: v.str(toolsRaw, 'dvipdfmx', 'tools'),
      latexTimeoutMs: v.num(toolsRaw, 'latexTimeoutMs', 'tools', 1000),
      pdfinfo: v.str(toolsRaw, 'pdfinfo', 'tools'),
      pdffonts: v.str(toolsRaw, 'pdffonts', 'tools'),
      pdftotext: v.str(toolsRaw, 'pdftotext', 'tools'),
      gitExecutable: v.str(toolsRaw, 'gitExecutable', 'tools'),
      maxOutputChars: v.num(toolsRaw, 'maxOutputChars', 'tools', 1000),
      testTimeoutMs: v.num(toolsRaw, 'testTimeoutMs', 'tools', 1000),
      verifyIgnoreDirs: v.strList(toolsRaw, 'verifyIgnoreDirs', 'tools'),
    },
    web: {
      search: v.oneOf(webRaw, 'search', 'web', ['duckduckgo', 'searxng', 'none'] as const),
      searxngURL: typeof webRaw.searxngURL === 'string' ? webRaw.searxngURL : '',
      timeoutMs: v.num(webRaw, 'timeoutMs', 'web', 1000),
      userAgent: v.str(webRaw, 'userAgent', 'web'),
    },
    daemon: {
      host: v.str(daemonRaw, 'host', 'daemon'),
      port: v.num(daemonRaw, 'port', 'daemon', 1),
      maxUploadBytes: v.num(daemonRaw, 'maxUploadBytes', 'daemon', 1),
      modelRefreshMs: v.num(daemonRaw, 'modelRefreshMs', 'daemon', 0),
    },
  }
  if (config.daemon.host !== '127.0.0.1' && config.daemon.host !== 'localhost' && config.daemon.host !== '::1') {
    v.problems.push('daemon.host must be a loopback address in this version (external exposure needs explicit design and approval)')
  }
  if (config.web.search === 'searxng' && !/^https?:\/\//.test(config.web.searxngURL)) v.problems.push('web.searxngURL must be an http(s) URL when web.search is searxng')
  if (config.daemon.port > 65535) v.problems.push('daemon.port must be <= 65535')
  if (config.queue.leaseTtlMs > config.queue.maxLeaseMs) v.problems.push('queue.leaseTtlMs must not exceed queue.maxLeaseMs')
  if (v.problems.length > 0) throw new ConfigError(v.problems, source)
  return config
}

export interface LoadOptions {
  /** Explicit config path; otherwise HEARTH_CONFIG, then ./hearth.yaml next to the project. */
  path?: string
  /** Final overrides applied on top of the file (for CLI flags and tests). */
  overrides?: Record<string, unknown>
  /** Directory used when no config file exists. */
  cwd?: string
}

/** Default project root: the directory containing this source tree's package.json. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Find and load the configuration.
 * @param options - path and overrides.
 * @returns the resolved configuration.
 */
export function loadConfig(options: LoadOptions = {}): HearthConfig {
  const candidate = options.path ?? process.env.HEARTH_CONFIG ?? resolve(PROJECT_ROOT, 'hearth.yaml')
  let fileRaw: unknown = {}
  let baseDir = options.cwd ?? PROJECT_ROOT
  let source = 'built-in defaults'
  if (existsSync(candidate)) {
    const text = readFileSync(candidate, 'utf8')
    try {
      fileRaw = parseYaml(text) ?? {}
    } catch (error) {
      throw new ConfigError([`YAML parse error: ${(error as Error).message}`], candidate)
    }
    baseDir = dirname(resolve(candidate))
    source = candidate
  } else if (options.path) {
    throw new ConfigError([`config file not found: ${options.path}`], options.path)
  }
  const merged = deepMerge(deepMerge(DEFAULT_RAW_CONFIG, fileRaw), options.overrides ?? {})
  const config = resolveConfig(merged, baseDir, source)
  if (source !== 'built-in defaults') config.sourcePath = resolve(candidate)
  return config
}
