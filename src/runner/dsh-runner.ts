/**
 * Run one Hearth task as a DSH headless child process.
 *
 * The runner owns: overlay generation, child environment (DSH_HOME, provider
 * keys, broker token), NDJSON parsing, telemetry collection, metrics, the task
 * deadline, and cancellation (process-tree kill). Everything the child prints
 * is kept under <stateDir>/runs/<taskId>/ for later inspection.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { HearthConfig } from '../config/types.ts'
import { buildTaskOverlay, providerKeyEnv, taskMessage } from '../dsh/overlay.ts'
import { parseTelemetryLine } from '../plugins/telemetry.ts'
import type { TaskMetrics, TaskRecord, TaskStatus } from '../queue/task-store.ts'
import { resolveApiKey } from '../security/secrets.ts'
import { killTree } from '../tools/process.ts'

export type RunEvent =
  | { kind: 'dsh'; event: Record<string, unknown> }
  | { kind: 'telemetry'; event: Record<string, unknown> }
  | { kind: 'stderr'; line: string }
  | { kind: 'lifecycle'; phase: 'spawned' | 'exited'; detail?: Record<string, unknown> }

export interface RunOptions {
  config: HearthConfig
  task: TaskRecord
  brokerURL?: string
  brokerToken?: string
  signal?: AbortSignal
  onEvent?: (event: RunEvent) => void
  /** Extra environment for the child (tests). */
  env?: NodeJS.ProcessEnv
}

export interface RunOutcome {
  status: TaskStatus
  sessionId?: string
  finalText?: string
  error?: string
  exitCode: number | null
  metrics: TaskMetrics
  runDir: string
}

