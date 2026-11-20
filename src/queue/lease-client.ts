/**
 * HTTP client for the daemon's inference lease API. Used by the
 * inference-gate plugin inside each DSH child process.
 */

export interface LeaseClientOptions {
  baseURL: string
  token: string
  taskId: string
  holder: string
  /** Connection attempts before giving up when the daemon is unreachable. */
  connectAttempts?: number
  /** Heartbeat period; must be well below the broker TTL. */
  heartbeatMs: number
}

export interface HeldLease {
  id: string
  /** True once the broker reported the lease gone (revoked or expired). */
  readonly lost: boolean
  release(): Promise<void>
}

export class LeaseClientError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'LeaseClientError'
    this.code = code
  }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

export class LeaseClient {
  private readonly options: Required<LeaseClientOptions>

  constructor(options: LeaseClientOptions) {
    this.options = { connectAttempts: 5, ...options }
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.options.token}`, 'content-type': 'application/json' }
  }

  /**
   * Wait for and hold an inference slot.
   * @param purpose - short label for status displays.
   * @param signal - aborts the wait.
   * @returns the held lease with a running heartbeat.
   */
  async acquire(purpose: string, signal?: AbortSignal): Promise<HeldLease> {
    let lastError: unknown
    for (let attempt = 1; attempt <= this.options.connectAttempts; attempt++) {
      if (signal?.aborted) throw new LeaseClientError('ABORTED', 'lease wait aborted')
      let response: Response
      try {
        response = await fetch(`${this.options.baseURL}/v1/leases`, {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ taskId: this.options.taskId, holder: this.options.holder, purpose }),
          signal,
        })
      } catch (error) {
        if (signal?.aborted) throw new LeaseClientError('ABORTED', 'lease wait aborted')
        lastError = error
        await sleep(Math.min(5000, 250 * 2 ** attempt))
        continue
      }
      const body = (await response.json().catch(() => ({}))) as { leaseId?: string; error?: string; code?: string }
      if (response.ok && body.leaseId) return this.hold(body.leaseId)
      throw new LeaseClientError(body.code ?? `HTTP_${response.status}`, `inference lease refused: ${body.error ?? response.statusText}`)
    }
    throw new LeaseClientError('UNREACHABLE', `Hearth daemon unreachable at ${this.options.baseURL}: ${String(lastError)}`)
  }

  private hold(id: string): HeldLease {
    let lost = false
    let released = false
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`${this.options.baseURL}/v1/leases/${id}/heartbeat`, { method: 'POST', headers: this.headers() })
        if (r.status === 404) lost = true
      } catch (error) {
        // Transient daemon hiccup: the broker TTL decides whether the lease survives.
        void error
      }
    }, this.options.heartbeatMs)
    timer.unref()
    const release = async () => {
      if (released) return
      released = true
      clearInterval(timer)
      try {
        await fetch(`${this.options.baseURL}/v1/leases/${id}`, { method: 'DELETE', headers: this.headers() })
      } catch (error) {
        // Daemon gone: its TTL sweep or task-exit cleanup reclaims the slot.
        void error
      }
    }
    return {
      id,
      get lost() {
        return lost
      },
      release,
    }
  }
}
