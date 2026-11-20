/**
 * Resolved Hearth configuration types. Every tunable lives here so plugins,
 * the daemon, and the CLI never hard-code deployment choices.
 */

export type ModeName = 'low' | 'medium' | 'high' | 'maximum'
export const MODE_NAMES: readonly ModeName[] = ['low', 'medium', 'high', 'maximum']

/** Where an API key comes from. The value itself never appears in config files. */
export type ApiKeySource =
  | { kind: 'none' }
  | { kind: 'env'; name: string }
  | { kind: 'secret'; name: string }

export interface ModelConfig {
  /** Model id sent on the wire. */
  id: string
  displayName: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  /** Whether the model is expected to emit native OpenAI tool calls. */
  toolCalling: 'native' | 'unknown'
  input: Array<'text' | 'image'>
}

export interface ProviderConfig {
  name: string
  /** Wire protocol understood by pi-ai. */
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  displayName: string
  baseURL: string
  apiKey: ApiKeySource
  /** Idle-stream timeout passed to the adapter. */
  timeoutMs: number
  /** Request timeout for non-streaming probes (doctor). */
  probeTimeoutMs: number
  /** Opaque pi-ai compat switches, passed through verbatim. */
  compat: Record<string, unknown>
  headers: Record<string, string>
  maxRetries: number
  /** Models known from configuration; the daemon adds discovered ones at run time. */
  models: ModelConfig[]
  /** Query GET {baseURL}/models and add the models the server reports. */
  discoverModels: boolean
  /** Capabilities assumed for discovered models the server does not describe. */
  discoveredModelDefaults: Omit<ModelConfig, 'id' | 'displayName'>
}

export interface ModeConfig {
  name: ModeName
  description: string
  /** Hard cap on model steps per task. */
  maxSteps: number
  /** Hard cap on wall-clock time per task. */
  maxWallTimeMs: number
  /** Hard cap on total (input + output) tokens per task. */
  maxTotalTokens: number
  /** Consecutive failed tool results before the task is stopped. */
  maxConsecutiveToolFailures: number
  /** Re-sample attempts after an unrepairable malformed tool call. */
  malformedToolCallRetries: number
  /** Fix rounds allowed after turn-end verification fails (0 disables the verifier). */
  verificationRounds: number
  /** Treat quality warnings (overfull boxes, undefined references, unembedded fonts) as verification failures. */
  strictVerification: boolean
  /** Reasoning effort requested from reasoning models. */
  reasoningEffort: 'off' | 'low' | 'medium' | 'high'
  /** Whether the system prompt asks for an explicit plan before acting. */
  requirePlan: boolean
  /** Hearth tools enabled in this mode. */
  hearthTools: string[]
  /** DSH plugin row ids disabled in this mode (removes their tools). */
  disabledDshRows: string[]
  /** Context compaction pressure ratio of the window. */
  compactionThresholdRatio: number
  /** Extra headroom tokens kept free beyond the output reservation. */
  compactionHeadroomTokens: number
  /**
   * DSH tool-result pruner: once compaction pressure is reached, tool results longer than
   * this are cut to head + tail (the middle is dropped, even from the newest result).
   */
  toolResultPruneThresholdChars: number
  toolResultPruneHeadChars: number
  toolResultPruneTailChars: number
  /** Repeat-tool reminder thresholds. */
  repeatReminderThresholds: number[]
}

export interface QueueConfig {
  maxConcurrentInference: number
  maxConcurrentTasks: number
  /** A lease not refreshed within this period is reclaimed. */
  leaseTtlMs: number
  /** Absolute maximum duration of one lease (one model stream). */
  maxLeaseMs: number
  /** How long a lease request may wait before failing. */
  leaseWaitTimeoutMs: number
  /** Default task timeout when the mode does not set a smaller one. */
  taskTimeoutMs: number
}

export interface SecurityConfig {
  /** DSH sandbox mode for confined commands and file tools. */
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
  /** Directories a task workspace must live under; empty means only the configured default workspace. */
  allowedWorkspaceRoots: string[]
  /** Glob-like path patterns (relative to the workspace) that may never be written or deleted. */
  protectedPaths: string[]
  /** Whether overwriting an existing file through write tools is allowed. */
  allowOverwrite: boolean
  /** Whether commands classified as dangerous may run without approval (headless has no approver). */
  allowDangerousCommands: boolean
  /** Extra command names always treated as dangerous. */
  extraDangerousCommands: string[]
  /** Command names explicitly trusted even if the classifier flags them. */
  trustedCommands: string[]
  /** backup: copy files before delete/overwrite (default); deny: refuse deletes; allow: no backups. */
  deleteMode: 'backup' | 'deny' | 'allow'
  /** Per-task backup quota. */
  backupMaxBytes: number
}

export interface ToolsConfig {
  pythonExecutable: string
  pythonTimeoutMs: number
  latexEngine: string
  bibtex: string
  dvipdfmx: string
  latexTimeoutMs: number
  pdfinfo: string
  pdffonts: string
  pdftotext: string
  gitExecutable: string
  /** Maximum characters of tool output returned to the model. */
  maxOutputChars: number
  /** Deadline for test suites and verification commands. */
  testTimeoutMs: number
  /** Directory names skipped when scanning the workspace for changed files. */
  verifyIgnoreDirs: string[]
}

export interface WebConfig {
  /** Search backend for the web_search tool; none removes the tool. */
  search: 'duckduckgo' | 'searxng' | 'none'
  searxngURL: string
  timeoutMs: number
  userAgent: string
}

export interface DaemonConfig {
  host: string
  port: number
  /** Largest file accepted from the GUI. */
  maxUploadBytes: number
  /** How often the daemon refreshes discovered model lists (0 = only on start and on demand). */
  modelRefreshMs: number
}

export interface HearthConfig {
  /** Absolute directory of the config file (or cwd when defaults are used). */
  baseDir: string
  /** Config file the values came from; undefined when only defaults are used. */
  sourcePath?: string
  stateDir: string
  dsh: { entry: string; home: string; nodeExecutable: string; extraPatches: string[]; titleGeneration: boolean }
  defaultModel: { provider: string; model: string }
  defaultMode: ModeName
  defaultWorkspace: string
  providers: Record<string, ProviderConfig>
  modes: Record<ModeName, ModeConfig>
  queue: QueueConfig
  security: SecurityConfig
  tools: ToolsConfig
  web: WebConfig
  daemon: DaemonConfig
}
