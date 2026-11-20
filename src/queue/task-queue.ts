/**
 * Task scheduler: FIFO queue with a concurrency limit, cancellation, durable
 * records, and live event fan-out. Execution itself is delegated to an
 * executor function (the DSH runner in production, a stub in tests).
 */
import { randomBytes } from 'node:crypto'
import type { RunEvent, RunOutcome } from '../runner/dsh-runner.ts'
import { TERMINAL_STATUSES, type TaskRecord, type TaskStore } from './task-store.ts'

export type Executor = (task: TaskRecord, signal: AbortSignal, onEvent: (event: RunEvent) => void) => Promise<RunOutcome>

export type TaskSubmission = Pick<TaskRecord, 'prompt' | 'mode' | 'provider' | 'model' | 'workspace' | 'source'> & Partial<Pick<TaskRecord, 'sessionId' | 'resumeOf' | 'verifyCommands' | 'conversationId'>>

export type QueueListener = (task: TaskRecord, event?: RunEvent) => void

/** Sortable, collision-resistant task id: time prefix + random suffix. */
export function newTaskId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  return `t${stamp}-${randomBytes(3).toString('hex')}`
}

export class TaskQueue {
  private readonly store: TaskStore
  private readonly executor: Executor
  private maxConcurrent: number
  private readonly pending: string[] = []
  private readonly running = new Map<string, AbortController>()
  private readonly listeners = new Set<QueueListener>()
  private readonly idleWaiters: Array<() => void> = []

  constructor(store: TaskStore, executor: Executor, maxConcurrent: number) {
    if (maxConcurrent < 1) throw new RangeError('maxConcurrent must be >= 1')
    this.store = store
    this.executor = executor
    this.maxConcurrent = maxConcurrent
  }

  /**
   * Restore state after a restart: tasks that were running are marked
   * interrupted (resumable through their session id); queued tasks re-enter
   * the queue in creation order.
   * @returns counts of interrupted and requeued tasks.
   */
  recover(): { interrupted: number; requeued: number } {
    let interrupted = 0
    let requeued = 0
    for (const task of this.store.list()) {
      if (task.status === 'running') {
        task.status = 'interrupted'
        task.finishedAt = new Date().toISOString()
        task.error = 'daemon stopped while the task was running; resume it to continue from its saved session'
        this.store.save(task)
        interrupted++
      } else if (task.status === 'queued') {
        this.pending.push(task.id)
        requeued++
      }
    }
    this.pump()
    return { interrupted, requeued }
  }

  onChange(listener: QueueListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(task: TaskRecord, event?: RunEvent): void {
    for (const l of this.listeners) {
      try {
        l(task, event)
      } catch (error) {
        process.stderr.write(`hearth: queue listener failed: ${String(error)}\n`)
      }
    }
  }

  submit(input: TaskSubmission): TaskRecord {
    const id = newTaskId()
    const task: TaskRecord = { ...input, id, conversationId: input.conversationId ?? id, status: 'queued', createdAt: new Date().toISOString() }
    this.store.save(task)
    this.pending.push(task.id)
    this.notify(task)
    this.pump()
    return this.store.get(task.id) ?? task
  }

  get(id: string): TaskRecord | undefined {
    return this.store.get(id)
  }

  list(): TaskRecord[] {
    return this.store.list()
  }

  /** Position in the waiting queue (1-based), or 0 when not waiting. */
  position(id: string): number {
    return this.pending.indexOf(id) + 1
  }

  stats(): { running: string[]; queued: string[]; maxConcurrent: number } {
    return { running: [...this.running.keys()], queued: [...this.pending], maxConcurrent: this.maxConcurrent }
  }

  /**
   * Cancel a queued or running task.
   * @returns false when the task does not exist or already finished.
   */
  cancel(id: string): boolean {
    const index = this.pending.indexOf(id)
    if (index >= 0) {
      this.pending.splice(index, 1)
      const task = this.store.get(id)
      if (task) {
        task.status = 'cancelled'
        task.finishedAt = new Date().toISOString()
        this.store.save(task)
        this.notify(task)
      }
      this.checkIdle()
      return true
    }
    const controller = this.running.get(id)
    if (controller) {
      controller.abort(new Error('cancelled by user'))
      return true
    }
    return false
  }

  private pump(): void {
    while (this.running.size < this.maxConcurrent && this.pending.length > 0) {
      const id = this.pending.shift()!
      const task = this.store.get(id)
      if (!task || task.status !== 'queued') continue
      void this.start(task)
    }
    this.checkIdle()
  }

  private async start(task: TaskRecord): Promise<void> {
    const controller = new AbortController()
    this.running.set(task.id, controller)
    task.status = 'running'
    task.startedAt = new Date().toISOString()
    this.store.save(task)
    this.notify(task)
    let outcome: RunOutcome | undefined
    let crash: string | undefined
    try {
      outcome = await this.executor(task, controller.signal, event => {
        if (event.kind === 'dsh' && event.event.type === 'session' && typeof event.event.sessionId === 'string' && task.sessionId !== event.event.sessionId) {
          task.sessionId = event.event.sessionId
          this.store.save(task)
        }
        this.notify(task, event)
      })
    } catch (error) {
      crash = `executor crashed: ${(error as Error).stack ?? String(error)}`
    } finally {
      this.running.delete(task.id)
    }
    const latest = this.store.get(task.id) ?? task
    latest.finishedAt = new Date().toISOString()
    if (outcome) {
      latest.status = outcome.status
      latest.sessionId = outcome.sessionId ?? latest.sessionId
      latest.metrics = outcome.metrics
      latest.finalText = outcome.finalText
      latest.error = outcome.error
      latest.exitCode = outcome.exitCode
    } else {
      latest.status = 'failed'
      latest.error = crash
    }
    this.store.save(latest)
    this.notify(latest)
    this.pump()
  }

  setMaxConcurrent(value: number): void {
    if (value < 1) throw new RangeError('maxConcurrent must be >= 1')
    this.maxConcurrent = value
    this.pump()
  }

  private checkIdle(): void {
    if (this.running.size === 0 && this.pending.length === 0) for (const w of this.idleWaiters.splice(0)) w()
  }

  /** Resolve once nothing is running or queued. */
  whenIdle(): Promise<void> {
    if (this.running.size === 0 && this.pending.length === 0) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  /** Cancel everything and wait for running executors to settle. */
  async shutdown(): Promise<void> {
    for (const id of [...this.pending]) this.cancel(id)
    for (const c of this.running.values()) c.abort(new Error('daemon shutting down'))
    await this.whenIdle()
  }

  static isTerminal(task: TaskRecord): boolean {
    return TERMINAL_STATUSES.includes(task.status)
  }
}
