/**
 * Hearth command-line interface.
 *
 * Every task goes through the daemon (auto-started) so local inference stays
 * serialized across all clients. Output for humans goes to stdout; `--json`
 * switches every command to machine-readable output for use by other agents
 * (Claude Code, Codex) as an external tool.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ConfigError, loadConfig } from '../config/load.ts'
import { MODE_NAMES, type HearthConfig, type ModeName } from '../config/types.ts'
import type { TaskRecord } from '../queue/task-store.ts'
import { deleteSecret, hasSecret, secretsDir, setSecret } from '../security/secrets.ts'
import { connect, DaemonError, ensureDaemon, type DaemonClient } from '../server/client.ts'
import { HearthDaemon } from '../server/daemon.ts'
import { localChecks, probeProvider, webSearchCheck, workspaceAclCheck, type Check } from './doctor.ts'

const HELP = `Hearth — local-LLM agent harness on DeepSeek Harness

Usage: hearth <command> [options]

Tasks
  run [options] <task...>      Submit a task and follow its progress ("-" reads the task from stdin)
      --mode <low|medium|high|maximum>   --model <provider/model>   --workspace <dir>
      --detach (print the task id and return)   --json (NDJSON events)
      --verify <command> (repeatable: PowerShell command that must exit 0, e.g. "python -m pytest")
  resume <task-id> [message]   Continue a task in its saved session (--mode, --model to switch models,
                               --interrupt to stop a running task first, --detach, --json)
  models [--refresh]           List configured and discovered models and which are loaded now
  cancel <task-id>             Cancel a queued or running task
  tasks                        List tasks
  show <task-id>               Show a task record and metrics
  logs <task-id> [--follow]    Print a task's event log

Daemon
  daemon start|stop|status     Manage the background daemon (start is automatic on "run")
  daemon run                   Run the daemon in the foreground
  status                       Queue and inference-slot status
  gui [--no-open]              Open the Web GUI in the browser (one-time login link)

Evaluation
  bench [--task id,...] [--repeat N] [--mode m] [--model p/m] [--label name] [--work-dir dir]
                               Run the Phase 5 benchmark suite through the daemon and write
                               docs/bench/<date>-<label>.md and .hearth/bench/<date>-<label>.json

Setup
  doctor [--provider <name>] [--workspace <dir>] [--no-probe]   Check tools, DSH, workspace ACLs, model connectivity / tool calling
  secret set <name>            Store an API key encrypted with Windows DPAPI (value read from stdin)
  secret delete <name> | secret list
  config                       Print the resolved configuration (no secrets)
  modes                        Show execution modes and their limits

Global options: --config <path>  --json  --help`

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = ms / 1000
  return s < 120 ? `${s.toFixed(1)}s` : `${(s / 60).toFixed(1)}min`
}

function out(json: boolean, value: unknown, human: () => string): void {
  process.stdout.write(json ? `${JSON.stringify(value)}\n` : `${human()}\n`)
}

function taskLine(t: TaskRecord): string {
  const m = t.metrics
  const metrics = m ? ` steps=${m.steps} tools=${m.toolCalls} tokens=${m.totalTokens} ${fmtMs(m.durationMs)}` : ''
  return `${t.id}  ${t.status.padEnd(16)} ${t.mode.padEnd(7)} ${t.prompt.replace(/\s+/g, ' ').slice(0, 60)}${metrics}`
}

function preview(value: unknown, max = 160): string {
  const s = typeof value === 'string' ? value : JSON.stringify(value)
  const flat = (s ?? '').replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/** Render one streamed record for humans. Returns the final task when the stream ends. */
