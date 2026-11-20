/**
 * LaTeX build and PDF inspection, shared by the `latex_compile` /
 * `pdf_inspect` tools and the turn-end verifier.
 *
 * Pipeline: upLaTeX (nonstop, file:line errors) → upbibtex when the .aux
 * declares a bibliography → upLaTeX reruns while TeX asks for them →
 * dvipdfmx → PDF checks (pdfinfo, pdffonts, pdftotext).
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { parseLatexLog, parsePdfFonts, parsePdfInfo, type LatexDiagnostics } from './latex-log.ts'
import { clip, runProcess, type RunResult } from './process.ts'
import type { Exec, ExecContext } from './sandbox-exec.ts'

export interface LatexSettings {
  latexEngine: string
  bibtex: string
  dvipdfmx: string
  latexTimeoutMs: number
  pdfinfo: string
  pdffonts: string
  pdftotext: string
}

export interface PdfReport {
  pdf_path: string
  bytes: number
  pages: number | null
  page_size: string | null
  fonts_not_embedded: string[]
  font_count: number
  empty_text_pages: number[]
  text_chars: number
  checks_unavailable: string[]
}

export interface LatexReport {
  success: boolean
  summary: string
  runs: Array<{ step: string; exit_code: number | null; timed_out: boolean }>
  errors: LatexDiagnostics['errors']
  overfull: LatexDiagnostics['overfull']
  underfull_count: number
  undefined_references: string[]
  undefined_citations: string[]
  missing_characters: string[]
  font_warnings: string[]
  pdf: PdfReport | null
  /** Problems a strict verifier should treat as failures even when the build succeeded. */
  quality_issues: string[]
}

/**
 * Inspect a PDF with poppler tools. These only read the file, so they run unconfined.
 * @param pdf - absolute PDF path.
 * @param settings - tool executables.
 * @param signal - cancellation.
 * @returns the report; unavailable checks are listed, never silently skipped.
 */
export async function inspectPdf(pdf: string, settings: LatexSettings, signal?: AbortSignal): Promise<PdfReport> {
  const cwd = dirname(pdf)
  const info = await runProcess(settings.pdfinfo, [pdf], { cwd, timeoutMs: 30_000, signal })
  const fonts = await runProcess(settings.pdffonts, [pdf], { cwd, timeoutMs: 30_000, signal })
  const text = await runProcess(settings.pdftotext, ['-layout', '-enc', 'UTF-8', pdf, '-'], { cwd, timeoutMs: 60_000, signal })
  const meta = parsePdfInfo(info.stdout)
  const fontRows = parsePdfFonts(fonts.stdout)
  const pageTexts = text.exitCode === 0 ? text.stdout.split('\f') : []
  if (pageTexts.length && pageTexts[pageTexts.length - 1]!.trim() === '') pageTexts.pop()
  return {
    pdf_path: pdf,
    bytes: statSync(pdf).size,
    pages: meta.Pages ? Number(meta.Pages) : null,
    page_size: meta['Page size'] ?? null,
    fonts_not_embedded: fontRows.filter(f => !f.embedded).map(f => f.name),
    font_count: fontRows.length,
    empty_text_pages: pageTexts.map((t, i) => (t.trim() === '' ? i + 1 : 0)).filter(Boolean),
    text_chars: pageTexts.reduce((n, t) => n + t.trim().length, 0),
    checks_unavailable: [
      ...(info.exitCode !== 0 ? [`pdfinfo failed: ${info.spawnError ?? info.stderr.trim()}`] : []),
      ...(fonts.exitCode !== 0 ? [`pdffonts failed: ${fonts.spawnError ?? fonts.stderr.trim()}`] : []),
      ...(text.exitCode !== 0 ? [`pdftotext failed: ${text.spawnError ?? text.stderr.trim()}`] : []),
    ],
  }
}

export function pdfText(r: PdfReport): string {
  const lines = [`PDF ${r.pdf_path}: ${r.pages ?? '?'} pages, ${r.bytes} bytes, page size ${r.page_size ?? '?'}`]
  lines.push(r.fonts_not_embedded.length ? `WARNING fonts not embedded (glyphs may be missing on other machines): ${r.fonts_not_embedded.join(', ')}` : `All ${r.font_count} fonts embedded.`)
  if (r.empty_text_pages.length) lines.push(`WARNING pages without extractable text: ${r.empty_text_pages.join(', ')}`)
  for (const c of r.checks_unavailable) lines.push(`CHECK UNAVAILABLE: ${c}`)
  return lines.join('\n')
}

/**
 * Build one LaTeX document.
 * @param tex - absolute path of the main .tex file.
 * @param opts - settings, pass limit, overfull threshold.
 * @param exec - sandboxed executor.
 * @param run - cancellation and session identity.
 * @returns the structured report.
 */
