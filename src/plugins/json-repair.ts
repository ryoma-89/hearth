/**
 * Lenient repair of tool-call argument JSON produced by local models.
 *
 * The repair is deliberately conservative: it only fixes syntax damage whose
 * intended value is unambiguous (code fences, trailing commas, single-quoted
 * strings, unquoted keys, unquoted scalar words, raw newlines inside strings,
 * Python literals, and missing closing brackets at the end of the text). The
 * result is always re-parsed with JSON.parse; anything still invalid is
 * reported as unrepairable so the caller can retry the model instead of
 * running a guessed command.
 */

export type RepairResult =
  | { ok: true; value: Record<string, unknown>; text: string; repaired: boolean; fixes: string[] }
  | { ok: false; error: string }

const PY_LITERALS: Record<string, string> = { True: 'true', False: 'false', None: 'null' }

function stripFences(text: string, fixes: string[]): string {
  const fenced = /^\s*```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(text)
  if (fenced) {
    fixes.push('removed code fence')
    return fenced[1]!
  }
  return text
}

function extractObject(text: string, fixes: string[]): string {
  const start = text.indexOf('{')
  if (start > 0 && text.slice(0, start).trim().length > 0) {
    fixes.push('dropped text before object')
    return text.slice(start)
  }
  return start >= 0 ? text.slice(start) : text
}

/**
 * Tokenizer-driven rewrite: walk the text once, normalizing strings and bare
 * words, and tracking bracket depth so missing closers can be appended.
 */
function rewrite(text: string, fixes: string[]): string {
  let out = ''
  const stack: string[] = []
  let i = 0
  const n = text.length
  const note = (fix: string) => {
    if (!fixes.includes(fix)) fixes.push(fix)
  }
  while (i < n) {
    const ch = text[i]!
    if (ch === '"' || ch === "'") {
      const quote = ch
      if (quote === "'") note('converted single-quoted strings')
      let s = '"'
      i++
      let closed = false
      while (i < n) {
        const c = text[i]!
        if (c === '\\') {
          const next = text[i + 1]
          if (next === undefined) {
            i++
            break
          }
          if (quote === "'" && next === "'") s += "'"
          else if ('"\\/bfnrtu'.includes(next)) s += `\\${next}`
          else {
            s += `\\\\${next}`
            note('escaped stray backslashes')
          }
          i += 2
          continue
        }
        if (c === quote) {
          closed = true
          i++
          break
        }
        if (c === '"') s += '\\"'
        else if (c === '\n') {
          s += '\\n'
          note('escaped raw newlines in strings')
        } else if (c === '\r') s += '\\r'
        else if (c === '\t') s += '\\t'
        else s += c
        i++
      }
      // A string cut off mid-way usually means truncated output (for example
      // file content); guessing its end could write a damaged file, so refuse.
      if (!closed) throw new Error('unterminated string (output was probably truncated)')
      out += `${s}"`
      continue
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch === '{' ? '}' : ']')
      out += ch
      i++
      continue
    }
    if (ch === '}' || ch === ']') {
      // Drop a trailing comma before a closer.
      const trimmed = out.replace(/\s+$/, '')
      if (trimmed.endsWith(',')) {
        out = trimmed.slice(0, -1)
        note('removed trailing comma')
      }
      if (stack.length > 0 && stack[stack.length - 1] === ch) stack.pop()
      out += ch
      i++
      continue
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i
      while (j < n && /[A-Za-z0-9_$.\-]/.test(text[j]!)) j++
      const word = text.slice(i, j)
      let k = j
      while (k < n && /\s/.test(text[k]!)) k++
      const isKey = text[k] === ':'
      if (isKey) {
        out += JSON.stringify(word)
        note('quoted bare keys')
      } else if (word === 'true' || word === 'false' || word === 'null') {
        out += word
      } else if (PY_LITERALS[word]) {
        out += PY_LITERALS[word]
        note('converted Python literals')
      } else {
        // A bare value word: take it up to the next structural delimiter.
        let m = i
        while (m < n && !/[,}\]\n]/.test(text[m]!)) m++
        out += JSON.stringify(text.slice(i, m).trim())
        note('quoted bare string values')
        j = m
      }
      i = j
      continue
    }
    out += ch
    i++
  }
  const trimmed = out.replace(/\s+$/, '')
  if (trimmed.endsWith(',')) {
    out = trimmed.slice(0, -1)
    note('removed trailing comma')
  }
  if (stack.length > 0) {
    out += stack.reverse().join('')
    note('closed unbalanced brackets')
  }
  return out
}

/**
 * Parse tool-call arguments, repairing common local-model damage.
 * @param raw - argument text exactly as streamed by the model.
 * @returns the parsed object, or the reason repair failed.
 */
export function repairToolArguments(raw: string): RepairResult {
  const text = raw.trim()
  if (text === '') return { ok: true, value: {}, text: '{}', repaired: true, fixes: ['empty arguments treated as {}'] }
  try {
    const value = JSON.parse(text) as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown>, text, repaired: false, fixes: [] }
    }
    // Some models double-encode: "{\"a\":1}"
    if (typeof value === 'string') {
      const inner = repairToolArguments(value)
      if (inner.ok) return { ...inner, repaired: true, fixes: ['decoded double-encoded JSON', ...inner.fixes] }
    }
    return { ok: false, error: 'arguments must be a JSON object' }
  } catch {
    // fall through to repair
  }
  const fixes: string[] = []
  try {
    const candidate = rewrite(extractObject(stripFences(text, fixes), fixes), fixes)
    const value = JSON.parse(candidate) as unknown
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return { ok: true, value: value as Record<string, unknown>, text: JSON.stringify(value), repaired: true, fixes }
    }
    return { ok: false, error: 'repaired arguments are not a JSON object' }
  } catch (error) {
    return { ok: false, error: `unrepairable JSON: ${(error as Error).message}` }
  }
}
