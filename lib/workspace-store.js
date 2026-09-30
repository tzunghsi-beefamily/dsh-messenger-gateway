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
 * Durable chat/topic -> session binding. A Telegram conversation keeps resuming
 * the same DSH session across host restarts and idle reaps; only an explicit
 * `/new` (or an unrecoverable session) starts a fresh one.
 */
export function createChatSessionStore(filePath, { logger } = {}) {
  let bindings = {}
  if (filePath && existsSync(filePath)) {
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'))
      if (raw?.bindings && typeof raw.bindings === 'object' && !Array.isArray(raw.bindings)) {
        bindings = raw.bindings
      }
    } catch (err) {
      logger?.warn?.(`[dsh-messenger-gateway] chat-session store read error: ${err?.message || err}`)
    }
  }

  const persist = () => {
    if (!filePath) return
    try {
      writeJsonAtomicSync(filePath, { version: 1, bindings })
    } catch (err) {
      logger?.warn?.(`[dsh-messenger-gateway] chat-session store persist error: ${err?.message || err}`)
    }
  }

  return {
    get: (threadKey) => bindings[String(threadKey)],
    set(threadKey, sessionId) {
      const key = String(threadKey)
      const value = String(sessionId)
      if (bindings[key] === value) return
      bindings[key] = value
      persist()
    },
    remove(threadKey) {
      const key = String(threadKey)
      if (bindings[key] === undefined) return
      delete bindings[key]
      persist()
    },
    size: () => Object.keys(bindings).length,
  }
}
