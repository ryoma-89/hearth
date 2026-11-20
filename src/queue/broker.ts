/**
 * Inference lease broker: a counting semaphore for model requests shared by
 * every Hearth task process (and, later, other clients such as a Discord bot).
 *
 * Guarantees:
 * - At most `maxConcurrent` leases are active.
 * - Waiters are served FIFO; a waiter whose signal aborts (client
 *   disconnected, task cancelled) leaves the queue without being granted.
 * - A granted lease that stops heartbeating for `leaseTtlMs`, or that lives
 *   longer than `maxLeaseMs`, is revoked so a crashed or hung holder cannot
 *   occupy the slot forever. `releaseTask` frees every lease of a task whose
 *   process exited.
 */
import { randomUUID } from 'node:crypto'

export interface BrokerOptions {
  maxConcurrent: number
  leaseTtlMs: number
  maxLeaseMs: number
  waitTimeoutMs: number
  /** Sweep period; defaults to a fraction of the TTL. */
  sweepIntervalMs?: number
  now?: () => number
}

export interface LeaseRequest {
  taskId: string
  holder: string
  purpose?: string
}

export interface LeaseInfo extends LeaseRequest {
  id: string
  grantedAt: number
  lastHeartbeat: number
}

export interface WaiterInfo extends LeaseRequest {
  id: string
  enqueuedAt: number
}

export type BrokerEvent =
  | { type: 'granted'; lease: LeaseInfo; waitedMs: number }
  | { type: 'released'; lease: LeaseInfo; reason: 'released' | 'expired' | 'max-duration' | 'task-ended' }
  | { type: 'wait-cancelled'; waiter: WaiterInfo; reason: string }

export class LeaseWaitError extends Error {
  readonly code: 'WAIT_TIMEOUT' | 'WAIT_ABORTED' | 'BROKER_CLOSED'
  constructor(code: LeaseWaitError['code'], message: string) {
    super(message)
    this.name = 'LeaseWaitError'
    this.code = code
  }
}

interface Waiter {
  info: WaiterInfo
  resolve: (lease: LeaseInfo) => void
  reject: (error: Error) => void
  cleanup: () => void
}

export class InferenceBroker {
  private readonly options: Required<Omit<BrokerOptions, 'now'>> & { now: () => number }
  private readonly active = new Map<string, LeaseInfo>()
  private readonly waiters: Waiter[] = []
  private readonly listeners = new Set<(event: BrokerEvent) => void>()
  private readonly sweeper: NodeJS.Timeout
  private closed = false
  private maxConcurrent: number
  private peakActive = 0

  constructor(options: BrokerOptions) {
    if (options.maxConcurrent < 1) throw new RangeError('maxConcurrent must be >= 1')
    this.options = {
      sweepIntervalMs: Math.max(50, Math.floor(options.leaseTtlMs / 4)),
      now: Date.now,
      ...options,
    }
    this.maxConcurrent = options.maxConcurrent
    this.sweeper = setInterval(() => this.sweep(), this.options.sweepIntervalMs)
    this.sweeper.unref()
  }

  /** Subscribe to lease lifecycle events; returns the unsubscribe function. */
  onEvent(listener: (event: BrokerEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: BrokerEvent): void {
    for (const l of this.listeners) {
      try {
        l(event)
      } catch (error) {
        // A faulty observer must not break scheduling; surface it on stderr.
        process.stderr.write(`hearth broker listener failed: ${String(error)}\n`)
      }
    }
  }

  /**
   * Wait for a slot.
   * @param request - task and holder identity.
   * @param signal - aborts the wait (not an already-granted lease).
   * @returns the granted lease.
   */
  acquire(request: LeaseRequest, signal?: AbortSignal): Promise<LeaseInfo> {
    if (this.closed) return Promise.reject(new LeaseWaitError('BROKER_CLOSED', 'broker is closed'))
    if (signal?.aborted) return Promise.reject(new LeaseWaitError('WAIT_ABORTED', 'lease wait aborted'))
    const now = this.options.now()
    const info: WaiterInfo = { ...request, id: randomUUID(), enqueuedAt: now }
    return new Promise<LeaseInfo>((resolve, reject) => {
      const timer = setTimeout(() => this.cancelWaiter(info.id, new LeaseWaitError('WAIT_TIMEOUT', `no inference slot within ${this.options.waitTimeoutMs} ms`)), this.options.waitTimeoutMs)
      timer.unref()
      const onAbort = () => this.cancelWaiter(info.id, new LeaseWaitError('WAIT_ABORTED', 'lease wait aborted'))
      signal?.addEventListener('abort', onAbort, { once: true })
      this.waiters.push({
        info,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
        },
      })
      this.pump()
    })
  }

