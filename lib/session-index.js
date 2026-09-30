/**
 * Read-only index of stored DSH sessions, used by `/sessions` and `/attach`.
 *
 * The session id is the directory name under `~/.dsh/sessions/<workspace>/`; the
 * human title and cwd come from the session projection cache. Nothing is written.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Read only the session log's first zstd frame (the `{"type":"session",…}` header)
 * so subagent-created sessions can be recognised by `delegationDepth` without
 * decompressing a whole conversation.
 */
export function readSessionHeader(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(65536)
    const read = readSync(fd, head, 0, head.length, 0)
    const buf = head.subarray(0, read)
    const first = buf.indexOf(ZSTD_MAGIC)
    if (first !== 0) return undefined
    const second = buf.indexOf(ZSTD_MAGIC, 4)
    const frame = second === -1 ? buf : buf.subarray(0, second)
    const text = zstdDecompressSync(frame).toString('utf8')
    const line = text.split('\n').find((l) => l.trim())
    return line ? JSON.parse(line) : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* ignore */
      }
    }
  }
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
 * Stored sessions, newest first. Sessions created by subagents
 * (`delegationDepth > 0`) are hidden unless `includeSubagents` is set: they are
 * activity of a parent session, not something to switch to.
 * @param {{home?: string, limit?: number, telegramOnly?: boolean, includeSubagents?: boolean}} [options]
 * @returns {Array<{id: string, title: string, cwd: string, depth: number, subagent: boolean, lastActivity: number, telegram: boolean}>}
 */
export function listStoredSessions({ home = dshHome(), limit = 0, telegramOnly = false, includeSubagents = false } = {}) {
  const sessionsRoot = join(home, 'sessions')
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  if (!existsSync(sessionsRoot)) return []
  const out = []
  for (const slug of safeDirs(sessionsRoot)) {
    const slugDir = join(sessionsRoot, slug)
    for (const id of safeDirs(slugDir)) {
      if (telegramOnly && !id.startsWith('msgw-')) continue
      const dir = join(slugDir, id)
      const header = readSessionHeader(join(dir, 'session.v4.jsonl.zstd'))
      const depth = Number.isFinite(header?.delegationDepth) ? header.delegationDepth : 0
      const subagent = depth > 0
      if (subagent && !includeSubagents) continue
      const meta = readMeta(cacheDir, id)
      out.push({
        id,
        title: meta.title,
        cwd: meta.cwd || (typeof header?.cwd === 'string' ? header.cwd : ''),
        depth,
        subagent,
        lastActivity: mtimeOf(dir),
        telegram: id.startsWith('msgw-'),
      })
    }
  }
  out.sort((a, b) => b.lastActivity - a.lastActivity)
  return limit > 0 ? out.slice(0, limit) : out
}

/** Exact id, id prefix, prefix without the `session-` head, or title fragment. */
export function findStoredSession(query, options = {}) {
  const q = String(query ?? '').trim()
  if (!q) return undefined
  const list = listStoredSessions({ limit: 200, ...options })
  const lower = q.toLowerCase()
  return list.find((s) => s.id === q)
    || list.find((s) => s.id.startsWith(q))
    || list.find((s) => s.id.replace(/^session-/, '').startsWith(q))
    || list.find((s) => (s.title || '').toLowerCase().includes(lower))
}

/**
 * Compare two workspace paths the way Windows resolves them: separators,
 * trailing slashes and case are all ignored.
 */
export function samePath(a, b) {
  if (!a || !b) return false
  const norm = (value) => String(value).replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** Sessions that ran in this directory — scopes /sessions to one workspace. */
export function filterByCwd(sessions, cwd) {
  if (!cwd) return sessions
  return sessions.filter((s) => samePath(s.cwd, cwd))
}

/** Last path segment, for showing a workspace name. */
export function baseName(dir) {
  const parts = String(dir ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(dir ?? '')
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
