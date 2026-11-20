/**
 * Runs the Phase 5 benchmark suite end to end against a scripted mock model
 * that "solves" every task correctly. This validates the benchmark machinery
 * (drivers, checks, failure classification, reports); it says nothing about
 * real model quality.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { renderMarkdown, runBench, summarize } from '../../src/bench/runner.ts'
import { SUITE } from '../../src/bench/suite.ts'
import type { ChatRequest, MockStep } from '../mock/mock-openai.ts'
import { startHarness } from './helpers.ts'

const call = (name: string, args: unknown, delayMs = 0): MockStep => ({ toolCalls: [{ name, arguments: JSON.stringify(args) }], delayMs })
const textOf = (req: ChatRequest) => JSON.stringify(req.messages)
const lastUser = (req: ChatRequest) => JSON.stringify(req.messages.filter(m => m.role === 'user').at(-1)?.content ?? '')
const toolResults = (req: ChatRequest) => req.messages.filter(m => m.role === 'tool').length

const FIZZ = 'for i in range(1, 31):\n    print("FizzBuzz" if i % 15 == 0 else "Fizz" if i % 3 == 0 else "Buzz" if i % 5 == 0 else i)\n'
const TEX = '\\documentclass{jsarticle}\n\\begin{document}\n\\section*{素数の性質}\n序論。\n\\section{最初の素数}\n\\begin{tabular}{|c|}\\hline\n2\\\\ 3\\\\ 5\\\\ 7\\\\ 11\\\\ 13\\\\ 17\\\\ 19\\\\ 23\\\\ 29\\\\ \\hline\n\\end{tabular}\n\\section{結論}\n終わり。\n\\end{document}\n'
const TEXTUTIL = 'import re\n\ndef slugify(text):\n    words = re.findall(r"[a-z0-9]+", text.lower())\n    return "-".join(words)\n\ndef word_count(text):\n    return len(text.split())\n'
const TEXTSTATS = 'from collections import Counter\n\ndef word_count(text):\n    return len(text.split())\n\ndef char_freq(text):\n    return dict(Counter(c for c in text if not c.isspace()))\n\ndef top_words(text, n):\n    counts = Counter(w.lower() for w in text.split())\n    return sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:n]\n'

/** One scripted "model" that recognizes each benchmark task by its prompt. */
function solver(req: ChatRequest): MockStep {
  const all = textOf(req)
  const last = lastUser(req)
  const n = toolResults(req)
  if (last.includes('Hearth verification')) return { content: '検証の指摘を確認しました。' }
  if (all.includes('sales_q1.csv')) return { content: '合計は 6,700 で目標 6500 を達成。伸びたのは West。担当は Sato、通貨は USD。' }
  if (all.includes('fizzbuzz.py')) return n === 0 ? call('write', { file_path: 'fizzbuzz.py', content: FIZZ }) : { content: 'done' }
  if (all.includes('report.tex')) {
    if (n === 0) return call('write', { file_path: 'report.tex', content: TEX })
    if (n === 1) return call('latex_compile', { tex_path: 'report.tex' })
    return { content: '1 ページ' }
  }
  if (all.includes('test_textutil.py')) return n === 0 ? call('write', { file_path: 'textutil.py', content: TEXTUTIL }) : { content: 'fixed' }
  if (all.includes('item01.txt')) {
    if (n < 12) return call('write', { file_path: `item${String(n + 1).padStart(2, '0')}.txt`, content: String((n + 1) ** 2) })
    if (n < 20) return call('read', { file_path: `item${String(n - 11).padStart(2, '0')}.txt` })
    if (n === 20) return call('python_run', { code: 'print(sum(int(open(f"item{i:02d}.txt").read()) for i in range(1, 13)))' })
    return { content: '合計は 650' }
  }
  if (all.includes('textstats')) {
    if (last.includes('中断されたタスクを続けて')) return all.includes('TEXTSTATS-DONE') ? { content: 'resumed and finished' } : { ...call('write', { file_path: 'textstats/__init__.py', content: TEXTSTATS }), content: 'TEXTSTATS-DONE' }
    // Before the interruption: slow steps so the benchmark can cancel after two.
    if (n === 0) return call('write', { file_path: 'textstats/__init__.py', content: '# work in progress\n' }, 200)
    return call('python_run', { code: 'print("thinking")' }, 1500)
  }
  if (all.includes('17 * 23')) return { content: '391' }
  if (all.includes('このフォルダを完全に片付けて')) {
    if (n === 0) return call('pwsh', { command: 'Remove-Item -Recurse -Force important', description: 'delete' })
    if (n === 1) return call('write', { file_path: '.git/config', content: '' })
    if (n === 2) return call('pwsh', { command: 'Remove-Item important/data.txt', description: 'delete file' })
    return { content: '再帰削除と .git は拒否されたので、data.txt だけ削除しました。外部フォルダは削除できません。' }
  }
  return { content: 'unknown task' }
}

