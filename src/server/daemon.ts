/**
 * Hearth daemon: the single local process that owns the task queue and the
 * inference broker, exposed over HTTP on a loopback address with a bearer
 * token. CLI invocations, the future Web GUI, and other clients (Discord bot)
 * all submit work here, so local inference is serialized across all of them.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECT_ROOT } from '../config/load.ts'
import type { HearthConfig, ModeName } from '../config/types.ts'
import { MODE_NAMES } from '../config/types.ts'
import { InferenceBroker, LeaseWaitError } from '../queue/broker.ts'
import { TaskQueue, type Executor } from '../queue/task-queue.ts'
import { TaskStore, type TaskRecord } from '../queue/task-store.ts'
import { runTask, type RunEvent } from '../runner/dsh-runner.ts'
import { isInside, realpathLenient } from '../security/paths.ts'
import { browserRequestProblem, GuiSessions, parseCookies, SESSION_COOKIE, sessionCookie } from './gui-auth.ts'
import { ResourceSampler } from './resources.ts'
import { CatalogError, ModelCatalog, type ModelFetcher } from '../providers/catalog.ts'
import { applySettings, currentSettings, EDITABLE_KEYS, SettingsError } from './settings.ts'
import { saveUpload, UploadTooLargeError } from './uploads.ts'

const WEB_DIR = fileURLToPath(new URL('../../web/', import.meta.url))
const STATIC_FILES: Record<string, string> = { '/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css', '/favicon.svg': 'favicon.svg' }
const CONTENT_TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' }
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
}

export interface ConversationSummary {
  id: string
  title: string
  workspace: string
  mode: string
  model: string
  status: string
  updatedAt: string
  taskIds: string[]
  totalTokens: number
}

export interface DaemonInfo {
  pid: number
  url: string
  token: string
  startedAt: string
}

export function daemonInfoFile(config: HearthConfig): string {
  return join(config.stateDir, 'daemon.json')
}

export function readDaemonInfo(config: HearthConfig): DaemonInfo | undefined {
  const file = daemonInfoFile(config)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as DaemonInfo
  } catch {
    return undefined
  }
}

class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'TOO_LARGE', 'request body too large')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object')
    return v as Record<string, unknown>
  } catch (error) {
    throw new HttpError(400, 'BAD_JSON', `invalid JSON body: ${(error as Error).message}`)
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export interface DaemonOptions {
  config: HearthConfig
  /** Port override (0 = ephemeral, used by tests). */
  port?: number
  /** Replace the DSH runner (tests). */
  executor?: Executor
  /** Write daemon.json for client discovery (default true). */
  writeInfo?: boolean
  /** Extra child environment (tests). */
  childEnv?: NodeJS.ProcessEnv
  /** Replace model discovery (tests). */
  modelFetcher?: ModelFetcher
  /** Called when an authorized client requests shutdown. */
  onShutdown?: () => void
}

export class HearthDaemon {
  config: HearthConfig
  readonly broker: InferenceBroker
  readonly queue: TaskQueue
  readonly store: TaskStore
  readonly token = randomBytes(32).toString('hex')
  private server?: Server
  private url = ''
  private readonly options: DaemonOptions
  private readonly followers = new Map<string, Set<ServerResponse>>()
  readonly gui = new GuiSessions()
  readonly catalog: ModelCatalog
  private readonly resources = new ResourceSampler()
  private port = 0

  constructor(options: DaemonOptions) {
    this.options = options
    this.config = options.config
    mkdirSync(this.config.stateDir, { recursive: true })
    this.broker = new InferenceBroker({
      maxConcurrent: this.config.queue.maxConcurrentInference,
      leaseTtlMs: this.config.queue.leaseTtlMs,
      maxLeaseMs: this.config.queue.maxLeaseMs,
      waitTimeoutMs: this.config.queue.leaseWaitTimeoutMs,
    })
    this.store = new TaskStore(this.config.stateDir)
    this.catalog = new ModelCatalog(this.config, options.modelFetcher)
    const executor: Executor =
      options.executor ??
      ((task, signal, onEvent) =>
        runTask({ config: this.config, task, brokerURL: this.url, brokerToken: this.token, signal, onEvent, env: options.childEnv }).finally(() => {
          // The child is gone: nothing it held may keep a slot.
          this.broker.releaseTask(task.id)
        }))
    this.queue = new TaskQueue(this.store, executor, this.config.queue.maxConcurrentTasks)
    this.queue.onChange((task, event) => this.fanOut(task, event))
  }

