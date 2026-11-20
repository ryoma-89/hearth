import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DEFAULT_RAW_CONFIG } from '../../src/config/defaults.ts'
import { resolveConfig } from '../../src/config/load.ts'
import { browserRequestProblem, GuiSessions, isLocalAuthority, parseCookies } from '../../src/server/gui-auth.ts'
import { parseNvidiaSmi } from '../../src/server/resources.ts'
import { applySettings, SettingsError } from '../../src/server/settings.ts'
import { sanitizeFileName } from '../../src/server/uploads.ts'

const req = (method: string, headers: Record<string, string>) => ({ method, headers }) as unknown as IncomingMessage

describe('GUI sessions', () => {
  it('redeems a login code exactly once and before it expires', () => {
    const s = new GuiSessions(1000, 100)
    const code = s.issueCode(0)
    const id = s.redeem(code, 50)
    assert.ok(id)
    assert.equal(s.redeem(code, 60), undefined, 'single use')
    assert.equal(s.valid(id, 500), true)
    assert.equal(s.valid(id, 2000), false, 'session expires')
    assert.equal(s.redeem(s.issueCode(0), 200), undefined, 'code expires')
  })
  it('parses cookies', () => {
    assert.deepEqual(parseCookies('a=1; hearth_session=x%3Dy'), { a: '1', hearth_session: 'x=y' })
  })
})

describe('browser request checks', () => {
  it('accepts only loopback hosts on the daemon port', () => {
    assert.equal(isLocalAuthority('127.0.0.1:47900', 47900), true)
    assert.equal(isLocalAuthority('localhost:47900', 47900), true)
    assert.equal(isLocalAuthority('[::1]:47900', 47900), true)
    assert.equal(isLocalAuthority('evil.example:47900', 47900), false, 'DNS rebinding')
    assert.equal(isLocalAuthority('127.0.0.1:1234', 47900), false)
  })
  it('requires the CSRF header and a same-origin Origin for writes', () => {
    const host = { host: '127.0.0.1:47900' }
    assert.equal(browserRequestProblem(req('GET', host), 47900), undefined)
    assert.match(browserRequestProblem(req('POST', host), 47900)!, /csrf/)
    assert.equal(browserRequestProblem(req('POST', { ...host, 'x-hearth-csrf': '1', origin: 'http://127.0.0.1:47900' }), 47900), undefined)
    assert.match(browserRequestProblem(req('POST', { ...host, 'x-hearth-csrf': '1', origin: 'https://evil.example' }), 47900)!, /cross-origin/)
    assert.match(browserRequestProblem(req('GET', { host: 'attacker.test:47900' }), 47900)!, /Host/)
  })
})

describe('upload names', () => {
  it('strips paths, Windows-reserved characters, and device names', () => {
    assert.equal(sanitizeFileName('..\\..\\evil.txt'), 'evil.txt')
    assert.equal(sanitizeFileName('a/b/c.csv'), 'c.csv')
    assert.equal(sanitizeFileName('re:port?.pdf'), 're_port_.pdf')
    assert.equal(sanitizeFileName('CON.txt'), 'file_CON.txt')
    assert.equal(sanitizeFileName('...'), 'file_upload')
  })
})

describe('nvidia-smi parsing', () => {
  it('reads one row per GPU', () => {
    assert.deepEqual(parseNvidiaSmi('NVIDIA GeForce RTX 5070 Ti, 37, 15691, 16303, 46\n'), [{ name: 'NVIDIA GeForce RTX 5070 Ti', utilizationPct: 37, memoryUsedMiB: 15691, memoryTotalMiB: 16303, temperatureC: 46 }])
  })
})

describe('settings', () => {
  it('writes allowed keys, keeps comments, and validates the result', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hearth-set-'))
    try {
      const file = join(dir, 'hearth.yaml')
      writeFileSync(file, '# my comment\ndefaultMode: medium # inline\n')
      const config = resolveConfig(DEFAULT_RAW_CONFIG, dir)
      const next = applySettings(config, { defaultMode: 'high', 'queue.maxConcurrentTasks': 2 }, file)
      assert.equal(next.defaultMode, 'high')
      assert.equal(next.queue.maxConcurrentTasks, 2)
      const text = readFileSync(file, 'utf8')
      assert.match(text, /# my comment/)
      assert.match(text, /maxConcurrentTasks: 2/)
      assert.throws(() => applySettings(config, { 'security.allowedWorkspaceRoots': ['C:/'] }, file), SettingsError)
      assert.throws(() => applySettings(config, { 'queue.maxConcurrentTasks': 99 }, file), SettingsError)
      assert.throws(() => applySettings(config, { defaultModel: 'nope/x' }, file), SettingsError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
