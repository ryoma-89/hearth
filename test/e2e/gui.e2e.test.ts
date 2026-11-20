/**
 * Web GUI API end-to-end: login flow, cookie + CSRF rules, static assets,
 * conversations across resumes, uploads, settings, resources. Real daemon and
 * DSH; mock model.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { startHarness } from './helpers.ts'

describe('Web GUI API', { concurrency: false, timeout: 300_000 }, () => {
  it('serves the GUI, logs in with a one-time code, and enforces cookie/CSRF rules', async () => {
    const h = await startHarness(() => ({ content: 'hello from the model' }))
    const base = h.daemon.baseURL
    const bearer = { authorization: `Bearer ${h.daemon.token}` }
    try {
      const page = await fetch(`${base}/`)
      assert.equal(page.status, 200)
      assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/)
      assert.match(await page.text(), /<script type="module" src="\/app.js">/)
      assert.equal((await fetch(`${base}/v1/conversations`)).status, 401, 'API needs credentials')

      const { url } = (await (await fetch(`${base}/v1/gui/login-code`, { method: 'POST', headers: bearer })).json()) as { url: string }
      const login = await fetch(url, { redirect: 'manual' })
      assert.equal(login.status, 302)
      const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!
      assert.match(login.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/)
      assert.equal((await fetch(url, { redirect: 'manual' })).status, 401, 'code is single use')

      const host = new URL(base).host
      const cookieHeaders = { cookie, host }
      assert.equal((await fetch(`${base}/v1/conversations`, { headers: cookieHeaders })).status, 200)
      const noCsrf = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { ...cookieHeaders, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) })
      assert.equal(noCsrf.status, 403, 'writes need the CSRF header')
      const cross = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: { ...cookieHeaders, 'x-hearth-csrf': '1', origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'x' }) })
      assert.equal(cross.status, 403, 'cross-origin writes are refused')
      const codeByCookie = await fetch(`${base}/v1/gui/login-code`, { method: 'POST', headers: { ...cookieHeaders, 'x-hearth-csrf': '1' } })
      assert.equal(codeByCookie.status, 403, 'a browser session cannot mint new login codes')

      const gui = { ...cookieHeaders, 'x-hearth-csrf': '1', origin: base, 'content-type': 'application/json' }
      // upload, then a conversation of two turns
      const up = await fetch(`${base}/v1/uploads?workspace=${encodeURIComponent(h.workspace)}&name=${encodeURIComponent('..\\data.csv')}`, { method: 'POST', headers: { ...gui, 'content-type': 'application/octet-stream' }, body: 'a,b\n1,2\n' })
      assert.equal(up.status, 201)
      const saved = (await up.json()) as { path: string }
      assert.equal(saved.path, 'attachments/data.csv')
      assert.equal(readFileSync(join(h.workspace, 'attachments', 'data.csv'), 'utf8'), 'a,b\n1,2\n')

      const first = (await (await fetch(`${base}/v1/tasks`, { method: 'POST', headers: gui, body: JSON.stringify({ prompt: 'first', mode: 'low', workspace: h.workspace, source: 'gui' }) })).json()) as { task: { id: string; conversationId: string } }
      assert.equal(first.task.conversationId, first.task.id)
      const done1 = await h.wait(first.task.id)
      const second = (await (await fetch(`${base}/v1/tasks/${done1.id}/resume`, { method: 'POST', headers: gui, body: JSON.stringify({ prompt: 'second' }) })).json()) as { task: { id: string; conversationId: string } }
      assert.equal(second.task.conversationId, first.task.id)
      await h.wait(second.task.id)
      const convs = (await (await fetch(`${base}/v1/conversations`, { headers: cookieHeaders })).json()) as { conversations: Array<{ id: string; taskIds: string[] }> }
      assert.deepEqual(convs.conversations[0]!.taskIds, [first.task.id, second.task.id])

      const res = (await (await fetch(`${base}/v1/resources`, { headers: cookieHeaders })).json()) as { memory: { totalBytes: number }; gpus: unknown[]; gpuUnavailable?: string }
      assert.ok(res.memory.totalBytes > 0)
      assert.ok(Array.isArray(res.gpus))

      const logout = await fetch(`${base}/v1/logout`, { method: 'POST', headers: { ...cookieHeaders, 'x-hearth-csrf': '1' } })
      assert.equal(logout.status, 200)
      assert.equal((await fetch(`${base}/v1/conversations`, { headers: cookieHeaders })).status, 401, 'session revoked')
    } finally {
      await h.close()
    }
  })

  it('applies settings live and persists them to the config file', async () => {
    const h = await startHarness([{ content: 'ok' }])
    const base = h.daemon.baseURL
    const headers = { authorization: `Bearer ${h.daemon.token}`, 'content-type': 'application/json' }
    try {
      h.daemon.config.sourcePath = join(h.root, 'hearth.yaml')
      const r = await fetch(`${base}/v1/settings`, { method: 'PATCH', headers, body: JSON.stringify({ 'queue.maxConcurrentInference': 2, 'security.deleteMode': 'deny' }) })
      const body = (await r.json()) as { values: Record<string, unknown>; error?: string }
      assert.equal(r.status, 200, body.error)
      assert.equal(body.values['queue.maxConcurrentInference'], 2)
      assert.equal(h.daemon.broker.snapshot().maxConcurrent, 2, 'applied to the running broker')
      assert.equal(h.daemon.config.security.deleteMode, 'deny')
      assert.ok(existsSync(join(h.root, 'hearth.yaml')))
      const bad = await fetch(`${base}/v1/settings`, { method: 'PATCH', headers, body: JSON.stringify({ 'providers.strata.baseURL': 'http://evil' }) })
      assert.equal(bad.status, 400)
    } finally {
      await h.close()
    }
  })
})
