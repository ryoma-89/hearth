/**
 * API key storage.
 *
 * Keys are never written to Hearth config files. Two sources are supported:
 *  - an environment variable named in the config (`apiKey: { env: NAME }`);
 *  - a Windows DPAPI-protected file (`apiKey: { secret: NAME }`) under
 *    %LOCALAPPDATA%\Hearth\secrets, readable only by the same Windows user.
 * Resolved keys are passed only to the DSH child process environment.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ApiKeySource } from '../config/types.ts'

export class SecretError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecretError'
  }
}

export function secretsDir(): string {
  const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  return join(base, 'Hearth', 'secrets')
}

function secretFile(name: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new SecretError(`invalid secret name: ${name}`)
  return join(secretsDir(), `${name}.dpapi`)
}

function powershell(script: string, input: string): string {
  if (process.platform !== 'win32') throw new SecretError('DPAPI secrets are only available on Windows; use apiKey: { env: NAME } instead')
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input, encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) throw new SecretError(`DPAPI operation failed: ${(r.stderr || r.error?.message || '').trim()}`)
  return r.stdout.trim()
}

const PROTECT = "Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd(); $b=[Text.Encoding]::UTF8.GetBytes($in); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))"
const UNPROTECT = "Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim(); $b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($in),$null,'CurrentUser'); [Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))"

/** Store a secret encrypted for the current Windows user. */
export function setSecret(name: string, value: string): string {
  if (!value) throw new SecretError('refusing to store an empty secret')
  const file = secretFile(name)
  mkdirSync(secretsDir(), { recursive: true })
  writeFileSync(file, powershell(PROTECT, value), { encoding: 'utf8', mode: 0o600 })
  return file
}

export function deleteSecret(name: string): boolean {
  const file = secretFile(name)
  if (!existsSync(file)) return false
  rmSync(file)
  return true
}

export function hasSecret(name: string): boolean {
  return existsSync(secretFile(name))
}

/** Decrypt a stored secret. */
export function getSecret(name: string): string {
  const file = secretFile(name)
  if (!existsSync(file)) throw new SecretError(`secret "${name}" is not stored (run: hearth secret set ${name})`)
  return powershell(UNPROTECT, readFileSync(file, 'utf8'))
}

/**
 * Resolve an API key source.
 * @param source - configured source.
 * @param env - environment to read from.
 * @returns the key, or undefined for `none`.
 */
export function resolveApiKey(source: ApiKeySource, env: NodeJS.ProcessEnv = process.env): string | undefined {
  switch (source.kind) {
    case 'none':
      return undefined
    case 'env': {
      const v = env[source.name]
      if (!v) throw new SecretError(`environment variable ${source.name} is not set`)
      return v
    }
    case 'secret':
      return getSecret(source.name)
  }
}
