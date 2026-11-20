import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { decide, deleteTargets, type Config } from '../../src/plugins/policy.ts'
import { VerifyLoop } from '../../src/plugins/verify.ts'
import { BackupStore } from '../../src/security/backup.ts'
import { createSandboxExec } from '../../src/tools/sandbox-exec.ts'
import { changedFiles, formatReport, runVerifiers, type VerifySettings } from '../../src/verify/verifiers.ts'

describe('deleteTargets', () => {
  it('extracts literal targets and flags computed ones', () => {
    const r = deleteTargets([
      { name: 'Remove-Item', args: ['-Path', 'a.txt', '-Filter', '*.log'] },
      { name: 'del', args: ['b.txt', '/q'] },
      { name: 'Remove-Item', args: ['$target'] },
      { name: 'Get-ChildItem', args: ['.'] },
    ])
    assert.deepEqual(r.targets, ['a.txt', 'b.txt'])
    assert.deepEqual(r.dynamic, ['$target'])
  })
})

describe('policy backups and delete modes', () => {
  let root: string
  let ws: string
  const base = (): Config => ({
    workspace: ws,
    auditLog: join(root, 'audit.jsonl'),
    protectedPaths: ['.git/**'],
    allowOverwrite: true,
    allowDangerousCommands: false,
    extraDangerousCommands: [],
    trustedCommands: [],
    deniedTools: [],
    deleteMode: 'backup',
    backupDir: join(root, 'backup'),
    backupMaxBytes: 1_000_000,
  })
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'hearth-pol-'))
    ws = join(root, 'ws')
    mkdirSync(ws)
    writeFileSync(join(ws, 'keep.txt'), 'original')
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  it('backs up a file before it is overwritten', async () => {
    const store = new BackupStore(join(root, 'backup'), 1_000_000)
    const d = await decide('write', { file_path: 'keep.txt', content: 'new' }, base(), store, 'c1')
    assert.equal(d.kind, 'allow')
    assert.deepEqual(d.kind === 'allow' ? d.backups : undefined, ['keep.txt'])
    const manifest = readFileSync(join(root, 'backup', 'manifest.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l) as { backup: string; reason: string })
    assert.equal(readFileSync(manifest[0]!.backup, 'utf8'), 'original')
    assert.equal(manifest[0]!.reason, 'overwrite')
  })

  if (process.platform === 'win32') {
    it('backs up literal delete targets of a PowerShell command', async () => {
      const store = new BackupStore(join(root, 'backup2'), 1_000_000)
      const d = await decide('pwsh', { command: 'Remove-Item keep.txt' }, base(), store, 'c2')
      assert.equal(d.kind, 'allow')
      assert.ok(existsSync(join(root, 'backup2', 'manifest.jsonl')))
    })
    it('refuses computed delete targets in backup mode and all deletes in deny mode', async () => {
      const d1 = await decide('pwsh', { command: '$f = "keep.txt"; Remove-Item $f' }, base(), new BackupStore(join(root, 'b3'), 1e6))
      assert.equal(d1.kind, 'deny')
      const d2 = await decide('pwsh', { command: 'Remove-Item keep.txt' }, { ...base(), deleteMode: 'deny' }, new BackupStore(join(root, 'b4'), 1e6))
      assert.equal(d2.kind, 'deny')
      assert.match(d2.kind === 'deny' ? d2.reason : '', /deleteMode: deny/)
    })
  }

  it('refuses a delete when the backup quota is exhausted', async () => {
    writeFileSync(join(ws, 'big.bin'), Buffer.alloc(5000))
    const d = await decide('apply_patch', { input: '*** Begin Patch\n*** Delete File: big.bin\n*** End Patch' }, base(), new BackupStore(join(root, 'b5'), 100))
    assert.equal(d.kind, 'deny')
    assert.match(d.kind === 'deny' ? d.reason : '', /quota/)
  })
})

describe('VerifyLoop', () => {
  const fail = [{ verifier: 'x', target: 'a', ok: false, detail: 'bad' }]
  const pass = [{ verifier: 'x', target: 'a', ok: true, detail: 'ok' }]
  it('steers up to the round limit, then reports exhaustion', () => {
    const l = new VerifyLoop(2)
    assert.deepEqual(l.record(fail), { passed: false, steer: true, exhausted: false })
    assert.deepEqual(l.record(fail), { passed: false, steer: true, exhausted: false })
    assert.deepEqual(l.record(fail), { passed: false, steer: false, exhausted: true })
    assert.equal(l.runs, 3)
  })
  it('stops steering once checks pass', () => {
    const l = new VerifyLoop(3)
    l.record(fail)
    assert.deepEqual(l.record(pass), { passed: true, steer: false, exhausted: false })
    assert.equal(l.steers, 1)
  })
  it('formats an actionable report', () => {
    const text = formatReport([...fail, ...pass], 1, 2)
    assert.match(text, /fix round 1 of 2/)
    assert.match(text, /FAILED x \(a\):\nbad/)
    assert.match(text, /Do not weaken or delete tests/)
  })
})

