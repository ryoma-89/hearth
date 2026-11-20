/**
 * DSH plugin: hold a daemon-issued inference lease for every model stream.
 *
 * Wraps the `llm/stream` waterfall, so the main agent loop, compaction
 * summaries, and title generation are all serialized through the same
 * broker. The daemon URL comes from config; the bearer token only from the
 * HEARTH_BROKER_TOKEN environment variable so it never lands in a patch file.
 */
import type { Context } from '@deepseek-ai/cordis'
import { LeaseClient, type HeldLease } from '../queue/lease-client.ts'
import { emitTelemetry } from './telemetry.ts'

export const name = 'hearth-inference-gate'

export interface Config {
  brokerURL: string
  taskId: string
  heartbeatMs: number
}

/**
 * Run a stream while holding a lease.
 * @param acquire - obtains the lease.
 * @param open - opens the downstream stream once the lease is held.
 * @returns the gated stream.
 */
export async function* gateStream<T>(acquire: () => Promise<HeldLease>, open: () => AsyncIterable<T>): AsyncGenerator<T> {
  const lease = await acquire()
  try {
    for await (const chunk of open()) {
      if (lease.lost) throw new Error('inference lease was revoked by the Hearth daemon (lease expired or exceeded its maximum duration)')
      yield chunk
    }
  } finally {
    await lease.release()
  }
}

/**
 * Plugin entry.
 * @param ctx - Cordis context.
 * @param config - broker location and task identity.
 */
export function apply(ctx: Context, config: Config): void {
  const token = process.env.HEARTH_BROKER_TOKEN
  if (!token) throw new Error('hearth-inference-gate: HEARTH_BROKER_TOKEN is not set (run tasks through the Hearth daemon or runner)')
  const client = new LeaseClient({ baseURL: config.brokerURL, token, taskId: config.taskId, holder: `pid:${process.pid}`, heartbeatMs: config.heartbeatMs })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event typing comes from DSH declaration merging
  ;(ctx as any).on('llm/stream', (options: { model?: string; signal?: AbortSignal; purpose?: string }, next: () => AsyncIterable<unknown>) => {
    const started = Date.now()
    return gateStream(
      async () => {
        const lease = await client.acquire(options?.purpose ?? 'model-request', options?.signal)
        emitTelemetry({ event: 'lease-granted', leaseId: lease.id, waitedMs: Date.now() - started, model: options?.model })
        return lease
      },
      next,
    )
  })
  emitTelemetry({ event: 'plugin-ready', plugin: name })
}
