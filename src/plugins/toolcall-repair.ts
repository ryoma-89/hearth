/**
 * DSH plugin: survive malformed tool calls from local models.
 *
 * DSH's pi-ai adapter ends the whole turn with MALFORMED_RESPONSE when a
 * streamed tool call's arguments are not valid JSON. This plugin
 *   1. wraps `llm/stream`, accumulates raw argument deltas, and when the
 *      stream finishes with MALFORMED_RESPONSE tries a conservative repair;
 *      if every pending call is repairable it re-emits them as completed
 *      tool-call blocks (so they are logged and executed normally), and
 *   2. on `agent/request-error`, re-samples the step a bounded number of
 *      times for failures that repair could not fix.
 * Schema-level problems (wrong or missing fields) are not handled here: DSH's
 * `defineTool` validation returns them to the model as tool errors.
 */
import type { Context } from '@deepseek-ai/cordis'
import { repairToolArguments } from './json-repair.ts'
import { emitTelemetry } from './telemetry.ts'

export const name = 'hearth-toolcall-repair'

export interface Config {
  /** Attempt syntax repair before failing the step. */
  repair: boolean
  /** Re-sample attempts per step after an unrepairable failure. */
  maxRetries: number
  /** Failure codes that trigger a re-sample. */
  retryCodes: string[]
}

/** Minimal structural view of DSH stream chunks used here. */
export type Chunk =
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: { type: string; [k: string]: unknown } }
  | { type: 'usage'; usage: unknown }
  | { type: 'finish'; reason: { kind: string; failure?: { code?: string; message?: string } }; replayState?: unknown }
  | { type: string; [k: string]: unknown }

interface PendingCall {
  id: string
  name: string
  args: string
}

function isMalformedError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'MALFORMED_RESPONSE'
}

/**
 * Wrap a raw chunk stream, repairing malformed tool-call arguments.
 * @param source - the downstream adapter stream.
 * @param onRepair - observer for repair outcomes.
 * @returns the possibly-repaired stream.
 */
export async function* repairStream(
  source: AsyncIterable<Chunk>,
  onRepair: (outcome: { repaired: boolean; calls: Array<{ name: string; fixes?: string[]; error?: string }> }) => void,
): AsyncGenerator<Chunk> {
  const calls = new Map<number, PendingCall>()
  const ended = new Set<number>()
  let heldUsage: Chunk | undefined

  const tryRepair = function* (): Generator<Chunk, boolean> {
    const pending = [...calls.entries()].filter(([index]) => !ended.has(index))
    if (pending.length === 0) return false
    const results = pending.map(([index, call]) => ({ index, call, result: repairToolArguments(call.args) }))
    const report = results.map(r => (r.result.ok ? { name: r.call.name, fixes: r.result.fixes } : { name: r.call.name, error: r.result.error }))
    if (!results.every(r => r.result.ok)) {
      onRepair({ repaired: false, calls: report })
      return false
    }
    onRepair({ repaired: true, calls: report })
    for (const { index, call, result } of results) {
      if (!result.ok) continue
      yield { type: 'block-end', index, block: { type: 'tool-call', id: call.id, name: call.name, arguments: result.text } }
    }
    if (heldUsage) yield heldUsage
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
    return true
  }

  try {
    for await (const chunk of source) {
      if (chunk.type === 'tool-call-delta') {
        const c = chunk as Extract<Chunk, { type: 'tool-call-delta' }>
        const call = calls.get(c.index) ?? { id: c.id, name: '', args: '' }
        if (c.id) call.id = c.id
        if (c.name) call.name = c.name
        call.args += c.argumentsDelta
        calls.set(c.index, call)
        yield chunk
        continue
      }
      if (chunk.type === 'block-end') {
        ended.add((chunk as { index: number }).index)
        yield chunk
        continue
      }
      if (chunk.type === 'usage') {
        heldUsage = chunk
        continue
      }
      if (chunk.type === 'finish') {
        const reason = (chunk as Extract<Chunk, { type: 'finish' }>).reason
        if (reason.kind === 'error' && reason.failure?.code === 'MALFORMED_RESPONSE') {
          if (yield* tryRepair()) return
        }
        if (heldUsage) yield heldUsage
        heldUsage = undefined
        yield chunk
        return
      }
      yield chunk
    }
  } catch (error) {
    if (isMalformedError(error) && (yield* tryRepair())) return
    throw error
  }
  if (heldUsage) yield heldUsage
}

/**
 * Plugin entry.
 * @param ctx - Cordis context.
 * @param config - repair and retry policy.
 */
export function apply(ctx: Context, config: Config): void {
  const attempts = new Map<string, number>()
  if (config.repair) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event typing comes from DSH declaration merging
    ;(ctx as any).on('llm/stream', (options: { model?: string }, next: () => AsyncIterable<Chunk>) =>
      repairStream(next(), outcome => emitTelemetry({ event: 'toolcall-repair', model: options?.model, ...outcome })),
    )
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(ctx as any).on('agent/request-error', async (payload: { agent: { session?: { id?: string } }; turn: number; step: number; failure: { code?: string } }, next: () => Promise<unknown>) => {
    const code = payload.failure?.code ?? ''
    if (!config.retryCodes.includes(code)) return next()
    const key = `${payload.agent?.session?.id ?? '?'}:${payload.turn}:${payload.step}`
    const used = attempts.get(key) ?? 0
    if (used >= config.maxRetries) {
      emitTelemetry({ event: 'toolcall-retry-exhausted', code, turn: payload.turn, step: payload.step, attempts: used })
      return next()
    }
    attempts.set(key, used + 1)
    emitTelemetry({ event: 'toolcall-retry', code, turn: payload.turn, step: payload.step, attempt: used + 1 })
    return { kind: 'retry' }
  })
  emitTelemetry({ event: 'plugin-ready', plugin: name })
}
