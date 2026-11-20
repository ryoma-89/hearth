import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { BudgetTracker } from '../../src/plugins/budget.ts'
import { patchPaths } from '../../src/plugins/policy.ts'
import { parseTelemetryLine, TELEMETRY_PREFIX } from '../../src/plugins/telemetry.ts'
import { accumulate, emptyMetrics } from '../../src/runner/dsh-runner.ts'
import { parseLatexLog, parsePdfFonts, parsePdfInfo } from '../../src/tools/latex-log.ts'

describe('BudgetTracker', () => {
  const cfg = { maxSteps: 3, maxWallTimeMs: 1000, maxTotalTokens: 100, maxConsecutiveToolFailures: 2 }
  it('caps steps', () => {
    const t = new BudgetTracker(cfg, 0)
    assert.equal(t.admitStep(1), true)
    assert.equal(t.admitStep(1), true)
    assert.equal(t.admitStep(1), true)
    assert.equal(t.admitStep(1), false)
    assert.equal(t.exhausted?.kind, 'steps')
  })
  it('caps wall time', () => {
    const t = new BudgetTracker(cfg, 0)
    assert.equal(t.admitStep(1000), false)
    assert.equal(t.exhausted?.kind, 'wall-time')
  })
  it('caps tokens', () => {
    const t = new BudgetTracker(cfg, 0)
    t.addUsage({ inputTokens: 60, outputTokens: 50 })
    assert.equal(t.exhausted?.kind, 'tokens')
    assert.equal(t.admitStep(1), false)
  })
  it('counts only consecutive tool failures', () => {
    const t = new BudgetTracker(cfg, 0)
    t.recordToolResult(true)
    t.recordToolResult(false)
    t.recordToolResult(true)
    const kind = () => t.exhausted?.kind
    assert.equal(kind(), undefined)
    t.recordToolResult(true)
    assert.equal(kind(), 'tool-failures')
  })
})

describe('parseLatexLog', () => {
  const log = [
    'This is e-upTeX, Version 3.141592653-p4.1.0-u1.29-230214-2.6 (utf8.uptex) (TeX Live 2025)',
    './main.tex:12: Undefined control sequence.',
    'l.12 \\foo',
    '! LaTeX Error: File `missing.sty\' not found.',
    '',
    'l.3 \\usepackage',
    'Overfull \\hbox (25.4pt too wide) in paragraph at lines 20--22',
    'Overfull \\hbox (0.3pt too wide) in paragraph at lines 30--30',
    'Underfull \\hbox (badness 10000) in paragraph at lines 5--6',
    "LaTeX Warning: Reference `fig:a' on page 1 undefined on input line 40.",
    "LaTeX Warning: Citation `knuth' on page 2 undefined on input line 41.",
    'Missing character: There is no あ in font cmr10!',
    'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.',
    'Output written on main.dvi (3 pages, 1234 bytes).',
  ].join('\n')
  const d = parseLatexLog(log)
  it('extracts errors with file and line', () => {
    assert.equal(d.errors.length, 2)
    assert.deepEqual([d.errors[0]!.file, d.errors[0]!.line], ['./main.tex', 12])
    assert.equal(d.errors[1]!.line, 3)
  })
  it('extracts overfull boxes, references, citations, missing characters, rerun, pages', () => {
    assert.equal(d.overfull.length, 2)
    assert.equal(d.overfull[0]!.amountPt, 25.4)
    assert.equal(d.overfull[0]!.lines, '20--22')
    assert.equal(d.underfullCount, 1)
    assert.deepEqual(d.undefinedReferences, ['fig:a'])
    assert.deepEqual(d.undefinedCitations, ['knuth'])
    assert.equal(d.missingCharacters.length, 1)
    assert.equal(d.rerunNeeded, true)
    assert.equal(d.outputPages, 3)
  })
})

describe('pdf parsers', () => {
  it('parses pdffonts and pdfinfo', () => {
    const fonts = parsePdfFonts([
      'name                                 type              encoding         emb sub uni object ID',
      '------------------------------------ ----------------- ---------------- --- --- --- ---------',
      'ABCDEF+CMR10                         Type 1C           Builtin          yes yes no       4  0',
      'Ryumin-Light-UniJIS-UTF16-H          CID Type 0        Identity-H       no  no  yes      5  0',
    ].join('\n'))
    assert.deepEqual(fonts.map(f => [f.name, f.embedded]), [['ABCDEF+CMR10', true], ['Ryumin-Light-UniJIS-UTF16-H', false]])
    const info = parsePdfInfo('Pages:          3\nPage size:      595.276 x 841.89 pts (A4)\n')
    assert.equal(info.Pages, '3')
  })
})

describe('apply_patch path extraction', () => {
  it('lists every touched path', () => {
    const p = patchPaths('*** Begin Patch\n*** Add File: a.txt\n+x\n*** Update File: src/b.py\n*** Move to: src/c.py\n*** Delete File: d.txt\n*** End Patch')
    assert.deepEqual(p.map(x => x.path), ['a.txt', 'src/b.py', 'src/c.py', 'd.txt'])
  })
})

describe('telemetry and metrics', () => {
  it('round-trips telemetry lines and ignores ordinary stderr', () => {
    assert.deepEqual(parseTelemetryLine(`${TELEMETRY_PREFIX}{"event":"x","n":1}`), { event: 'x', n: 1 })
    assert.equal(parseTelemetryLine('dsh: reasoning:'), undefined)
    assert.equal(parseTelemetryLine(`${TELEMETRY_PREFIX}not json`), undefined)
  })
  it('accumulates metrics from DSH and telemetry events', () => {
    const m = emptyMetrics()
    accumulate(m, { kind: 'dsh', event: { type: 'status', phase: 'step_end', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } } })
    accumulate(m, { kind: 'dsh', event: { type: 'tool_call' } })
    accumulate(m, { kind: 'dsh', event: { type: 'tool_result', status: 'error' } })
    accumulate(m, { kind: 'telemetry', event: { event: 'toolcall-repair', repaired: true } })
    accumulate(m, { kind: 'telemetry', event: { event: 'lease-granted', waitedMs: 250 } })
    accumulate(m, { kind: 'telemetry', event: { event: 'budget-exhausted', kind: 'steps', detail: 'x' } })
    assert.deepEqual([m.steps, m.totalTokens, m.toolCalls, m.toolErrors, m.toolCallRepairs, m.leaseWaitMs, m.budgetExhausted?.kind], [1, 15, 1, 1, 1, 250, 'steps'])
  })
})

describe('BudgetTracker sandbox failures', () => {
  it('stops immediately when the sandbox cannot be prepared', () => {
    const t = new BudgetTracker({ maxSteps: 10, maxWallTimeMs: 1000, maxTotalTokens: 1000, maxConsecutiveToolFailures: 5 }, 0)
    t.recordToolResult(true, 'SANDBOX_PREPARATION_FAILED')
    assert.equal(t.exhausted?.kind, 'sandbox-unavailable')
    assert.match(t.exhausted!.detail, /Full Control/)
  })
})
