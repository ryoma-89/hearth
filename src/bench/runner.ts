/**
 * Benchmark runner: drives the suite through a Hearth daemon (the same path
 * real users take), applies each task's objective check, classifies failures,
 * and writes JSON + Markdown reports.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModeName } from '../config/types.ts'
import { TERMINAL_STATUSES, type TaskRecord } from '../queue/task-store.ts'
import type { BenchContext, BenchTask, CheckResult } from './suite.ts'

export interface BenchEndpoint {
  baseURL: string
  token: string
}

export interface BenchOptions {
  endpoint: BenchEndpoint
  stateDir: string
  workRoot: string
  tasks: BenchTask[]
  repeat: number
  mode?: ModeName
  model?: string
  label: string
  /** Per-task deadline (ms) for waiting on a daemon task. */
  taskTimeoutMs: number
  onProgress?: (message: string) => void
}

export interface BenchRun {
  task: string
  item: number
  title: string
  repeat: number
  pass: boolean
  detail: string
  failureCause: string | null
  statuses: string[]
  taskIds: string[]
  workspace: string
  durationMs: number
  wallMs: number
  steps: number
  toolCalls: number
  toolErrors: number
  totalTokens: number
  outputTokens: number
  repairs: number
  retries: number
  policyDenials: number
  compactions: number
  verification: string | null
}

export interface BenchReport {
  label: string
  startedAt: string
  finishedAt: string
  model: string
  modeOverride: string | null
  repeat: number
  runs: BenchRun[]
  summary: Array<{ task: string; item: number; title: string; runs: number; passes: number; successRate: number; avgDurationMs: number; avgToolCalls: number; avgTokens: number; causes: Record<string, number> }>
}

