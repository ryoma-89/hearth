/**
 * Scripted OpenAI-compatible Chat Completions server for keyless tests.
 *
 * Each request is answered by the step whose index equals the number of
 * assistant messages already present in the request history, so a scenario
 * is replayed deterministically per session. The server records every
 * request and the peak number of concurrent in-flight requests so tests can
 * assert queue behavior.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface MockToolCall {
  name: string
  /** Raw argument text sent on the wire; may be deliberately malformed. */
  arguments: string
}

export interface MockStep {
  content?: string
  reasoning?: string
  toolCalls?: MockToolCall[]
  /** Milliseconds to wait before answering. */
  delayMs?: number
  /** Respond with this HTTP status and an error body instead of a completion. */
  httpError?: number
  /** Close the socket mid-stream after the first chunk. */
  dropConnection?: boolean
}

export type Scenario = MockStep[] | ((request: ChatRequest, index: number) => MockStep)

export interface ChatRequest {
  model: string
  messages: Array<{ role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string }>
  tools?: Array<{ type: string; function: { name: string } }>
  stream?: boolean
  [key: string]: unknown
}

export interface MockServer {
  baseURL: string
  requests: ChatRequest[]
  peakConcurrency: number
  /** Models reported by GET /v1/models (tests change this to simulate loading another model). */
  servedModels?: string[]
  close(): Promise<void>
}

export interface MockOptions {
  scenario: Scenario
  apiKey?: string
  port?: number
  modelId?: string
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function pickStep(scenario: Scenario, request: ChatRequest): MockStep {
  const index = request.messages.filter(m => m.role === 'assistant').length
  if (typeof scenario === 'function') return scenario(request, index)
  return scenario[index] ?? { content: 'Scenario exhausted; finishing.' }
}

function estimateTokens(value: unknown): number {
  return Math.ceil(JSON.stringify(value ?? '').length / 4)
}

let callCounter = 0

function sendStream(res: ServerResponse, model: string, step: MockStep, promptTokens: number): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  const id = `chatcmpl-mock-${++callCounter}`
  const created = Math.floor(Date.now() / 1000)
  const send = (delta: Record<string, unknown>, finish: string | null = null) => {
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`)
  }
  send({ role: 'assistant', content: '' })
  if (step.dropConnection) {
    res.socket?.destroy()
    return
  }
  if (step.reasoning) send({ reasoning_content: step.reasoning })
  if (step.content) {
    for (const piece of step.content.match(/.{1,40}/gs) ?? []) send({ content: piece })
  }
  step.toolCalls?.forEach((call, i) => {
    const callId = `call_${callCounter}_${i}`
    send({ tool_calls: [{ index: i, id: callId, type: 'function', function: { name: call.name, arguments: '' } }] })
    for (const piece of call.arguments.match(/.{1,30}/gs) ?? ['']) {
      send({ tool_calls: [{ index: i, function: { arguments: piece } }] })
    }
  })
  const completionTokens = estimateTokens(step.content) + estimateTokens(step.toolCalls)
  send({}, step.toolCalls?.length ? 'tool_calls' : 'stop')
  res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens } })}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function sendJson(res: ServerResponse, model: string, step: MockStep, promptTokens: number): void {
  const completionTokens = estimateTokens(step.content) + estimateTokens(step.toolCalls)
  const message: Record<string, unknown> = { role: 'assistant', content: step.content ?? null }
  if (step.toolCalls?.length) {
    message.tool_calls = step.toolCalls.map((c, i) => ({ id: `call_${++callCounter}_${i}`, type: 'function', function: { name: c.name, arguments: c.arguments } }))
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({
    id: `chatcmpl-mock-${++callCounter}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: step.toolCalls?.length ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  }))
}

/**
 * Start a mock server on 127.0.0.1.
 * @param options - scenario, optional bearer key, port, and advertised model id.
 * @returns the running server handle.
 */
export async function startMockOpenAI(options: MockOptions): Promise<MockServer> {
  const modelId = options.modelId ?? 'mock-model'
  let inFlight = 0
  const state: MockServer = {
    baseURL: '',
    requests: [],
    peakConcurrency: 0,
    close: async () => {},
  }
  const server: Server = createServer(async (req, res) => {
    if (options.apiKey && req.headers.authorization !== `Bearer ${options.apiKey}`) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'authentication_error', message: 'missing or wrong API key' } }))
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (req.method === 'GET' && url.pathname === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: (state.servedModels ?? [modelId]).map(id => ({ id, object: 'model', owned_by: 'mock' })) }))
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
      inFlight++
      state.peakConcurrency = Math.max(state.peakConcurrency, inFlight)
      try {
        const request = JSON.parse(await readBody(req)) as ChatRequest
        state.requests.push(request)
        const step = pickStep(options.scenario, request)
        if (step.delayMs) await new Promise(r => setTimeout(r, step.delayMs))
        if (step.httpError) {
          res.writeHead(step.httpError, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { type: 'server_error', message: `mock failure ${step.httpError}` } }))
          return
        }
        const promptTokens = estimateTokens(request.messages)
        if (request.stream) sendStream(res, request.model, step, promptTokens)
        else sendJson(res, request.model, step, promptTokens)
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'mock_error', message: String(error) } }))
      } finally {
        inFlight--
      }
      return
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(resolve => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  state.baseURL = `http://127.0.0.1:${port}/v1`
  state.close = () => new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
  return state
}
