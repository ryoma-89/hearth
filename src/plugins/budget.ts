/**
 * DSH plugin: hard execution budgets for one Hearth task.
 *
 * DSH has advisory loop guards (repeat reminders, per-tool timeouts) but no
 * caps on steps, wall time, tokens, or consecutive failures. This plugin adds
 * them. When a budget is exhausted the next step is rejected (closing the
 * turn) and, for time limits, the active turn is cancelled immediately. Every
 * stop is reported on the telemetry channel so the runner records the cause.
 */
import type { Context } from '@deepseek-ai/cordis'
import { emitTelemetry } from './telemetry.ts'

export const name = 'hearth-budget'

export interface Config {
  maxSteps: number
  maxWallTimeMs: number
  maxTotalTokens: number
  maxConsecutiveToolFailures: number
}

export type BudgetKind = 'steps' | 'wall-time' | 'tokens' | 'tool-failures' | 'sandbox-unavailable'

/** Tool error codes meaning no confined process can run at all; retrying cannot help. */
export const SANDBOX_FAILURE_CODES = ['SANDBOX_PREPARATION_FAILED', 'SANDBOX_UNAVAILABLE', 'SANDBOX_INVALID_TEMP_ROOT']

/** Process-wide view of the active budget, read by other Hearth plugins (one task per process). */
export const budgetState: { exhausted: { kind: BudgetKind; detail: string } | undefined } = { exhausted: undefined }

interface CancellableAgent {
  cancel(cause: { kind: 'hook'; reason: string }): void
}

/** Pure budget state; separated from Cordis wiring for unit tests. */
export class BudgetTracker {
  readonly config: Config
  readonly startedAt: number
  steps = 0
  tokens = 0
  consecutiveFailures = 0
  exhausted: { kind: BudgetKind; detail: string } | undefined

  constructor(config: Config, now = Date.now()) {
    this.config = config
    this.startedAt = now
  }

  private exhaust(kind: BudgetKind, detail: string): void {
    this.exhausted ??= { kind, detail }
  }

  /** Called before each step; returns false when the step must not run. */
  admitStep(now = Date.now()): boolean {
    if (now - this.startedAt >= this.config.maxWallTimeMs) this.exhaust('wall-time', `wall time ${now - this.startedAt} ms >= ${this.config.maxWallTimeMs} ms`)
    if (this.steps >= this.config.maxSteps) this.exhaust('steps', `step limit ${this.config.maxSteps} reached`)
    if (this.exhausted) return false
    this.steps++
    return true
  }

  addUsage(usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): void {
    this.tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
    if (this.tokens >= this.config.maxTotalTokens) this.exhaust('tokens', `token budget ${this.config.maxTotalTokens} reached (${this.tokens})`)
  }

  recordToolResult(isError: boolean, errorCode?: string): void {
    if (isError && errorCode && SANDBOX_FAILURE_CODES.includes(errorCode)) {
      this.exhaust(
        'sandbox-unavailable',
        `the DSH Windows ACL sandbox could not prepare the workspace (${errorCode}); every confined command will fail. Usual cause: your account lacks Full Control (WRITE_OWNER) on the workspace folder. Fix: icacls "<workspace>" /grant "%USERNAME%:(OI)(CI)F", or run hearth doctor --workspace <dir>`,
      )
      return
    }
    this.consecutiveFailures = isError ? this.consecutiveFailures + 1 : 0
    if (this.consecutiveFailures >= this.config.maxConsecutiveToolFailures) {
      this.exhaust('tool-failures', `${this.consecutiveFailures} consecutive tool failures`)
    }
  }
}

/**
 * Plugin entry.
 * @param ctx - Cordis context.
 * @param config - budget limits for this task.
 */
export function apply(ctx: Context, config: Config): void {
  const tracker = new BudgetTracker(config)
  const agents = new Set<CancellableAgent>()
  let reported = false
  const report = () => {
    budgetState.exhausted = tracker.exhausted
    if (reported || !tracker.exhausted) return
    reported = true
    emitTelemetry({ event: 'budget-exhausted', kind: tracker.exhausted.kind, detail: tracker.exhausted.detail, steps: tracker.steps, tokens: tracker.tokens })
  }
  const stopAll = () => {
    report()
    for (const agent of agents) {
      try {
        agent.cancel({ kind: 'hook', reason: `hearth budget: ${tracker.exhausted?.detail ?? 'exhausted'}` })
      } catch (error) {
        emitTelemetry({ event: 'budget-cancel-failed', error: String(error) })
      }
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event typing comes from DSH declaration merging
  const on = (ctx as any).on.bind(ctx)

  on('agent/pre-step', async (payload: { agent: CancellableAgent; turn: number; step: number }, next: () => Promise<unknown>) => {
    agents.add(payload.agent)
    if (!tracker.admitStep()) {
      report()
      return { kind: 'reject' }
    }
    emitTelemetry({ event: 'step-admitted', turn: payload.turn, step: payload.step, steps: tracker.steps, tokens: tracker.tokens })
    return next()
  })

  on('llm/stream', (_options: unknown, next: () => AsyncIterable<{ type: string; usage?: Record<string, number> }>) =>
    (async function* () {
      for await (const chunk of next()) {
        if (chunk.type === 'usage' && chunk.usage) {
          tracker.addUsage(chunk.usage)
          if (tracker.exhausted) report()
        }
        yield chunk
      }
    })(),
  )

  on('tools/result', (_exec: unknown, result: { isError?: boolean; error?: { info?: { code?: string } } }) => {
    tracker.recordToolResult(result?.isError === true, result?.error?.info?.code)
    if (tracker.exhausted?.kind === 'tool-failures' || tracker.exhausted?.kind === 'sandbox-unavailable') stopAll()
  })

  const timer = setTimeout(() => {
    tracker.admitStep() // marks wall-time exhaustion
    stopAll()
  }, config.maxWallTimeMs)
  timer.unref()
  ctx.effect(() => () => clearTimeout(timer))
  emitTelemetry({ event: 'plugin-ready', plugin: name })
}
