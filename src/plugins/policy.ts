/**
 * DSH plugin: Hearth's execution policy and audit log.
 *
 * Runs on the `tools/pre-execute` waterfall before DSH's own approval and
 * sandbox layers:
 *  - file tools: every path argument must resolve (through symlinks and
 *    junctions) inside the workspace; protected paths may not be written;
 *    overwriting existing files can be disabled;
 *  - shell tools: commands are classified by AST; dangerous ones are denied
 *    unless the configuration explicitly allows them (headless runs have
 *    nobody to approve, so "ask" becomes "deny" — never silent execution);
 *  - unknown tools in the mode's deny list are refused.
 * Every decision and every tool result is appended to an audit JSONL file.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { BackupStore } from '../security/backup.ts'
import { baseName, classifyPosixShell, classifyPowerShell, DELETE_COMMANDS, type CommandPolicyOptions, type ParsedCommand } from '../security/command-policy.ts'
import { checkWorkspacePath, matchProtected } from '../security/paths.ts'
import { emitTelemetry } from './telemetry.ts'

export const name = 'hearth-policy'

export interface Config {
  workspace: string
  auditLog: string
  protectedPaths: string[]
  allowOverwrite: boolean
  allowDangerousCommands: boolean
  extraDangerousCommands: string[]
  trustedCommands: string[]
  deniedTools: string[]
  /** backup: copy files before delete/overwrite; deny: refuse every delete; allow: no backups. */
  deleteMode: 'backup' | 'deny' | 'allow'
  backupDir: string
  backupMaxBytes: number
}

export type Decision = { kind: 'allow'; backups?: string[] } | { kind: 'deny'; reason: string }

/** Argument flags whose value is a filter, not a target path. */
const NON_PATH_FLAGS = new Set(['-filter', '-include', '-exclude', '-erroraction', '-ea', '-stream'])