function renderRecord(rec: Record<string, unknown>, verbose: boolean): void {
  if (rec.type === 'task') {
    const t = rec.task as TaskRecord
    process.stderr.write(`· task ${t.id} ${t.status}\n`)
    return
  }
  const ev = rec.event as { kind: string; event?: Record<string, unknown>; line?: string; phase?: string }
  if (ev.kind === 'dsh' && ev.event) {
    const e = ev.event
    if (e.type === 'status' && e.phase === 'step_start') process.stderr.write(`\n[step ${e.step}]\n`)
    else if (e.type === 'text' && typeof e.text === 'string') process.stdout.write(`${e.text}\n`)
    else if (e.type === 'thinking' && verbose) process.stderr.write(`  (thinking) ${preview(e.text, 300)}\n`)
    else if (e.type === 'tool_call') process.stderr.write(`  → ${e.tool} ${preview(e.input)}\n`)
    else if (e.type === 'tool_result') process.stderr.write(`  ${e.status === 'completed' ? '✓' : '✗'} ${preview(e.error ?? e.result, 200)}\n`)
    else if (e.type === 'status' && e.phase === 'step_end' && e.usage) {
      const u = e.usage as { inputTokens?: number; outputTokens?: number }
      process.stderr.write(`  tokens in=${u.inputTokens ?? 0} out=${u.outputTokens ?? 0}\n`)
    }
  } else if (ev.kind === 'telemetry' && ev.event) {
    const e = ev.event
    if (e.event === 'lease-granted' && Number(e.waitedMs) > 500) process.stderr.write(`  (waited ${fmtMs(Number(e.waitedMs))} for the inference slot)\n`)
    else if (e.event === 'toolcall-repair') process.stderr.write(`  ! tool-call JSON ${e.repaired ? 'repaired' : 'unrepairable'}: ${preview(e.calls)}\n`)
    else if (e.event === 'toolcall-retry') process.stderr.write(`  ! re-sampling step after ${e.code} (attempt ${e.attempt})\n`)
    else if (e.event === 'policy-denied') process.stderr.write(`  ⛔ policy denied ${e.tool}: ${preview(e.reason, 200)}\n`)
    else if (e.event === 'budget-exhausted') process.stderr.write(`  ⏹ budget exhausted (${e.kind}): ${e.detail}\n`)
    else if (e.event === 'verification') {
      const checks = Array.isArray(e.checks) ? (e.checks as Array<{ verifier: string; target: string; ok: boolean }>) : []
      const failed = checks.filter(c => !c.ok)
      if (e.status === 'skipped') process.stderr.write(`  ◇ verification skipped (${e.reason})\n`)
      else process.stderr.write(`  ◆ verification ${e.status}: ${checks.length - failed.length}/${checks.length} checks passed${failed.length ? ` — failed: ${failed.map(c => `${c.verifier} (${c.target})`).join(', ')}` : ''}${e.fixRound ? ` → fix round ${e.fixRound}` : ''}\n`)
    }
  } else if (ev.kind === 'stderr' && verbose && ev.line) process.stderr.write(`  [dsh] ${ev.line}\n`)
}

async function follow(client: DaemonClient, taskId: string, json: boolean, verbose: boolean): Promise<TaskRecord> {
  let last: TaskRecord | undefined
  const controller = new AbortController()
  let interrupted = false
  const onSigint = async () => {
    if (interrupted) process.exit(130)
    interrupted = true
    process.stderr.write(`\nCancelling task ${taskId} (press Ctrl+C again to detach)…\n`)
    try {
      await client.request('POST', `/v1/tasks/${taskId}/cancel`)
    } catch (error) {
      process.stderr.write(`cancel failed: ${(error as Error).message}\n`)
    }
  }
  process.on('SIGINT', onSigint)
  try {
    for await (const rec of client.events(taskId, true, controller.signal)) {
      if (json) process.stdout.write(`${JSON.stringify(rec)}\n`)
      else renderRecord(rec, verbose)
      if (rec.type === 'task') last = rec.task as TaskRecord
    }
  } finally {
    process.off('SIGINT', onSigint)
  }
  const final = (await client.request<{ task: TaskRecord }>('GET', `/v1/tasks/${taskId}`)).task
  return final ?? last!
}

