/**
 * Browser authentication for the Web GUI.
 *
 * The daemon token never appears in a URL. `hearth gui` asks the daemon (with
 * the bearer token) for a one-time login code valid for 60 seconds and opens
 * `/login?code=...`; the daemon exchanges it for an HttpOnly, SameSite=Strict
 * session cookie. Cookie-authenticated requests must also
 *  - target a loopback Host on the daemon's port (DNS-rebinding defense), and
 *  - for state-changing methods, carry `x-hearth-csrf: 1` and, when the
 *    browser sends one, a same-origin `Origin` header (CSRF defense).
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export const SESSION_COOKIE = 'hearth_session'

export class GuiSessions {
  private readonly codes = new Map<string, number>()
  private readonly sessions = new Map<string, number>()
  readonly sessionTtlMs: number
  readonly codeTtlMs: number

  constructor(sessionTtlMs = 12 * 60 * 60_000, codeTtlMs = 60_000) {
    this.sessionTtlMs = sessionTtlMs
    this.codeTtlMs = codeTtlMs
  }

  issueCode(now = Date.now()): string {
    const code = randomBytes(24).toString('base64url')
    this.codes.set(code, now + this.codeTtlMs)
    return code
  }

  /** Exchange a code (once) for a session id. */
  redeem(code: string, now = Date.now()): string | undefined {
    const expiry = this.codes.get(code)
    this.codes.delete(code)
    if (!expiry || expiry < now) return undefined
    const id = randomBytes(32).toString('base64url')
    this.sessions.set(id, now + this.sessionTtlMs)
    return id
  }

  valid(id: string | undefined, now = Date.now()): boolean {
    if (!id) return false
    const expiry = this.sessions.get(id)
    if (!expiry) return false
    if (expiry < now) {
      this.sessions.delete(id)
      return false
    }
    return true
  }

  revoke(id: string): void {
    this.sessions.delete(id)
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Whether a Host / Origin authority names this daemon on a loopback address. */
export function isLocalAuthority(authority: string | undefined, port: number): boolean {
  if (!authority) return false
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(authority.toLowerCase())
  if (!m) return false
  return LOOPBACK_HOSTS.has(m[1]!) && Number(m[2] ?? 80) === port
}

/**
 * Check a cookie-authenticated browser request.
 * @returns undefined when acceptable, else the reason it is refused.
 */
export function browserRequestProblem(req: IncomingMessage, port: number): string | undefined {
  if (!isLocalAuthority(req.headers.host, port)) return 'Host header is not this daemon on a loopback address'
  const method = req.method ?? 'GET'
  if (method === 'GET' || method === 'HEAD') return undefined
  if (req.headers['x-hearth-csrf'] !== '1') return 'missing x-hearth-csrf header'
  const origin = req.headers.origin
  if (origin) {
    try {
      if (!isLocalAuthority(new URL(origin).host, port)) return 'cross-origin request refused'
    } catch {
      return 'invalid Origin header'
    }
  }
  return undefined
}

export function sessionCookie(id: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`
}