/** Literal delete targets of a lowered command, or `dynamic` when a target is computed at run time. */
export function deleteTargets(commands: readonly ParsedCommand[]): { targets: string[]; dynamic: string[] } {
  const targets: string[] = []
  const dynamic: string[] = []
  for (const c of commands) {
    if (!DELETE_COMMANDS.has(baseName(c.name))) continue
    for (let i = 0; i < c.args.length; i++) {
      const a = c.args[i]!
      if (a.startsWith('-') || (a.startsWith('/') && a.length <= 3)) {
        if (NON_PATH_FLAGS.has(a.toLowerCase())) i++
        continue
      }
      if (/[$(){}@`]/.test(a)) dynamic.push(a)
      else targets.push(a.replace(/^['"]|['"]$/g, ''))
    }
  }
  return { targets, dynamic }
}

/** Path-bearing argument keys per tool, and whether the access writes. */
const PATH_TOOLS: Record<string, { keys: string[]; write: boolean }> = {
  read: { keys: ['file_path'], write: false },
  read_image: { keys: ['file_path', 'path'], write: false },
  write: { keys: ['file_path'], write: true },
  edit: { keys: ['file_path'], write: true },
  str_replace_editor: { keys: ['path'], write: true },
  glob: { keys: ['path'], write: false },
  grep: { keys: ['path'], write: false },
  python_run: { keys: ['script_path', 'cwd'], write: false },
  latex_compile: { keys: ['tex_path'], write: false },
  pdf_inspect: { keys: ['pdf_path'], write: false },
}

/** Paths named by an apply_patch body (Add/Update/Delete/Move). */
export function patchPaths(patch: string): Array<{ path: string; op: string }> {
  const out: Array<{ path: string; op: string }> = []
  for (const m of patch.matchAll(/^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/gm)) out.push({ op: m[1]!, path: m[2]!.trim() })
  return out
}

/**
 * Decide a tool call. Pure apart from filesystem lookups and the command parser.
 * @param tool - tool name.
 * @param args - parsed tool arguments.
 * @param config - policy configuration.
 * @returns allow or deny with a model-facing reason.
 */
export async function decide(tool: string, args: Record<string, unknown>, config: Config, backups?: BackupStore, callId?: string): Promise<Decision> {
  if (config.deniedTools.includes(tool)) return { kind: 'deny', reason: `Tool ${tool} is disabled in the current Hearth mode.` }
  const saved: string[] = []
  /** Back up an existing workspace path before it changes; returns a denial when a required backup fails. */
  const preserve = (requested: string, reason: 'delete' | 'overwrite'): Decision | undefined => {
    if (!backups || config.deleteMode === 'allow') return undefined
    const verdict = checkWorkspacePath(config.workspace, requested)
    if (!verdict.ok || !existsSync(verdict.real)) return undefined
    const r = backups.backup(verdict.real, verdict.relative, { tool, callId, reason })
    if (r.backupPath) saved.push(verdict.relative)
    if (!r.ok && reason === 'delete') return { kind: 'deny', reason: `Hearth could not back up "${verdict.relative}" before deleting it (${r.reason}); the deletion was refused.` }
    if (!r.ok) emitTelemetry({ event: 'backup-skipped', tool, path: verdict.relative, reason: r.reason })
    return undefined
  }
  const allow = (): Decision => (saved.length ? { kind: 'allow', backups: saved } : { kind: 'allow' })
  const checkPath = (value: unknown, write: boolean, op = write ? 'write' : 'read'): Decision => {
    if (value === undefined || value === null || value === '') return { kind: 'allow' }
    if (typeof value !== 'string') return { kind: 'deny', reason: 'Path arguments must be strings.' }
    const verdict = checkWorkspacePath(config.workspace, value)
    if (!verdict.ok) return { kind: 'deny', reason: `Path "${value}" was refused: ${verdict.reason}. Work inside the workspace ${config.workspace}.` }
    if (write) {
      const hit = matchProtected(verdict.relative, config.protectedPaths)
      if (hit) return { kind: 'deny', reason: `"${verdict.relative}" is protected by Hearth policy (${hit}); ${op} is not allowed.` }
      if (op === 'write' && !config.allowOverwrite && existsSync(verdict.real)) {
        return { kind: 'deny', reason: `"${verdict.relative}" already exists and overwriting is disabled; use edit or choose a new file name.` }
      }
    }
    return { kind: 'allow' }
  }

  const pathSpec = PATH_TOOLS[tool]
  if (pathSpec) {
    for (const key of pathSpec.keys) {
      const d = checkPath(args[key], pathSpec.write, tool === 'write' ? 'write' : 'edit')
      if (d.kind === 'deny') return d
    }
    if (pathSpec.write) for (const key of pathSpec.keys) if (typeof args[key] === 'string') preserve(args[key], 'overwrite')
    return allow()
  }
  if (tool === 'apply_patch') {
    const paths = patchPaths(String(args.input ?? ''))
    for (const { path, op } of paths) {
      if (op === 'Delete File' && config.deleteMode === 'deny') return { kind: 'deny', reason: `Deleting files is disabled by Hearth policy (security.deleteMode: deny); "${path}" was not deleted.` }
      const d = checkPath(path, true, op === 'Delete File' ? 'deletion' : 'edit')
      if (d.kind === 'deny') return d
    }
    for (const { path, op } of paths) {
      if (op === 'Add File') continue
      const denied = preserve(path, op === 'Delete File' ? 'delete' : 'overwrite')
      if (denied) return denied
    }
    return allow()
  }
  if (tool === 'pwsh' || tool === 'bash') {
    const command = String(args.command ?? '')
    const options: CommandPolicyOptions = { extraDangerous: config.extraDangerousCommands, trusted: config.trustedCommands }
    const result = tool === 'pwsh' ? await classifyPowerShell(command, options) : classifyPosixShell(command, options)
    if (result.verdict === 'dangerous' && !config.allowDangerousCommands) {
      return {
        kind: 'deny',
        reason: `Hearth policy blocked this command because it needs explicit user approval: ${result.reasons.join('; ')}. No approver is attached to this run. Use a safer alternative inside the workspace, or report that the user must perform or approve this step.`,
      }
    }
    const { targets, dynamic } = deleteTargets(result.commands)
    if (targets.length || dynamic.length) {
      if (config.deleteMode === 'deny') return { kind: 'deny', reason: 'Deleting files is disabled by Hearth policy (security.deleteMode: deny). Leave the files in place and mention them in your report.' }
      if (config.deleteMode === 'backup') {
        if (dynamic.length) return { kind: 'deny', reason: `Hearth backs up files before deleting them, so delete targets must be literal paths (got ${dynamic.join(', ')}). Delete the files with literal paths instead.` }
        // pwsh may run in a sub-directory (workdir); relative targets resolve against it.
        const base = typeof args.workdir === 'string' && args.workdir ? args.workdir : typeof args.cwd === 'string' && args.cwd ? args.cwd : undefined
        for (const raw of targets) {
          const t = base && !isAbsolute(raw) ? resolve(isAbsolute(base) ? base : resolve(config.workspace, base), raw) : raw
          const d = checkPath(t, true, 'deletion')
          if (d.kind === 'deny') return d
          const denied = preserve(t, 'delete')
          if (denied) return denied
        }
      }
    }
    return allow()
  }
  return allow()
}

function audit(file: string, record: Record<string, unknown>): void {
  try {
    appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, 'utf8')
  } catch (error) {
    emitTelemetry({ event: 'audit-write-failed', error: String(error) })
  }
}

/** Shorten argument values for the audit log; full arguments stay in the DSH session log. */
function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(args ?? {})) {
    const s = typeof v === 'string' ? v : JSON.stringify(v)
    out[k] = s !== undefined && s.length > 300 ? `${s.slice(0, 300)}…(${s.length} chars)` : v
  }
  return out
}

/**
 * Plugin entry.
 * @param ctx - Cordis context.
 * @param config - policy configuration.
 */
export function apply(ctx: Context, config: Config): void {
  mkdirSync(dirname(config.auditLog), { recursive: true })
  const backups = new BackupStore(config.backupDir, config.backupMaxBytes)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event typing comes from DSH declaration merging
  const on = (ctx as any).on.bind(ctx)
  on('tools/pre-execute', async (exec: { name: string; callId: string; arguments: unknown }, next: () => Promise<unknown>) => {
    const args = (typeof exec.arguments === 'object' && exec.arguments !== null ? exec.arguments : {}) as Record<string, unknown>
    let decision: Decision
    try {
      decision = await decide(exec.name, args, config, backups, exec.callId)
    } catch (error) {
      decision = { kind: 'deny', reason: `Hearth policy check failed (${(error as Error).message}); the call was not executed.` }
    }
    audit(config.auditLog, { type: 'decision', tool: exec.name, callId: exec.callId, decision: decision.kind, reason: decision.kind === 'deny' ? decision.reason : undefined, backups: decision.kind === 'allow' ? decision.backups : undefined, args: summarizeArgs(args) })
    if (decision.kind === 'allow' && decision.backups?.length) emitTelemetry({ event: 'backup', tool: exec.name, callId: exec.callId, paths: decision.backups })
    if (decision.kind === 'deny') {
      emitTelemetry({ event: 'policy-denied', tool: exec.name, callId: exec.callId, reason: decision.reason })
      return { kind: 'deny', reason: decision.reason }
    }
    return next()
  })
  on('tools/result', (exec: { name: string; callId: string }, result: { isError?: boolean; error?: { message?: string; info?: { code?: string; name?: string } } }) => {
    audit(config.auditLog, { type: 'result', tool: exec.name, callId: exec.callId, isError: result?.isError === true, error: result?.error?.info?.code ?? result?.error?.info?.name, message: result?.error?.message?.slice(0, 300) })
  })
  emitTelemetry({ event: 'plugin-ready', plugin: name })
}
