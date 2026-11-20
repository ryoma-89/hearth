/**
 * Generate the DSH `--patch` overlay for one Hearth task.
 *
 * The overlay is the only place Hearth changes DSH composition: provider
 * routes, the default model, mode-dependent DSH settings, disabled rows, and
 * the inserted Hearth plugins. Secrets never appear here: provider keys are
 * referenced by environment-variable name and the broker token is read from
 * the child environment by the inference-gate plugin.
 */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify } from 'yaml'
import type { HearthConfig, ModeConfig, ProviderConfig } from '../config/types.ts'

export interface TaskOverlayInput {
  config: HearthConfig
  mode: ModeConfig
  taskId: string
  workspace: string
  provider: string
  model: string
  auditLog: string
  /** Daemon URL for the inference gate; omitted disables the gate (tests, direct runs). */
  brokerURL?: string
  /** Task-level verification commands. */
  verifyCommands?: string[]
  /** Directory for pre-delete / pre-overwrite backups. */
  backupDir?: string
}

/** Environment variable carrying a provider's API key into the child. */
export function providerKeyEnv(provider: string): string {
  return `HEARTH_KEY_${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

function pluginPath(file: string): string {
  return fileURLToPath(new URL(`../plugins/${file}`, import.meta.url)).replace(/\\/g, '/')
}

function providerRoute(p: ProviderConfig): Record<string, unknown> {
  const route: Record<string, unknown> = {
    displayName: p.displayName,
    api: p.api,
    baseURL: p.baseURL,
    streamIdleTimeoutMs: p.timeoutMs,
    retryPolicy: { mode: 'normal', maxRetries: p.maxRetries },
    models: p.models.map(m => ({
      id: m.id,
      name: m.displayName,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      input: m.input,
      reasoning: m.reasoning,
      ...(m.reasoning ? { reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high' } } : {}),
    })),
  }
  if (p.apiKey.kind !== 'none') route.apiKeyEnv = providerKeyEnv(p.name)
  if (Object.keys(p.compat).length) route.compat = p.compat
  if (Object.keys(p.headers).length) route.headers = p.headers
  return route
}

/**
 * System-prompt persona. It must not contain task-specific text (workspace
 * path, task id, time): the system prompt and tool schemas form the request
 * prefix, and keeping them identical across tasks of a mode lets the
 * inference server reuse its prefix cache. Task facts go into the task
 * message instead (see {@link taskMessage}).
 */
function personaPrefix(mode: ModeConfig): string {
  const lines = [
    'You are a coding agent powered by the {{model}} model, running inside the Hearth harness on a local machine.',
    'Work only inside the task workspace named at the top of the task message. Hearth policy refuses paths outside it and dangerous commands; when a call is refused, read the reason and choose a safer approach instead of retrying the same call.',
    'Tool results report failures exactly; read errors carefully, fix the cause, and re-run to confirm. Do not claim success for anything you did not verify with a tool.',
    'When the context gets long, older or very long tool results may be shortened and show "[... tool result middle pruned ...]" or say content was omitted. You did not see that part: read the missing range again (for example read with offset and limit) before using any value from it. Never guess a value, identifier, or number you have not actually seen.',
    `Execution mode: ${mode.name} (at most ${mode.maxSteps} steps). Finish with a concise report of what was done, what was verified, and anything left unresolved.`,
  ]
  if (mode.requirePlan) lines.push('Before acting on a multi-step task, write a short numbered plan with todo_write, then follow and update it.')
  if (mode.verificationRounds > 0) lines.push('After producing code or documents, verify them yourself (run the code or tests, compile documents, inspect PDFs) before finishing. Hearth also runs automatic checks when you finish and will send back any failures for you to fix.')
  return lines.join('\n')
}

/**
 * Text sent to DSH as the task: the task-specific facts first, then the user's prompt.
 * @param workspace - task workspace.
 * @param prompt - the user's prompt.
 * @returns message text.
 */
export function taskMessage(workspace: string, prompt: string): string {
  return `[Hearth] Task workspace: ${workspace.replace(/\\/g, '/')}\n\n${prompt}`
}

/**
 * Build the overlay rows.
 * @param input - config, mode and task facts.
 * @returns YAML text for `dsh --patch`.
 */
export function buildTaskOverlay(input: TaskOverlayInput): string {
  const { config, mode } = input
  // A route without models is invalid for pi-ai and would fail the whole adapter, so skip it (e.g. a discovering server that is down).
  const providers = Object.fromEntries(Object.values(config.providers).filter(p => p.models.length > 0).map(p => [p.name, providerRoute(p)]))
  const model = config.providers[input.provider]?.models.find(m => m.id === input.model)
  if (!model) throw new Error(`model ${input.provider}/${input.model} is not configured`)
  const rows: unknown[] = [
    {
      id: 'agent-default-model',
      name: '@deepseek-ai/dsh-agent-default-model',
      config: {
        provider: input.provider,
        model: input.model,
        ...(model.reasoning ? { reasoningEffort: mode.reasoningEffort } : {}),
      },
    },
    { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: { providers } },
    {
      id: 'compaction-basic',
      name: '@deepseek-ai/dsh-compaction-basic',
      config: { thresholdRatio: mode.compactionThresholdRatio, headroomTokens: mode.compactionHeadroomTokens, maxTokens: Math.min(model.maxTokens, 8192) },
    },
    {
      id: 'tool-result-pruner',
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
      config: { thresholdChars: mode.toolResultPruneThresholdChars, headChars: mode.toolResultPruneHeadChars, tailChars: mode.toolResultPruneTailChars },
    },
    {
      id: 'repeat-tool-reminder',
      name: '@deepseek-ai/dsh-repeat-tool-reminder',
      config: { thresholds: mode.repeatReminderThresholds, argumentsPreviewChars: 500 },
    },
    {
      id: 'system-prompt',
      name: '@deepseek-ai/dsh-system-prompt',
      config: { personaPrefix: personaPrefix(mode) },
    },
  ]
  if (!config.dsh.titleGeneration) rows.push({ id: 'session-title-llm', disabled: true })
  // Web: pin providers so DSH never has to choose between the DeepSeek and Hearth backends.
  rows.push({ id: 'web', name: '@deepseek-ai/dsh-web', config: config.web.search === 'none' ? { fetchProvider: 'http' } : { fetchProvider: 'http', searchProvider: 'hearth-search' } })
  rows.push({ id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, search: config.web.search !== 'none', searchTimeoutMs: config.web.timeoutMs + 5000 } })
  for (const id of mode.disabledDshRows) rows.push({ id, disabled: true })

  const hearthTools = mode.hearthTools
  const deniedTools: string[] = []
  const insert: unknown[] = [
    {
      id: 'hearth-policy',
      name: pluginPath('policy.ts'),
      config: {
        workspace: input.workspace,
        auditLog: input.auditLog,
        protectedPaths: config.security.protectedPaths,
        allowOverwrite: config.security.allowOverwrite,
        allowDangerousCommands: config.security.allowDangerousCommands,
        extraDangerousCommands: config.security.extraDangerousCommands,
        trustedCommands: config.security.trustedCommands,
        deniedTools,
        deleteMode: config.security.deleteMode,
        backupDir: input.backupDir ?? input.auditLog.replace(/audit\.jsonl$/, 'backup'),
        backupMaxBytes: config.security.backupMaxBytes,
      },
    },
    {
      id: 'hearth-budget',
      name: pluginPath('budget.ts'),
      config: {
        maxSteps: mode.maxSteps,
        maxWallTimeMs: Math.min(mode.maxWallTimeMs, config.queue.taskTimeoutMs),
        maxTotalTokens: mode.maxTotalTokens,
        maxConsecutiveToolFailures: mode.maxConsecutiveToolFailures,
      },
    },
    {
      id: 'hearth-toolcall-repair',
      name: pluginPath('toolcall-repair.ts'),
      config: { repair: true, maxRetries: mode.malformedToolCallRetries, retryCodes: ['MALFORMED_RESPONSE', 'EMPTY_RESPONSE'] },
    },
  ]
  // The history archive always runs; the task_memory tool only where the mode enables it.
  const stateDir = config.stateDir
  insert.push({
    id: 'hearth-memory',
    name: pluginPath('memory.ts'),
    config: { historyDir: join(stateDir, 'history'), notesDir: join(stateDir, 'notes'), maxEventChars: 20_000, enableTool: hearthTools.includes('task_memory') },
  })
  if (config.web.search !== 'none') {
    insert.push({
      id: 'hearth-web-search',
      name: pluginPath('web-search.ts'),
      config: { backend: config.web.search, searxngURL: config.web.searxngURL, timeoutMs: config.web.timeoutMs, userAgent: config.web.userAgent },
    })
  }
  if (hearthTools.some(t => t !== 'task_memory')) {
    insert.push({
      id: 'hearth-tools',
      name: pluginPath('tools.ts'),
      config: {
        enabled: hearthTools.filter(t => t !== 'task_memory'),
        workspace: input.workspace,
        sandboxMode: config.security.sandbox,
        pythonExecutable: config.tools.pythonExecutable,
        pythonTimeoutMs: config.tools.pythonTimeoutMs,
        latexEngine: config.tools.latexEngine,
        bibtex: config.tools.bibtex,
        dvipdfmx: config.tools.dvipdfmx,
        latexTimeoutMs: config.tools.latexTimeoutMs,
        pdfinfo: config.tools.pdfinfo,
        pdffonts: config.tools.pdffonts,
        pdftotext: config.tools.pdftotext,
        gitExecutable: config.tools.gitExecutable,
        maxOutputChars: config.tools.maxOutputChars,
      },
    })
  }
  const verifyCommands = input.verifyCommands ?? []
  if (mode.verificationRounds > 0 || verifyCommands.length > 0) {
    insert.push({
      id: 'hearth-verify',
      name: pluginPath('verify.ts'),
      config: {
        rounds: mode.verificationRounds,
        strict: mode.strictVerification,
        workspace: input.workspace,
        sandboxMode: config.security.sandbox,
        pythonExecutable: config.tools.pythonExecutable,
        testTimeoutMs: config.tools.testTimeoutMs,
        commands: verifyCommands,
        maxScanFiles: 20_000,
        ignoreDirs: config.tools.verifyIgnoreDirs,
        latex: {
          latexEngine: config.tools.latexEngine,
          bibtex: config.tools.bibtex,
          dvipdfmx: config.tools.dvipdfmx,
          latexTimeoutMs: config.tools.latexTimeoutMs,
          pdfinfo: config.tools.pdfinfo,
          pdffonts: config.tools.pdffonts,
          pdftotext: config.tools.pdftotext,
        },
      },
    })
  }
  if (input.brokerURL) {
    insert.push({
      id: 'hearth-inference-gate',
      name: pluginPath('inference-gate.ts'),
      config: { brokerURL: input.brokerURL, taskId: input.taskId, heartbeatMs: Math.max(250, Math.floor(config.queue.leaseTtlMs / 3)) },
    })
  }
  rows.push({ insert })

  // The sandbox-policy row needs DSH's `!!js` tag to keep headless --add-dir grants; written by hand.
  const sandboxRow = [
    '- id: sandbox-policy',
    "  name: '@deepseek-ai/dsh-sandbox-policy'",
    '  config:',
    `    mode: ${JSON.stringify(config.security.sandbox)}`,
    `    workspaceRoot: ${JSON.stringify(input.workspace)}`,
    '    additionalWritableRoots: !!js ctx.headlessStartup.additionalWritableRoots',
    '  inject:',
    '    - headlessStartup',
  ].join('\n')
  return `# Generated by Hearth for task ${input.taskId}. Do not edit; regenerated per run.\n${stringify(rows, { lineWidth: 0 })}${sandboxRow}\n`
}
