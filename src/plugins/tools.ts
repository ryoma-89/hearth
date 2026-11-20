/**
 * DSH plugin: Hearth's additional model-facing tools.
 *
 *  - python_run     run Python code or a script in the workspace
 *  - latex_compile  upLaTeX (+ upbibtex) + dvipdfmx with log parsing and PDF checks
 *  - pdf_inspect    page count, fonts not embedded, empty pages
 *  - git            a restricted set of local git subcommands
 *
 * Every process is spawned through DSH's `ctx.sandbox.confine()` (Windows ACL
 * sandbox) unless the configured sandbox mode is danger-full-access; the
 * sandbox fails closed. Non-zero exit codes are returned as data, not thrown,
 * so the model sees the full diagnostic; argument and setup failures throw
 * and reach the model as tool errors.
 */
import { existsSync } from 'node:fs'
import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { checkWorkspacePath } from '../security/paths.ts'
import { compileLatex, inspectPdf, pdfText, type LatexSettings, type PdfReport } from '../tools/latex.ts'
import { clip, type RunResult } from '../tools/process.ts'
import { emitTelemetry } from './telemetry.ts'
import { createSandboxExec, type ExecContext, type SandboxLike, type SandboxMode } from '../tools/sandbox-exec.ts'

export const name = 'hearth-tools'
export const inject = { tools: { required: true }, sandbox: { required: false } }

export interface Config extends LatexSettings {
  enabled: string[]
  workspace: string
  sandboxMode: SandboxMode
  pythonExecutable: string
  pythonTimeoutMs: number
  gitExecutable: string
  maxOutputChars: number
}

interface RunLike {
  signal: AbortSignal
  agent?: { session?: { id?: string } }
}

/** Detach a value into plain lossless JSON (drops undefined fields, which DSH rejects). */
export function toJson<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue
}

const GIT_SUBCOMMANDS = ['status', 'diff', 'log', 'show', 'add', 'commit', 'init', 'branch', 'rev-parse', 'ls-files'] as const

function resolveInWorkspace(workspace: string, p: string, label: string): string {
  const verdict = checkWorkspacePath(workspace, p)
  if (!verdict.ok) throw new ToolArgsError([`${label}: ${verdict.reason}`])
  return verdict.real
}

export function summarizeRun(r: RunResult, maxChars: number) {
  return {
    exit_code: r.exitCode,
    timed_out: r.timedOut,
    duration_ms: r.durationMs,
    stdout: clip(r.stdout, maxChars),
    stderr: clip(r.stderr, Math.floor(maxChars / 2)),
    truncated: r.truncated || r.stdout.length > maxChars,
    ...(r.spawnError ? { spawn_error: r.spawnError } : {}),
  }
}

function runText(title: string, r: ReturnType<typeof summarizeRun>): string {
  const parts = [`${title}: exit code ${r.exit_code}${r.timed_out ? ' (TIMED OUT)' : ''}, ${r.duration_ms} ms`]
  if (r.spawn_error) parts.push(`spawn error: ${r.spawn_error}`)
  if (r.stdout) parts.push(`--- stdout ---\n${r.stdout}`)
  if (r.stderr) parts.push(`--- stderr ---\n${r.stderr}`)
  return parts.join('\n')
}

const runContext = (run: unknown): ExecContext => ({ signal: (run as RunLike).signal, sessionId: (run as RunLike).agent?.session?.id })

/**
 * Plugin entry.
 * @param ctx - Cordis context.
 * @param config - tool settings.
 */