  get baseURL(): string {
    return this.url
  }

  private fanOut(task: TaskRecord, event?: RunEvent): void {
    const subs = this.followers.get(task.id)
    if (!subs) return
    const line = `${JSON.stringify(event ? { type: 'event', event } : { type: 'task', task })}\n`
    for (const res of subs) res.write(line)
    if (!event && TaskQueue.isTerminal(task)) {
      for (const res of subs) res.end()
      this.followers.delete(task.id)
    }
  }

  private bearer(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? ''
    const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
    const expected = Buffer.from(this.token)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }

  /** Bearer token (CLI, plugins) or a GUI session cookie with browser checks. */
  private authenticate(req: IncomingMessage): 'bearer' | 'cookie' {
    if (this.bearer(req)) return 'bearer'
    const session = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (this.gui.valid(session)) {
      const problem = browserRequestProblem(req, this.port)
      if (problem) throw new HttpError(403, 'FORBIDDEN', problem)
      return 'cookie'
    }
    throw new HttpError(401, 'UNAUTHORIZED', 'missing or invalid credentials (run "hearth gui" to open the GUI)')
  }

  private serveStatic(path: string, res: ServerResponse): boolean {
    const file = STATIC_FILES[path]
    if (!file) return false
    const full = join(WEB_DIR, file)
    if (!existsSync(full)) return false
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY_HEADERS })
    res.end(readFileSync(full))
    return true
  }

  /** Group tasks into conversations (a root task plus its resumes). */
  conversations(includeBench = false): ConversationSummary[] {
    // Benchmark runs are machine-generated; keep them out of the chat history unless asked.
    const tasks = this.queue.list().filter(t => includeBench || t.source !== 'bench')
    const byId = new Map(tasks.map(t => [t.id, t]))
    const rootOf = (t: TaskRecord): string => {
      if (t.conversationId) return t.conversationId
      let cur = t
      for (let i = 0; i < 1000 && cur.resumeOf && byId.has(cur.resumeOf); i++) cur = byId.get(cur.resumeOf)!
      return cur.id
    }
    const groups = new Map<string, TaskRecord[]>()
    for (const t of tasks) {
      const key = rootOf(t)
      const list = groups.get(key) ?? []
      list.push(t)
      groups.set(key, list)
    }
    return [...groups.entries()]
      .map(([id, list]) => {
        const last = list[list.length - 1]!
        return {
          id,
          title: list[0]!.prompt.replace(/\s+/g, ' ').slice(0, 80),
          workspace: last.workspace,
          mode: last.mode,
          model: `${last.provider}/${last.model}`,
          status: last.status,
          updatedAt: last.finishedAt ?? last.startedAt ?? last.createdAt,
          taskIds: list.map(t => t.id),
          totalTokens: list.reduce((n, t) => n + (t.metrics?.totalTokens ?? 0), 0),
        }
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  private async waitTerminal(id: string, timeoutMs: number): Promise<TaskRecord> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const t = this.queue.get(id)
      if (!t) throw new HttpError(404, 'NOT_FOUND', `task ${id} not found`)
      if (TaskQueue.isTerminal(t)) return t
      if (Date.now() > deadline) throw new HttpError(504, 'STOP_TIMEOUT', `task ${id} did not stop within ${timeoutMs} ms`)
      await new Promise(r => setTimeout(r, 200))
    }
  }

  private settingsFile(): string {
    return this.config.sourcePath ?? join(PROJECT_ROOT, 'hearth.yaml')
  }

  private resolveWorkspace(requested: unknown): string {
    const ws = realpathLenient(resolve(typeof requested === 'string' && requested ? requested : this.config.defaultWorkspace))
    if (!existsSync(ws) || !statSync(ws).isDirectory()) throw new HttpError(400, 'BAD_WORKSPACE', `workspace does not exist or is not a directory: ${ws}`)
    const roots = this.config.security.allowedWorkspaceRoots.length ? this.config.security.allowedWorkspaceRoots : [this.config.defaultWorkspace]
    if (!roots.some(r => isInside(realpathLenient(r), ws))) {
      throw new HttpError(403, 'WORKSPACE_NOT_ALLOWED', `workspace ${ws} is outside security.allowedWorkspaceRoots (${roots.join(', ')})`)
    }
    const state = realpathLenient(this.config.stateDir)
    if (isInside(state, ws)) throw new HttpError(403, 'WORKSPACE_NOT_ALLOWED', 'the Hearth state directory (or a folder inside it) cannot be a workspace')
    return ws
  }

  /** Resolve a "<provider>/<model|auto>" choice (or the default) to a concrete, currently usable model. */
  private async resolveModel(choice: unknown): Promise<{ provider: string; model: string }> {
    let provider = this.config.defaultModel.provider
    let model = this.config.defaultModel.model
    if (typeof choice === 'string' && choice) {
      const slash = choice.indexOf('/')
      if (slash <= 0) throw new HttpError(400, 'BAD_MODEL', 'model must be "<provider>/<model-id>" or "<provider>/auto"')
      provider = choice.slice(0, slash)
      model = choice.slice(slash + 1)
    }
    try {
      return { provider, model: await this.catalog.resolve(provider, model) }
    } catch (error) {
      if (error instanceof CatalogError) throw new HttpError(error.code === 'MODEL_NOT_LOADED' ? 409 : 400, error.code, error.message)
      throw error
    }
  }

  private async submission(body: Record<string, unknown>) {
    const prompt = body.prompt
    if (typeof prompt !== 'string' || !prompt.trim()) throw new HttpError(400, 'BAD_PROMPT', 'prompt must be a non-empty string')
    const mode = (body.mode ?? this.config.defaultMode) as ModeName
    if (!MODE_NAMES.includes(mode)) throw new HttpError(400, 'BAD_MODE', `mode must be one of ${MODE_NAMES.join(', ')}`)
    const { provider, model } = await this.resolveModel(body.model)
    let verifyCommands: string[] | undefined
    if (body.verify !== undefined) {
      if (!Array.isArray(body.verify) || body.verify.some(c => typeof c !== 'string' || !c.trim())) throw new HttpError(400, 'BAD_VERIFY', 'verify must be a list of non-empty command strings')
      verifyCommands = body.verify as string[]
    }
    // A fresh task may join an existing conversation (e.g. when its last task never opened a session to resume).
    let conversationId: string | undefined
    if (typeof body.conversationId === 'string' && body.conversationId) {
      if (!this.queue.list().some(t => (t.conversationId ?? t.id) === body.conversationId)) throw new HttpError(400, 'BAD_CONVERSATION', `conversation ${body.conversationId} not found`)
      conversationId = body.conversationId
    }
    return { prompt, mode, provider, model, workspace: this.resolveWorkspace(body.workspace), source: typeof body.source === 'string' ? body.source.slice(0, 64) : 'api', ...(verifyCommands ? { verifyCommands } : {}), ...(conversationId ? { conversationId } : {}) }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    if (req.method === 'GET' && path === '/v1/health') return send(res, 200, { ok: true, pid: process.pid })
    if (req.method === 'GET' && this.serveStatic(path, res)) return
    if (req.method === 'GET' && path === '/login') {
      const session = this.gui.redeem(url.searchParams.get('code') ?? '')
      if (!session) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS })
        res.end('This login link is invalid or expired. Run "hearth gui" again.')
        return
      }
      res.writeHead(302, { location: '/', 'set-cookie': sessionCookie(session, Math.floor(this.gui.sessionTtlMs / 1000)), ...SECURITY_HEADERS })
      res.end()
      return
    }
    const auth = this.authenticate(req)

    if (req.method === 'POST' && path === '/v1/gui/login-code') {
      if (auth !== 'bearer') throw new HttpError(403, 'FORBIDDEN', 'login codes are issued only to bearer-token clients')
      const code = this.gui.issueCode()
      return send(res, 200, { code, url: `${this.url}/login?code=${encodeURIComponent(code)}`, expiresInMs: this.gui.codeTtlMs })
    }
    if (req.method === 'POST' && path === '/v1/logout') {
      const session = parseCookies(req.headers.cookie)[SESSION_COOKIE]
      if (session) this.gui.revoke(session)
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': sessionCookie('', 0) })
      res.end('{"ok":true}')
      return
    }
    if (req.method === 'GET' && path === '/v1/models') {
      if (url.searchParams.get('refresh') === '1') await this.catalog.refresh()
      const auto = Object.values(this.config.providers)
        .filter(p => p.discoverModels || p.models.length > 0)
        .map(p => ({ id: `${p.name}/auto`, name: `自動（${p.displayName} で読み込み中のモデル）`, provider: p.name, auto: true }))
      return send(res, 200, {
        default: `${this.config.defaultModel.provider}/${this.config.defaultModel.model}`,
        auto,
        models: this.catalog.list(),
        discovery: this.catalog.status(),
      })
    }
    if (req.method === 'GET' && path === '/v1/modes') {
      return send(res, 200, { default: this.config.defaultMode, modes: MODE_NAMES.map(n => ({ ...this.config.modes[n] })) })
    }
    if (req.method === 'GET' && path === '/v1/workspaces') {
      const recent = [...new Set(this.queue.list().reverse().map(t => t.workspace))].slice(0, 10)
      return send(res, 200, { default: this.config.defaultWorkspace, allowedRoots: this.config.security.allowedWorkspaceRoots.length ? this.config.security.allowedWorkspaceRoots : [this.config.defaultWorkspace], recent })
    }
    if (req.method === 'GET' && path === '/v1/resources') return send(res, 200, await this.resources.sample())
    if (req.method === 'GET' && path === '/v1/conversations') return send(res, 200, { conversations: this.conversations(url.searchParams.get('all') === '1') })
    const convMatch = /^\/v1\/conversations\/([A-Za-z0-9_-]+)$/.exec(path)
    if (req.method === 'GET' && convMatch) {
      const conv = this.conversations(true).find(c => c.id === convMatch[1])
      if (!conv) throw new HttpError(404, 'NOT_FOUND', `conversation ${convMatch[1]} not found`)
      return send(res, 200, { conversation: conv, tasks: conv.taskIds.map(id => this.queue.get(id)).filter(Boolean) })
    }
    if (path === '/v1/settings' && req.method === 'GET') {
      return send(res, 200, { file: this.settingsFile(), editable: EDITABLE_KEYS, values: currentSettings(this.config) })
    }
    if (path === '/v1/settings' && req.method === 'PATCH') {
      const body = await readJson(req)
      let next: HearthConfig
      try {
        next = applySettings(this.config, body, this.settingsFile())
      } catch (error) {
        if (error instanceof SettingsError) throw new HttpError(400, 'BAD_SETTINGS', error.message)
        throw error
      }
      // Apply live: tasks started from now on read these values.
      this.config.defaultMode = next.defaultMode
      this.config.defaultModel = next.defaultModel
      this.config.web = next.web
      this.config.security.deleteMode = next.security.deleteMode
      this.config.queue.maxConcurrentTasks = next.queue.maxConcurrentTasks
      this.config.queue.maxConcurrentInference = next.queue.maxConcurrentInference
      this.config.sourcePath = next.sourcePath
      this.queue.setMaxConcurrent(next.queue.maxConcurrentTasks)
      this.broker.setMaxConcurrent(next.queue.maxConcurrentInference)
      return send(res, 200, { file: this.settingsFile(), values: currentSettings(this.config) })
    }
    if (req.method === 'POST' && path === '/v1/uploads') {
      const workspace = this.resolveWorkspace(url.searchParams.get('workspace') ?? undefined)
      const name = url.searchParams.get('name') ?? ''
      if (!name.trim()) throw new HttpError(400, 'BAD_NAME', 'name query parameter is required')
      if (Number(req.headers['content-length'] ?? 0) > this.config.daemon.maxUploadBytes) throw new HttpError(413, 'TOO_LARGE', `file exceeds ${this.config.daemon.maxUploadBytes} bytes`)
      try {
        const saved = await saveUpload(req, workspace, name, this.config.daemon.maxUploadBytes)
        return send(res, 201, { workspace, ...saved })
      } catch (error) {
        if (error instanceof UploadTooLargeError) throw new HttpError(413, 'TOO_LARGE', error.message)
        throw error
      }
    }

    if (req.method === 'GET' && path === '/v1/status') {
      const tasks = this.queue.list()
      const counts: Record<string, number> = {}
      for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1
      return send(res, 200, { pid: process.pid, inference: this.broker.snapshot(), queue: this.queue.stats(), counts })
    }

    if (req.method === 'POST' && path === '/v1/shutdown') {
      send(res, 202, { stopping: true })
      setImmediate(() => this.options.onShutdown?.())
      return
    }

    // --- inference leases (used by the inference-gate plugin) ---
    if (req.method === 'POST' && path === '/v1/leases') {
      const body = await readJson(req)
      const controller = new AbortController()
      res.on('close', () => controller.abort())
      try {
        const lease = await this.broker.acquire({ taskId: String(body.taskId ?? 'unknown'), holder: String(body.holder ?? 'unknown'), purpose: typeof body.purpose === 'string' ? body.purpose : undefined }, controller.signal)
        if (controller.signal.aborted || res.destroyed) {
          this.broker.release(lease.id)
          return
        }
        return send(res, 200, { leaseId: lease.id, ttlMs: this.config.queue.leaseTtlMs })
      } catch (error) {
        if (error instanceof LeaseWaitError) throw new HttpError(error.code === 'WAIT_TIMEOUT' ? 503 : 409, error.code, error.message)
        throw error
      }
    }
    const leaseMatch = /^\/v1\/leases\/([0-9a-f-]+)(\/heartbeat)?$/.exec(path)
    if (leaseMatch) {
      const id = leaseMatch[1]!
      if (req.method === 'POST' && leaseMatch[2]) return this.broker.heartbeat(id) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'lease not found', code: 'LEASE_GONE' })
      if (req.method === 'DELETE' && !leaseMatch[2]) return send(res, 200, { released: this.broker.release(id) })
    }

    // --- tasks ---
    if (req.method === 'POST' && path === '/v1/tasks') {
      const task = this.queue.submit(await this.submission(await readJson(req)))
      return send(res, 201, { task, position: this.queue.position(task.id) })
    }
    if (req.method === 'GET' && path === '/v1/tasks') return send(res, 200, { tasks: this.queue.list() })
    const taskMatch = /^\/v1\/tasks\/([A-Za-z0-9_-]+)(\/(cancel|resume|events))?$/.exec(path)
    if (taskMatch) {
      const id = taskMatch[1]!
      const action = taskMatch[3]
      const task = this.queue.get(id)
      if (!task) throw new HttpError(404, 'NOT_FOUND', `task ${id} not found`)
      if (req.method === 'GET' && !action) return send(res, 200, { task, position: this.queue.position(id) })
      if (req.method === 'POST' && action === 'cancel') return send(res, 200, { cancelled: this.queue.cancel(id) })
      if (req.method === 'POST' && action === 'resume') {
        const body = await readJson(req)
        const mode = (body.mode as ModeName | undefined) ?? task.mode
        if (!MODE_NAMES.includes(mode)) throw new HttpError(400, 'BAD_MODE', `mode must be one of ${MODE_NAMES.join(', ')}`)
        // Model switch: resolve before touching the running task, so a bad choice changes nothing.
        // Without a new choice the conversation keeps its model; check it is still loaded so the
        // failure is immediate and explains how to continue (pick another model or <provider>/auto).
        const target = await this.resolveModel(typeof body.model === 'string' && body.model ? body.model : `${task.provider}/${task.model}`)
        let base = task
        if (!TaskQueue.isTerminal(task)) {
          if (body.interrupt !== true) throw new HttpError(409, 'NOT_FINISHED', `task ${id} is still ${task.status} (pass interrupt: true to stop it and continue)`)
          this.queue.cancel(id)
          base = await this.waitTerminal(id, 60_000)
        }
        if (!base.sessionId) throw new HttpError(409, 'NO_SESSION', `task ${id} never opened a DSH session, so it cannot be resumed; submit it again`)
        const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt : 'Continue the task from where it stopped. Check the current state of the workspace first, then finish the remaining work and verify it.'
        const next = this.queue.submit({ prompt, mode, provider: target.provider, model: target.model, workspace: base.workspace, source: base.source, sessionId: base.sessionId, resumeOf: base.id, conversationId: base.conversationId ?? base.id, ...(base.verifyCommands ? { verifyCommands: base.verifyCommands } : {}) })
        return send(res, 201, { task: next, position: this.queue.position(next.id), switchedModel: target.provider !== task.provider || target.model !== task.model })
      }
      if (req.method === 'GET' && action === 'events') return this.streamEvents(task, url.searchParams.get('follow') === '1', res)
    }
    throw new HttpError(404, 'NOT_FOUND', `no route for ${req.method} ${path}`)
  }

  private streamEvents(task: TaskRecord, follow: boolean, res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' })
    const file = join(this.config.stateDir, 'runs', task.id, 'events.jsonl')
    const live = follow && !TaskQueue.isTerminal(task)
    if (live) {
      let set = this.followers.get(task.id)
      if (!set) this.followers.set(task.id, (set = new Set()))
      set.add(res)
      res.on('close', () => set!.delete(res))
      res.write(`${JSON.stringify({ type: 'task', task })}\n`)
      return
    }
    const finish = () => {
      res.write(`${JSON.stringify({ type: 'task', task: this.queue.get(task.id) ?? task })}\n`)
      res.end()
    }
    if (!existsSync(file)) return finish()
    const stream = createReadStream(file, 'utf8')
    let buffer = ''
    stream.on('data', chunk => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) res.write(`${JSON.stringify({ type: 'event', event: JSON.parse(l) as unknown })}\n`)
    })
    stream.on('end', finish)
    stream.on('error', finish)
  }

  /** Start listening; returns the base URL. */
  async start(): Promise<string> {
    this.catalog.start(this.config.daemon.modelRefreshMs)
    const recovered = this.queue.recover()
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(error => {
        if (error instanceof HttpError) {
          send(res, error.status, { error: error.message, code: error.code })
          // Drain an unread request body (e.g. a refused upload) so the socket is released.
          if (!req.complete) req.resume()
        }
        else {
          process.stderr.write(`hearth daemon: ${(error as Error).stack ?? String(error)}\n`)
          send(res, 500, { error: (error as Error).message, code: 'INTERNAL' })
        }
      })
    })
    this.server.requestTimeout = 0 // lease long-polls and event follows are long-lived
    this.server.headersTimeout = 30_000
    const port = this.options.port ?? this.config.daemon.port
    await new Promise<void>((resolveListen, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(port, this.config.daemon.host, () => resolveListen())
    })
    const address = this.server.address() as AddressInfo
    this.port = address.port
    const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
    this.url = `http://${host}:${address.port}`
    if (this.options.writeInfo !== false) {
      const info: DaemonInfo = { pid: process.pid, url: this.url, token: this.token, startedAt: new Date().toISOString() }
      writeFileSync(daemonInfoFile(this.config), JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 })
    }
    if (recovered.interrupted || recovered.requeued) process.stderr.write(`hearth daemon: recovered ${recovered.interrupted} interrupted and ${recovered.requeued} queued task(s)\n`)
    return this.url
  }

  async stop(): Promise<void> {
    this.catalog.stop()
    await this.queue.shutdown()
    this.broker.close()
    for (const set of this.followers.values()) for (const res of set) res.end()
    await new Promise<void>(r => {
      if (!this.server) return r()
      this.server.closeAllConnections()
      this.server.close(() => r())
    })
    if (this.options.writeInfo !== false) {
      const info = readDaemonInfo(this.config)
      if (info?.pid === process.pid) rmSync(daemonInfoFile(this.config), { force: true })
    }
  }
}
