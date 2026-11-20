/**
 * Workspace path containment checks.
 *
 * Resolution is done on the real filesystem: the longest existing ancestor of
 * the requested path is passed through `realpath`, so symbolic links,
 * junctions, `..` segments, and 8.3 short names cannot point a write outside
 * the workspace. Windows-specific escape forms (UNC, device namespace,
 * alternate data streams, reserved device names) are rejected up front.
 *
 * Known limitation: hard links share a file object and cannot be detected by
 * path inspection; DSH's ACL sandbox remains the enforcing layer for spawned
 * processes.
 */
import { realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type PathVerdict =
  | { ok: true; absolute: string; real: string; relative: string }
  | { ok: false; reason: string }

const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i
const isWindows = process.platform === 'win32'

function norm(p: string): string {
  return isWindows ? p.toLowerCase() : p
}

/** Real path of `target`, resolving the longest existing ancestor. */
export function realpathLenient(target: string): string {
  const tail: string[] = []
  let current = target
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return tail.length ? join(real, ...tail.reverse()) : real
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(current)
      if (parent === current) return target
      tail.push(basename(current))
      current = parent
    }
  }
}

/** Whether `child` equals or lies inside `parent` (both real, absolute). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(norm(parent), norm(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Validate a path requested by a tool.
 * @param workspace - the task workspace root.
 * @param requested - the path as given by the model (relative or absolute).
 * @returns a verdict with the resolved real path when allowed.
 */
export function checkWorkspacePath(workspace: string, requested: string): PathVerdict {
  if (typeof requested !== 'string' || requested.length === 0) return { ok: false, reason: 'empty path' }
  if (requested.includes('\0')) return { ok: false, reason: 'path contains a NUL character' }
  if (isWindows) {
    if (/^[\\/]{2}/.test(requested)) return { ok: false, reason: 'UNC and device-namespace paths (\\\\server, \\\\?\\, \\\\.\\) are not allowed' }
    const withoutDrive = requested.replace(/^[A-Za-z]:/, '')
    if (withoutDrive.includes(':')) return { ok: false, reason: 'alternate data streams (":" in a path) are not allowed' }
    for (const segment of requested.split(/[\\/]/)) {
      if (RESERVED.test(segment.replace(/[ .]+$/, ''))) return { ok: false, reason: `reserved device name "${segment}" is not allowed` }
    }
  }
  const realWorkspace = realpathLenient(resolve(workspace))
  const absolute = resolve(workspace, requested)
  let real: string
  try {
    real = realpathLenient(absolute)
  } catch (error) {
    return { ok: false, reason: `cannot resolve path: ${(error as Error).message}` }
  }
  if (!isInside(realWorkspace, real)) {
    return { ok: false, reason: `path resolves outside the workspace (${real} is not under ${realWorkspace})` }
  }
  return { ok: true, absolute, real, relative: relative(realWorkspace, real).split(sep).join('/') }
}

/** Compile a glob (`**`, `*`, `?`) into a case-insensitive regular expression. */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          re += '(?:.*/)?'
        } else re += '.*'
      } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else if ('\\^$+.()|{}[]'.includes(c)) re += `\\${c}`
    else re += c
  }
  return new RegExp(`^${re}$`, isWindows ? 'i' : '')
}

/**
 * Check a workspace-relative path against protected patterns.
 * @param relativePath - forward-slash path relative to the workspace.
 * @param patterns - glob patterns.
 * @returns the first matching pattern, if any.
 */
export function matchProtected(relativePath: string, patterns: readonly string[]): string | undefined {
  const p = relativePath.replace(/\\/g, '/')
  return patterns.find(pattern => {
    const re = globToRegExp(pattern)
    // A directory pattern like `.git/**` also protects the directory itself.
    return re.test(p) || (pattern.endsWith('/**') && globToRegExp(pattern.slice(0, -3)).test(p))
  })
}
