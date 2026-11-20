import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { InferenceBroker, LeaseWaitError } from '../../src/queue/broker.ts'

function broker(overrides: Partial<ConstructorParameters<typeof InferenceBroker>[0]> = {}) {
  return new InferenceBroker({ maxConcurrent: 1, leaseTtlMs: 10_000, maxLeaseMs: 60_000, waitTimeoutMs: 10_000, ...overrides })
}

describe('InferenceBroker', () => {
  it('grants at most maxConcurrent leases and serves waiters FIFO', async () => {
    const b = broker()
    const a = await b.acquire({ taskId: 't1', holder: 'h' })
    const order: string[] = []
    const p2 = b.acquire({ taskId: 't2', holder: 'h' }).then(l => (order.push('t2'), l))
    const p3 = b.acquire({ taskId: 't3', holder: 'h' }).then(l => (order.push('t3'), l))
    await new Promise(r => setTimeout(r, 10))
    assert.equal(b.snapshot().active.length, 1)
    assert.equal(b.snapshot().waiting.length, 2)
    b.release(a.id)
    const l2 = await p2
    b.release(l2.id)
    const l3 = await p3
    assert.deepEqual(order, ['t2', 't3'])
    b.release(l3.id)
    b.close()
  })

  it('reclaims a lease whose holder stopped heartbeating', async () => {
    let now = 0
    const b = broker({ leaseTtlMs: 1000, now: () => now })
    const events: string[] = []
    b.onEvent(e => events.push(e.type === 'released' ? `released:${e.reason}` : e.type))
    await b.acquire({ taskId: 't1', holder: 'crashed' })
    const next = b.acquire({ taskId: 't2', holder: 'h' })
    now = 1500
    b.sweep()
    const lease = await next
    assert.equal(lease.taskId, 't2')
    assert.ok(events.includes('released:expired'))
    b.close()
  })

  it('heartbeats keep a lease alive, max duration still revokes it', async () => {
    let now = 0
    const b = broker({ leaseTtlMs: 1000, maxLeaseMs: 5000, now: () => now })
    const l = await b.acquire({ taskId: 't1', holder: 'h' })
    for (now = 500; now <= 4500; now += 500) {
      assert.equal(b.heartbeat(l.id), true)
      b.sweep()
    }
    assert.equal(b.snapshot().active.length, 1)
    now = 5600
    b.heartbeat(l.id)
    b.sweep()
    assert.equal(b.snapshot().active.length, 0)
    assert.equal(b.heartbeat(l.id), false)
    b.close()
  })

  it('drops an aborted waiter without granting it', async () => {
    const b = broker()
    const held = await b.acquire({ taskId: 't1', holder: 'h' })
    const controller = new AbortController()
    const waiting = b.acquire({ taskId: 't2', holder: 'h' }, controller.signal)
    controller.abort()
    await assert.rejects(waiting, (e: unknown) => e instanceof LeaseWaitError && e.code === 'WAIT_ABORTED')
    assert.equal(b.snapshot().waiting.length, 0)
    b.release(held.id)
    assert.equal(b.snapshot().active.length, 0)
    b.close()
  })

  it('times out waiters', async () => {
    const b = broker({ waitTimeoutMs: 30 })
    await b.acquire({ taskId: 't1', holder: 'h' })
    await assert.rejects(b.acquire({ taskId: 't2', holder: 'h' }), (e: unknown) => e instanceof LeaseWaitError && e.code === 'WAIT_TIMEOUT')
    b.close()
  })

  it('releaseTask frees leases and waiters of an exited task', async () => {
    const b = broker({ maxConcurrent: 2 })
    await b.acquire({ taskId: 'dead', holder: 'h' })
    await b.acquire({ taskId: 'dead', holder: 'h' })
    const w = b.acquire({ taskId: 'dead', holder: 'h' })
    const other = b.acquire({ taskId: 'alive', holder: 'h' })
    assert.equal(b.releaseTask('dead'), 3)
    await assert.rejects(w)
    assert.equal((await other).taskId, 'alive')
    b.close()
  })
})