/** Locate the DSH CLI entry script. */
export function resolveDshEntry(config: HearthConfig): string {
  if (config.dsh.entry !== 'auto') return config.dsh.entry
  const require = createRequire(join(config.baseDir, 'package.json'))
  try {
    return join(dirname(require.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
  } catch {
    const fallback = createRequire(import.meta.url)
    return join(dirname(fallback.resolve('@deepseek-ai/dsh/package.json')), 'lib', 'bin.js')
  }
}

export function emptyMetrics(): TaskMetrics {
  return { durationMs: 0, steps: 0, toolCalls: 0, toolErrors: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, leaseWaitMs: 0, toolCallRepairs: 0, toolCallRetries: 0, policyDenials: 0 }
}

/** Fold one event into the metrics (pure; unit-tested). */
export function accumulate(metrics: TaskMetrics, event: RunEvent): void {
  if (event.kind === 'dsh') {
    const e = event.event
    if (e.type === 'status' && e.phase === 'step_end') {
      metrics.steps++
      const u = e.usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number } | undefined
      if (u) {
        metrics.inputTokens += (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0)
        metrics.outputTokens += u.outputTokens ?? 0
        metrics.totalTokens += u.totalTokens ?? (u.inputTokens ?? 0) + (u.outputTokens ?? 0)
      }
    } else if (e.type === 'tool_call') metrics.toolCalls++
    else if (e.type === 'tool_result' && e.status !== 'completed') metrics.toolErrors++
  } else if (event.kind === 'telemetry') {
    const e = event.event
    if (e.event === 'lease-granted') metrics.leaseWaitMs += Number(e.waitedMs ?? 0)
    else if (e.event === 'toolcall-repair' && e.repaired) metrics.toolCallRepairs++
    else if (e.event === 'toolcall-retry') metrics.toolCallRetries++
    else if (e.event === 'policy-denied') metrics.policyDenials++
    else if (e.event === 'compaction') metrics.compactions = (metrics.compactions ?? 0) + 1
    else if (e.event === 'memory-reinjected') metrics.memoryReinjections = (metrics.memoryReinjections ?? 0) + 1
    else if (e.event === 'budget-exhausted') metrics.budgetExhausted = { kind: String(e.kind), detail: String(e.detail) }
    else if (e.event === 'verification') {
      const v = (metrics.verification ??= { runs: 0, fixRounds: 0, last: 'skipped', failures: [] })
      const status = String(e.status) as NonNullable<TaskMetrics['verification']>['last']
      if (status !== 'skipped') v.runs++
      if (typeof e.fixRound === 'number') v.fixRounds = e.fixRound
      v.last = status
      const checks = Array.isArray(e.checks) ? (e.checks as Array<{ verifier: string; target: string; ok: boolean }>) : []
      v.failures = checks.filter(c => !c.ok).map(c => `${c.verifier} (${c.target})`)
    }
  }
}

/**
 * Execute a task to completion.
 * @param options - config, task, broker, cancellation.
 * @returns the outcome; never throws for task-level failures.
 */
export async function runTask(options: RunOptions): Promise<RunOutcome> {
  const { config, task } = options
  const mode = config.modes[task.mode]
  const runDir = join(config.stateDir, 'runs', task.id)
  mkdirSync(runDir, { recursive: true })
  const metrics = emptyMetrics()
  const started = Date.now()
  const fail = (error: string): RunOutcome => ({ status: 'failed', error, exitCode: null, metrics, runDir })

  const patchFile = join(runDir, 'patch.yml')
  let expectedPlugins: string[]
  try {
    const overlay = buildTaskOverlay({ config, mode, taskId: task.id, workspace: task.workspace, provider: task.provider, model: task.model, auditLog: join(runDir, 'audit.jsonl'), brokerURL: options.brokerURL, verifyCommands: task.verifyCommands, backupDir: join(runDir, 'backup') })
    expectedPlugins = [...new Set([...overlay.matchAll(/^\s*- id: (hearth-[a-z-]+)$/gm)].map(m => m[1]!))]
    writeFileSync(patchFile, overlay, 'utf8')
  } catch (error) {
    return fail(`could not build DSH overlay: ${(error as Error).message}`)
  }

  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, DSH_HOME: config.dsh.home, HEARTH_TASK_ID: task.id }
  delete env.DSH_PERMISSION_MODE
  if (options.brokerToken) env.HEARTH_BROKER_TOKEN = options.brokerToken
  const provider = config.providers[task.provider]
  if (!provider) return fail(`provider ${task.provider} is not configured`)
  try {
    const key = resolveApiKey(provider.apiKey, { ...process.env, ...options.env })
    if (key) env[providerKeyEnv(provider.name)] = key
  } catch (error) {
    return fail(`API key for provider ${provider.name}: ${(error as Error).message}`)
  }

  const node = config.dsh.nodeExecutable === 'auto' ? process.execPath : config.dsh.nodeExecutable
  const args = [resolveDshEntry(config), '--profile', 'headless', '--patch', patchFile]
  for (const p of config.dsh.extraPatches) args.push('--patch', p)
  args.push('--json', '--approval-policy', 'never')
  if (task.sessionId) args.push('--session-id', task.sessionId)
  args.push('-')

  mkdirSync(config.dsh.home, { recursive: true })
  const eventsFile = join(runDir, 'events.jsonl')
  const stderrFile = join(runDir, 'stderr.log')
  const record = (event: RunEvent) => {
    accumulate(metrics, event)
    if (event.kind !== 'stderr') appendFileSync(eventsFile, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`, 'utf8')
    try {
      options.onEvent?.(event)
    } catch (error) {
      appendFileSync(stderrFile, `hearth: event observer failed: ${String(error)}\n`)
    }
  }

  return await new Promise<RunOutcome>(resolve => {
    const child = spawn(node, args, { cwd: task.workspace, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let sessionId = task.sessionId
    let finalText: string | undefined
    let finalReason: { kind?: string; error?: { message?: string; code?: string } } | undefined
    let errorEvent: string | undefined
    let cancelled = false
    let timedOut = false
    let pluginFailure: string | undefined
    const ready = new Set<string>()
    let taskSent = false
    record({ kind: 'lifecycle', phase: 'spawned', detail: { pid: child.pid, args: args.slice(1) } })
    // DSH keeps running when a plugin fails to load. The task text is only sent
    // once every Hearth plugin (policy, budget, ...) has reported that it is
    // active, so no step can run without them.
    const sendTask = () => {
      if (taskSent) return
      taskSent = true
      clearTimeout(readyTimer)
      child.stdin.end(taskMessage(task.workspace, task.prompt), 'utf8')
    }
    const readyTimer = setTimeout(() => {
      const missing = expectedPlugins.filter(p => !ready.has(p))
      pluginFailure = `Hearth plugin(s) did not load: ${missing.join(', ')}; the task was not started (see ${stderrFile})`
      killTree(child.pid)
    }, 60_000)

    const deadline = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, Math.min(config.queue.taskTimeoutMs, mode.maxWallTimeMs + 60_000))
    const onAbort = () => {
      cancelled = true
      killTree(child.pid)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()

    createInterface({ input: child.stdout }).on('line', line => {
      if (!line.trim()) return
      let event: Record<string, unknown>
      try {
        event = JSON.parse(line) as Record<string, unknown>
      } catch {
        record({ kind: 'stderr', line: `non-JSON stdout: ${line}` })
        return
      }
      if (event.type === 'session' && typeof event.sessionId === 'string') sessionId = event.sessionId
      if (event.type === 'final') {
        finalText = typeof event.text === 'string' ? event.text : undefined
        finalReason = event.reason as typeof finalReason
      }
      if (event.type === 'error') errorEvent = String(event.message ?? 'unknown error')
      record({ kind: 'dsh', event })
    })
    createInterface({ input: child.stderr }).on('line', line => {
      const t = parseTelemetryLine(line)
      if (t) {
        record({ kind: 'telemetry', event: t })
        if (t.event === 'plugin-ready' && typeof t.plugin === 'string') {
          ready.add(t.plugin)
          if (expectedPlugins.every(p => ready.has(p))) sendTask()
        }
      } else {
        if (/did not activate/.test(line)) record({ kind: 'telemetry', event: { event: 'dsh-plugin-warning', line } })
        const failed = /^(hearth-[a-z-]+) \(.*?\): (.*)$/.exec(line)
        if (failed && expectedPlugins.includes(failed[1]!) && !ready.has(failed[1]!) && !pluginFailure) {
          pluginFailure = `Hearth plugin ${failed[1]} did not load (${failed[2]}); the task was not started`
          killTree(child.pid)
        }
        appendFileSync(stderrFile, `${line}\n`, 'utf8')
        record({ kind: 'stderr', line })
      }
    })
    if (expectedPlugins.length === 0) sendTask()

    let settled = false
    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(readyTimer)
      options.signal?.removeEventListener('abort', onAbort)
      metrics.durationMs = Date.now() - started
      record({ kind: 'lifecycle', phase: 'exited', detail: { exitCode } })
      let status: TaskStatus
      let error: string | undefined
      if (spawnError) {
        status = 'failed'
        error = `could not start DSH: ${spawnError}`
      } else if (pluginFailure) {
        status = 'failed'
        error = pluginFailure
      } else if (!taskSent && !cancelled) {
        const missing = expectedPlugins.filter(p => !ready.has(p))
        status = 'failed'
        error = `DSH exited (code ${exitCode}) before Hearth plugin(s) ${missing.join(', ')} loaded; see ${stderrFile}`
      } else if (cancelled) status = 'cancelled'
      else if (timedOut) {
        status = 'timed_out'
        error = 'task deadline exceeded; process tree killed'
      } else if (metrics.budgetExhausted) {
        status = 'budget_exhausted'
        error = `budget exhausted (${metrics.budgetExhausted.kind}): ${metrics.budgetExhausted.detail}`
      } else if (exitCode === 0 && finalReason?.kind === 'completed' && metrics.verification && metrics.verification.last !== 'passed' && metrics.verification.last !== 'skipped') {
        status = 'verification_failed'
        error = `verification still failing after ${metrics.verification.fixRounds} fix round(s): ${metrics.verification.failures.join(', ')}`
      } else if (exitCode === 0 && finalReason?.kind === 'completed') status = 'succeeded'
      else {
        status = 'failed'
        error = errorEvent ?? (finalReason?.error ? `${finalReason.error.code ?? ''} ${finalReason.error.message ?? ''}`.trim() : `DSH exited with code ${exitCode} (turn end: ${finalReason?.kind ?? 'none'}); see ${stderrFile}`)
      }
      resolve({ status, sessionId, finalText, error, exitCode, metrics, runDir })
    }
    child.on('error', e => finish(null, e.message))
    child.on('close', code => finish(code))
  })
}
