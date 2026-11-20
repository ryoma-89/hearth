/**
 * Shared setup for end-to-end tests: a temp workspace + state dir, a mock
 * OpenAI-compatible model, and a real Hearth daemon running real DSH child
 * processes with the Hearth plugins. Only the model is simulated.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_RAW_CONFIG } from '../../src/config/defaults.ts'
import { deepMerge, PROJECT_ROOT, resolveConfig } from '../../src/config/load.ts'
import type { HearthConfig } from '../../src/config/types.ts'
import { TERMINAL_STATUSES, type TaskRecord } from '../../src/queue/task-store.ts'
import { HearthDaemon } from '../../src/server/daemon.ts'
import { startMockOpenAI, type MockServer, type Scenario } from '../mock/mock-openai.ts'

export interface Harness {
  root: string
  workspace: string
  config: HearthConfig
  mock: MockServer
  daemon: HearthDaemon
  submit(prompt: string, extra?: Record<string, unknown>): Promise<TaskRecord>
  wait(id: string, timeoutMs?: number): Promise<TaskRecord>
  close(): Promise<void>
}

export async function startHarness(scenario: Scenario, overrides: Record<string, unknown> = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'hearth-e2e-'))
  const workspace = join(root, 'ws')
  mkdirSync(workspace)
  const mock = await startMockOpenAI({ scenario, apiKey: 'mock-key' })
  const raw = deepMerge(
    deepMerge(DEFAULT_RAW_CONFIG, {
      stateDir: join(root, 'state'),
      // Share one DSH home across e2e runs so profile creation happens once.
      dsh: { home: join(PROJECT_ROOT, '.hearth', 'test-dsh-home') },
      defaultModel: 'mock/mock-model',
      defaultWorkspace: workspace,
      providers: {
        // Never let tests reach the real STRATA server (discovery would use the stored key).
        strata: null,
        mock: {
          baseURL: mock.baseURL,
          apiKey: { env: 'HEARTH_TEST_MOCK_KEY' },
          compat: { supportsStore: false },
          models: [{ id: 'mock-model', contextWindow: 32768, maxTokens: 4096 }],
          maxRetries: 0,
        },
      },
      queue: { leaseTtlMs: 5000 },
    }),
    overrides,
  )
  // The daemon itself (model discovery) and its DSH children both read the mock key.
  process.env.HEARTH_TEST_MOCK_KEY = 'mock-key'
  const config = resolveConfig(raw, root, 'e2e')
  const daemon = new HearthDaemon({ config, port: 0, writeInfo: false, childEnv: { HEARTH_TEST_MOCK_KEY: 'mock-key' } })
  await daemon.start()
  const h: Harness = {
    root,
    workspace,
    config,
    mock,
    daemon,
    async submit(prompt, extra = {}) {
      const res = await fetch(`${daemon.baseURL}/v1/tasks`, {
        method: 'POST',
        headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, mode: 'medium', ...extra }),
      })
      const body = (await res.json()) as { task: TaskRecord; error?: string }
      if (!res.ok) throw new Error(`submit failed: ${res.status} ${body.error}`)
      return body.task
    },
    async wait(id, timeoutMs = 120_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const t = daemon.queue.get(id)!
        if (TERMINAL_STATUSES.includes(t.status)) return t
        if (Date.now() > deadline) throw new Error(`task ${id} still ${t.status} after ${timeoutMs} ms`)
        await new Promise(r => setTimeout(r, 200))
      }
    },
    async close() {
      await daemon.stop()
      await mock.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
  return h
}

/** Count tool messages (results) sent back to the model in the latest request. */
export function toolResultsSeen(mock: MockServer): string[] {
  const last = mock.requests.at(-1)
  return (last?.messages ?? []).filter(m => m.role === 'tool').map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
}