function summary(t: TaskRecord): string {
  const m = t.metrics
  const lines = [`\n== ${t.id}: ${t.status}${t.error ? ` — ${t.error}` : ''}`]
  if (m?.verification) lines.push(`   verification: ${m.verification.last} after ${m.verification.runs} run(s), ${m.verification.fixRounds} fix round(s)${m.verification.failures.length ? ` — ${m.verification.failures.join(', ')}` : ''}`)
  if (m) lines.push(`   steps ${m.steps} · tool calls ${m.toolCalls} (errors ${m.toolErrors}) · tokens ${m.totalTokens} (in ${m.inputTokens} / out ${m.outputTokens}) · ${fmtMs(m.durationMs)} · slot wait ${fmtMs(m.leaseWaitMs)} · repairs ${m.toolCallRepairs} · retries ${m.toolCallRetries} · denials ${m.policyDenials}`)
  if (t.sessionId) lines.push(`   session ${t.sessionId} (resume with: hearth resume ${t.id})`)
  return lines.join('\n')
}

function exitCodeFor(t: TaskRecord): number {
  return t.status === 'succeeded' ? 0 : t.status === 'cancelled' ? 130 : 1
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of process.stdin) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Read one line from a TTY without echoing it. */
function readHiddenLine(promptText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stderr.write(promptText)
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    let value = ''
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.off('data', onData)
          process.stderr.write('\n')
          resolve(value)
          return
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false)
          reject(new Error('cancelled'))
          return
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on('data', onData)
  })
}

