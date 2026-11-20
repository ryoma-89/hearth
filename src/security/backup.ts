/**
 * Pre-change backups: before a tool deletes or overwrites workspace files,
 * Hearth copies them under the task's run directory so the change can be
 * undone by hand. A manifest (manifest.jsonl) records original and backup
 * paths. A byte quota bounds the backup size per task.
 */
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface BackupResult {
  ok: boolean
  backupPath?: string
  bytes?: number
  reason?: string
}

function sizeOf(path: string, limit: number): number {
  const st = lstatSync(path)
  if (st.isSymbolicLink()) return 0
  if (!st.isDirectory()) return st.size
  let total = 0
  for (const name of readdirSync(path)) {
    total += sizeOf(join(path, name), limit)
    if (total > limit) return total
  }
  return total
}

export class BackupStore {
  readonly dir: string
  readonly maxBytes: number
  usedBytes = 0
  private seq = 0

  constructor(dir: string, maxBytes: number) {
    this.dir = dir
    this.maxBytes = maxBytes
  }

  /**
   * Copy a file or directory into the backup area.
   * @param real - resolved absolute path inside the workspace.
   * @param relative - workspace-relative path (used for the backup layout).
   * @param meta - tool, call id, and reason for the manifest.
   * @returns whether a backup exists afterwards (missing originals count as ok: nothing to lose).
   */
  backup(real: string, relative: string, meta: { tool: string; callId?: string; reason: string }): BackupResult {
    if (!existsSync(real)) return { ok: true }
    let bytes: number
    try {
      bytes = sizeOf(real, this.maxBytes - this.usedBytes + 1)
    } catch (error) {
      return { ok: false, reason: `cannot read ${relative}: ${(error as Error).message}` }
    }
    if (this.usedBytes + bytes > this.maxBytes) {
      return { ok: false, reason: `backup quota exceeded (${this.usedBytes + bytes} > ${this.maxBytes} bytes)` }
    }
    const target = join(this.dir, String(++this.seq).padStart(4, '0'), relative.replace(/^(\.\.[\\/])+/, ''))
    try {
      mkdirSync(dirname(target), { recursive: true })
      cpSync(real, target, { recursive: true, errorOnExist: false, force: true, preserveTimestamps: true, dereference: false })
    } catch (error) {
      return { ok: false, reason: `backup of ${relative} failed: ${(error as Error).message}` }
    }
    this.usedBytes += bytes
    appendFileSync(
      join(this.dir, 'manifest.jsonl'),
      `${JSON.stringify({ ts: new Date().toISOString(), original: real, backup: target, bytes, directory: statSync(real).isDirectory(), ...meta })}\n`,
      'utf8',
    )
    return { ok: true, backupPath: target, bytes }
  }
}
