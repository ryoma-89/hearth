/**
 * Model discovery and model switching through the real daemon and DSH,
 * with a mock server that can change which models it "has loaded".
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { TaskRecord } from '../../src/queue/task-store.ts'
import { startHarness, type Harness } from './helpers.ts'

const discovering = {
  defaultModel: 'mock/auto',
  providers: {
    mock: {
      discoverModels: true,
      discoveredModelDefaults: { contextWindow: 32768, maxTokens: 4096, reasoning: false, toolCalling: 'unknown', input: ['text'] },
    },
  },
}

async function api<T>(h: Harness, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${h.daemon.baseURL}${path}`, { method, headers: { authorization: `Bearer ${h.daemon.token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as T }
}

describe('model discovery and switching', { concurrency: false, timeout: 300_000 }, () => {
  it('imports served models, resolves auto, and refuses models that are not loaded', async () => {
    const h = await startHarness(req => ({ content: `answer from ${req.model}` }), discovering)
    try {
      h.mock.servedModels = ['mock-model', 'mock-b']
      const list = await api<{ models: Array<{ id: string; available: boolean | null; discovered: boolean }>; auto: Array<{ id: string }> }>(h, 'GET', '/v1/models?refresh=1')
      assert.deepEqual(list.body.models.map(m => [m.id, m.available, m.discovered]), [['mock/mock-model', true, false], ['mock/mock-b', true, true]])
      assert.ok(list.body.auto.some(a => a.id === 'mock/auto'))

      const first = await h.submit('which model?', { model: 'mock/auto', mode: 'low' })
      assert.equal(first.model, 'mock-model', 'auto picks the first served model')
      assert.equal((await h.wait(first.id)).finalText, 'answer from mock-model')

      // The server switches models (as when the user loads another model in STRATA).
      h.mock.servedModels = ['mock-b']
      await api(h, 'GET', '/v1/models?refresh=1')
      const refused = await api<{ code: string; error: string }>(h, 'POST', '/v1/tasks', { prompt: 'x', model: 'mock/mock-model', workspace: h.workspace })
      assert.equal(refused.status, 409)
      assert.equal(refused.body.code, 'MODEL_NOT_LOADED')
      const second = await h.submit('which model now?', { model: 'mock/auto', mode: 'low' })
      assert.equal(second.model, 'mock-b')
      assert.equal((await h.wait(second.id)).finalText, 'answer from mock-b')
    } finally {
      await h.close()
    }
  })

  it('continues a conversation on another model with its history', async () => {
    const h = await startHarness(req => {
      const history = JSON.stringify(req.messages)
      return { content: history.includes('secret word is PLUM') ? `${req.model} remembers PLUM` : `${req.model}: noted, the secret word is PLUM` }
    }, discovering)
    try {
      h.mock.servedModels = ['mock-model', 'mock-b']
      await api(h, 'GET', '/v1/models?refresh=1')
      const first = await h.wait((await h.submit('remember this', { model: 'mock/mock-model', mode: 'low' })).id)
      assert.equal(first.status, 'succeeded', first.error)
      const r = await api<{ task: TaskRecord; switchedModel: boolean }>(h, 'POST', `/v1/tasks/${first.id}/resume`, { prompt: 'what was the word?', model: 'mock/mock-b' })
      assert.equal(r.status, 201)
      assert.equal(r.body.switchedModel, true)
      const second = await h.wait(r.body.task.id)
      assert.equal(second.status, 'succeeded', second.error)
      assert.equal(second.model, 'mock-b')
      assert.equal(second.sessionId, first.sessionId, 'same DSH session')
      assert.equal(second.conversationId, first.conversationId ?? first.id)
      assert.equal(second.finalText, 'mock-b remembers PLUM')
      assert.equal(h.mock.requests.at(-1)!.model, 'mock-b')

      // The original model is unloaded: resuming without a choice is refused up front; auto continues.
      h.mock.servedModels = ['mock-b']
      await api(h, 'GET', '/v1/models?refresh=1')
      const stale = await api<{ code: string }>(h, 'POST', `/v1/tasks/${first.id}/resume`, { prompt: 'again' })
      assert.equal(stale.status, 409)
      assert.equal(stale.body.code, 'MODEL_NOT_LOADED')
      const viaAuto = await api<{ task: TaskRecord }>(h, 'POST', `/v1/tasks/${first.id}/resume`, { prompt: 'again', model: 'mock/auto' })
      assert.equal(viaAuto.body.task.model, 'mock-b')
      assert.equal((await h.wait(viaAuto.body.task.id)).status, 'succeeded')
    } finally {
      await h.close()
    }
  })

  it('stops a running task and continues it on another model', async () => {
    const h = await startHarness(req => (req.model === 'mock-model' ? { content: 'slow', delayMs: 30_000 } : { content: `continued on ${req.model}` }), discovering)
    try {
      h.mock.servedModels = ['mock-model', 'mock-b']
      await api(h, 'GET', '/v1/models?refresh=1')
      const running = await h.submit('long job', { model: 'mock/mock-model', mode: 'low' })
      for (let i = 0; i < 100 && h.daemon.broker.snapshot().active.length === 0; i++) await new Promise(r => setTimeout(r, 100))
      const notInterrupted = await api<{ code: string }>(h, 'POST', `/v1/tasks/${running.id}/resume`, { model: 'mock/mock-b' })
      assert.equal(notInterrupted.status, 409, 'a running task is not switched without interrupt')
      const r = await api<{ task: TaskRecord }>(h, 'POST', `/v1/tasks/${running.id}/resume`, { model: 'mock/mock-b', interrupt: true })
      assert.equal(r.status, 201)
      assert.equal(h.daemon.queue.get(running.id)!.status, 'cancelled')
      const next = await h.wait(r.body.task.id)
      assert.equal(next.status, 'succeeded', next.error)
      assert.equal(next.finalText, 'continued on mock-b')
    } finally {
      await h.close()
    }
  })
})
