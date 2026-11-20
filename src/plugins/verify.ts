/**
 * DSH plugin: automatic verify-and-fix loop at turn end.
 *
 * When the model is about to finish (`agent/turn-stopping`), the files the
 * task changed are verified (see src/verify/verifiers.ts). Failures are sent
 * back with `agent.steer()`, which makes the same turn continue so the model
 * can fix them. The number of fix rounds is bounded by the mode; after the
 * last round the result is reported and the turn ends. Every verification is
 * reported on the telemetry channel so the runner can record the outcome.
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { changedFiles, formatReport, runVerifiers, type Finding, type VerifySettings } from '../verify/verifiers.ts'
import { createSandboxExec, type SandboxLike, type SandboxMode } from '../tools/sandbox-exec.ts'
import { budgetState } from './budget.ts'
import { emitTelemetry } from './telemetry.ts'

export const name = 'hearth-verify'
export const inject = { sandbox: { required: false } }

export interface Config extends VerifySettings {
  /** Fix rounds allowed after failed verification. */
  rounds: number
  sandboxMode: SandboxMode
}

interface SteerableAgent {
  steer(message: unknown): void
  session?: { id?: string }
}

/** Loop state, separated for unit tests. */
export class VerifyLoop {
  readonly rounds: number
  steers = 0
  runs = 0
  last: { passed: boolean; findings: Finding[] } | undefined

  constructor(rounds: number) {
    this.rounds = rounds
  }

  /** Record a verification and decide whether to steer another fix round. */
  record(findings: Finding[]): { passed: boolean; steer: boolean; exhausted: boolean } {
    this.runs++
    const passed = findings.every(f => f.ok)
    this.last = { passed, findings }
    if (passed) return { passed, steer: false, exhausted: false }
    if (this.steers < this.rounds) {
      this.steers++
      return { passed, steer: true, exhausted: false }
    }
    return { passed, steer: false, exhausted: true }
  }
}

/**
 * Plugin entry.
 * @param ctx - Cordis context.
 * @param config - verifier settings and round limit.
 */
export function apply(ctx: Context, config: Config): void {
  const startedAt = Date.now() - 2000 // files written in the first moments still count
  const exec = createSandboxExec((ctx as unknown as { sandbox?: SandboxLike }).sandbox, config.sandboxMode, config.workspace)
  const loop = new VerifyLoop(config.rounds)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event typing comes from DSH declaration merging
  ;(ctx as any).on('agent/turn-stopping', async (payload: { agent: SteerableAgent; turn: number; signal: AbortSignal }) => {
    if (payload.signal?.aborted || budgetState.exhausted) return
    const files = changedFiles(config.workspace, startedAt, config.ignoreDirs, config.maxScanFiles)
    if (files.length === 0 && config.commands.length === 0) {
      emitTelemetry({ event: 'verification', status: 'skipped', reason: 'no files changed' })
      return
    }
    const started = Date.now()
    let findings: Finding[]
    try {
      findings = await runVerifiers(files, config, exec, { signal: payload.signal, sessionId: payload.agent?.session?.id })
    } catch (error) {
      findings = [{ verifier: 'hearth', target: 'verification', ok: false, detail: `verifier crashed: ${(error as Error).message}` }]
    }
    if (findings.length === 0) {
      emitTelemetry({ event: 'verification', status: 'skipped', reason: 'no verifier applies to the changed files', files: files.slice(0, 20) })
      return
    }
    const decision = loop.record(findings)
    emitTelemetry({
      event: 'verification',
      status: decision.passed ? 'passed' : decision.exhausted ? 'failed-final' : 'failed',
      run: loop.runs,
      fixRound: decision.steer ? loop.steers : undefined,
      durationMs: Date.now() - started,
      checks: findings.map(f => ({ verifier: f.verifier, target: f.target, ok: f.ok, detail: f.ok ? undefined : f.detail.slice(0, 500) })),
    })
    if (decision.steer) {
      payload.agent.steer(createUserMessage({
        content: [{ type: 'text', text: formatReport(findings, loop.steers, loop.rounds) }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- plugin-declared message source kind
        source: { kind: 'hearth-verify', round: loop.steers } as any,
      }))
    }
  })
  emitTelemetry({ event: 'plugin-ready', plugin: name })
}
