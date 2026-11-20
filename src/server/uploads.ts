/**
 * File attachments from the GUI. Uploads are written into
 * `<workspace>/attachments/` with a sanitized, collision-free file name and a
 * size limit; the model then reads them like any workspace file.
 */
import { createWriteStream, existsSync, mkdirSync, rmSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import { extname, join } from 'node:path'

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

/** Make an uploaded file name safe for Windows and free of path components. */
export function sanitizeFileName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? ''
  let name = base
    .replace(/[\x00-\x1f<>:"|?*]/g, '_')
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, 120)
  const stem = name.replace(/\.[^.]*$/, '')
  if (!name || RESERVED.test(stem)) name = `file_${name || 'upload'}`
  return name
}

function uniquePath(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return join(dir, name)
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; i < 10_000; i++) {
    const candidate = join(dir, `${stem}-${i}${ext}`)
    if (!existsSync(candidate)) return candidate
  }
  throw new Error('too many files with the same name')
}

export class UploadTooLargeError extends Error {}

/**
 * Stream a request body into the workspace attachments folder.
 * @param req - request whose body is the raw file content.
 * @param workspace - validated workspace root.
 * @param fileName - client-supplied name.
 * @param maxBytes - size limit.
 * @returns workspace-relative path and size.
 */
export async function saveUpload(req: IncomingMessage, workspace: string, fileName: string, maxBytes: number): Promise<{ path: string; bytes: number }> {
  const dir = join(workspace, 'attachments')
  mkdirSync(dir, { recursive: true })
  const target = uniquePath(dir, sanitizeFileName(fileName))
  const out = createWriteStream(target, { flags: 'wx' })
  let bytes = 0
  try {
    for await (const chunk of req) {
      bytes += (chunk as Buffer).length
      if (bytes > maxBytes) throw new UploadTooLargeError(`file exceeds ${maxBytes} bytes`)
      if (!out.write(chunk)) await new Promise<void>(r => out.once('drain', () => r()))
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())))
  } catch (error) {
    out.destroy()
    rmSync(target, { force: true })
    throw error
  }
  return { path: `attachments/${target.slice(dir.length + 1)}`, bytes }
}