export async function compileLatex(
  tex: string,
  opts: LatexSettings & { maxRuns: number; overfullThresholdPt: number },
  exec: Exec,
  run: ExecContext,
): Promise<LatexReport> {
  const dir = dirname(tex)
  const stem = basename(tex, extname(tex))
  const runs: LatexReport['runs'] = []
  let diag: LatexDiagnostics = parseLatexLog('')
  let engineOutput = ''
  let engineFailed = false
  let bibtexRun: RunResult | undefined
  const engine = async () => {
    const r = await exec([opts.latexEngine, '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-kanji=utf8', `${stem}.tex`], dir, opts.latexTimeoutMs, run)
    runs.push({ step: opts.latexEngine, exit_code: r.exitCode, timed_out: r.timedOut })
    if (r.spawnError) throw new Error(`could not start ${opts.latexEngine}: ${r.spawnError}`)
    engineOutput = r.stdout + r.stderr
    const logPath = join(dir, `${stem}.log`)
    diag = parseLatexLog(existsSync(logPath) ? readFileSync(logPath, 'utf8') : engineOutput)
    engineFailed = r.exitCode !== 0 || r.timedOut
  }
  await engine()
  const auxPath = join(dir, `${stem}.aux`)
  if (!engineFailed && existsSync(auxPath) && /\\bibdata\{/.test(readFileSync(auxPath, 'utf8'))) {
    bibtexRun = await exec([opts.bibtex, stem], dir, opts.latexTimeoutMs, run)
    runs.push({ step: opts.bibtex, exit_code: bibtexRun.exitCode, timed_out: bibtexRun.timedOut })
    await engine()
    if (!engineFailed) await engine()
  }
  while (!engineFailed && diag.rerunNeeded && runs.filter(r => r.step === opts.latexEngine).length < opts.maxRuns) await engine()

  let dvipdf: RunResult | undefined
  let pdf: PdfReport | undefined
  if (!engineFailed) {
    dvipdf = await exec([opts.dvipdfmx, `${stem}.dvi`], dir, opts.latexTimeoutMs, run)
    runs.push({ step: opts.dvipdfmx, exit_code: dvipdf.exitCode, timed_out: dvipdf.timedOut })
    const pdfPath = join(dir, `${stem}.pdf`)
    if (dvipdf.exitCode === 0 && existsSync(pdfPath)) pdf = await inspectPdf(pdfPath, opts, run.signal)
  }
  const overfull = diag.overfull.filter(o => o.amountPt > opts.overfullThresholdPt)
  const bibtexFailed = bibtexRun !== undefined && bibtexRun.exitCode !== 0
  const success = !engineFailed && !bibtexFailed && dvipdf?.exitCode === 0 && pdf !== undefined
  const lines: string[] = [`latex_compile ${basename(tex)}: ${success ? 'SUCCESS' : 'FAILED'} (${runs.map(r => r.step).join(' → ')})`]
  for (const e of diag.errors.slice(0, 10)) lines.push(`ERROR ${e.file ? `${e.file}:` : ''}${e.line ?? '?'}: ${e.message}${e.context ? ` | ${e.context}` : ''}`)
  if (engineFailed && diag.errors.length === 0) lines.push(`ENGINE OUTPUT (tail):\n${clip(engineOutput, 3000)}`)
  if (bibtexRun && bibtexRun.exitCode !== 0) lines.push(`${opts.bibtex.toUpperCase()} FAILED (exit ${bibtexRun.exitCode}):\n${clip(bibtexRun.stdout + bibtexRun.stderr, 2000)}`)
  if (dvipdf && dvipdf.exitCode !== 0) lines.push(`DVIPDFMX FAILED (exit ${dvipdf.exitCode}):\n${clip(dvipdf.stderr || dvipdf.stdout, 3000)}`)
  for (const o of overfull.slice(0, 10)) lines.push(`OVERFULL ${o.kind} ${o.amountPt}pt${o.lines ? ` at lines ${o.lines}` : ''} (content sticks out of the margin)`)
  if (diag.undefinedReferences.length) lines.push(`UNDEFINED REFERENCES: ${diag.undefinedReferences.join(', ')}`)
  if (diag.undefinedCitations.length) lines.push(`UNDEFINED CITATIONS: ${diag.undefinedCitations.join(', ')}`)
  if (diag.missingCharacters.length) lines.push(`MISSING CHARACTERS: ${diag.missingCharacters.slice(0, 10).join(', ')}`)
  for (const w of diag.fontWarnings.slice(0, 5)) lines.push(`FONT WARNING: ${w}`)
  if (pdf) lines.push(pdfText(pdf))
  if (diag.otherWarnings.length) lines.push(`${diag.otherWarnings.length} other warning(s); first: ${diag.otherWarnings.slice(0, 3).join(' / ')}`)

  const quality: string[] = []
  if (overfull.length) quality.push(`${overfull.length} overfull box(es) wider than ${opts.overfullThresholdPt}pt`)
  if (diag.undefinedReferences.length) quality.push(`undefined references: ${diag.undefinedReferences.join(', ')}`)
  if (diag.undefinedCitations.length) quality.push(`undefined citations: ${diag.undefinedCitations.join(', ')}`)
  if (diag.missingCharacters.length) quality.push(`missing characters: ${diag.missingCharacters.slice(0, 5).join(', ')}`)
  if (pdf?.fonts_not_embedded.length) quality.push(`fonts not embedded: ${pdf.fonts_not_embedded.join(', ')}`)
  if (pdf?.empty_text_pages.length) quality.push(`pages without text: ${pdf.empty_text_pages.join(', ')}`)

  return {
    success,
    summary: lines.join('\n'),
    runs,
    errors: diag.errors.slice(0, 20),
    overfull: overfull.slice(0, 20),
    underfull_count: diag.underfullCount,
    undefined_references: diag.undefinedReferences,
    undefined_citations: diag.undefinedCitations,
    missing_characters: diag.missingCharacters,
    font_warnings: diag.fontWarnings.slice(0, 10),
    pdf: pdf ?? null,
    quality_issues: quality,
  }
}