describe('verifiers', () => {
  let ws: string
  const exec = createSandboxExec(undefined, 'danger-full-access', '')
  const settings = (): VerifySettings => ({
    workspace: ws,
    strict: false,
    pythonExecutable: 'python',
    testTimeoutMs: 60_000,
    commands: [],
    latex: { latexEngine: 'uplatex', bibtex: 'upbibtex', dvipdfmx: 'dvipdfmx', latexTimeoutMs: 60_000, pdfinfo: 'pdfinfo', pdffonts: 'pdffonts', pdftotext: 'pdftotext' },
    maxScanFiles: 1000,
    ignoreDirs: ['.git', '__pycache__'],
  })
  before(() => {
    ws = mkdtempSync(join(tmpdir(), 'hearth-ver-'))
    writeFileSync(join(ws, 'old.py'), 'x = 1\n')
    const past = new Date(Date.now() - 3_600_000)
    utimesSync(join(ws, 'old.py'), past, past)
  })
  after(() => rmSync(ws, { recursive: true, force: true }))

  it('lists only files changed since the start time', () => {
    const since = Date.now() - 1000
    writeFileSync(join(ws, 'new.json'), '{}')
    assert.deepEqual(changedFiles(ws, since, ['.git'], 100), ['new.json'])
  })

  it('reports syntax errors, failing tests, and bad JSON; passes good files', async () => {
    writeFileSync(join(ws, 'calc.py'), 'def add(a, b):\n    return a - b\n')
    writeFileSync(join(ws, 'broken.py'), 'def f(:\n')
    writeFileSync(join(ws, 'test_calc.py'), 'import unittest\nfrom calc import add\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n')
    writeFileSync(join(ws, 'bad.json'), '{"a":')
    writeFileSync(join(ws, 'ok.yaml'), 'a: 1\n')
    const findings = await runVerifiers(['calc.py', 'broken.py', 'test_calc.py', 'bad.json', 'ok.yaml'], settings(), exec, {})
    const by = (v: string) => findings.find(f => f.verifier === v)!
    assert.equal(by('python-syntax').ok, false)
    assert.match(by('python-syntax').detail, /broken\.py/)
    const tests = findings.find(f => f.verifier === 'pytest' || f.verifier === 'unittest')!
    assert.equal(tests.ok, false)
    assert.equal(by('json').ok, false)
    assert.equal(by('yaml').ok, true)
  })

  it('runs explicit verification commands', async () => {
    const findings = await runVerifiers([], { ...settings(), commands: ['exit 0', 'exit 3'] }, exec, {})
    assert.deepEqual(findings.map(f => f.ok), [true, false])
  })
})

describe('web search parsers', async () => {
  const { parseDuckDuckGoHtml, parseSearxng } = await import('../../src/plugins/web-search.ts')
  it('parses DuckDuckGo result blocks and unwraps redirect links', () => {
    const html = `<div class="result results_links web-result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%3Fx%3D1&amp;rut=abc">Example &amp; Co</a><a class="result__snippet" href="#">An <b>example</b> page</a></div>
<div class="result results_links web-result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>`
    assert.deepEqual(parseDuckDuckGoHtml(html), [{ url: 'https://example.com/a?x=1', title: 'Example & Co', snippet: 'An example page' }])
  })
  it('reports bot-detection pages instead of working around them', () => {
    assert.throws(() => parseDuckDuckGoHtml('<div class="anomaly-modal">'), /bot-detection/)
  })
  it('parses SearXNG JSON', () => {
    assert.deepEqual(parseSearxng({ results: [{ url: 'https://a.example', title: 'A', content: 'c' }, { title: 'no url' }] }), [{ url: 'https://a.example', title: 'A', snippet: 'c' }])
  })
})

if (process.platform === 'win32') {
  describe('PowerShell array arguments', async () => {
    const { classifyPowerShell } = await import('../../src/security/command-policy.ts')
    it('lowers literal arrays into separate words so each delete target is checked', async () => {
      const r = await classifyPowerShell("Remove-Item -LiteralPath 'a.txt','b.txt'", { extraDangerous: [], trusted: [] })
      assert.deepEqual(deleteTargets(r.commands).targets, ['a.txt', 'b.txt'])
    })
  })
}
