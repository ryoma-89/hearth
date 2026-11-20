// Hearth Web GUI. Plain ES module, no build step. Talks only to the Hearth
// daemon on the same origin (session cookie + CSRF header). All model output
// is rendered through escape-first markdown, never as raw HTML.

const $ = sel => document.querySelector(sel)
const EMPTY = document.querySelector('#empty')
const TERMINAL = new Set(['succeeded', 'failed', 'verification_failed', 'cancelled', 'timed_out', 'budget_exhausted', 'interrupted'])
const STATUS_LABEL = {
  queued: ['待機中', 'run'],
  running: ['実行中', 'run'],
  succeeded: ['完了', 'ok'],
  failed: ['失敗', 'err'],
  verification_failed: ['検証不合格', 'warn'],
  cancelled: ['キャンセル', 'warn'],
  timed_out: ['時間切れ', 'err'],
  budget_exhausted: ['上限到達', 'warn'],
  interrupted: ['中断', 'warn'],
}

const state = {
  conversations: [],
  current: null, // conversation id
  tasks: [], // tasks of the current conversation
  streams: new Map(), // taskId -> AbortController
  attachments: [], // { name, path }
  models: [],
  autoModels: [],
  modes: [],
  workspaceDefault: '',
  sessionExpired: false,
}

// ---------------------------------------------------------------- API
async function api(method, path, body, extra = {}) {
  const headers = { 'x-hearth-csrf': '1' }
  let payload = body
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) {
    headers['content-type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', ...extra })
  if (res.status === 401) {
    sessionExpired()
    throw new Error('セッションが切れました')
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

function sessionExpired() {
  if (state.sessionExpired) return
  state.sessionExpired = true
  hint('ログインが必要です。ターミナルで hearth gui を実行してください。', true)
  $('#send').disabled = true
}

// ---------------------------------------------------------------- rendering helpers
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c !== null && c !== undefined) node.append(c instanceof Node ? c : document.createTextNode(String(c)))
  return node
}

