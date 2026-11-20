/**
 * Command risk classification.
 *
 * PowerShell input is parsed by PowerShell's own AST parser (ps-ast.ps1) and
 * classified per command invocation; nothing is decided by substring search
 * over the raw script. Anything the parser cannot lower to literal command
 * words (dynamic command names, Invoke-Expression, encoded commands, parse
 * errors) is treated as dangerous: unknown is never auto-approved.
 *
 * The classifier is an approval trigger, not the sandbox. DSH's Windows ACL
 * sandbox still confines what an allowed command can write.
 */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export interface ParsedCommand {
  name: string
  args: string[]
}

export interface CommandClassification {
  verdict: 'allow' | 'dangerous'
  reasons: string[]
  commands: ParsedCommand[]
}

export interface CommandPolicyOptions {
  extraDangerous: readonly string[]
  trusted: readonly string[]
}

const AST_SCRIPT = fileURLToPath(new URL('./ps-ast.ps1', import.meta.url))

/** Commands that are dangerous regardless of arguments. */
const ALWAYS_DANGEROUS = new Set([
  'format-volume', 'format', 'diskpart', 'bcdedit', 'clear-disk', 'initialize-disk', 'remove-partition',
  'stop-computer', 'restart-computer', 'shutdown', 'logoff',
  'set-executionpolicy', 'takeown', 'icacls', 'cacls', 'vssadmin', 'wbadmin', 'cipher',
  'reg', 'regedit', 'set-itemproperty', 'remove-itemproperty', 'new-itemproperty',
  'invoke-expression', 'iex', 'invoke-command', 'icm', 'start-job', 'register-scheduledtask', 'schtasks',
  'new-service', 'set-service', 'sc', 'sc.exe', 'net', 'net1', 'netsh', 'runas',
  'add-mppreference', 'set-mppreference', 'disable-computerrestore',
  'remove-localuser', 'new-localuser', 'add-localgroupmember',
  'mklink', 'new-psdrive', 'subst',
])

/** Deletion commands: dangerous when recursive/forced or targeting wildcards. */
export const DELETE_COMMANDS = new Set(['remove-item', 'rm', 'del', 'erase', 'rd', 'rmdir', 'ri', 'rimraf', 'clear-content', 'clc'])

/** Process launchers that can elevate or open arbitrary handlers. */
const LAUNCHERS = new Set(['start-process', 'saps', 'start', 'invoke-item', 'ii'])

/** Dangerous .NET static members (type::member, lower-case, type prefix optional). */
const DANGEROUS_DOTNET = [
  /io\.file\]::(delete|move|replace|writeall\w*|appendall\w*|setattributes|encrypt)/,
  /io\.directory\]::(delete|move)/,
  /diagnostics\.process\]::start/,
  /net\.webclient/,
  /microsoft\.win32\.registry/,
  /environment\]::(setenvironmentvariable|exit)/,
  /reflection\.assembly\]::load/,
  /runtime\.interopservices/,
]

export function baseName(word: string): string {
  const parts = word.replace(/\\/g, '/').split('/')
  return (parts[parts.length - 1] ?? word).toLowerCase().replace(/\.(exe|cmd|bat|com|ps1)$/, '')
}

function hasFlag(args: readonly string[], ...flags: string[]): boolean {
  const lowered = args.map(a => a.toLowerCase())
  return flags.some(f => lowered.some(a => a === f || a.startsWith(`${f}:`)))
}

/**
 * Classify one lowered command (shared by PowerShell and POSIX-shell input).
 * @param command - command name and literal argument words.
 * @param options - extra dangerous and trusted names.
 * @returns reasons this command is dangerous (empty when allowed).
 */
export function classifyCommand(command: ParsedCommand, options: CommandPolicyOptions): string[] {
  const name = baseName(command.name)
  const args = command.args
  if (options.trusted.includes(name)) return []
  if (options.extraDangerous.includes(name)) return [`${name} is configured as dangerous`]
  if (ALWAYS_DANGEROUS.has(name)) return [`${name} can change system state outside the workspace`]
  if (DELETE_COMMANDS.has(name)) {
    if (hasFlag(args, '-recurse', '-r', '-rf', '-fr', '/s', '-force', '-f', '/q')) return [`${name} with recursive/forced deletion`]
    if (args.some(a => /[*?]/.test(a))) return [`${name} with wildcard targets`]
    if (args.some(a => /^([A-Za-z]:)?[\\/]*$/.test(a) || a === '~' || a === '..')) return [`${name} targeting a root or parent directory`]
    return []
  }
  if (LAUNCHERS.has(name)) {
    if (hasFlag(args, '-verb')) return [`${name} with -Verb (possible elevation)`]
    if (args.some(a => /^[a-z][a-z0-9+.-]*:/i.test(a) && !/^[a-z]:[\\/]/i.test(a))) return [`${name} opening a URL or protocol handler`]
  }
  if (name === 'powershell' || name === 'pwsh' || name === 'cmd') {
    if (hasFlag(args, '-encodedcommand', '-enc', '-e', '-ec')) return [`${name} with an encoded command`]
    if (hasFlag(args, '-command', '-c', '/c', '/k')) return [`nested ${name} invocation cannot be inspected`]
  }
  if (name === 'git') {
    const sub = args.find(a => !a.startsWith('-'))?.toLowerCase()
    if (sub === 'push') return ['git push publishes outside this machine']
    if (sub === 'reset' && hasFlag(args, '--hard')) return ['git reset --hard discards work']
    if (sub === 'clean' && args.some(a => /^-[a-z]*f/i.test(a))) return ['git clean -f deletes untracked files']
    if (sub === 'checkout' && args.includes('--') && args.includes('.')) return ['git checkout -- . discards work']
    if (sub === 'filter-branch' || (sub === 'branch' && hasFlag(args, '-d', '--delete'))) return [`git ${sub} rewrites or deletes history`]
  }
  if (name === 'npm' || name === 'pnpm' || name === 'yarn') {
    const sub = args[0]?.toLowerCase()
    if (sub === 'publish' || sub === 'unpublish' || sub === 'deprecate') return [`${name} ${sub} publishes outside this machine`]
  }
  if (name === 'curl' || name === 'invoke-webrequest' || name === 'iwr' || name === 'invoke-restmethod' || name === 'irm' || name === 'wget') {
    if (hasFlag(args, '-method', '-x', '--request', '-d', '--data', '-f', '--form', '-t', '--upload-file', '-infile', '-body')) return [`${name} sending data to a remote host`]
  }
  return []
}

