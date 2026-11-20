/**
 * Bounded child-process execution shared by Hearth tools.
 * Output is captured with a size cap, the process tree is killed on timeout
 * or abort, and the exit status is always reported (never thrown away).
 */
import { spawn, spawnSync } from 'node:child_process'

export interface RunOptions {
  cwd: string
  timeoutMs: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  input?: string
  /** Bytes of stdout/stderr retained (each). */
  maxBytes?: number
}

export interface RunResult {
  command: string
  exitCode: number | null
  signal: string | null
  timedOut: boolean
  aborted: boolean
  durationMs: number
  stdout: string
  stderr: string
  truncated: boolean
  /** Set when the executable could not be started. */
  spawnError?: string
}

/** Kill a process and its children (Windows needs taskkill for the tree). */
export function killTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch (error) {
        void error // already exited
      }
    }
  }
}

/**
 * Run an executable with arguments (no shell).
 * @param file - executable.
 * @param args - argument vector.
 * @param options - cwd, deadline, cancellation.
 * @returns captured result.
 */
export function runProcess(file: string, args: string[], options: RunOptions): Promise<RunResult> {
  const maxBytes = options.maxBytes ?? 1_000_000
  const started = Date.now()
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false
    let aborted = false
    let settled = false
    const command = [file, ...args].join(' ')
    const child = spawn(file, args, { cwd: options.cwd, env: options.env ?? process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const append = (current: string, chunk: string): string => {
      if (current.length + chunk.length <= maxBytes) return current + chunk
      truncated = true
      return current + chunk.slice(0, Math.max(0, maxBytes - current.length))
    }
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout = append(stdout, d)))
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr = append(stderr, d)))
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, options.timeoutMs)
    const onAbort = () => {
      aborted = true
      killTree(child.pid)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const finish = (exitCode: number | null, sig: string | null, spawnError?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({ command, exitCode, signal: sig, timedOut, aborted, durationMs: Date.now() - started, stdout, stderr, truncated, ...(spawnError ? { spawnError } : {}) })
    }
    child.on('error', error => finish(null, null, error.message))
    child.on('close', (code, sig) => finish(code, sig))
    if (options.input !== undefined) child.stdin.end(options.input)
    else child.stdin.end()
  })
}

/** Keep the head and tail of long output so errors at the end survive. */
export function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.4)
  const tail = maxChars - head
  return `${text.slice(0, head)}\n…[${text.length - maxChars} characters omitted]…\n${text.slice(-tail)}`
}
