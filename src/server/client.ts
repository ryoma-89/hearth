/**
 * Client for the Hearth daemon, with auto-start.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { HearthConfig } from '../config/types.ts'
import { readDaemonInfo, type DaemonInfo } from './daemon.ts'

export class DaemonError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'DaemonError'
    this.status = status
    this.code = code
  }
}

const BIN = fileURLToPath(new URL('../../bin/hearth.mjs', import.meta.url))

export class DaemonClient {
  readonly info: DaemonInfo

  constructor(info: DaemonInfo) {
    this.info = info
  }

  async request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.info.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.info.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
    const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string }
    if (!res.ok) throw new DaemonError(res.status, data.code ?? `HTTP_${res.status}`, data.error ?? res.statusText)
    return data
  }

  /** Stream NDJSON lines from an events endpoint. */
  async *events(taskId: string, follow: boolean, signal?: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    const res = await fetch(`${this.info.url}/v1/tasks/${taskId}/events${follow ? '?follow=1' : ''}`, { headers: { authorization: `Bearer ${this.info.token}` }, signal })
    if (!res.ok || !res.body) throw new DaemonError(res.status, `HTTP_${res.status}`, await res.text())
    const decoder = new TextDecoder()
    let buffer = ''
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) yield JSON.parse(line) as Record<string, unknown>
    }
    if (buffer.trim()) yield JSON.parse(buffer) as Record<string, unknown>
  }
}

/** Return a client for a live daemon, or undefined. */
export async function connect(config: HearthConfig): Promise<DaemonClient | undefined> {
  const info = readDaemonInfo(config)
  if (!info) return undefined
  try {
    const res = await fetch(`${info.url}/v1/health`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return undefined
    const health = (await res.json()) as { pid?: number }
    if (health.pid !== info.pid) return undefined
    return new DaemonClient(info)
  } catch {
    return undefined
  }
}

/**
 * Connect to the daemon, starting it detached when it is not running.
 * @param config - resolved config (its file path is forwarded to the daemon).
 * @param configPath - explicit config path passed to the CLI, if any.
 * @returns a connected client.
 */
export async function ensureDaemon(config: HearthConfig, configPath?: string): Promise<DaemonClient> {
  const existing = await connect(config)
  if (existing) return existing
  const args = [BIN, 'daemon', 'run']
  if (configPath) args.push('--config', configPath)
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', windowsHide: true, env: process.env })
  child.unref()
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 300))
    const client = await connect(config)
    if (client) return client
  }
  throw new DaemonError(0, 'DAEMON_START_FAILED', `the Hearth daemon did not start within 20 s; run "hearth daemon run" in a terminal to see why (state dir ${config.stateDir})`)
}