interface AstOutput {
  status: 'ok' | 'parse_failed' | 'parse_errors'
  message?: string
  commands?: Array<{ name: string; args: string[] | string | null }> | { name: string; args: string[] | string | null }
  dynamic?: string[] | string
  dotnet?: string[] | string
}

function asArray<T>(value: T[] | T | null | undefined): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

/**
 * Parse a PowerShell script into command words without executing it.
 * @param script - script text.
 * @param timeoutMs - parser process deadline.
 * @returns the parser's report.
 */
export function parsePowerShell(script: string, timeoutMs = 15_000): Promise<AstOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', AST_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`PowerShell AST parser timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    child.stdout.setEncoding('utf8').on('data', d => (out += d))
    child.stderr.setEncoding('utf8').on('data', d => (err += d))
    child.on('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', code => {
      clearTimeout(timer)
      try {
        resolve(JSON.parse(out.trim()) as AstOutput)
      } catch {
        reject(new Error(`PowerShell AST parser failed (exit ${code}): ${err.trim() || out.trim()}`))
      }
    })
    child.stdin.end(script, 'utf8')
  })
}

/**
 * Classify a PowerShell script.
 * @param script - the command text the model wants to run.
 * @param options - extra dangerous and trusted names.
 * @returns the verdict; parser failure yields `dangerous`.
 */
export async function classifyPowerShell(script: string, options: CommandPolicyOptions): Promise<CommandClassification> {
  let ast: AstOutput
  try {
    ast = await parsePowerShell(script)
  } catch (error) {
    return { verdict: 'dangerous', reasons: [`could not analyze command: ${(error as Error).message}`], commands: [] }
  }
  if (ast.status !== 'ok') {
    return { verdict: 'dangerous', reasons: [`PowerShell could not parse the command (${ast.status}${ast.message ? `: ${ast.message}` : ''})`], commands: [] }
  }
  const commands = asArray(ast.commands).map(c => ({ name: c.name, args: asArray(c.args).map(String) }))
  const reasons: string[] = []
  for (const d of asArray(ast.dynamic)) reasons.push(`not statically analyzable: ${d}`)
  for (const member of asArray(ast.dotnet)) {
    const lowered = member.toLowerCase()
    if (DANGEROUS_DOTNET.some(re => re.test(lowered))) reasons.push(`dangerous .NET call ${member}`)
  }
  for (const c of commands) reasons.push(...classifyCommand(c, options))
  return { verdict: reasons.length ? 'dangerous' : 'allow', reasons, commands }
}

/**
 * Split a POSIX-shell command line into commands (for the bash tool).
 * Quoting is honored; command substitution and variable-built command names
 * are reported as not analyzable.
 * @param line - shell text.
 * @returns parsed commands, or an error description.
 */
export function splitPosixShell(line: string): { commands: ParsedCommand[]; dynamic: string[] } {
  const dynamic: string[] = []
  if (/\$\(|`/.test(line)) dynamic.push('command substitution')
  if (/\beval\b/.test(line)) dynamic.push('eval')
  const commands: ParsedCommand[] = []
  let words: string[] = []
  let word = ''
  let quote: string | null = null
  let hasWord = false
  const endWord = () => {
    if (hasWord) words.push(word)
    word = ''
    hasWord = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push({ name: words[0]!, args: words.slice(1) })
    words = []
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < line.length) word += line[++i]
      else word += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      hasWord = true
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i]
      hasWord = true
    } else if (/\s/.test(c)) endWord()
    else if (c === ';' || c === '|' || c === '&' || c === '\n') endCommand()
    else {
      word += c
      hasWord = true
    }
  }
  endCommand()
  for (const c of commands) if (c.name.startsWith('$')) dynamic.push(`dynamic command name ${c.name}`)
  // `sudo x` / `env x` wrap the real command.
  for (const c of [...commands]) {
    const n = baseName(c.name)
    if ((n === 'sudo' || n === 'env' || n === 'xargs' || n === 'nohup') && c.args.length) {
      dynamic.push(n === 'sudo' ? 'sudo elevation' : `${n} wrapper`)
      commands.push({ name: c.args[0]!, args: c.args.slice(1) })
    }
  }
  return { commands, dynamic }
}

/**
 * Classify a POSIX-shell command line.
 * @param line - shell text.
 * @param options - extra dangerous and trusted names.
 * @returns the verdict.
 */
export function classifyPosixShell(line: string, options: CommandPolicyOptions): CommandClassification {
  const { commands, dynamic } = splitPosixShell(line)
  const reasons = dynamic.map(d => `not statically analyzable: ${d}`)
  for (const c of commands) reasons.push(...classifyCommand(c, options))
  return { verdict: reasons.length ? 'dangerous' : 'allow', reasons, commands }
}
