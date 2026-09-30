import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Atomic JSON write; same approach as the pairing store. */
function writeJsonAtomicSync(filePath, data) {
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = `${filePath}.${randomUUID().slice(0, 8)}.tmp`
  try {
    writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8')
    renameSync(tmpPath, filePath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* best-effort temp cleanup */ }
    throw err
  }
}

const emptyState = () => ({ version: 1, forumChatId: '', bindings: {} })

const normalizeThreadId = (threadId) => {
  const n = Number(threadId)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/**
 * Durable map of DSH workspace -> Telegram forum topic.
 *
 * `bindings[workspaceId] = { chatId, threadId, title, path, closed }`
 *
 * The store is deliberately independent of the plugin settings document: the
 * forum can be adopted from a chat command (/ws sync), and thread ids must
 * survive both host restarts and settings rewrites.
 */
export function createWorkspaceTopicsStore(filePath, { logger } = {}) {
  let state = emptyState()

  if (filePath && existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'))
      if (raw && typeof raw === 'object') {
        state = {
          version: 1,
          forumChatId: raw.forumChatId === undefined || raw.forumChatId === null ? '' : String(raw.forumChatId),
          bindings: raw.bindings && typeof raw.bindings === 'object' && !Array.isArray(raw.bindings) ? raw.bindings : {},
        }
      }
    } catch (err) {
      logger?.warn?.(`[dsh-messenger-gateway] workspace-topics store read error: ${err?.message || err}`)
    }
  }

  const persist = () => {
    if (!filePath) return
    try {
      writeJsonAtomicSync(filePath, state)
    } catch (err) {
      logger?.warn?.(`[dsh-messenger-gateway] workspace-topics store persist error: ${err?.message || err}`)
    }
  }

  return {
    getForumChatId: () => state.forumChatId,

    /**
     * Adopt a forum. Changing the forum invalidates every recorded thread id,
     * because a thread id is only meaningful inside one chat.
     * @returns true when the forum changed.
     */
    setForumChatId(chatId) {
      const next = String(chatId ?? '').trim()
      if (next === state.forumChatId) return false
      if (state.forumChatId) state.bindings = {}
      state.forumChatId = next
      persist()
      return true
    },

    all: () => Object.entries(state.bindings).map(([workspaceId, rec]) => ({ workspaceId, ...rec })),

    byWorkspace: (workspaceId) => {
      const rec = state.bindings[String(workspaceId)]
      return rec ? { workspaceId: String(workspaceId), ...rec } : null
    },

    byThread(chatId, threadId) {
      const tid = normalizeThreadId(threadId)
      if (!tid) return null
      const cid = String(chatId ?? '')
      for (const [workspaceId, rec] of Object.entries(state.bindings)) {
        if (normalizeThreadId(rec.threadId) === tid && String(rec.chatId) === cid) {
          return { workspaceId, ...rec }
        }
      }
      return null
    },

    set(workspaceId, rec) {
      state.bindings[String(workspaceId)] = {
        chatId: String(rec.chatId ?? ''),
        threadId: normalizeThreadId(rec.threadId),
        title: String(rec.title ?? ''),
        path: String(rec.path ?? ''),
        closed: Boolean(rec.closed),
      }
      persist()
    },

    markClosed(workspaceId) {
      const rec = state.bindings[String(workspaceId)]
      if (!rec) return
      rec.closed = true
      persist()
    },

    markOpen(workspaceId) {
      const rec = state.bindings[String(workspaceId)]
      if (!rec) return
      rec.closed = false
      persist()
    },

    remove(workspaceId) {
      if (state.bindings[String(workspaceId)]) {
        delete state.bindings[String(workspaceId)]
        persist()
      }
    },

    /** Drop every binding but keep the adopted forum. */
    clear() {
      const dropped = Object.keys(state.bindings).length
      state.bindings = {}
      persist()
      return dropped
    },

    size: () => Object.keys(state.bindings).length,
  }
}

/**
 * Durable chat/topic -> session binding.
 *
 * Each conversation keeps a `defaultSessionId` (created on the first Telegram
 * message and resumed across host restarts and idle reaps) plus an optional
 * `attachedSessionId`: a session the user picked with /attach to continue from
 * Telegram. While attached, the attachment wins; /detach returns to the default.
 *
 * v1 stored a bare session id string and is migrated on load.
 */
export function createChatSessionStore(filePath, { logger } = {}) {
  /** @type {Record<string, {defaultSessionId?: string, attachedSessionId?: string}>} */
  let bindings = {}

  const normalize = (value) => {
    if (typeof value === 'string' && value) return { defaultSessionId: value }
    if (value && typeof value === 'object') {
      const out = {}
      if (typeof value.defaultSessionId === 'string' && value.defaultSessionId) out.defaultSessionId = value.defaultSessionId
      if (typeof value.attachedSessionId === 'string' && value.attachedSessionId) out.attachedSessionId = value.attachedSessionId
      return out
    }
    return {}
  }

  let version = 2
  let migrated = false
  if (filePath && existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'))
      if (raw?.bindings && typeof raw.bindings === 'object' && !Array.isArray(raw.bindings)) {
        for (const [key, value] of Object.entries(raw.bindings)) {
          if (typeof value === 'string') migrated = true
          bindings[key] = normalize(value)
        }
      }
    } catch (err) {
      logger?.warn?.(`[dsh-messenger-gateway] chat-session store read error: ${err?.message || err}`)
    }
  }

  const persist = () => {
    if (!filePath) return
    try {
      writeJsonAtomicSync(filePath, { version, bindings })
    } catch (err) {
      logger?.warn?.(`[dsh-messenger-gateway] chat-session store persist error: ${err?.message || err}`)
    }
  }

  const update = (threadKey, mutate) => {
    const key = String(threadKey)
    const next = { ...(bindings[key] || {}) }
    mutate(next)
    const empty = !next.defaultSessionId && !next.attachedSessionId
    if (empty) delete bindings[key]
    else bindings[key] = next
    persist()
  }

  if (migrated) persist()

  return {
    /** Which session this chat talks to right now: attachment wins. */
    effective: (threadKey) => {
      const rec = bindings[String(threadKey)]
      return rec?.attachedSessionId || rec?.defaultSessionId
    },
    get: (threadKey) => bindings[String(threadKey)],
    defaultOf: (threadKey) => bindings[String(threadKey)]?.defaultSessionId,
    attachedOf: (threadKey) => bindings[String(threadKey)]?.attachedSessionId,
    /** Remember the Telegram-owned session for this chat (never overwrites an attachment). */
    setDefault(threadKey, sessionId) {
      const value = String(sessionId)
      if (bindings[String(threadKey)]?.defaultSessionId === value) return
      update(threadKey, (rec) => { rec.defaultSessionId = value })
    },
    attach(threadKey, sessionId) {
      const value = String(sessionId)
      if (bindings[String(threadKey)]?.attachedSessionId === value) return
      update(threadKey, (rec) => { rec.attachedSessionId = value })
    },
    /** Leave the attached session; the default (if any) is untouched. */
    detach(threadKey) {
      if (!bindings[String(threadKey)]?.attachedSessionId) return
      update(threadKey, (rec) => { delete rec.attachedSessionId })
    },
    /** Forget everything for this chat: the next message creates a new default. */
    remove(threadKey) {
      if (bindings[String(threadKey)] === undefined) return
      delete bindings[String(threadKey)]
      persist()
    },
    size: () => Object.keys(bindings).length,
  }
}
