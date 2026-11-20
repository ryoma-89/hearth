import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { repairToolArguments } from '../../src/plugins/json-repair.ts'

describe('repairToolArguments', () => {
  it('passes valid JSON through unchanged', () => {
    const r = repairToolArguments('{"a":1,"b":"x"}')
    assert.equal(r.ok, true)
    if (r.ok) {
      assert.equal(r.repaired, false)
      assert.deepEqual(r.value, { a: 1, b: 'x' })
    }
  })

  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['unquoted value', '{"text": hi}', { text: 'hi' }],
    ['code fence', '```json\n{"path":"a.txt"}\n```', { path: 'a.txt' }],
    ['trailing comma', '{"a":1,"b":2,}', { a: 1, b: 2 }],
    ['single quotes', "{'path': 'a b.txt'}", { path: 'a b.txt' }],
    ['bare keys', '{path: "x", count: 3}', { path: 'x', count: 3 }],
    ['python literals', '{"ok": True, "v": None}', { ok: true, v: null }],
    ['missing closing brace', '{"a": {"b": 1}', { a: { b: 1 } }],
    ['raw newline in string', '{"code": "print(1)\nprint(2)"}', { code: 'print(1)\nprint(2)' }],
    ['leading prose', 'Here you go: {"a": 1}', { a: 1 }],
    ['double encoded', '"{\\"a\\":1}"', { a: 1 }],
    ['empty arguments', '', {}],
    ['windows path backslashes', '{"p": "C:\\Users\\me"}', { p: 'C:\\Users\\me' }],
  ]
  for (const [name, input, expected] of cases) {
    it(`repairs ${name}`, () => {
      const r = repairToolArguments(input)
      assert.equal(r.ok, true, JSON.stringify(r))
      if (r.ok) assert.deepEqual(r.value, expected)
    })
  }

  it('refuses truncated strings instead of guessing', () => {
    const r = repairToolArguments('{"content": "line one\nline two')
    assert.equal(r.ok, false)
  })

  it('refuses non-object JSON', () => {
    assert.equal(repairToolArguments('[1,2]').ok, false)
    assert.equal(repairToolArguments('42').ok, false)
  })
})