async function call<T>(ep: BenchEndpoint, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ep.baseURL}${path}`, {
    method,
    headers: { authorization: `Bearer ${ep.token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${data.error ?? ''}`)
  return data
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitTask(ep: BenchEndpoint, id: string, timeoutMs: number): Promise<TaskRecord> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { task } = await call<{ task: TaskRecord }>(ep, 'GET', `/v1/tasks/${id}`)
    if (TERMINAL_STATUSES.includes(task.status)) return task
    if (Date.now() > deadline) {
      await call(ep, 'POST', `/v1/tasks/${id}/cancel`).catch(() => undefined)
      throw new Error(`task ${id} did not finish within ${timeoutMs} ms (cancelled)`)
    }
    await sleep(1000)
  }
}

/** Number of completed steps so far, read from the task's event log. */
async function completedSteps(ep: BenchEndpoint, id: string): Promise<number> {
  const res = await fetch(`${ep.baseURL}/v1/tasks/${id}/events`, { headers: { authorization: `Bearer ${ep.token}` } })
  const text = await res.text()
  return (text.match(/"phase":"step_end"/g) ?? []).length
}

/**
 * Classify why a run failed.
 * @param run - collected statuses and check result.
 * @returns a short cause label, or null on success.
 */
export function classifyFailure(tasks: TaskRecord[], check: CheckResult, expectCancelledFirst: boolean): string | null {
  if (check.pass) return null
  const relevant = expectCancelledFirst ? tasks.slice(1) : tasks
  for (const t of relevant) {
    if (t.status === 'succeeded') continue
    if (t.status === 'budget_exhausted') return `budget:${t.metrics?.budgetExhausted?.kind ?? '?'}`
    if (t.status === 'failed') {
      const code = /\b([A-Z][A-Z_]{3,})\b/.exec(t.error ?? '')?.[1]
      return `failed:${code ?? 'other'}`
    }
    return t.status
  }
  return 'check-failed'
}

function sum(tasks: TaskRecord[], pick: (t: TaskRecord) => number | undefined): number {
  return tasks.reduce((n, t) => n + (pick(t) ?? 0), 0)
}

async function runOne(opts: BenchOptions, task: BenchTask, repeat: number): Promise<BenchRun> {
  const ep = opts.endpoint
  const dir = join(opts.workRoot, `${task.id}-r${repeat}`)
  rmSync(dir, { recursive: true, force: true })
  const workspace = join(dir, 'ws')
  const scratch = join(dir, 'scratch')
  mkdirSync(workspace, { recursive: true })
  mkdirSync(scratch, { recursive: true })
  task.setup({ workspace, scratch })
  const submit = (ws: string, prompt = task.prompt) =>
    call<{ task: TaskRecord }>(ep, 'POST', '/v1/tasks', { prompt, mode: opts.mode ?? task.mode, model: opts.model, workspace: ws, source: 'bench' }).then(r => r.task)

  const started = Date.now()
  const tasks: TaskRecord[] = []
  let driverError: string | undefined
  try {
    if (task.driver === 'single') {
      const t = await submit(workspace)
      tasks.push(await waitTask(ep, t.id, opts.taskTimeoutMs))
    } else if (task.driver === 'interrupt-resume') {
      const t = await submit(workspace)
      const deadline = Date.now() + opts.taskTimeoutMs
      let finishedEarly = false
      for (;;) {
        const { task: cur } = await call<{ task: TaskRecord }>(ep, 'GET', `/v1/tasks/${t.id}`)
        if (TERMINAL_STATUSES.includes(cur.status)) {
          finishedEarly = true
          break
        }
        if ((await completedSteps(ep, t.id)) >= (task.interruptAfterSteps ?? 2)) break
        if (Date.now() > deadline) throw new Error('interrupt point not reached in time')
        await sleep(500)
      }
      if (!finishedEarly) await call(ep, 'POST', `/v1/tasks/${t.id}/cancel`)
      const first = await waitTask(ep, t.id, 120_000)
      tasks.push(first)
      if (first.sessionId) {
        const { task: next } = await call<{ task: TaskRecord }>(ep, 'POST', `/v1/tasks/${first.id}/resume`, { prompt: task.resumePrompt })
        tasks.push(await waitTask(ep, next.id, opts.taskTimeoutMs))
      }
    } else {
      const n = task.batch ?? 3
      const created: TaskRecord[] = []
      for (let i = 0; i < n; i++) {
        const ws = join(workspace, `q${i + 1}`)
        mkdirSync(ws, { recursive: true })
        created.push(await submit(ws))
      }
      for (const t of created) tasks.push(await waitTask(ep, t.id, opts.taskTimeoutMs))
    }
  } catch (error) {
    driverError = (error as Error).message
  }
  const wallMs = Date.now() - started
  let peakInference: number | undefined
  let maxInference: number | undefined
  try {
    const s = await call<{ inference: { peakActive: number; maxConcurrent: number } }>(ep, 'GET', '/v1/status')
    peakInference = s.inference.peakActive
    maxInference = s.inference.maxConcurrent
  } catch {
    // status is informational for the queue check only
  }
  const ctx: BenchContext = { workspace, scratch, stateDir: opts.stateDir, tasks, peakInference, maxInference }
  let check: CheckResult
  if (driverError) check = { pass: false, detail: `driver error: ${driverError}` }
  else {
    try {
      check = task.check(ctx)
    } catch (error) {
      check = { pass: false, detail: `check crashed: ${(error as Error).message}` }
    }
  }
  const cause = driverError ? 'driver-error' : classifyFailure(tasks, check, task.driver === 'interrupt-resume')
  const last = tasks.at(-1)
  return {
    task: task.id,
    item: task.item,
    title: task.title,
    repeat,
    pass: check.pass,
    detail: check.detail,
    failureCause: cause,
    statuses: tasks.map(t => t.status),
    taskIds: tasks.map(t => t.id),
    workspace,
    durationMs: sum(tasks, t => t.metrics?.durationMs),
    wallMs,
    steps: sum(tasks, t => t.metrics?.steps),
    toolCalls: sum(tasks, t => t.metrics?.toolCalls),
    toolErrors: sum(tasks, t => t.metrics?.toolErrors),
    totalTokens: sum(tasks, t => t.metrics?.totalTokens),
    outputTokens: sum(tasks, t => t.metrics?.outputTokens),
    repairs: sum(tasks, t => t.metrics?.toolCallRepairs),
    retries: sum(tasks, t => t.metrics?.toolCallRetries),
    policyDenials: sum(tasks, t => t.metrics?.policyDenials),
    compactions: sum(tasks, t => t.metrics?.compactions),
    verification: last?.metrics?.verification ? `${last.metrics.verification.last}/${last.metrics.verification.fixRounds}` : null,
  }
}

/** Aggregate runs per task. */
export function summarize(runs: BenchRun[]): BenchReport['summary'] {
  const byTask = new Map<string, BenchRun[]>()
  for (const r of runs) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r])
  return [...byTask.values()].map(list => {
    const causes: Record<string, number> = {}
    for (const r of list) if (r.failureCause) causes[r.failureCause] = (causes[r.failureCause] ?? 0) + 1
    const avg = (f: (r: BenchRun) => number) => Math.round(list.reduce((n, r) => n + f(r), 0) / list.length)
    return {
      task: list[0]!.task,
      item: list[0]!.item,
      title: list[0]!.title,
      runs: list.length,
      passes: list.filter(r => r.pass).length,
      successRate: list.filter(r => r.pass).length / list.length,
      avgDurationMs: avg(r => r.durationMs),
      avgToolCalls: avg(r => r.toolCalls),
      avgTokens: avg(r => r.totalTokens),
      causes,
    }
  })
}

export async function runBench(opts: BenchOptions): Promise<BenchReport> {
  mkdirSync(opts.workRoot, { recursive: true })
  const startedAt = new Date().toISOString()
  const runs: BenchRun[] = []
  for (let r = 1; r <= opts.repeat; r++) {
    for (const task of opts.tasks) {
      opts.onProgress?.(`[${r}/${opts.repeat}] #${task.item} ${task.id} ...`)
      const run = await runOne(opts, task, r)
      runs.push(run)
      opts.onProgress?.(`[${r}/${opts.repeat}] #${task.item} ${task.id}: ${run.pass ? 'PASS' : `FAIL (${run.failureCause})`} — ${run.detail} (${Math.round(run.wallMs / 1000)}s, tools ${run.toolCalls}, tokens ${run.totalTokens})`)
    }
  }
  return { label: opts.label, startedAt, finishedAt: new Date().toISOString(), model: opts.model ?? 'default', modeOverride: opts.mode ?? null, repeat: opts.repeat, runs, summary: summarize(runs) }
}