export function apply(ctx: Context, config: Config): void {
  const exec = createSandboxExec((ctx as unknown as { sandbox?: SandboxLike }).sandbox, config.sandboxMode, config.workspace)
  const enabled = new Set(config.enabled)
  const register = (def: ReturnType<typeof defineTool>) => ctx.effect(() => (ctx as unknown as { tools: { register(d: unknown): () => void } }).tools.register(def))

  if (enabled.has('python_run')) {
    register(defineTool({
      name: 'python_run',
      description:
        'Run Python in the workspace and return exit code, stdout and stderr. Provide either `code` (run from stdin) or `script_path` (a .py file inside the workspace). A non-zero exit code is reported, not hidden; read stderr to fix the error and run again.',
      parameters: {
        code: { type: 'string', description: 'Python source to execute.' },
        script_path: { type: 'string', description: 'Workspace-relative path of a .py file to execute.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Command-line arguments for the script.' },
        timeout_sec: { type: 'number', description: 'Deadline in seconds (capped by configuration).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: runText('python', value as ReturnType<typeof summarizeRun>) }],
      },
      async execute(args, run) {
        if ((args.code === undefined) === (args.script_path === undefined)) throw new ToolArgsError(['provide exactly one of code or script_path'])
        const timeoutMs = Math.min(config.pythonTimeoutMs, args.timeout_sec ? Math.max(1, args.timeout_sec) * 1000 : config.pythonTimeoutMs)
        const argv = [config.pythonExecutable, '-X', 'utf8']
        if (args.script_path !== undefined) {
          const script = resolveInWorkspace(config.workspace, args.script_path, 'script_path')
          if (!existsSync(script)) throw new ToolArgsError([`script_path: ${args.script_path} does not exist`])
          argv.push(script)
        } else argv.push('-')
        argv.push(...(args.args ?? []))
        const r = await exec(argv, config.workspace, timeoutMs, runContext(run), args.code)
        return toJson(summarizeRun(r, config.maxOutputChars))
      },
    }))
  }

  if (enabled.has('pdf_inspect')) {
    register(defineTool({
      name: 'pdf_inspect',
      description: 'Inspect a PDF in the workspace: page count, page size, fonts that are not embedded, and pages without extractable text. Use after generating a PDF to verify it.',
      parameters: {
        pdf_path: { type: 'string', required: true, description: 'Workspace-relative path of the PDF.' },
        expect_pages: { type: 'integer', description: 'Expected page count; a mismatch is reported.' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => {
          const v = value as unknown as PdfReport & { page_mismatch?: string }
          return [{ type: 'text', text: pdfText(v) + (v.page_mismatch ? `\nWARNING ${v.page_mismatch}` : '') }]
        },
      },
      async execute(args, run) {
        const pdf = resolveInWorkspace(config.workspace, args.pdf_path, 'pdf_path')
        if (!existsSync(pdf)) throw new ToolArgsError([`pdf_path: ${args.pdf_path} does not exist`])
        const r = await inspectPdf(pdf, config, runContext(run).signal)
        const mismatch = args.expect_pages !== undefined && r.pages !== args.expect_pages ? `expected ${args.expect_pages} pages but found ${r.pages}` : undefined
        return toJson({ ...r, ...(mismatch ? { page_mismatch: mismatch } : {}) })
      },
    }))
  }

  if (enabled.has('latex_compile')) {
    register(defineTool({
      name: 'latex_compile',
      description:
        'Compile a .tex file with upLaTeX (runs upbibtex when the document has a bibliography, and reruns for references) and convert it with dvipdfmx. Returns structured errors with line numbers, overfull boxes (text/figures sticking out), undefined references/citations, missing characters, and PDF checks. Fix reported errors in the source and compile again.',
      parameters: {
        tex_path: { type: 'string', required: true, description: 'Workspace-relative path of the main .tex file.' },
        max_runs: { type: 'integer', description: 'Maximum LaTeX passes (1-4, default 3).' },
        overfull_threshold_pt: { type: 'number', description: 'Report overfull boxes wider than this (default 1pt).' },
      },
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: (value as { summary: string }).summary }],
      },
      async execute(args, run) {
        const tex = resolveInWorkspace(config.workspace, args.tex_path, 'tex_path')
        if (!existsSync(tex)) throw new ToolArgsError([`tex_path: ${args.tex_path} does not exist`])
        if (extname(tex).toLowerCase() !== '.tex') throw new ToolArgsError(['tex_path must be a .tex file'])
        const report = await compileLatex(tex, { ...config, maxRuns: Math.min(4, Math.max(1, args.max_runs ?? 3)), overfullThresholdPt: args.overfull_threshold_pt ?? 1 }, exec, runContext(run))
        return toJson(report)
      },
    }))
  }

  if (enabled.has('git')) {
    register(defineTool({
      name: 'git',
      description: `Run a local git subcommand in the workspace. Allowed: ${GIT_SUBCOMMANDS.join(', ')}. Remote operations (push, fetch, pull, clone) and history rewriting are not available.`,
      parameters: {
        subcommand: { type: 'string', required: true, enum: GIT_SUBCOMMANDS, description: 'git subcommand' },
        args: { type: 'array', items: { type: 'string' }, description: 'Additional arguments.' },
        message: { type: 'string', description: 'Commit message (commit only).' },
      },
      output: {
        schema: { type: 'json' },
        render: (args, value) => [{ type: 'text', text: runText(`git ${args.subcommand}`, value as ReturnType<typeof summarizeRun>) }],
      },
      async execute(args, run) {
        const extra = [...(args.args ?? [])]
        for (const a of extra) {
          if (/^--(exec|upload-pack|receive-pack|output|git-dir|work-tree)\b/i.test(a) || /^-c$/i.test(a)) throw new ToolArgsError([`argument ${a} is not allowed`])
        }
        if (args.subcommand === 'branch' && extra.some(a => /^(-d|-D|--delete|-m|-M|--move|-f|--force)$/.test(a))) throw new ToolArgsError(['deleting, moving, or forcing branches is not allowed'])
        const argv = [config.gitExecutable, '-c', 'core.pager=cat', '-c', 'color.ui=false', args.subcommand, ...extra]
        if (args.subcommand === 'commit') {
          if (!args.message) throw new ToolArgsError(['commit requires message'])
          argv.push('-m', args.message)
        }
        const r = await exec(argv, config.workspace, 60_000, runContext(run))
        return toJson(summarizeRun(r, config.maxOutputChars))
      },
    }))
  }
  emitTelemetry({ event: 'plugin-ready', plugin: name })
}
