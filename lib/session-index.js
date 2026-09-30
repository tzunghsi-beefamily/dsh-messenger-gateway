/**
 * Read-only index of stored DSH sessions, used by `/sessions` and `/attach`.
 *
 * The session id is the directory name under `~/.dsh/sessions/<workspace>/`; the
 * human title and cwd come from the session projection cache. Nothing is written.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

const safeDirs = (dir) => {
  try {
    return readdirSync(dir).filter((name) => {
      try {
        return statSync(join(dir, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return []
  }
}

const readMeta = (cacheDir, id) => {
  try {
    const record = JSON.parse(readFileSync(join(cacheDir, `${id}.json`), 'utf8'))?.record || {}
    const title = typeof record?.rows?.title?.val === 'string' ? record.rows.title.val : ''
    const cwd = typeof record?.identity?.cwd === 'string' ? record.identity.cwd : ''
    return { title, cwd }
  } catch {
    return { title: '', cwd: '' }
  }
}

const mtimeOf = (dir) => {
  try {
    return statSync(dir).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Stored sessions, newest first.
 * @param {{home?: string, limit?: number, telegramOnly?: boolean}} [options]
 * @returns {Array<{id: string, title: string, cwd: string, lastActivity: number, telegram: boolean}>}
 */
export function listStoredSessions({ home = dshHome(), limit = 0, telegramOnly = false } = {}) {
  const sessionsRoot = join(home, 'sessions')
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  if (!existsSync(sessionsRoot)) return []
  const out = []
  for (const slug of safeDirs(sessionsRoot)) {
    const slugDir = join(sessionsRoot, slug)
    for (const id of safeDirs(slugDir)) {
      if (telegramOnly && !id.startsWith('msgw-')) continue
      const meta = readMeta(cacheDir, id)
      out.push({ id, title: meta.title, cwd: meta.cwd, lastActivity: mtimeOf(join(slugDir, id)), telegram: id.startsWith('msgw-') })
    }
  }
  out.sort((a, b) => b.lastActivity - a.lastActivity)
  return limit > 0 ? out.slice(0, limit) : out
}

/** Exact id, then id prefix, then title fragment (case-insensitive). */
export function findStoredSession(query, options = {}) {
  const q = String(query ?? '').trim()
  if (!q) return undefined
  const list = listStoredSessions({ limit: 200, ...options })
  const lower = q.toLowerCase()
  return list.find((s) => s.id === q)
    || list.find((s) => s.id.startsWith(q))
    || list.find((s) => (s.title || '').toLowerCase().includes(lower))
}

/** Does this session exist on disk? Used to validate /attach before switching. */
export function sessionExists(id, { home = dshHome() } = {}) {
  const wanted = String(id)
  return listStoredSessions({ home }).some((s) => s.id === wanted)
}

/** "09-30 14:43" in local time. */
export function shortWhen(ms) {
  if (!ms) return '?'
  try {
    return new Date(ms).toLocaleString('sv-SE').slice(5, 16)
  } catch {
    return '?'
  }
}
