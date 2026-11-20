/**
 * Turn-end verifiers. Each verifier checks one kind of artifact the task
 * produced and reports pass/fail with a model-actionable detail. Which
 * verifiers run is decided by the files changed during the task, plus any
 * explicit verification commands given with the task.
 *
 * Implemented:  Python syntax (py_compile), Python tests (pytest, else
 *               unittest discovery), JSON / YAML parse, LaTeX build (+ strict
 *               quality checks), PDF inspection, custom shell commands.
 * Not implemented: type checking, linting, language toolchains other than
 *               Python/LaTeX (use custom commands for those).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { compileLatex, inspectPdf, type LatexSettings } from '../tools/latex.ts'
import { clip } from '../tools/process.ts'
import type { Exec, ExecContext } from '../tools/sandbox-exec.ts'

export interface VerifySettings {
  workspace: string
  /** Treat quality warnings (overfull boxes, undefined refs, unembedded fonts) as failures. */
  strict: boolean
  pythonExecutable: string
  testTimeoutMs: number
  /** Extra shell commands (PowerShell) that must exit 0. */
  commands: string[]
  latex: LatexSettings
  maxScanFiles: number
  ignoreDirs: string[]
}

export interface Finding {
  verifier: string
  target: string
  ok: boolean
  detail: string
}

/**
 * List workspace files modified at or after `sinceMs` (bounded scan).
 * @returns forward-slash paths relative to the workspace.
 */
export function changedFiles(workspace: string, sinceMs: number, ignoreDirs: readonly string[], maxFiles: number): string[] {
  const out: string[] = []
  let scanned = 0
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // unreadable directory: not something the task produced
    }
    for (const e of entries) {
      if (scanned >= maxFiles) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!ignoreDirs.includes(e.name)) walk(full)
        continue
      }
      if (!e.isFile()) continue
      scanned++
      try {
        if (statSync(full).mtimeMs >= sinceMs) out.push(relative(workspace, full).split(sep).join('/'))
      } catch {
        // vanished between readdir and stat
      }
    }
  }
  walk(workspace)
  return out.sort()
}

function findTestFiles(workspace: string, ignoreDirs: readonly string[], limit = 2000): string[] {
  const out: string[] = []
  let seen = 0
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (++seen > limit) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!ignoreDirs.includes(e.name)) walk(full, depth + 1)
      } else if (/^test_.*\.py$|_test\.py$/.test(e.name)) out.push(relative(workspace, full).split(sep).join('/'))
    }
  }
  walk(workspace, 0)
  return out
}

/**
 * Run every verifier that applies to the changed files.
 * @param files - workspace-relative changed files.
 * @param settings - verifier settings.
 * @param exec - sandboxed executor.
 * @param run - cancellation and session identity.
 * @returns one finding per check performed.
 */