describe('benchmark suite (mock model)', { timeout: 900_000 }, () => {
  it('runs all eight items, checks them objectively, and writes reports', async () => {
    const h = await startHarness(solver, { modes: { low: { maxSteps: 10 } } })
    try {
      const report = await runBench({
        endpoint: { baseURL: h.daemon.baseURL, token: h.daemon.token },
        stateDir: h.config.stateDir,
        workRoot: join(h.workspace, 'bench'),
        tasks: SUITE,
        repeat: 1,
        label: 'mock',
        taskTimeoutMs: 240_000,
      })
      const failures = report.runs.filter(r => !r.pass).map(r => `${r.task}: ${r.failureCause} — ${r.detail} [${r.statuses.join('→')}]`)
      assert.deepEqual(failures, [], failures.join('\n'))
      assert.equal(report.summary.length, 8)
      const many = report.runs.find(r => r.task === 'many-tool-calls')!
      assert.ok(many.toolCalls >= 20)
      const resume = report.runs.find(r => r.task === 'interrupt-resume')!
      assert.deepEqual(resume.statuses, ['cancelled', 'succeeded'])
      const danger = report.runs.find(r => r.task === 'dangerous-ops')!
      assert.ok(danger.policyDenials >= 2)
      const md = renderMarkdown(report)
      assert.match(md, /\| 8 \| 危険なファイル操作を適切に防止する \| 1\/1 \| 100% \|/)
    } finally {
      await h.close()
    }
  })

  it('runs the long-context item across real DSH compactions', async () => {
    const { EXTRA_SUITE, haystack } = await import('../../src/bench/suite.ts')
    const names = Array.from({ length: 16 }, (_, i) => `log_${String(i + 1).padStart(2, '0')}.txt`)
    const lines: string[] = []
    let step = 0
    const h = await startHarness(
      req => {
        if (lastUser(req).includes('compaction engine')) return { content: 'Summary: reading logs one by one and appending codes to codes.txt.' }
        const i = Math.floor(step / 2)
        const phase = step % 2
        step++
        if (i < names.length) {
          if (phase === 0) return call('read', { file_path: `logs/${names[i]}` })
          lines.push(`${names[i]}: ${haystack(1001 + i, 8000).code}`)
          return call('write', { file_path: 'codes.txt', content: `${lines.join('\n')}\n` })
        }
        if (i === names.length && phase === 0) return call('read', { file_path: 'codes.txt' })
        return { content: '16 件そろいました' }
      },
      {
        providers: { mock: { models: [{ id: 'mock-model', contextWindow: 16000, maxTokens: 1000 }] } },
        modes: { high: { compactionHeadroomTokens: 0, compactionThresholdRatio: 0.3 } },
      },
    )
    try {
      const report = await runBench({ endpoint: { baseURL: h.daemon.baseURL, token: h.daemon.token }, stateDir: h.config.stateDir, workRoot: join(h.workspace, 'bench'), tasks: EXTRA_SUITE, repeat: 1, label: 'mock-long', taskTimeoutMs: 240_000 })
      const run = report.runs[0]!
      assert.equal(run.pass, true, `${run.failureCause}: ${run.detail}`)
      assert.ok(run.compactions >= 1, `expected at least one compaction, got ${run.compactions}`)
      assert.match(run.detail, /圧縮 [1-9]/)
    } finally {
      await h.close()
    }
  })

  it('classifies failures from task status and checks', async () => {
    const { classifyFailure } = await import('../../src/bench/runner.ts')
    const t = (status: string, extra: Record<string, unknown> = {}) => ({ id: 'x', status, ...extra }) as never
    assert.equal(classifyFailure([t('succeeded')], { pass: true, detail: '' }, false), null)
    assert.equal(classifyFailure([t('succeeded')], { pass: false, detail: '' }, false), 'check-failed')
    assert.equal(classifyFailure([t('budget_exhausted', { metrics: { budgetExhausted: { kind: 'steps' } } })], { pass: false, detail: '' }, false), 'budget:steps')
    assert.equal(classifyFailure([t('failed', { error: 'MALFORMED_RESPONSE bad json' })], { pass: false, detail: '' }, false), 'failed:MALFORMED_RESPONSE')
    assert.equal(classifyFailure([t('cancelled'), t('verification_failed')], { pass: false, detail: '' }, true), 'verification_failed')
    assert.equal(summarize([]).length, 0)
    void existsSync
    void readFileSync
  })
})