const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Small markdown renderer: escape everything first, then add a safe subset. */
function renderMarkdown(text) {
  const blocks = []
  let src = String(text ?? '').replace(/\r\n/g, '\n')
  src = src.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    blocks.push(`<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`)
    return `\u0000${blocks.length - 1}\u0000`
  })
  const inline = s =>
    escapeHtml(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
  const out = []
  const lines = src.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const ph = /^\u0000(\d+)\u0000$/.exec(line.trim())
    if (ph) { out.push(blocks[Number(ph[1])]); continue }
    if (/^#{1,4} /.test(line)) { const level = Math.min(4, line.match(/^#+/)[0].length + 1); out.push(`<h${level}>${inline(line.replace(/^#+ /, ''))}</h${level}>`); continue }
    if (/^\s*[-*] /.test(line)) {
      const items = []
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*[-*] /, ''))}</li>`)
      i--
      out.push(`<ul>${items.join('')}</ul>`)
      continue
    }
    if (/^\s*\d+[.)] /.test(line)) {
      const items = []
      while (i < lines.length && /^\s*\d+[.)] /.test(lines[i])) items.push(`<li>${inline(lines[i++].replace(/^\s*\d+[.)] /, ''))}</li>`)
      i--
      out.push(`<ol>${items.join('')}</ol>`)
      continue
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = (l, tag) => `<tr>${l.trim().slice(1, -1).split('|').map(c => `<${tag}>${inline(c.trim())}</${tag}>`).join('')}</tr>`
      const rows = [row(line, 'th')]
      i += 2
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(row(lines[i++], 'td'))
      i--
      out.push(`<table>${rows.join('')}</table>`)
      continue
    }
    if (line.trim() === '') { out.push(''); continue }
    out.push(`<p>${inline(line)}</p>`)
  }
  const div = document.createElement('div')
  div.className = 'answer'
  div.innerHTML = out.join('\n') // built only from escaped text and fixed tags
  return div
}

const fmtMs = ms => (ms < 1000 ? `${ms}ms` : ms < 120000 ? `${(ms / 1000).toFixed(1)}s` : `${(ms / 60000).toFixed(1)}min`)
const fmtNum = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))
const preview = (v, max = 220) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  const flat = (s ?? '').replace(/\s+/g, ' ')
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
function badge(status) {
  const [label, cls] = STATUS_LABEL[status] ?? [status, 'run']
  return el('span', { class: `badge ${cls}`, text: label })
}
function hint(text, isError = false) {
  const h = $('#composer-hint')
  h.textContent = text || ''
  h.style.color = isError ? 'var(--err)' : ''
}

// ---------------------------------------------------------------- sidebar
async function loadConversations() {
  const { conversations } = await api('GET', '/v1/conversations')
  state.conversations = conversations
  const list = $('#conv-list')
  list.replaceChildren(
    ...conversations.map(c =>
      el('button', { class: `conv-item${c.id === state.current ? ' active' : ''}`, type: 'button', onclick: () => openConversation(c.id) },
        el('span', { class: 't', text: c.title }),
        el('span', { class: 'm' }, badge(c.status), `${new Date(c.updatedAt).toLocaleString()}`)),
    ),
  )
  if (!conversations.length) list.append(el('p', { class: 'muted', text: 'まだ会話はありません' }))
}

function setSidebar(open) {
  $('#app').classList.toggle('sidebar-open', open)
  $('#scrim').hidden = !open
}

// ---------------------------------------------------------------- conversation view
function stopStreams() {
  for (const c of state.streams.values()) c.abort()
  state.streams.clear()
}

function newConversation() {
  stopStreams()
  state.current = null
  state.tasks = []
  $('#conv-title').textContent = '新しい会話'
  $('#messages').replaceChildren(EMPTY)
  EMPTY.hidden = false
  $('#workspace').disabled = false
  $('#model').disabled = false
  $('#composer').classList.remove('in-conv')
  $('#workspace').value = localStorage.getItem('hearth.workspace') || state.workspaceDefault
  updateComposer()
  loadConversations().catch(() => {})
  setSidebar(false)
  $('#prompt').focus()
}

async function openConversation(id) {
  stopStreams()
  state.current = id
  const { conversation, tasks } = await api('GET', `/v1/conversations/${id}`)
  state.tasks = tasks
  $('#conv-title').textContent = conversation.title
  $('#workspace').value = conversation.workspace
  $('#workspace').disabled = true
  selectModel(conversation.model)
  $('#composer').classList.add('in-conv')
  $('#mode').value = tasks.at(-1)?.mode ?? $('#mode').value
  const box = $('#messages')
  box.replaceChildren()
  for (const t of tasks) box.append(renderTurn(t))
  for (const t of tasks) attachStream(t)
  updateComposer()
  loadConversations().catch(() => {})
  setSidebar(false)
  box.scrollTop = box.scrollHeight
}

/** One user message plus the assistant's run for one task. */
function renderTurn(task) {
  const view = {
    root: el('div', { class: 'turn', id: `turn-${task.id}` }),
    head: el('div', { class: 'task-head' }),
    activity: el('details', { class: 'activity' }),
    summary: el('summary'),
    steps: el('div', { class: 'steps' }),
    answer: el('div'),
    metrics: el('div', { class: 'metrics' }),
    error: el('div', { class: 'error-box', hidden: true }),
    stepEl: null,
    stepStart: 0,
    speeds: [],
    toolCount: 0,
    texts: [],
  }
  view.activity.append(view.summary, view.steps)
  view.summary.textContent = 'ツールの実行ログ'
  const user = el('div', { class: 'user-msg', text: task.prompt })
  view.root.append(user, el('div', { class: 'user-meta', text: `${task.mode} · ${task.provider}/${task.model}` }), el('div', { class: 'assistant' }, view.head, view.activity, view.answer, view.error, view.metrics))
  task.__view = view
  updateTaskHead(task)
  return view.root
}

function updateTaskHead(task) {
  const v = task.__view
  if (!v) return
  const live = !TERMINAL.has(task.status)
  v.head.replaceChildren(...[badge(task.status), live ? el('span', { class: 'live-dot' }) : null, el('span', { text: task.id })].filter(Boolean))
  if (live && task.status === 'running') v.head.append(el('button', { class: 'link-btn', type: 'button', text: '停止', onclick: () => cancelTask(task.id) }))
  if (task.error) {
    v.error.hidden = false
    v.error.textContent = task.error
  }
  const m = task.metrics
  if (m) {
    const avg = v.speeds.length ? v.speeds.reduce((a, b) => a + b, 0) / v.speeds.length : null
    const parts = [
      `ステップ ${m.steps}`,
      `ツール ${m.toolCalls}${m.toolErrors ? `（エラー ${m.toolErrors}）` : ''}`,
      `トークン ${fmtNum(m.totalTokens)}（入 ${fmtNum(m.inputTokens)} / 出 ${fmtNum(m.outputTokens)}）`,
      `時間 ${fmtMs(m.durationMs)}`,
      avg ? `生成 約 ${avg.toFixed(1)} tok/s` : null,
      m.leaseWaitMs > 500 ? `スロット待ち ${fmtMs(m.leaseWaitMs)}` : null,
      m.verification && m.verification.last !== 'skipped' ? `検証 ${{ passed: '合格', failed: '不合格', 'failed-final': '不合格' }[m.verification.last] ?? m.verification.last}（修正 ${m.verification.fixRounds} 回）` : null,
      m.toolCallRepairs ? `JSON修復 ${m.toolCallRepairs}` : null,
      m.policyDenials ? `ポリシー拒否 ${m.policyDenials}` : null,
    ]
    v.metrics.replaceChildren(...parts.filter(Boolean).map(p => el('span', { text: p })))
  }
  if (TERMINAL.has(task.status) && task.finalText && v.texts.length === 0) v.answer.replaceChildren(renderMarkdown(task.finalText))
}

function addLine(view, cls, text) {
  if (!view.stepEl) {
    view.stepEl = el('div', { class: 'step' })
    view.steps.append(view.stepEl)
  }
  view.stepEl.append(el('div', { class: `tool-line ${cls}`, text }))
}

function onEvent(task, rec) {
  const v = task.__view
  if (!v) return
  if (rec.type === 'task') {
    Object.assign(task, rec.task)
    updateTaskHead(task)
    return
  }
  const ev = rec.event
  const at = ev.ts ? Date.parse(ev.ts) : Date.now()
  if (ev.kind === 'dsh') {
    const e = ev.event
    if (e.type === 'status' && e.phase === 'step_start') {
      v.stepEl = el('div', { class: 'step' }, el('div', { class: 'step-title', text: `ステップ ${e.step}` }))
      v.steps.append(v.stepEl)
      v.stepStart = at
    } else if (e.type === 'status' && e.phase === 'step_end' && e.usage) {
      const secs = (at - v.stepStart) / 1000
      if (secs > 0.2 && e.usage.outputTokens > 5) v.speeds.push(e.usage.outputTokens / secs)
    } else if (e.type === 'text' && typeof e.text === 'string') {
      v.texts.push(e.text)
      v.answer.replaceChildren(renderMarkdown(v.texts.join('\n\n')))
    } else if (e.type === 'thinking') addLine(v, 'think', `思考: ${preview(e.text, 400)}`)
    else if (e.type === 'tool_call') {
      v.toolCount++
      addLine(v, 'call', `→ ${e.tool} ${preview(e.input)}`)
    } else if (e.type === 'tool_result') addLine(v, e.status === 'completed' ? 'ok' : 'err', `${e.status === 'completed' ? '✓' : '✗'} ${preview(e.error ?? e.result, 400)}`)
  } else if (ev.kind === 'telemetry') {
    const e = ev.event
    if (e.event === 'verification' && e.status !== 'skipped') {
      const checks = e.checks ?? []
      const failed = checks.filter(c => !c.ok)
      addLine(v, failed.length ? 'note' : 'ok', `◆ 自動検証 ${e.status}: ${checks.length - failed.length}/${checks.length} 合格${failed.length ? ` — ${failed.map(c => `${c.verifier} (${c.target})`).join(', ')}` : ''}`)
    } else if (e.event === 'policy-denied') addLine(v, 'err', `⛔ ポリシーで拒否: ${preview(e.reason, 300)}`)
    else if (e.event === 'toolcall-repair') addLine(v, 'note', `! ツール引数 JSON を${e.repaired ? '修復' : '修復できず'}`)
    else if (e.event === 'budget-exhausted') addLine(v, 'err', `⏹ 上限到達 (${e.kind}): ${e.detail}`)
    else if (e.event === 'backup') addLine(v, 'note', `💾 バックアップ: ${(e.paths ?? []).join(', ')}`)
    else if (e.event === 'lease-granted' && e.waitedMs > 1000) addLine(v, 'note', `推論スロット待ち ${fmtMs(e.waitedMs)}`)
  }
  v.summary.textContent = `ツールの実行ログ（${v.toolCount} 回）`
}

async function attachStream(task) {
  if (state.streams.has(task.id)) return
  const controller = new AbortController()
  state.streams.set(task.id, controller)
  const follow = !TERMINAL.has(task.status)
  try {
    const res = await fetch(`/v1/tasks/${task.id}/events${follow ? '?follow=1' : ''}`, { credentials: 'same-origin', signal: controller.signal })
    if (res.status === 401) return sessionExpired()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    const box = $('#messages')
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop()
      const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120
      for (const line of lines) if (line.trim()) onEvent(task, JSON.parse(line))
      if (nearBottom && follow) box.scrollTop = box.scrollHeight
    }
  } catch (error) {
    if (error.name !== 'AbortError') hint(`ログの取得に失敗: ${error.message}`, true)
  } finally {
    state.streams.delete(task.id)
  }
  if (follow && state.current && state.tasks.includes(task)) {
    const { task: fresh } = await api('GET', `/v1/tasks/${task.id}`).catch(() => ({ task }))
    Object.assign(task, fresh)
    updateTaskHead(task)
    updateComposer()
    loadConversations().catch(() => {})
  }
}

// ---------------------------------------------------------------- composer
function lastTask() {
  return state.tasks.at(-1)
}

function updateComposer() {
  const last = lastTask()
  const busy = last && !TERMINAL.has(last.status)
  $('#send').disabled = Boolean(busy) || state.sessionExpired
  $('#stop').hidden = !busy
  $('#switch-model').hidden = !(busy && last.status === 'running' && modelChanged())
  hint(busy ? (last.status === 'queued' ? '前のタスクが終わると開始します（キュー待ち）' : 'このタスクの実行中です') : '')
}

function renderAttachments() {
  $('#attachments').replaceChildren(
    ...state.attachments.map((a, i) =>
      el('span', { class: 'chip' }, `📄 ${a.path}`, el('button', { type: 'button', 'aria-label': '外す', text: '✕', onclick: () => { state.attachments.splice(i, 1); renderAttachments() } }))),
  )
}

async function uploadFiles(files) {
  const workspace = $('#workspace').value.trim()
  if (!workspace) return hint('先に作業フォルダを指定してください', true)
  for (const file of files) {
    hint(`${file.name} をアップロード中…`)
    try {
      const saved = await api('POST', `/v1/uploads?workspace=${encodeURIComponent(workspace)}&name=${encodeURIComponent(file.name)}`, file)
      state.attachments.push({ name: file.name, path: saved.path })
      renderAttachments()
      hint('')
    } catch (error) {
      hint(`アップロード失敗: ${error.message}`, true)
    }
  }
}

async function send(event) {
  event?.preventDefault()
  const text = $('#prompt').value.trim()
  if (!text || $('#send').disabled) return
  let prompt = text
  if (state.attachments.length) prompt += `\n\n添付ファイル（作業フォルダ内）:\n${state.attachments.map(a => `- ${a.path}`).join('\n')}`
  const mode = $('#mode').value
  $('#send').disabled = true
  try {
    let task
    const last = lastTask()
    if (state.current && last?.sessionId) ({ task } = await api('POST', `/v1/tasks/${last.id}/resume`, { prompt, mode, ...(modelChanged() ? { model: $('#model').value } : {}) }))
    else {
      const workspace = $('#workspace').value.trim()
      localStorage.setItem('hearth.workspace', workspace)
      ;({ task } = await api('POST', '/v1/tasks', { prompt, mode, model: $('#model').value, workspace, source: 'gui', ...(state.current ? { conversationId: state.current } : {}) }))
    }
    $('#prompt').value = ''
    autoGrow()
    state.attachments = []
    renderAttachments()
    if (!state.current) {
      await openConversation(task.conversationId ?? task.id)
    } else {
      state.tasks.push(task)
      $('#messages').append(renderTurn(task))
      attachStream(task)
      $('#messages').scrollTop = $('#messages').scrollHeight
    }
  } catch (error) {
    hint(`送信できませんでした: ${error.message}`, true)
  } finally {
    updateComposer()
  }
}

/** Whether the model picker differs from the model of the conversation's last task. */
function modelChanged() {
  const last = lastTask()
  if (!last) return false
  const chosen = $('#model').value
  if (chosen.endsWith('/auto')) return !chosen.startsWith(`${last.provider}/`) || !isLoaded(`${last.provider}/${last.model}`)
  return chosen !== `${last.provider}/${last.model}`
}

function isLoaded(id) {
  return state.models.find(m => m.id === id)?.available !== false
}

function selectModel(id) {
  const select = $('#model')
  if (![...select.options].some(o => o.value === id)) select.append(el('option', { value: id, text: id }))
  select.value = id
}

/** Stop the running task and continue the same session with the chosen model. */
async function switchRunningModel() {
  const last = lastTask()
  if (!last) return
  $('#switch-model').disabled = true
  hint('タスクを止めて、選んだモデルで続きを実行します…')
  try {
    const { task } = await api('POST', `/v1/tasks/${last.id}/resume`, { model: $('#model').value, interrupt: true, mode: $('#mode').value })
    const { task: stopped } = await api('GET', `/v1/tasks/${last.id}`)
    Object.assign(last, stopped)
    updateTaskHead(last)
    state.tasks.push(task)
    $('#messages').append(renderTurn(task))
    attachStream(task)
    hint(`${task.provider}/${task.model} で続きを実行中`)
  } catch (error) {
    hint(`切り替えできませんでした: ${error.message}`, true)
  } finally {
    $('#switch-model').disabled = false
    updateComposer()
  }
}

async function refreshModels() {
  hint('モデル一覧を取得中…')
  try {
    await loadOptions(true)
    const loaded = state.models.filter(m => m.available).map(m => m.name)
    hint(loaded.length ? `読み込み中: ${loaded.join(', ')}` : 'モデル一覧を更新しました')
  } catch (error) {
    hint(`モデル一覧を取得できませんでした: ${error.message}`, true)
  }
}

async function cancelTask(id) {
  try {
    await api('POST', `/v1/tasks/${id}/cancel`)
    hint('キャンセルを要求しました')
  } catch (error) {
    hint(`キャンセル失敗: ${error.message}`, true)
  }
}

function autoGrow() {
  const t = $('#prompt')
  t.style.height = 'auto'
  t.style.height = `${Math.min(t.scrollHeight, window.innerHeight * 0.4)}px`
}

// ---------------------------------------------------------------- status, resources, settings
async function refreshStatus() {
  if (document.hidden || state.sessionExpired) return
  try {
    const [s, r] = await Promise.all([api('GET', '/v1/status'), api('GET', '/v1/resources')])
    const pills = []
    const busy = s.inference.active.length
    pills.push(el('span', { class: `pill${busy ? ' busy' : ''}`, text: `推論 ${busy}/${s.inference.maxConcurrent}${s.inference.waiting.length ? ` 待ち${s.inference.waiting.length}` : ''}` }))
    pills.push(el('span', { class: `pill${s.queue.running.length ? ' busy' : ''}`, text: `タスク ${s.queue.running.length} 実行 / ${s.queue.queued.length} 待機` }))
    if (r.cpu.usagePct !== null) pills.push(el('span', { class: 'pill', text: `CPU ${r.cpu.usagePct}%` }))
    pills.push(el('span', { class: 'pill', text: `RAM ${r.memory.usagePct}%` }))
    for (const g of r.gpus) pills.push(el('span', { class: 'pill', text: `GPU ${g.utilizationPct}% · ${(g.memoryUsedMiB / 1024).toFixed(1)}/${(g.memoryTotalMiB / 1024).toFixed(1)}GB` }))
    $('#status-pills').replaceChildren(...pills)
    if ($('#settings').open) renderResources(s, r)
  } catch (error) {
    $('#status-pills').replaceChildren(el('span', { class: 'pill err', text: `デーモン接続エラー: ${error.message}` }))
  }
}

function meter(label, pct, detail) {
  const fill = el('div', { class: 'fill' })
  fill.style.width = `${Math.max(0, Math.min(100, pct ?? 0))}%`
  return el('div', { class: 'meter' }, el('div', { text: `${label}: ${detail}` }), el('div', { class: 'bar' }, fill))
}

function renderResources(s, r) {
  const gb = b => (b / 1024 ** 3).toFixed(1)
  $('#resources').replaceChildren(...[
    meter('CPU', r.cpu.usagePct, r.cpu.usagePct === null ? '計測中' : `${r.cpu.usagePct}%（${r.cpu.cores} スレッド）`),
    meter('メモリ', r.memory.usagePct, `${gb(r.memory.usedBytes)} / ${gb(r.memory.totalBytes)} GB`),
    ...r.gpus.flatMap(g => [
      meter(`${g.name} 使用率`, g.utilizationPct, `${g.utilizationPct}%・${g.temperatureC}°C`),
      meter(`${g.name} VRAM`, (g.memoryUsedMiB / g.memoryTotalMiB) * 100, `${(g.memoryUsedMiB / 1024).toFixed(1)} / ${(g.memoryTotalMiB / 1024).toFixed(1)} GB`),
    ]),
    r.gpuUnavailable ? el('p', { class: 'muted', text: r.gpuUnavailable }) : null,
  ].filter(Boolean))
  const lines = [
    `推論スロット: ${s.inference.active.length}/${s.inference.maxConcurrent} 使用中、待ち ${s.inference.waiting.length}`,
    ...s.inference.active.map(l => `  使用中: ${l.taskId}（${fmtMs(Date.now() - l.grantedAt)}）`),
    `タスク: 実行中 ${s.queue.running.length}/${s.queue.maxConcurrent}、待機 ${s.queue.queued.length}`,
    `累計: ${Object.entries(s.counts).map(([k, v]) => `${STATUS_LABEL[k]?.[0] ?? k} ${v}`).join('、')}`,
  ]
  $('#queue-detail').replaceChildren(...lines.map(l => el('div', { text: l })))
}

const SETTING_FIELDS = [
  ['defaultMode', '既定のモード', () => state.modes.map(m => m.name)],
  ['defaultModel', '既定のモデル', () => [...state.autoModels.map(m => m.id), ...state.models.map(m => m.id)]],
  ['queue.maxConcurrentTasks', '同時実行タスク数', null, 'number'],
  ['queue.maxConcurrentInference', '同時推論数', null, 'number'],
  ['security.deleteMode', '削除の扱い（backup / deny / allow）', () => ['backup', 'deny', 'allow']],
  ['web.search', 'Web 検索', () => ['none', 'searxng', 'duckduckgo']],
  ['web.searxngURL', 'SearXNG の URL', null, 'text'],
]

async function openSettings() {
  $('#settings').showModal()
  $('#settings-msg').textContent = ''
  try {
    const { file, values } = await api('GET', '/v1/settings')
    $('#settings-file').textContent = `保存先: ${file}（その他の項目はこのファイルを直接編集）`
    $('#settings-grid').replaceChildren(
      ...SETTING_FIELDS.map(([key, label, options, type]) => {
        const input = options
          ? el('select', { 'data-key': key }, ...options().map(o => el('option', { value: o, text: o, selected: String(values[key]) === o })))
          : el('input', { 'data-key': key, type, value: values[key] ?? '', min: type === 'number' ? '1' : undefined, max: type === 'number' ? '8' : undefined })
        return el('label', {}, label, input)
      }),
    )
  } catch (error) {
    $('#settings-msg').textContent = error.message
  }
  refreshStatus()
}

async function saveSettings() {
  const patch = {}
  for (const input of $('#settings-grid').querySelectorAll('[data-key]')) patch[input.dataset.key] = input.type === 'number' ? Number(input.value) : input.value
  try {
    await api('PATCH', '/v1/settings', patch)
    $('#settings-msg').textContent = '保存しました（次のタスクから反映）'
    await loadOptions()
  } catch (error) {
    $('#settings-msg').textContent = `保存できませんでした: ${error.message}`
  }
}

async function loadOptions(refresh = false) {
  const previous = $('#model').value
  const [models, modes, ws] = await Promise.all([api('GET', `/v1/models${refresh ? '?refresh=1' : ''}`), api('GET', '/v1/modes'), api('GET', '/v1/workspaces')])
  state.models = models.models
  state.autoModels = models.auto
  state.modes = modes.modes
  state.workspaceDefault = ws.default
  const label = m => `${m.name}${m.available === false ? '（未ロード）' : m.available ? '（読み込み中）' : ''}`
  $('#model').replaceChildren(
    ...models.auto.map(m => el('option', { value: m.id, text: m.name })),
    ...models.models.map(m => el('option', { value: m.id, text: label(m) })),
  )
  selectModel(previous && [...$('#model').options].some(o => o.value === previous) ? previous : state.current && lastTask() ? `${lastTask().provider}/${lastTask().model}` : models.default)
  $('#mode').replaceChildren(...modes.modes.map(m => el('option', { value: m.name, text: `${m.name}（最大 ${m.maxSteps} ステップ）`, selected: m.name === modes.default })))
  $('#workspace-list').replaceChildren(...[...new Set([...ws.recent, ...ws.allowedRoots])].map(w => el('option', { value: w })))
  if (!state.current && !$('#workspace').value) $('#workspace').value = localStorage.getItem('hearth.workspace') || ws.default
}

// ---------------------------------------------------------------- wiring
function init() {
  $('#composer').addEventListener('submit', send)
  $('#prompt').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) send(e)
  })
  $('#prompt').addEventListener('input', autoGrow)
  $('#file-input').addEventListener('change', e => {
    uploadFiles([...e.target.files])
    e.target.value = ''
  })
  $('#messages').addEventListener('dragover', e => e.preventDefault())
  $('#messages').addEventListener('drop', e => {
    e.preventDefault()
    if (e.dataTransfer?.files?.length) uploadFiles([...e.dataTransfer.files])
  })
  $('#new-chat').addEventListener('click', newConversation)
  $('#stop').addEventListener('click', () => lastTask() && cancelTask(lastTask().id))
  $('#switch-model').addEventListener('click', switchRunningModel)
  $('#refresh-models').addEventListener('click', refreshModels)
  $('#model').addEventListener('change', updateComposer)
  $('#open-sidebar').addEventListener('click', () => setSidebar(true))
  $('#close-sidebar').addEventListener('click', () => setSidebar(false))
  $('#scrim').addEventListener('click', () => setSidebar(false))
  $('#open-settings').addEventListener('click', openSettings)
  $('#save-settings').addEventListener('click', saveSettings)
  $('#logout').addEventListener('click', async () => {
    await api('POST', '/v1/logout').catch(() => {})
    sessionExpired()
    $('#settings').close()
  })
  loadOptions()
    .then(() => loadConversations())
    .then(() => {
      const id = new URLSearchParams(location.hash.slice(1)).get('c')
      if (id) openConversation(id)
    })
    .catch(error => hint(error.message, true))
  refreshStatus()
  setInterval(refreshStatus, 3000)
  setInterval(() => !document.hidden && !state.sessionExpired && loadConversations().catch(() => {}), 10000)
}

init()
