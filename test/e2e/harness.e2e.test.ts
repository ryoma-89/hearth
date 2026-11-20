/**
 * End-to-end tests with a scripted mock model. Real components: Hearth
 * daemon, task queue, inference broker, DSH headless child processes, DSH
 * tools and sandbox, Hearth plugins, Python, upLaTeX. Simulated: the LLM.
 * Results here say nothing about how well a real local model performs.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { MockStep } from '../mock/mock-openai.ts'
import { startHarness, toolResultsSeen } from './helpers.ts'

const call = (name: string, args: unknown, content?: string): MockStep => ({ content, toolCalls: [{ name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }] })
const pwsh = (command: string) => call('pwsh', { command, description: 'run command' })

describe('Hearth end-to-end (mock model)', { concurrency: false, timeout: 600_000 }, () => {
  it('completes a multi-step task: write a file, run Python, read the result', async () => {
    const h = await startHarness([
      call('write', { file_path: 'calc.py', content: 'import json\nprint(json.dumps({"sum": sum(range(1, 11))}))\n' }),
      call('python_run', { script_path: 'calc.py' }),
      call('read', { file_path: 'calc.py' }),
      { content: 'Done: the sum is 55.' },
    ])
    try {
      const t = await h.wait((await h.submit('Write calc.py that prints the sum of 1..10 and run it')).id)
      assert.equal(t.status, 'succeeded', t.error)
      assert.equal(t.finalText, 'Done: the sum is 55.')
      assert.ok(existsSync(join(h.workspace, 'calc.py')))
      const results = h.mock.requests[2]!.messages.filter(m => m.role === 'tool').map(m => JSON.stringify(m.content))
      assert.ok(results.some(r => r.includes('\\"sum\\": 55') || r.includes('"sum": 55')), `python output returned to the model: ${results.join(' | ')}`)
      assert.equal(t.metrics!.toolCalls, 3)
      assert.equal(t.metrics!.steps, 4)
      assert.ok(t.metrics!.totalTokens > 0)
      assert.ok(existsSync(join(h.config.stateDir, 'runs', t.id, 'audit.jsonl')), 'audit log written')
    } finally {
      await h.close()
    }
  })

  it('repairs malformed tool-call JSON instead of failing the turn', async () => {
    const h = await startHarness([
      call('write', "{'file_path': 'note.txt', content: 'hello',}"),
      { content: 'written' },
    ])
    try {
      const t = await h.wait((await h.submit('write note.txt')).id)
      assert.equal(t.status, 'succeeded', t.error)
      assert.equal(readFileSync(join(h.workspace, 'note.txt'), 'utf8'), 'hello')
      assert.equal(t.metrics!.toolCallRepairs, 1)
    } finally {
      await h.close()
    }
  })

  it('re-samples after an unrepairable tool call and returns tool errors to the model', async () => {
    let malformedSent = false
    const h = await startHarness((req, index) => {
      if (index === 0 && !malformedSent) {
        malformedSent = true
        return call('write', '{"file_path": "x.txt", "content": "cut off')
      }
      if (index === 0) return call('python_run', { code: 'raise ValueError("boom")' })
      if (index === 1) return call('python_run', { code: 'print("fixed")' })
      return { content: `final after ${req.messages.filter(m => m.role === 'tool').length} tool results` }
    })
    try {
      const t = await h.wait((await h.submit('do it')).id)
      assert.equal(t.status, 'succeeded', t.error)
      assert.equal(t.metrics!.toolCallRetries, 1)
      const seen = toolResultsSeen(h.mock).join('\n')
      assert.match(seen, /ValueError: boom/, 'the Python traceback reached the model')
      assert.match(seen, /fixed/)
    } finally {
      await h.close()
    }
  })

  it('verifies at turn end and sends failures back until they are fixed', async () => {
    const buggy = 'def add(a, b):\n    return a - b\n'
    const fixed = 'def add(a, b):\n    return a + b\n'
    const test = 'import unittest\nfrom calc import add\n\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n'
    const h = await startHarness((req, index) => {
      const lastUser = JSON.stringify(req.messages.filter(m => m.role === 'user').at(-1)?.content ?? '')
      if (index === 0) return call('write', { file_path: 'calc.py', content: buggy })
      if (index === 1) return call('write', { file_path: 'test_calc.py', content: test })
      if (index === 2) return { content: 'Finished (without running tests).' }
      if (lastUser.includes('Hearth verification')) return call('write', { file_path: 'calc.py', content: fixed })
      return { content: 'Fixed add(); tests pass now.' }
    })
    try {
      const t = await h.wait((await h.submit('write calc.py with add() and a test')).id)
      assert.equal(t.status, 'succeeded', t.error)
      assert.deepEqual([t.metrics!.verification?.last, t.metrics!.verification?.fixRounds, t.metrics!.verification?.runs], ['passed', 1, 2])
      const steer = h.mock.requests.map(r => JSON.stringify(r.messages)).find(m => m.includes('Hearth verification'))
      assert.ok(steer, 'the failure report reached the model')
      assert.match(steer!, /AssertionError: -1 != 5|unittest/)
    } finally {
      await h.close()
    }
  })

  it('ends as verification_failed when fixes run out', async () => {
    const h = await startHarness((_req, index) =>
      index === 0 ? call('write', { file_path: 'bad.json', content: '{"a": 1,' }) : { content: 'done' },
    )
    try {
      const t = await h.wait((await h.submit('write bad.json', { mode: 'medium' })).id)
      assert.equal(t.status, 'verification_failed', t.error)
      assert.equal(t.metrics!.verification?.fixRounds, 1)
      assert.match(t.error!, /json \(bad\.json\)/)
    } finally {
      await h.close()
    }
  })

  it('runs task-level verification commands', async () => {
    const h = await startHarness([call('write', { file_path: 'out.txt', content: 'hello' }), { content: 'done' }])
    try {
      const t = await h.wait((await h.submit('write out.txt', { mode: 'low', verify: ['if ((Get-Content out.txt) -ne "hello") { exit 1 }'] })).id)
      assert.equal(t.status, 'succeeded', t.error)
      assert.equal(t.metrics!.verification?.last, 'passed')
    } finally {
      await h.close()
    }
  })

  it('keeps task notes and searchable history across context compaction', async () => {
    let summarized = false
    let noted = false
    let bigOutputs = 0
    let searched = false
    const h = await startHarness(
      req => {
        const last = JSON.stringify(req.messages.at(-1)?.content ?? '')
        const all = JSON.stringify(req.messages)
        if (last.includes('compaction engine')) {
          summarized = true
          return { content: 'Summary: a decision was recorded and large outputs were printed.' }
        }
        if (!noted) {
          noted = true
          return call('task_memory', { action: 'note', kind: 'decision', text: 'Use port 8123 for the dev server' })
        }
        if (bigOutputs < 3) {
          bigOutputs++
          return call('python_run', { code: `print("MARKER-77 " + "abcdefghij" * 1500)` })
        }
        if (all.includes('[Hearth task memory]') && !searched) {
          searched = true
          return call('task_memory', { action: 'search_history', text: 'MARKER-77' })
        }
        return { content: all.includes('[Hearth task memory]') ? 'notes were re-injected' : 'no compaction happened' }
      },
      {
        providers: { mock: { models: [{ id: 'mock-model', contextWindow: 16000, maxTokens: 1000 }] } },
        modes: { high: { compactionHeadroomTokens: 0, compactionThresholdRatio: 0.5 } },
      },
    )
    try {
      const t = await h.wait((await h.submit('do the steps', { mode: 'high' })).id, 300_000)
      assert.equal(t.status, 'succeeded', t.error)
      assert.ok(summarized, 'compaction asked the model for a summary')
      assert.equal(t.finalText, 'notes were re-injected')
      assert.match(toolResultsSeen(h.mock).join('\n'), /MARKER-77/, 'search_history found text from before compaction')
      const notes = readFileSync(join(h.config.stateDir, 'notes', `${t.sessionId}.md`), 'utf8')
      assert.match(notes, /\[decision\] Use port 8123/)
    } finally {
      await h.close()
    }
  })

  it('refuses to start when a Hearth plugin fails to load', async () => {
    const { runTask } = await import('../../src/runner/dsh-runner.ts')
    const h = await startHarness([{ content: 'must never be requested' }])
    try {
      // No broker token: the inference-gate plugin throws during activation.
      const out = await runTask({ config: h.config, task: { id: 'tplugfail', prompt: 'x', mode: 'low', provider: 'mock', model: 'mock-model', workspace: h.workspace, status: 'running', createdAt: '', source: 'test' }, brokerURL: 'http://127.0.0.1:1', env: { HEARTH_TEST_MOCK_KEY: 'mock-key' } })
      assert.equal(out.status, 'failed')
      assert.match(out.error!, /hearth-inference-gate did not load/)
      assert.equal(h.mock.requests.length, 0, 'no model request was made')
    } finally {
      await h.close()
    }
  })

  it('routes web_search to the Hearth SearXNG provider', async () => {
    const { createServer } = await import('node:http')
    const searx = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ results: [{ url: 'https://example.org/uplatex', title: 'upLaTeX guide', content: 'How to use upLaTeX' }], query: new URL(req.url!, 'http://x').searchParams.get('q') }))
    })
    await new Promise<void>(r => searx.listen(0, '127.0.0.1', r))
    const port = (searx.address() as { port: number }).port
    const h = await startHarness([call('web_search', { queries: ['uplatex guide'] }), { content: 'found it' }], { web: { search: 'searxng', searxngURL: `http://127.0.0.1:${port}` } })
    try {
      const t = await h.wait((await h.submit('search')).id)
      assert.equal(t.status, 'succeeded', t.error)
      assert.match(toolResultsSeen(h.mock).join('\n'), /example\.org\/uplatex/)
    } finally {
      await h.close()
      searx.close()
    }
  })

  it('backs up files before a PowerShell delete', async () => {
    const h = await startHarness([pwsh('Remove-Item notes.txt'), { content: 'deleted' }])
    try {
      writeFileSync(join(h.workspace, 'notes.txt'), 'precious')
      const t = await h.wait((await h.submit('delete notes.txt')).id)
      assert.equal(t.status, 'succeeded', t.error)
      assert.ok(!existsSync(join(h.workspace, 'notes.txt')), 'the delete itself happened')
      const manifest = readFileSync(join(h.config.stateDir, 'runs', t.id, 'backup', 'manifest.jsonl'), 'utf8')
      const entry = JSON.parse(manifest.trim().split('\n')[0]!) as { backup: string; reason: string }
      assert.equal(entry.reason, 'delete')
      assert.equal(readFileSync(entry.backup, 'utf8'), 'precious')
    } finally {
      await h.close()
    }
  })

  it('handles a task with more than 20 tool calls', async () => {
    const steps: MockStep[] = []
    for (let i = 0; i < 22; i++) steps.push(call('write', { file_path: `parts/p${i}.txt`, content: `part ${i}` }))
    steps.push(call('python_run', { code: 'import os; print(len(os.listdir("parts")))' }))
    steps.push({ content: 'created 22 parts' })
    const h = await startHarness(steps)
    try {
      const t = await h.wait((await h.submit('make 22 parts', { mode: 'high' })).id, 300_000)
      assert.equal(t.status, 'succeeded', t.error)
      assert.equal(t.metrics!.toolCalls, 23)
      assert.match(toolResultsSeen(h.mock).at(-1)!, /22/)
    } finally {
      await h.close()
    }
  })

  it('stops at the mode step budget', async () => {
    const h = await startHarness(() => call('python_run', { code: 'print(1)' }), { modes: { low: { maxSteps: 3 } } })
    try {
      const t = await h.wait((await h.submit('loop forever', { mode: 'low' })).id)
      assert.equal(t.status, 'budget_exhausted')
      assert.equal(t.metrics!.budgetExhausted?.kind, 'steps')
      assert.equal(h.mock.requests.length, 3)
    } finally {
      await h.close()
    }
  })

  it('blocks dangerous operations and path escapes', async () => {
    const h = await startHarness([
      pwsh('Remove-Item -Path . -Recurse -Force'),
      call('write', { file_path: '../escape.txt', content: 'x' }),
      call('write', { file_path: '.git/config', content: 'x' }),
      pwsh("& ('Remove'+'-Item') keep.txt"),
      { content: 'all refused' },
    ])
    try {
      writeFileSync(join(h.workspace, 'keep.txt'), 'keep')
      mkdirSync(join(h.workspace, '.git'))
      // high mode: 4 consecutive denials stay below its failure budget (5); medium (4) would stop the task.
      const t = await h.wait((await h.submit('clean up', { mode: 'high' })).id)
      assert.equal(t.status, 'succeeded', t.error)
      assert.equal(t.metrics!.policyDenials, 4)
      assert.ok(existsSync(join(h.workspace, 'keep.txt')), 'workspace untouched')
      assert.ok(!existsSync(join(h.root, 'escape.txt')), 'no write outside the workspace')
      assert.ok(!existsSync(join(h.workspace, '.git', 'config')), 'protected path not written')
      assert.match(toolResultsSeen(h.mock).join('\n'), /Hearth policy/)
    } finally {
      await h.close()
    }
  })

  it('runs Hearth tools inside the DSH sandbox (writes outside the workspace fail)', async () => {
    const h = await startHarness((_req, index) =>
      index === 0
        ? call('python_run', { code: `import pathlib\ntarget = pathlib.Path("..").resolve() / "sandbox-escape.txt"\ntry:\n    target.write_text("x")\n    print("WROTE")\nexcept Exception as e:\n    print("BLOCKED", type(e).__name__)\npathlib.Path("inside.txt").write_text("ok")\n` })
        : { content: 'done' },
    )
    try {
      const t = await h.wait((await h.submit('try to escape')).id)
      assert.equal(t.status, 'succeeded', t.error)
      const seen = toolResultsSeen(h.mock).join('\n')
      assert.match(seen, /BLOCKED/, seen)
      assert.ok(existsSync(join(h.workspace, 'inside.txt')), 'workspace writes still work')
      assert.ok(!existsSync(join(h.root, 'sandbox-escape.txt')), 'nothing written outside the workspace')
    } finally {
      await h.close()
    }
  })

  it('serializes inference across queued tasks (max 1 concurrent request)', async () => {
    const h = await startHarness(() => ({ content: 'ok', delayMs: 300 }), { queue: { maxConcurrentTasks: 3 } })
    try {
      const tasks = await Promise.all([h.submit('a'), h.submit('b'), h.submit('c')])
      const done = await Promise.all(tasks.map(t => h.wait(t.id)))
      assert.deepEqual(done.map(t => t.status), ['succeeded', 'succeeded', 'succeeded'])
      assert.equal(h.mock.peakConcurrency, 1, 'never more than one model request in flight')
      assert.ok(done.some(t => t.metrics!.leaseWaitMs > 0), 'some task waited for the slot')
      assert.equal(h.daemon.broker.snapshot().active.length, 0, 'no lease left behind')
    } finally {
      await h.close()
    }
  })

  it('cancels a running task and frees the inference slot', async () => {
    const h = await startHarness(() => ({ content: 'slow', delayMs: 60_000 }))
    try {
      const t = await h.submit('slow task')
      for (let i = 0; i < 100 && h.daemon.broker.snapshot().active.length === 0; i++) await new Promise(r => setTimeout(r, 100))
      assert.equal(h.daemon.broker.snapshot().active.length, 1)
      h.daemon.queue.cancel(t.id)
      const done = await h.wait(t.id, 30_000)
      assert.equal(done.status, 'cancelled')
      assert.equal(h.daemon.broker.snapshot().active.length, 0)
    } finally {
      await h.close()
    }
  })

  it('resumes a finished task in its saved session', async () => {
    const h = await startHarness((req, index) => {
      if (index === 0) return { content: 'first answer: remember 42' }
      const history = JSON.stringify(req.messages)
      return { content: history.includes('remember 42') ? 'resumed with history' : 'history lost' }
    })
    try {
      const first = await h.wait((await h.submit('first')).id)
      assert.equal(first.status, 'succeeded', first.error)
      assert.ok(first.sessionId)
      const res = await fetch(`${h.daemon.baseURL}/v1/tasks/${first.id}/resume`, {
        method: 'POST',
        headers: { authorization: `Bearer ${h.daemon.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'continue' }),
      })
      const { task } = (await res.json()) as { task: { id: string } }
      const second = await h.wait(task.id)
      assert.equal(second.status, 'succeeded', second.error)
      assert.equal(second.sessionId, first.sessionId)
      assert.equal(second.finalText, 'resumed with history')
    } finally {
      await h.close()
    }
  })

  it('compiles LaTeX with upLaTeX + dvipdfmx and reports structured errors', async () => {
    const good = '\\documentclass{ujarticle}\n\\begin{document}\nこんにちは、Hearth。\n\\end{document}\n'
    const bad = '\\documentclass{ujarticle}\n\\begin{document}\n\\undefinedmacro\n\\end{document}\n'
    const h = await startHarness([
      call('write', { file_path: 'doc.tex', content: bad }),
      call('latex_compile', { tex_path: 'doc.tex' }),
      call('write', { file_path: 'doc.tex', content: good }),
      call('latex_compile', { tex_path: 'doc.tex' }),
      { content: 'PDF ready' },
    ])
    try {
      const t = await h.wait((await h.submit('make a PDF')).id, 300_000)
      assert.equal(t.status, 'succeeded', t.error)
      const msgs = h.mock.requests.map(r => JSON.stringify(r.messages.filter(m => m.role === 'tool').at(-1)?.content ?? ''))
      assert.match(msgs[2]!, /FAILED/)
      assert.match(msgs[2]!, /Undefined control sequence/)
      assert.match(msgs[4]!, /SUCCESS/)
      assert.match(msgs[4]!, /1 pages/)
      assert.ok(existsSync(join(h.workspace, 'doc.pdf')))
    } finally {
      await h.close()
    }
  })
})
