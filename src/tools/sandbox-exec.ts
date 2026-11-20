/**
 * Spawn processes through DSH's sandbox service (`ctx.sandbox.confine`).
 * Shared by Hearth tools and the verifier so both run under the same policy.
 */
import { runProcess, type RunResult } from './process.ts'

export interface SandboxLike {
  confine(argv: string[], policy: { mode: string; workspaceRoot: string; sessionId?: string }, signal?: AbortSignal): Promise<{ argv: string[] }>
}

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface ExecContext {
  signal?: AbortSignal
  sessionId?: string
}

export type Exec = (argv: string[], cwd: string, timeoutMs: number, run: ExecContext, input?: string) => Promise<RunResult>

/**
 * Build an executor bound to one sandbox policy.
 * @param sandbox - the DSH sandbox service (may be absent).
 * @param mode - configured sandbox mode.
 * @param workspace - the workspace root writes are confined to.
 * @returns an exec function; it fails closed when confinement is required but unavailable.
 */
export function createSandboxExec(sandbox: SandboxLike | undefined, mode: SandboxMode, workspace: string): Exec {
  return async (argv, cwd, timeoutMs, run, input) => {
    let finalArgv = argv
    if (mode !== 'danger-full-access') {
      if (!sandbox) throw new Error('DSH sandbox service is not available; refusing to run unconfined (set security.sandbox to danger-full-access to opt out).')
      const confined = await sandbox.confine(argv, { mode, workspaceRoot: workspace, sessionId: run.sessionId }, run.signal)
      finalArgv = confined.argv
    }
    return runProcess(finalArgv[0]!, finalArgv.slice(1), {
      cwd,
      timeoutMs,
      signal: run.signal,
      input,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
  }
}
