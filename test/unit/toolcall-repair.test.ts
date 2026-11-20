import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { repairStream, type Chunk } from '../../src/plugins/toolcall-repair.ts'

async function* from(chunks: Chunk[], throwAtEnd?: Error): AsyncGenerator<Chunk> {
  for (const c of chunks) yield c
  if (throwAtEnd) throw throwAtEnd
}

async function collect(it: AsyncIterable<Chunk>): Promise<Chunk[]> {
  const out: Chunk[] = []
  for await (const c of it) out.push(c)
  return out
}

const malformedFinish: Chunk = { type: 'finish', reason: { kind: 'error', failure: { code: 'MALFORMED_RESPONSE', message: 'bad json' } } }

describe('repairStream', () => {
  it('passes a healthy stream through and keeps usage before finish', async () => {
    const chunks: Chunk[] = [
      { type: 'text-delta', index: 0, text: 'hi' },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const out = await collect(repairStream(from(chunks), () => assert.fail('no repair expected')))
    assert.deepEqual(out.map(c => c.type), ['text-delta', 'usage', 'finish'])
  })

  it('re-emits repaired tool calls when the adapter reports MALFORMED_RESPONSE', async () => {
    const outcomes: unknown[] = []
    const chunks: Chunk[] = [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', name: 'write', argumentsDelta: '{"file_path": "a.txt", ' },
      { type: 'tool-call-delta', index: 0, id: 'call_1', argumentsDelta: '"content": "x",}' },
      { type: 'usage', usage: { inputTokens: 5, outputTokens: 7 } },
      malformedFinish,
    ]
    const out = await collect(repairStream(from(chunks), o => outcomes.push(o)))
    const end = out.find(c => c.type === 'block-end') as unknown as { block: { arguments: string; name: string; id: string } }
    assert.ok(end, 'block-end emitted')
    assert.deepEqual(JSON.parse(end.block.arguments), { file_path: 'a.txt', content: 'x' })
    assert.equal(end.block.name, 'write')
    assert.deepEqual(out.slice(-2).map(c => c.type), ['usage', 'finish'])
    assert.equal((out.at(-1) as { reason: { kind: string } }).reason.kind, 'tool-calls')
    assert.equal((outcomes[0] as { repaired: boolean }).repaired, true)
  })

  it('handles a thrown MALFORMED_RESPONSE error the same way', async () => {
    const err = Object.assign(new Error('bad'), { code: 'MALFORMED_RESPONSE' })
    const chunks: Chunk[] = [{ type: 'tool-call-delta', index: 0, id: 'c', name: 'read', argumentsDelta: "{'file_path': 'x'}" }]
    const out = await collect(repairStream(from(chunks, err), () => {}))
    assert.equal(out.at(-1)!.type, 'finish')
  })

  it('keeps the original failure when repair is impossible', async () => {
    const outcomes: Array<{ repaired: boolean }> = []
    const chunks: Chunk[] = [
      { type: 'tool-call-delta', index: 0, id: 'c', name: 'write', argumentsDelta: '{"content": "truncat' },
      { type: 'usage', usage: {} },
      malformedFinish,
    ]
    const out = await collect(repairStream(from(chunks), o => outcomes.push(o)))
    assert.equal(out.at(-1), malformedFinish)
    assert.equal(outcomes[0]!.repaired, false)
  })

  it('does not re-emit calls that already completed', async () => {
    const chunks: Chunk[] = [
      { type: 'tool-call-delta', index: 0, id: 'a', name: 'read', argumentsDelta: '{"file_path":"ok"}' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'a', name: 'read', arguments: '{"file_path":"ok"}' } },
      { type: 'tool-call-delta', index: 1, id: 'b', name: 'read', argumentsDelta: '{file_path: "x"}' },
      malformedFinish,
    ]
    const out = await collect(repairStream(from(chunks), () => {}))
    const ends = out.filter(c => c.type === 'block-end')
    assert.equal(ends.length, 2)
  })
})
