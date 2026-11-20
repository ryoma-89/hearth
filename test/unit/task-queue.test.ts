import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { emptyMetrics, type RunOutcome } from '../../src/runner/dsh-runner.ts'
import { TaskQueue, type Executor } from '../../src/queue/task-queue.ts'
import { TaskStore } from '../../src/queue/task-store.ts'

const sub = { prompt: 'p', mode: 'low' as const, provider: 'x', model: 'y', workspace: '.', source: 'test' }

function outcome(status: RunOutcome['status'] = 'succeeded'): RunOutcome {
  return { status, exitCode: 0, metrics: emptyMetrics(), runDir: '' }
}

describe('TaskQueue', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'hearth-q-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('runs tasks one at a time in submission order', async () => {
    let concurrent = 0
    let peak = 0
    const order: string[] = []
    const exec: Executor = async task => {
      concurrent++
      peak = Math.max(peak, concurrent)
      order.push(task.id)
      await new Promise(r => setTimeout(r, 20))
      concurrent--
      return outcome()
    }
    const q = new TaskQueue(new TaskStore(dir), exec, 1)
    const ids = [q.submit(sub).id, q.submit(sub).id, q.submit(sub).id]
    assert.equal(q.position(ids[2]!), 2)
    await q.whenIdle()
    assert.equal(peak, 1)
    assert.deepEqual(order, ids)
    assert.ok(ids.every(id => q.get(id)!.status === 'succeeded'))
  })

  it('cancels queued and running tasks', async () => {
    const exec: Executor = (_task, signal) =>
      new Promise(resolve => signal.addEventListener('abort', () => resolve(outcome('cancelled'))))
    const q = new TaskQueue(new TaskStore(dir), exec, 1)
    const a = q.submit(sub)
    const b = q.submit(sub)
    assert.equal(q.cancel(b.id), true)
    assert.equal(q.get(b.id)!.status, 'cancelled')
    assert.equal(q.cancel(a.id), true)
    await q.whenIdle()
    assert.equal(q.get(a.id)!.status, 'cancelled')
    assert.equal(q.cancel(a.id), false, 'finished tasks cannot be cancelled')
  })

  it('records executor crashes as failures and keeps going', async () => {
    let n = 0
    const exec: Executor = async () => {
      if (n++ === 0) throw new Error('boom')
      return outcome()
    }
    const q = new TaskQueue(new TaskStore(dir), exec, 1)
    const a = q.submit(sub)
    const b = q.submit(sub)
    await q.whenIdle()
    assert.equal(q.get(a.id)!.status, 'failed')
    assert.match(q.get(a.id)!.error!, /boom/)
    assert.equal(q.get(b.id)!.status, 'succeeded')
  })

  it('recovers after a restart: running → interrupted, queued → re-run', async () => {
    const store = new TaskStore(dir)
    const blocked: Executor = () => new Promise(() => {})
    const q1 = new TaskQueue(store, blocked, 1)
    const running = q1.submit(sub)
    const queued = q1.submit(sub)
    // Simulate a daemon crash: drop q1 without settling.
    const ran: string[] = []
    const q2 = new TaskQueue(new TaskStore(dir), async task => (ran.push(task.id), outcome()), 1)
    const r = q2.recover()
    await q2.whenIdle()
    assert.deepEqual(r, { interrupted: 1, requeued: 1 })
    assert.equal(q2.get(running.id)!.status, 'interrupted')
    assert.deepEqual(ran, [queued.id])
  })
})