  private cancelWaiter(id: string, error: LeaseWaitError): void {
    const index = this.waiters.findIndex(w => w.info.id === id)
    if (index < 0) return
    const [waiter] = this.waiters.splice(index, 1)
    waiter!.cleanup()
    this.emit({ type: 'wait-cancelled', waiter: waiter!.info, reason: error.code })
    waiter!.reject(error)
  }

  private pump(): void {
    while (this.active.size < this.maxConcurrent && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!
      waiter.cleanup()
      const now = this.options.now()
      const lease: LeaseInfo = { ...waiter.info, grantedAt: now, lastHeartbeat: now }
      this.active.set(lease.id, lease)
      this.peakActive = Math.max(this.peakActive, this.active.size)
      this.emit({ type: 'granted', lease, waitedMs: now - waiter.info.enqueuedAt })
      waiter.resolve(lease)
    }
  }

  /** Refresh a lease. Returns false when the lease no longer exists (revoked or released). */
  heartbeat(id: string): boolean {
    const lease = this.active.get(id)
    if (!lease) return false
    lease.lastHeartbeat = this.options.now()
    return true
  }

  /** Release a lease. Returns false when it was already gone. */
  release(id: string, reason: 'released' | 'expired' | 'max-duration' | 'task-ended' = 'released'): boolean {
    const lease = this.active.get(id)
    if (!lease) return false
    this.active.delete(id)
    this.emit({ type: 'released', lease, reason })
    this.pump()
    return true
  }

  /** Release every lease and drop every waiter that belongs to a task. */
  releaseTask(taskId: string): number {
    let count = 0
    // Drop waiters first: releasing a lease pumps the queue and would otherwise
    // grant a slot to another waiter of the same dead task.
    for (const waiter of [...this.waiters]) {
      if (waiter.info.taskId === taskId) {
        this.cancelWaiter(waiter.info.id, new LeaseWaitError('WAIT_ABORTED', 'task ended'))
        count++
      }
    }
    for (const lease of [...this.active.values()]) {
      if (lease.taskId === taskId && this.release(lease.id, 'task-ended')) count++
    }
    return count
  }

  /** Change the concurrency limit at runtime (active leases are never preempted). */
  setMaxConcurrent(value: number): void {
    if (value < 1) throw new RangeError('maxConcurrent must be >= 1')
    this.maxConcurrent = value
    this.pump()
  }

  /** Revoke expired leases. Public for deterministic tests. */
  sweep(): void {
    const now = this.options.now()
    for (const lease of [...this.active.values()]) {
      if (now - lease.grantedAt > this.options.maxLeaseMs) this.release(lease.id, 'max-duration')
      else if (now - lease.lastHeartbeat > this.options.leaseTtlMs) this.release(lease.id, 'expired')
    }
  }

  snapshot(): { maxConcurrent: number; peakActive: number; active: LeaseInfo[]; waiting: WaiterInfo[] } {
    return {
      maxConcurrent: this.maxConcurrent,
      peakActive: this.peakActive,
      active: [...this.active.values()].map(l => ({ ...l })),
      waiting: this.waiters.map(w => ({ ...w.info })),
    }
  }

  close(): void {
    this.closed = true
    clearInterval(this.sweeper)
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup()
      waiter.reject(new LeaseWaitError('BROKER_CLOSED', 'broker is closed'))
    }
    this.active.clear()
  }
}
