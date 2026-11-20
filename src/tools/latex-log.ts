/**
 * Parse (u)pLaTeX and dvipdfmx logs into structured diagnostics the model
 * can act on. Only patterns that TeX reliably prints are recognized; anything
 * else stays in the raw excerpt.
 */

export interface LatexError {
  message: string
  file?: string
  line?: number
  context?: string
}

export interface LatexDiagnostics {
  errors: LatexError[]
  overfull: Array<{ kind: 'hbox' | 'vbox'; amountPt: number; lines?: string; text: string }>
  underfullCount: number
  undefinedReferences: string[]
  undefinedCitations: string[]
  missingCharacters: string[]
  fontWarnings: string[]
  otherWarnings: string[]
  rerunNeeded: boolean
  outputPages?: number
}

/**
 * Parse a TeX engine log.
 * @param log - full .log text.
 * @returns structured diagnostics.
 */
export function parseLatexLog(log: string): LatexDiagnostics {
  const text = log.replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const d: LatexDiagnostics = {
    errors: [],
    overfull: [],
    underfullCount: 0,
    undefinedReferences: [],
    undefinedCitations: [],
    missingCharacters: [],
    fontWarnings: [],
    otherWarnings: [],
    rerunNeeded: false,
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    // -file-line-error style: ./main.tex:12: Undefined control sequence.
    const fileLine = /^(.*?\.(?:tex|sty|cls|bbl|aux)):(\d+): (.*)$/.exec(line)
    if (fileLine) {
      const ctx = lines.slice(i + 1, i + 3).filter(Boolean).join(' | ')
      d.errors.push({ file: fileLine[1], line: Number(fileLine[2]), message: fileLine[3]!, context: ctx })
      continue
    }
    if (line.startsWith('! ')) {
      const err: LatexError = { message: line.slice(2) }
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
        const m = /^l\.(\d+) ?(.*)$/.exec(lines[j]!)
        if (m) {
          err.line = Number(m[1])
          err.context = m[2]
          break
        }
      }
      d.errors.push(err)
      continue
    }
    const over = /^(Overfull) \\([hv])box \(([\d.]+)pt too (?:wide|high)\)(?: (?:in paragraph|detected|has occurred while \\output is active))?(?: at lines? (\d+(?:--\d+)?))?/.exec(line)
    if (over) {
      d.overfull.push({ kind: over[2] === 'h' ? 'hbox' : 'vbox', amountPt: Number(over[3]), lines: over[4], text: line.trim() })
      continue
    }
    if (/^Underfull \\[hv]box/.test(line)) {
      d.underfullCount++
      continue
    }
    const ref = /LaTeX Warning: Reference `([^']*)' on page/.exec(line)
    if (ref) {
      d.undefinedReferences.push(ref[1]!)
      continue
    }
    const cite = /LaTeX Warning: Citation `([^']*)' on page/.exec(line)
    if (cite) {
      d.undefinedCitations.push(cite[1]!)
      continue
    }
    const missing = /^Missing character: There is no (.+?) in font (.+?)!/.exec(line)
    if (missing) {
      d.missingCharacters.push(`${missing[1]} (font ${missing[2]})`)
      continue
    }
    if (/Rerun to get|Label\(s\) may have changed|Rerun LaTeX/.test(line)) {
      d.rerunNeeded = true
      continue
    }
    if (/LaTeX Font Warning:|Font shape .* undefined|dvipdfmx:warning: .*font|Could not locate a virtual\/physical font/i.test(line)) {
      d.fontWarnings.push(line.trim())
      continue
    }
    if (/(LaTeX|Package \S+|Class \S+) Warning:/.test(line) || /^dvipdfmx:warning:/.test(line)) {
      // Warnings can wrap; join continuation lines starting with spaces or "(pkg)".
      let w = line.trim()
      for (let j = i + 1; j < lines.length && /^\(\S+\)\s|^ {4,}/.test(lines[j]!); j++) w += ` ${lines[j]!.trim()}`
      d.otherWarnings.push(w)
    }
    const pages = /^Output written on .*\((\d+) pages?/.exec(line)
    if (pages) d.outputPages = Number(pages[1])
  }
  d.undefinedReferences = [...new Set(d.undefinedReferences)]
  d.undefinedCitations = [...new Set(d.undefinedCitations)]
  d.missingCharacters = [...new Set(d.missingCharacters)]
  return d
}

export interface PdfFontRow {
  name: string
  type: string
  embedded: boolean
}

/**
 * Parse `pdffonts` output.
 * @param output - pdffonts stdout.
 * @returns one row per font.
 */
export function parsePdfFonts(output: string): PdfFontRow[] {
  const lines = output.replace(/\r\n/g, '\n').split('\n')
  const sep = lines.findIndex(l => /^-{5,}/.test(l))
  if (sep < 0) return []
  const header = lines[sep - 1] ?? ''
  const embCol = header.indexOf('emb')
  const typeCol = header.indexOf('type')
  const encCol = header.indexOf('encoding')
  return lines
    .slice(sep + 1)
    .filter(l => l.trim())
    .map(l => ({
      name: l.slice(0, typeCol).trim(),
      type: l.slice(typeCol, encCol > 0 ? encCol : undefined).trim(),
      embedded: l.slice(embCol, embCol + 3).trim() === 'yes',
    }))
}

/**
 * Parse `pdfinfo` key/value output.
 * @param output - pdfinfo stdout.
 * @returns key/value map.
 */
export function parsePdfInfo(output: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of output.replace(/\r\n/g, '\n').split('\n')) {
    const m = /^([^:]+):\s*(.*)$/.exec(line)
    if (m) out[m[1]!.trim()] = m[2]!.trim()
  }
  return out
}
