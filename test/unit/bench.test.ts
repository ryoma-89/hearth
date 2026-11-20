import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { renderMarkdown, summarize, type BenchRun } from '../../src/bench/runner.ts'
import { SUITE } from '../../src/bench/suite.ts'

const run = (task: string, pass: boolean, extra: Partial<BenchRun> = {}): BenchRun => ({
  task,
  item: 1,
  title: 't',
  repeat: 1,
  pass,
  detail: 'd|x',
  failureCause: pass ? null : 'check-failed',
  statuses: ['succeeded'],
  taskIds: ['a'],
  workspace: 'w',
  durationMs: 1000,
  wallMs: 1200,
  steps: 2,
  toolCalls: 4,
  toolErrors: 0,
  totalTokens: 100,
  outputTokens: 10,
  repairs: 0,
  retries: 0,
  policyDenials: 0,
  compactions: 0,
  verification: null,
  ...extra,
})

describe('bench suite definition', () => {
  it('covers the eight evaluation items exactly once', () => {
    assert.deepEqual(SUITE.map(t => t.item).sort(), [1, 2, 3, 4, 5, 6, 7, 8])
    assert.equal(new Set(SUITE.map(t => t.id)).size, 8)
  })
})

describe('long-context fixture', () => {
  it('is deterministic and hides exactly one code line', async () => {
    const { haystack, EXTRA_SUITE } = await import('../../src/bench/suite.ts')
    const a = haystack(1001, 8000)
    const b = haystack(1001, 8000)
    assert.deepEqual(a, b)
    assert.notEqual(haystack(1002, 8000).code, a.code)
    assert.ok(a.text.length >= 8000)
    assert.equal(a.text.split('\n').filter(l => l.startsWith('ARCHIVE-CODE:')).length, 1)
    assert.match(a.code, /^[A-Z2-9]{8}$/)
    assert.deepEqual(EXTRA_SUITE.map(t => t.id), ['long-context'])
  })
})

describe('bench reports', () => {
  it('aggregates success rate, averages, and failure causes per task', () => {
    const s = summarize([run('a', true), run('a', false, { durationMs: 3000, toolCalls: 6 }), run('b', true)])
    const a = s.find(x => x.task === 'a')!
    assert.deepEqual([a.runs, a.passes, a.successRate, a.avgDurationMs, a.avgToolCalls, a.causes], [2, 1, 0.5, 2000, 5, { 'check-failed': 1 }])
  })
  it('renders Markdown with escaped table cells', () => {
    const md = renderMarkdown({ label: 'x', startedAt: 's', finishedAt: 'f', model: 'm', modeOverride: null, repeat: 1, runs: [run('a', true)], summary: summarize([run('a', true)]) })
    assert.match(md, /合計 1 実行、合格 1（100%）/)
    assert.match(md, /d\\\|x/)
  })
})