export async function runVerifiers(files: string[], settings: VerifySettings, exec: Exec, run: ExecContext): Promise<Finding[]> {
  const findings: Finding[] = []
  const abs = (f: string) => join(settings.workspace, f)
  const byExt = (...exts: string[]) => files.filter(f => exts.includes(extname(f).toLowerCase()) && existsSync(abs(f)))

  // Python syntax
  const py = byExt('.py')
  if (py.length) {
    const r = await exec([settings.pythonExecutable, '-X', 'utf8', '-m', 'py_compile', ...py.map(abs)], settings.workspace, 60_000, run)
    findings.push({ verifier: 'python-syntax', target: py.join(', '), ok: r.exitCode === 0, detail: r.exitCode === 0 ? `${py.length} file(s) compile` : clip(r.stderr || r.stdout || r.spawnError || 'py_compile failed', 3000) })
  }

  // Python tests (only when Python changed and tests exist)
  if (py.length) {
    const tests = findTestFiles(settings.workspace, settings.ignoreDirs)
    if (tests.length) {
      const probe = await exec([settings.pythonExecutable, '-c', 'import pytest'], settings.workspace, 30_000, run)
      const usePytest = probe.exitCode === 0
      const argv = usePytest
        ? [settings.pythonExecutable, '-X', 'utf8', '-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...tests]
        : [settings.pythonExecutable, '-X', 'utf8', '-m', 'unittest', ...tests.map(t => t.replace(/\.py$/, '').replace(/\//g, '.'))]
      const r = await exec(argv, settings.workspace, settings.testTimeoutMs, run)
      const output = `${r.stdout}\n${r.stderr}`.trim()
      const ok = r.exitCode === 0 && !r.timedOut
      findings.push({
        verifier: usePytest ? 'pytest' : 'unittest',
        target: `${tests.length} test file(s)`,
        ok,
        detail: r.timedOut ? `tests timed out after ${settings.testTimeoutMs} ms` : ok ? (output.split('\n').filter(Boolean).at(-1) ?? 'passed') : clip(output || r.spawnError || 'tests failed', 4000),
      })
    }
  }

  // Structured data
  for (const f of byExt('.json')) {
    try {
      JSON.parse(readFileSync(abs(f), 'utf8'))
      findings.push({ verifier: 'json', target: f, ok: true, detail: 'parses' })
    } catch (error) {
      findings.push({ verifier: 'json', target: f, ok: false, detail: (error as Error).message })
    }
  }
  for (const f of byExt('.yaml', '.yml')) {
    try {
      parseYaml(readFileSync(abs(f), 'utf8'))
      findings.push({ verifier: 'yaml', target: f, ok: true, detail: 'parses' })
    } catch (error) {
      findings.push({ verifier: 'yaml', target: f, ok: false, detail: (error as Error).message.split('\n')[0]! })
    }
  }

  // LaTeX documents (main files only)
  const builtPdfs = new Set<string>()
  for (const f of byExt('.tex')) {
    const text = readFileSync(abs(f), 'utf8')
    if (!/\\documentclass/.test(text)) continue
    const report = await compileLatex(abs(f), { ...settings.latex, maxRuns: 3, overfullThresholdPt: 1 }, exec, run)
    if (report.pdf) builtPdfs.add(relative(settings.workspace, report.pdf.pdf_path).split(sep).join('/'))
    const qualityFail = settings.strict && report.quality_issues.length > 0
    findings.push({
      verifier: 'latex',
      target: f,
      ok: report.success && !qualityFail,
      detail: report.success ? (report.quality_issues.length ? `builds; ${settings.strict ? 'STRICT FAIL: ' : 'warnings: '}${report.quality_issues.join('; ')}` : `builds cleanly (${report.pdf?.pages ?? '?'} pages)`) : clip(report.summary, 4000),
    })
  }

  // Other PDFs the task produced
  for (const f of byExt('.pdf')) {
    if (builtPdfs.has(f)) continue
    const r = await inspectPdf(abs(f), settings.latex, run.signal)
    const problems = [...(r.pages ? [] : ['no pages reported']), ...(settings.strict && r.fonts_not_embedded.length ? [`fonts not embedded: ${r.fonts_not_embedded.join(', ')}`] : []), ...r.checks_unavailable]
    findings.push({ verifier: 'pdf', target: f, ok: problems.length === 0, detail: problems.length ? problems.join('; ') : `${r.pages} pages` })
  }

  // Explicit commands
  for (const command of settings.commands) {
    const r = await exec(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', command], settings.workspace, settings.testTimeoutMs, run)
    const ok = r.exitCode === 0 && !r.timedOut
    findings.push({ verifier: 'command', target: command, ok, detail: ok ? 'exit 0' : clip(`exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}\n${r.stdout}\n${r.stderr}`.trim(), 4000) })
  }
  return findings
}

/**
 * Format findings as the steering message sent back to the model.
 * @param findings - verifier results.
 * @param round - 1-based fix round being requested.
 * @param rounds - maximum fix rounds.
 * @returns message text.
 */
export function formatReport(findings: Finding[], round: number, rounds: number): string {
  const failed = findings.filter(f => !f.ok)
  const passed = findings.filter(f => f.ok)
  const lines = [
    `[Hearth verification — fix round ${round} of ${rounds}] Automatic checks of your changes found ${failed.length} problem(s). The task is not finished until they pass.`,
    '',
    ...failed.map(f => `FAILED ${f.verifier} (${f.target}):\n${f.detail}`),
  ]
  if (passed.length) lines.push('', `Passed: ${passed.map(f => `${f.verifier} (${f.target})`).join(', ')}`)
  lines.push('', 'Fix the cause of each failure, re-run the relevant check yourself, then finish with an updated report. Do not weaken or delete tests to make them pass.')
  return lines.join('\n')
}
