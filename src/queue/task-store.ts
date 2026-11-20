/**
 * Durable task records: one JSON file per task under <stateDir>/tasks.
 * Writes are atomic (temp file + rename) so a crash never leaves a torn record.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModeName } from '../config/types.ts'

export type TaskStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'verification_failed' | 'cancelled' | 'timed_out' | 'budget_exhausted' | 'interrupted'

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['succeeded', 'failed', 'verification_failed', 'cancelled', 'timed_out', 'budget_exhausted', 'interrupted']

export interface TaskMetrics {
  durationMs: number
  steps: number
  toolCalls: number
  toolErrors: number
  inputTokens: number
  outputTokens: number
  totalTokens: number
  leaseWaitMs: number
  toolCallRepairs: number
  toolCallRetries: number
  policyDenials: number
  /** DSH history compactions during the task, and task notes re-injected after them. */
  compactions?: number
  memoryReinjections?: number
  budgetExhausted?: { kind: string; detail: string }
  /** Turn-end verification: runs performed, fix rounds requested, and the last outcome. */
  verification?: { runs: number; fixRounds: number; last: 'passed' | 'failed' | 'failed-final' | 'skipped'; failures: string[] }
}

export interface TaskRecord {
  id: string
  prompt: string
  mode: ModeName
  provider: string
  model: string
  workspace: string
  status: TaskStatus
  createdAt: string
  startedAt?: string
  finishedAt?: string
  /** DSH session id; set once the run opened its session. */
  sessionId?: string
  /** Task id this run resumes, when created by `resume`. */
  resumeOf?: string
  /** Root task id of the conversation (chain of resumes) this task belongs to. */
  conversationId?: string
  /** Extra verification commands (PowerShell) that must exit 0 before the task counts as done. */
  verifyCommands?: string[]
  source: string
  metrics?: TaskMetrics
  finalText?: string
  error?: string
  exitCode?: number | null
}

export class TaskStore {
  readonly dir: string

  constructor(stateDir: string) {
    this.dir = join(stateDir, 'tasks')
    mkdirSync(this.dir, { recursive: true })
  }

  private file(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`invalid task id: ${id}`)
    return join(this.dir, `${id}.json`)
  }

  save(task: TaskRecord): void {
    const file = this.file(task.id)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(task, null, 2), 'utf8')
    renameSync(tmp, file)
  }

  get(id: string): TaskRecord | undefined {
    const file = this.file(id)
    if (!existsSync(file)) return undefined
    return JSON.parse(readFileSync(file, 'utf8')) as TaskRecord
  }

  list(): TaskRecord[] {
    return readdirSync(this.dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          return JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as TaskRecord
        } catch (error) {
          process.stderr.write(`hearth: skipping unreadable task record ${f}: ${(error as Error).message}\n`)
          return undefined
        }
      })
      .filter((t): t is TaskRecord => t !== undefined)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
}