function printChecks(checks: Check[], json: boolean): number {
  out(json, checks, () => checks.map(c => `${c.status === 'pass' ? 'PASS' : c.status === 'warn' ? 'WARN' : 'FAIL'}  ${c.name.padEnd(28)} ${c.detail}`).join('\n'))
  return checks.some(c => c.status === 'fail') ? 1 : 0
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      config: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      mode: { type: 'string' },
      model: { type: 'string' },
      workspace: { type: 'string', short: 'w' },
      detach: { type: 'boolean', default: false },
      follow: { type: 'boolean', short: 'f', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      provider: { type: 'string' },
      verify: { type: 'string', multiple: true },
      'no-probe': { type: 'boolean', default: false },
      'no-open': { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      interrupt: { type: 'boolean', default: false },
      task: { type: 'string' },
      repeat: { type: 'string' },
      label: { type: 'string' },
      'work-dir': { type: 'string' },
    },
  })
  const [command, ...rest] = positionals
  if (values.help || !command) {
    process.stdout.write(`${HELP}\n`)
    return command ? 0 : values.help ? 0 : 1
  }
  const json = values.json === true
  let config: HearthConfig
  try {
    config = loadConfig({ path: values.config })
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`)
    return 2
  }
  if (values.mode && !(MODE_NAMES as readonly string[]).includes(values.mode)) {
    process.stderr.write(`--mode must be one of ${MODE_NAMES.join(', ')}\n`)
    return 2
  }

  switch (command) {
    case 'run': {
      let prompt = rest.join(' ')
      if (prompt === '-' || (!prompt && !process.stdin.isTTY)) prompt = await readStdin()
      if (!prompt.trim()) {
        process.stderr.write('hearth run: missing task text\n')
        return 2
      }
      const client = await ensureDaemon(config, values.config)
      const { task, position } = await client.request<{ task: TaskRecord; position: number }>('POST', '/v1/tasks', {
        prompt,
        mode: values.mode,
        model: values.model,
        workspace: values.workspace ?? process.cwd(),
        source: 'cli',
        verify: values.verify,
      })
      if (values.detach) {
        out(json, { task, position }, () => `${task.id} queued${position > 1 ? ` (position ${position})` : ''}`)
        return 0
      }
      if (!json) process.stderr.write(`Task ${task.id} (${task.mode}, ${task.provider}/${task.model}) in ${task.workspace}${position > 1 ? ` — queued at position ${position}` : ''}\n`)
      const final = await follow(client, task.id, json, values.verbose === true)
      if (!json) process.stderr.write(`${summary(final)}\n`)
      return exitCodeFor(final)
    }
    case 'resume': {
      const [id, ...msg] = rest
      if (!id) throw new Error('usage: hearth resume <task-id> [message]')
      const client = await ensureDaemon(config, values.config)
      const { task } = await client.request<{ task: TaskRecord }>('POST', `/v1/tasks/${id}/resume`, { prompt: msg.join(' ') || undefined, mode: values.mode, model: values.model, interrupt: values.interrupt === true })
      if (values.detach) {
        out(json, { task }, () => `${task.id} queued (resumes ${id})`)
        return 0
      }
      if (!json) process.stderr.write(`Resuming ${id} as ${task.id} (session ${task.sessionId})\n`)
      const final = await follow(client, task.id, json, values.verbose === true)
      if (!json) process.stderr.write(`${summary(final)}\n`)
      return exitCodeFor(final)
    }
    case 'models': {
      const client = await ensureDaemon(config, values.config)
      const r = await client.request<{ default: string; auto: Array<{ id: string; name: string }>; models: Array<{ id: string; name: string; available: boolean | null; discovered: boolean; contextWindow: number }>; discovery: Record<string, { available: string[]; refreshedAt: string | null; error?: string }> }>('GET', `/v1/models${values.refresh ? '?refresh=1' : ''}`)
      out(json, r, () =>
        [
          `default: ${r.default}`,
          ...r.auto.map(a => `  ${a.id.padEnd(40)} ${a.name}`),
          ...r.models.map(m => `  ${m.id.padEnd(40)} ${m.name}  ctx=${m.contextWindow}  ${m.available === null ? '' : m.available ? '[loaded]' : '[not loaded]'}${m.discovered ? ' (discovered)' : ''}`),
          ...Object.entries(r.discovery).map(([p, d]) => `${p}: ${d.error ? `discovery error: ${d.error}` : `serving ${d.available.join(', ') || 'nothing'}`} (checked ${d.refreshedAt ?? 'never'})`),
        ].join('\n'),
      )
      return 0
    }
    case 'cancel': {
      const client = await connect(config)
      if (!client) throw new Error('the Hearth daemon is not running')
      const r = await client.request<{ cancelled: boolean }>('POST', `/v1/tasks/${rest[0]}/cancel`)
      out(json, r, () => (r.cancelled ? `cancelled ${rest[0]}` : `${rest[0]} was not queued or running`))
      return r.cancelled ? 0 : 1
    }
    case 'tasks': {
      const client = await connect(config)
      const tasks = client ? (await client.request<{ tasks: TaskRecord[] }>('GET', '/v1/tasks')).tasks : new (await import('../queue/task-store.ts')).TaskStore(config.stateDir).list()
      out(json, tasks, () => (tasks.length ? tasks.map(taskLine).join('\n') : '(no tasks)'))
      return 0
    }
    case 'show': {
      const store = new (await import('../queue/task-store.ts')).TaskStore(config.stateDir)
      const t = store.get(rest[0] ?? '')
      if (!t) throw new Error(`task ${rest[0]} not found`)
      out(json, t, () => `${taskLine(t)}\nworkspace ${t.workspace}\nprompt: ${t.prompt}\n${summary(t)}${t.finalText ? `\n\n${t.finalText}` : ''}`)
      return 0
    }
    case 'logs': {
      const id = rest[0] ?? ''
      const client = await connect(config)
      if (client) {
        for await (const rec of client.events(id, values.follow === true)) {
          if (json) process.stdout.write(`${JSON.stringify(rec)}\n`)
          else renderRecord(rec, true)
        }
        return 0
      }
      const file = `${config.stateDir}/runs/${id}/events.jsonl`
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        if (json) process.stdout.write(`${line}\n`)
        else renderRecord({ type: 'event', event: JSON.parse(line) as unknown }, true)
      }
      return 0
    }
    case 'bench': {
      const { SUITE: OFFICIAL, EXTRA_SUITE } = await import('../bench/suite.ts')
      const { PROJECT_ROOT } = await import('../config/load.ts')
      // Extra items (e.g. long-context) run only when named explicitly.
      const SUITE = values.task ? [...OFFICIAL, ...EXTRA_SUITE] : OFFICIAL
      const { runBench, writeReports } = await import('../bench/runner.ts')
      const wanted = values.task ? values.task.split(',').map(s => s.trim()) : undefined
      const tasks = wanted ? SUITE.filter(t => wanted.includes(t.id) || wanted.includes(String(t.item))) : SUITE
      if (wanted && tasks.length !== wanted.length) {
        process.stderr.write(`unknown bench task in --task; available: ${SUITE.map(t => `${t.item}:${t.id}`).join(', ')}\n`)
        return 2
      }
      const repeat = Number(values.repeat ?? '1')
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20) {
        process.stderr.write('--repeat must be an integer between 1 and 20\n')
        return 2
      }
      const client = await ensureDaemon(config, values.config)
      const { join, resolve } = await import('node:path')
      const report = await runBench({
        endpoint: { baseURL: client.info.url, token: client.info.token },
        stateDir: config.stateDir,
        workRoot: resolve(values['work-dir'] ?? join(PROJECT_ROOT, '.bench-work')),
        tasks,
        repeat,
        mode: values.mode as ModeName | undefined,
        model: values.model,
        label: values.label ?? (values.model ?? `${config.defaultModel.provider}-${config.defaultModel.model}`),
        taskTimeoutMs: config.queue.taskTimeoutMs,
        onProgress: m => process.stderr.write(`${m}\n`),
      })
      const files = writeReports(report, join(config.stateDir, 'bench'), join(PROJECT_ROOT, 'docs', 'bench'))
      out(json, { ...files, summary: report.summary }, () => `\n${report.summary.map(s => `#${s.item} ${s.task}: ${s.passes}/${s.runs}`).join('\n')}\n\nreport: ${files.md}\nraw:    ${files.json}`)
      return report.runs.every(r => r.pass) ? 0 : 1
    }
    case 'gui': {
      const client = await ensureDaemon(config, values.config)
      const { url, expiresInMs } = await client.request<{ url: string; expiresInMs: number }>('POST', '/v1/gui/login-code')
      if (!values['no-open'] && process.platform === 'win32') {
        const { spawn } = await import('node:child_process')
        spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref()
      }
      out(json, { url, expiresInMs }, () => `Hearth GUI: ${url}
(one-time link, valid for ${Math.round(expiresInMs / 1000)} s; the browser keeps a session cookie afterwards)`)
      return 0
    }
    case 'status': {
      const client = await connect(config)
      if (!client) {
        out(json, { running: false }, () => 'daemon: not running')
        return 0
      }
      const s = await client.request<{ pid: number; inference: { maxConcurrent: number; active: Array<{ taskId: string; purpose?: string; grantedAt: number }>; waiting: Array<{ taskId: string }> }; queue: { running: string[]; queued: string[]; maxConcurrent: number }; counts: Record<string, number> }>('GET', '/v1/status')
      out(json, s, () =>
        [
          `daemon: running (pid ${s.pid}) at ${client.info.url}`,
          `inference slots: ${s.inference.active.length}/${s.inference.maxConcurrent} busy, ${s.inference.waiting.length} waiting`,
          ...s.inference.active.map(l => `  active: ${l.taskId} ${l.purpose ?? ''} for ${fmtMs(Date.now() - l.grantedAt)}`),
          `tasks: ${s.queue.running.length}/${s.queue.maxConcurrent} running, ${s.queue.queued.length} queued`,
          ...s.queue.running.map(id => `  running: ${id}`),
          ...s.queue.queued.map((id, i) => `  queued #${i + 1}: ${id}`),
          `totals: ${Object.entries(s.counts).map(([k, v]) => `${k}=${v}`).join(' ')}`,
        ].join('\n'),
      )
      return 0
    }
    case 'daemon': {
      const sub = rest[0] ?? 'status'
      if (sub === 'run') {
        const daemon = new HearthDaemon({ config, onShutdown: () => void shutdown() })
        const url = await daemon.start()
        process.stderr.write(`hearth daemon listening on ${url} (state ${config.stateDir})\n`)
        let stopping = false
        const shutdown = async () => {
          if (stopping) return
          stopping = true
          await daemon.stop()
          process.exit(0)
        }
        process.on('SIGINT', () => void shutdown())
        process.on('SIGTERM', () => void shutdown())
        await new Promise(() => {})
      }
      if (sub === 'start') {
        const client = await ensureDaemon(config, values.config)
        out(json, client.info, () => `daemon running (pid ${client.info.pid}) at ${client.info.url}`)
        return 0
      }
      if (sub === 'stop') {
        const client = await connect(config)
        if (!client) {
          out(json, { stopped: false }, () => 'daemon is not running')
          return 0
        }
        await client.request('POST', '/v1/shutdown')
        out(json, { stopped: true }, () => 'daemon stopping (running tasks are cancelled and can be resumed)')
        return 0
      }
      const client = await connect(config)
      out(json, client ? client.info : { running: false }, () => (client ? `daemon running (pid ${client.info.pid}) at ${client.info.url}` : 'daemon: not running'))
      return 0
    }
    case 'doctor': {
      const checks = localChecks(config)
      const workspaces = values.workspace ? [values.workspace] : [...new Set([config.defaultWorkspace, ...config.security.allowedWorkspaceRoots])]
      for (const ws of workspaces) checks.push(workspaceAclCheck(ws, config.security.sandbox))
      if (!values['no-probe']) checks.push(await webSearchCheck(config))
      if (!values['no-probe']) {
        const names = values.provider ? [values.provider] : [config.defaultModel.provider]
        for (const name of names) {
          const p = config.providers[name]
          if (!p) checks.push({ name, status: 'fail', detail: 'provider not configured' })
          else checks.push(...(await probeProvider(p, name === config.defaultModel.provider ? config.defaultModel.model : undefined)))
        }
      }
      return printChecks(checks, json)
    }
    case 'secret': {
      const [sub, name] = rest
      if (sub === 'list') {
        const names = Object.values(config.providers).flatMap(p => (p.apiKey.kind === 'secret' ? [p.apiKey.name] : []))
        out(json, names.map(n => ({ name: n, stored: hasSecret(n) })), () => `secrets dir: ${secretsDir()}\n${names.map(n => `${n}: ${hasSecret(n) ? 'stored' : 'missing'}`).join('\n') || '(no provider uses a stored secret)'}`)
        return 0
      }
      if (!name) throw new Error('usage: hearth secret set|delete <name>')
      if (sub === 'delete') {
        out(json, { deleted: deleteSecret(name) }, () => `deleted ${name}`)
        return 0
      }
      if (sub === 'set') {
        const value = process.stdin.isTTY ? await readHiddenLine(`Value for ${name} (input hidden): `) : (await readStdin()).replace(/\r?\n$/, '')
        const file = setSecret(name, value)
        out(json, { stored: true, file }, () => `stored ${name} (DPAPI, current user) at ${file}`)
        return 0
      }
      throw new Error('usage: hearth secret set|delete|list <name>')
    }
    case 'config': {
      const { baseDir, ...rest2 } = config
      out(true, { baseDir, ...rest2 }, () => '')
      return 0
    }
    case 'modes': {
      out(json, config.modes, () =>
        MODE_NAMES.map(n => {
          const m = config.modes[n]
          return `${n.padEnd(8)} steps≤${m.maxSteps} time≤${fmtMs(m.maxWallTimeMs)} tokens≤${m.maxTotalTokens} failures≤${m.maxConsecutiveToolFailures} verify=${m.verificationRounds} effort=${m.reasoningEffort} plan=${m.requirePlan} tools=${m.hearthTools.join(',')}\n         ${m.description}`
        }).join('\n'),
      )
      return 0
    }
    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}\n`)
      return 2
  }
}

export async function run(argv: string[]): Promise<void> {
  try {
    process.exitCode = await main(argv)
  } catch (error) {
    if (error instanceof ConfigError) process.stderr.write(`${error.message}\n`)
    else if (error instanceof DaemonError) process.stderr.write(`hearth: ${error.code}: ${error.message}\n`)
    else process.stderr.write(`hearth: ${(error as Error).message}\n`)
    process.exitCode = 1
  }
}
