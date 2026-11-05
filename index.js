'use strict'
/*
 * dsh-session-mailbox
 * ==================================================================
 * A file-based mailbox plus push notification between DSH sessions.
 * Multi-workspace: no project-specific path is hard-coded.
 *
 * Tools (all prefixed `mailbox_*`):
 *   - mailbox_send     : drop a message into the current workspace mailbox.
 *   - mailbox_read     : read pending messages (and archive them).
 *   - mailbox_sessions : list LIVE sessions.
 *   - mailbox_notify   : push a message into another session and wake it up.
 *
 * MAILBOX RESOLUTION
 *   The mailbox is resolved on every call from the WORKSPACE of the session
 *   that runs the tool (never from a project-specific constant):
 *     workspace = ctx.agents.currentInitiator()?.session.header.cwd
 *   - absolute `config.folder` → used as-is (explicit override).
 *   - relative `config.folder` → resolved against the session workspace.
 *   - absent                   → default `_dsh-mailbox` in the workspace.
 *   `process.cwd()` of the host process IS the profile directory, not the
 *   workspace: it is only a last-resort fallback.
 *
 * ORIGIN METADATA
 *   A notified message carries its originating session:
 *     source: { kind:'agent-message', form:'relay', senderSessionId }
 *   The chat UI renders this source as a collapsible "trigger" node (agent
 *   icon, "From session {id}"). The model-facing content is prefixed with
 *   "Message received from session {id}: ".
 *
 * VERIFIED CONTRACTS
 *   - ctx.sessions.list() → Session[] (a method; there is no .getSnapshot()).
 *   - ctx.agents.get(id) → live Agent; agent.followup(msg) → push + wake.
 *   - ctx.agents.currentInitiator() → the calling Agent (the sender session).
 *   - UserMessage = { role:'user', content:[{type:'text',text}],
 *                     source:{...}, id:uuid } (built via node:crypto).
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

exports.name = 'session-mailbox'
exports.inject = ['tools', 'sessions', 'agents', 'sessionTitle']

const DEFAULT_MAILBOX = '_dsh-mailbox'

function log (message) {
  const line = '[' + new Date().toISOString() + '] (pid ' + process.pid + ') ' + message + '\n'
  try { fs.appendFileSync(path.join(__dirname, 'mailbox.log'), line) } catch (_) {}
}

function ensureMailboxDirs (root) {
  fs.mkdirSync(root, { recursive: true })
  const read = path.join(root, '_read')
  fs.mkdirSync(read, { recursive: true })
  return read
}

function schema (properties, required) {
  return { type: 'object', properties: properties, required: required || [], additionalProperties: false }
}

// `render` must return CONTENT BLOCKS, not a plain string.
const OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: function (args, value) {
    let text
    try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) } catch (_) { text = String(value) }
    return [{ type: 'text', text: text }]
  }
}

function getSessionsService (ctx) {
  if (ctx && ctx.sessions) return ctx.sessions
  try { if (typeof ctx.get === 'function') return ctx.get('sessions') } catch (_) {}
  return null
}

function sessionTitle (ctx, session) {
  try {
    if (ctx && ctx.sessionTitle && typeof ctx.sessionTitle.get === 'function') {
      const t = ctx.sessionTitle.get(session)
      if (t && typeof t.title === 'string' && t.title) return t.title
    }
  } catch (_) {}
  return null
}

function agentStatusMap (ctx) {
  const byId = {}
  try {
    if (ctx && ctx.agents && typeof ctx.agents.list === 'function') {
      for (const a of ctx.agents.list()) {
        try { byId[a.id] = a.status } catch (_) {}
      }
    }
  } catch (_) {}
  return byId
}

function listSessions (ctx) {
  try {
    const service = getSessionsService(ctx)
    if (!service || typeof service.list !== 'function') {
      return { ok: false, reason: 'sessions service not injected (add sessions to exports.inject)' }
    }
    const sessions = service.list() // Session[]
    const statusById = agentStatusMap(ctx)
    const items = sessions.map(function (s) {
      const header = (s && s.header) || {}
      return {
        id: s.id,
        title: sessionTitle(ctx, s),
        folder: header.cwd || null,
        createdAt: header.createdAt || null,
        status: statusById[s.id] || null
      }
    })
    return { ok: true, sessions: items }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
}

// The Agent running the tool (AsyncLocalStorage) is the sender session.
function senderSessionId (ctx) {
  try {
    if (ctx && ctx.agents && typeof ctx.agents.currentInitiator === 'function') {
      const agent = ctx.agents.currentInitiator()
      return (agent && agent.id) ? String(agent.id) : null
    }
  } catch (_) {}
  return null
}

// The workspace of the current session (the one running the tool).
function sessionWorkspace (ctx) {
  try {
    if (ctx && ctx.agents && typeof ctx.agents.currentInitiator === 'function') {
      const agent = ctx.agents.currentInitiator()
      const cwd = agent && agent.session && agent.session.header && agent.session.header.cwd
      return (typeof cwd === 'string' && cwd) ? cwd : null
    }
  } catch (_) {}
  return null
}

// Recreates createUserMessage({ content, source }) from @deepseek-ai/dsh-llm.
function buildUserMessage (text, sender) {
  const body = String(text || '')
  const content = sender
    ? [{ type: 'text', text: 'Message received from session ' + sender + ': ' }, { type: 'text', text: body }]
    : [{ type: 'text', text: body }]
  return {
    role: 'user',
    content: content,
    source: sender
      ? { kind: 'agent-message', form: 'relay', senderSessionId: sender }
      : { kind: 'user' },
    id: crypto.randomUUID()
  }
}

function notifySession (ctx, sessionId, text) {
  try {
    if (!ctx || !ctx.agents || typeof ctx.agents.get !== 'function') {
      return { ok: false, reason: 'agents service not injected (add agents to exports.inject)' }
    }
    const target = String(sessionId || '').trim()
    if (!target) return { ok: false, reason: 'empty session id' }
    const agent = ctx.agents.get(target)
    if (!agent) return { ok: false, reason: 'unknown session or no live agent: ' + target }
    if (typeof agent.followup !== 'function') return { ok: false, reason: 'agent has no followup method' }
    const sender = senderSessionId(ctx)
    agent.followup(buildUserMessage(text, sender))
    return { ok: true, notified: target, sender: sender }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
}

exports.apply = function apply (ctx, config) {
  log('--- apply() ---')

  const configuredFolder = (config && typeof config.folder === 'string' && config.folder.trim()) || null

  // Resolve the mailbox root on EVERY call, from the current session's
  // workspace (never from process.cwd(), which is the profile directory).
  function resolveMailboxRoot (folderArg) {
    const raw = (folderArg && typeof folderArg === 'string' && folderArg.trim()) || configuredFolder || DEFAULT_MAILBOX
    if (path.isAbsolute(raw)) return raw
    const ws = sessionWorkspace(ctx)
    return ws ? path.join(ws, raw) : path.join(process.cwd(), raw)
  }

  try {
    if (!ctx.tools || typeof ctx.tools.register !== 'function') {
      log('FAIL: ctx.tools missing despite inject')
      return
    }

    ctx.tools.register({
      name: 'mailbox_send',
      description: 'Drop a message into the current workspace shared mailbox. Does not deliver into the recipient conversation (unless notifier=true): the recipient must read its mailbox.',
      parameters: schema({
        message: { type: 'string', description: 'The message to drop.' },
        recipient: { type: 'string', description: 'Target session id or name. Empty = all.' },
        folder: { type: 'string', description: 'Mailbox folder (optional; relative = inside the workspace).' },
        notifier: { type: 'boolean', description: 'If true, also push a notification into the target session conversation (recipient required).' }
      }, ['message']),
      output: OUTPUT,
      async execute (args) {
        const root = resolveMailboxRoot(args && args.folder)
        ensureMailboxDirs(root)
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const suffix = Math.random().toString(36).slice(2, 8)
        const file = path.join(root, timestamp + '-' + suffix + '.md')
        const body = [
          '---',
          'from: sender session (pid ' + process.pid + ')',
          'to: ' + (args.recipient || 'all'),
          'date: ' + new Date().toISOString(),
          '---',
          '',
          String(args.message || ''),
          ''
        ].join('\n')
        fs.writeFileSync(file, body, 'utf8')
        log('message dropped: ' + file)
        const result = { deposited: true, file: file, mailbox: root }
        if (args && args.notifier === true && args.recipient) {
          result.notification = notifySession(ctx, args.recipient,
            '[session-mailbox] A message is waiting: "' + String(args.message || '').slice(0, 300) + '" (read it with mailbox_read)')
        }
        return result
      }
    })
    log('tool registered: mailbox_send')

    ctx.tools.register({
      name: 'mailbox_read',
      description: 'Read pending messages in the current workspace shared mailbox, and archive them if requested.',
      parameters: schema({
        folder: { type: 'string', description: 'Mailbox folder (optional; relative = inside the workspace).' },
        archive: { type: 'boolean', description: 'Move read messages into _read/ (default: true).' }
      }, []),
      output: OUTPUT,
      async execute (args) {
        const root = resolveMailboxRoot(args && args.folder)
        const read = ensureMailboxDirs(root)
        const files = fs.readdirSync(root).filter(function (f) { return f.endsWith('.md') }).sort()
        if (files.length === 0) return { pending: 0, mailbox: root, messages: [] }
        const archive = args && args.archive === false ? false : true
        const messages = files.map(function (f) {
          const full = path.join(root, f)
          const content = fs.readFileSync(full, 'utf8')
          if (archive) { try { fs.renameSync(full, path.join(read, f)) } catch (_) {} }
          return { file: f, content: content }
        })
        log('messages read: ' + messages.length)
        return { pending: messages.length, mailbox: root, messages: messages }
      }
    })
    log('tool registered: mailbox_read')

    ctx.tools.register({
      name: 'mailbox_sessions',
      description: 'List LIVE DSH sessions (id, title, folder, created at, agent status).',
      parameters: schema({}, []),
      output: OUTPUT,
      async execute () { return listSessions(ctx) }
    })
    log('tool registered: mailbox_sessions')

    ctx.tools.register({
      name: 'mailbox_notify',
      description: 'Push a message into another live session and wake it up. The message carries the sender session in metadata (distinct UI rendering).',
      parameters: schema({
        session: { type: 'string', description: 'Target session id (see mailbox_sessions).' },
        message: { type: 'string', description: 'Message to deliver into the target conversation.' }
      }, ['session', 'message']),
      output: OUTPUT,
      async execute (args) {
        return notifySession(ctx, args.session, args.message)
      }
    })
    log('tool registered: mailbox_notify')
  } catch (e) {
    log('FAIL registering tools: ' + String((e && e.stack) || e))
    return
  }

  log('--- apply() done ---')
}