const pct = (x: number) => `${Math.round(x * 100)}%`
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`

/** Render a report as Markdown (Japanese, matching the project docs). */
export function renderMarkdown(report: BenchReport): string {
  const total = report.runs.length
  const passed = report.runs.filter(r => r.pass).length
  const lines = [
    `# ベンチマーク結果: ${report.label}`,
    '',
    `- 期間: ${report.startedAt} 〜 ${report.finishedAt}`,
    `- モデル: ${report.model}${report.modeOverride ? ` / モード上書き: ${report.modeOverride}` : ''}`,
    `- 繰り返し: ${report.repeat} 回、合計 ${total} 実行、合格 ${passed}（${pct(passed / Math.max(1, total))}）`,
    '',
    '## 項目別',
    '',
    '| # | 項目 | 合格/実行 | 成功率 | 平均処理時間 | 平均ツール呼出 | 平均トークン | 失敗原因 |',
    '|---|---|---|---|---|---|---|---|',
    ...report.summary.map(s => `| ${s.item} | ${s.title} | ${s.passes}/${s.runs} | ${pct(s.successRate)} | ${secs(s.avgDurationMs)} | ${s.avgToolCalls} | ${s.avgTokens} | ${Object.entries(s.causes).map(([k, v]) => `${k}×${v}`).join(', ') || '—'} |`),
    '',
    '## 実行ごと',
    '',
    '| 項目 | 回 | 結果 | 状態 | 時間 | ステップ | ツール(エラー) | トークン(出力) | 修復/再試行 | 拒否 | 圧縮 | 検証 | 判定の詳細 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...report.runs.map(r => `| ${r.task} | ${r.repeat} | ${r.pass ? '✔' : '✖'} | ${r.statuses.join('→')} | ${secs(r.wallMs)} | ${r.steps} | ${r.toolCalls}(${r.toolErrors}) | ${r.totalTokens}(${r.outputTokens}) | ${r.repairs}/${r.retries} | ${r.policyDenials} | ${r.compactions} | ${r.verification ?? '—'} | ${r.detail.replace(/\|/g, '\\|')} |`),
    '',
    '判定はモデルの自己申告ではなく、生成物・ファイル・状態を直接検査した結果。タスク ID ごとのログは `.hearth/runs/<task-id>/`。',
    '',
  ]
  return lines.join('\n')
}

export function writeReports(report: BenchReport, jsonDir: string, mdDir: string): { json: string; md: string } {
  mkdirSync(jsonDir, { recursive: true })
  mkdirSync(mdDir, { recursive: true })
  const stamp = report.startedAt.replace(/[:.]/g, '-').slice(0, 19)
  const base = `${stamp}-${report.label.replace(/[^A-Za-z0-9_-]+/g, '_')}`
  const json = join(jsonDir, `${base}.json`)
  const md = join(mdDir, `${base}.md`)
  writeFileSync(json, JSON.stringify(report, null, 2), 'utf8')
  writeFileSync(md, renderMarkdown(report), 'utf8')
  return { json, md }
}
