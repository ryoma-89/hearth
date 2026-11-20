/**
 * DSH plugin: task memory that survives context compaction.
 *
 *  - Archive: every durable session event is appended, uncompacted, to
 *    <stateDir>/history/<sessionId>.jsonl as it happens. Compaction replaces
 *    old history in the model's view; the archive keeps the original.
 *  - Notes: the `task_memory` tool lets the model record decisions, facts,
 *    and open items in <stateDir>/notes/<sessionId>.md, list them, and search
 *    the archive for earlier details ("what exactly did the error say?").
 *  - After every compaction the notes are injected into the next request so
 *    key decisions are not lost with the summarized history.
 * Notes and archive are keyed by DSH session id, so `hearth resume` keeps them.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import { emitTelemetry } from './telemetry.ts'

export const name = 'hearth-memory'
export const inject = { tools: { required: true } }

export interface Config {
  historyDir: string
  notesDir: string
  maxEventChars: number
  enableTool: boolean
}

interface AgentLike {
  session?: { id?: string }
}

const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_')

/** Collect human-readable text from an event payload (message text, tool names, arguments, results). */
export function eventText(value: unknown, budget: number): string {
  const parts: string[] = []
  let used = 0
  const walk = (v: unknown, key: string, depth: number) => {
    if (used >= budget || depth > 8 || v === null || v === undefined) return
    if (typeof v === 'string') {
      if (['text', 'content', 'arguments', 'name', 'message', 'summary', 'reason', 'input', 'result'].includes(key) || key === '') {
        const s = v.slice(0, budget - used)
        parts.push(s)
        used += s.length
      }
      return
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, key, depth + 1)
      return
    }
    if (typeof v === 'object') for (const [k, child] of Object.entries(v as Record<string, unknown>)) walk(child, k, depth + 1)
  }
  walk(value, '', 0)
  return parts.join(' | ')
}

export interface HistoryHit {
  ts: string
  type: string
  snippet: string
}

/**
 * Search an archive file for a case-insensitive substring.
 * @param file - archive path.
 * @param query - text to find.
 * @param maxResults - cap.
 * @returns newest-first hits with surrounding context.
 */
export function searchArchive(file: string, query: string, maxResults: number): HistoryHit[] {
  if (!existsSync(file)) return []
  const q = query.toLowerCase()
  const hits: HistoryHit[] = []
  const lines = readFileSync(file, 'utf8').split('\n')
  for (let i = lines.length - 1; i >= 0 && hits.length < maxResults; i--) {
    const line = lines[i]
    if (!line) continue
    let rec: { ts: string; type: string; text: string }
    try {
      rec = JSON.parse(line) as typeof rec
    } catch {
      continue
    }
    const at = rec.text.toLowerCase().indexOf(q)
    if (at < 0) continue
    const start = Math.max(0, at - 300)
    hits.push({ ts: rec.ts, type: rec.type, snippet: `${start > 0 ? '…' : ''}${rec.text.slice(start, at + q.length + 500)}${at + q.length + 500 < rec.text.length ? '…' : ''}` })
  }
  return hits
}

/**
 * Plugin entry.
 * @param ctx - Cordis context.
 * @param config - storage locations.
 */
export function apply(ctx: Context, config: Config): void {
  mkdirSync(config.historyDir, { recursive: true })
  mkdirSync(config.notesDir, { recursive: true })
  const archiveFile = (sessionId: string) => join(config.historyDir, `${safeId(sessionId)}.jsonl`)
  const notesFile = (sessionId: string) => join(config.notesDir, `${safeId(sessionId)}.md`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- event typing comes from DSH declaration merging
  const on = (ctx as any).on.bind(ctx)

  // Sessions whose history was compacted since their last step; their notes ride along with the next step.
  const pendingNotes = new Set<string>()
  on('agent/pre-step', async (payload: { agent: AgentLike }, next: () => Promise<{ kind: string; messages?: unknown[] }>) => {
    const id = payload.agent?.session?.id
    const decision = await next()
    if (!id || !pendingNotes.has(id) || decision.kind !== 'enter') return decision
    pendingNotes.delete(id)
    const file = notesFile(id)
    const notes = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
    if (!notes) return decision
    emitTelemetry({ event: 'memory-reinjected', sessionId: id, chars: notes.length })
    const message = createUserMessage({
      content: [{ type: 'text', text: `[Hearth task memory] Earlier history was compacted. Notes you recorded during this task:
${notes}
Use task_memory search_history to look up exact earlier details.` }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- plugin-declared message source kind
      source: { kind: 'hearth-memory' } as any,
    })
    return { ...decision, messages: [...(decision.messages ?? []), message] }
  })

  on('session/event', (session: { id?: string }, event: { type?: string }) => {
    const sessionId = session?.id
    if (!sessionId || !event?.type) return
    try {
      const text = eventText(event, config.maxEventChars)
      if (text) appendFileSync(archiveFile(sessionId), `${JSON.stringify({ ts: new Date().toISOString(), type: event.type, text })}\n`, 'utf8')
    } catch (error) {
      emitTelemetry({ event: 'history-archive-failed', error: String(error) })
    }
    if (event.type === 'compaction/summary') {
      // Appending from inside a session-event listener would re-enter the session log; defer to the next step.
      emitTelemetry({ event: 'compaction', sessionId })
      pendingNotes.add(sessionId)
    }
  })

  if (!config.enableTool) {
    emitTelemetry({ event: 'plugin-ready', plugin: name })
    return
  }
  const tools = (ctx as unknown as { tools: { register(d: unknown): () => void } }).tools
  ctx.effect(() =>
    tools.register(defineTool({
      name: 'task_memory',
      description:
        'Persistent memory for long tasks. action="note": record a decision, fact, or open item (kept across context compaction and resume). action="notes": list recorded notes. action="search_history": search the full, uncompacted history of this task for text (exact error messages, earlier outputs, file contents you saw).',
      parameters: {
        action: { type: 'string', required: true, enum: ['note', 'notes', 'search_history'] },
        text: { type: 'string', description: 'note: the note text. search_history: the text to search for.' },
        kind: { type: 'string', enum: ['decision', 'fact', 'todo'], description: 'note category (default fact).' },
        max_results: { type: 'integer', description: 'search_history: maximum hits (default 5).' },
      },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute(args, exec) {
        const sessionId = (exec as unknown as { agent?: { session?: { id?: string } } }).agent?.session?.id
        if (!sessionId) throw new Error('no session is attached to this call')
        if (args.action === 'note') {
          if (!args.text?.trim()) throw new ToolArgsError(['note requires text'])
          appendFileSync(notesFile(sessionId), `- [${args.kind ?? 'fact'}] ${args.text.trim().replace(/\s*\n\s*/g, ' ')} (${new Date().toISOString().slice(0, 16)})\n`, 'utf8')
          return 'noted'
        }
        if (args.action === 'notes') {
          const file = notesFile(sessionId)
          return existsSync(file) ? readFileSync(file, 'utf8').trim() || '(no notes)' : '(no notes)'
        }
        if (!args.text?.trim()) throw new ToolArgsError(['search_history requires text'])
        const hits = searchArchive(archiveFile(sessionId), args.text.trim(), Math.min(20, Math.max(1, args.max_results ?? 5)))
        return hits.length ? hits.map(h => `[${h.ts} ${h.type}] ${h.snippet}`).join('\n\n') : `no matches for "${args.text}" in this task's history`
      },
    })),
  )
  emitTelemetry({ event: 'plugin-ready', plugin: name })
}
