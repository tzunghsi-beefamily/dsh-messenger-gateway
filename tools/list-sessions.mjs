/**
 * List DSH sessions with their ids, titles and project, so a GUI title can be
 * matched to the session id Telegram uses.
 *
 *   node tools/list-sessions.mjs                 all sessions
 *   node tools/list-sessions.mjs --telegram      only messenger sessions (msgw-…)
 *   node tools/list-sessions.mjs --id <session>  details for one session
 *   node tools/list-sessions.mjs --json          machine readable
 *
 * Data sources (nothing is modified):
 *   ~/.dsh/sessions/<workspace-slug>/<session-id>/       the session id is the directory name
 *   ~/.dsh/storages/session_projcache/sessions/<id>.json  title + cwd
 *   ~/.dsh/storages/workspace.json                        project -> session ids
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const args = process.argv.slice(2)
const wantJson = args.includes('--json')
const onlyTelegram = args.includes('--telegram')
const idIndex = args.indexOf('--id')
const wantedId = idIndex === -1 ? undefined : args[idIndex + 1]
const limitIndex = args.indexOf('--limit')
const limit = limitIndex === -1 ? 0 : Number(args[limitIndex + 1]) || 0

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const sessionsRoot = join(home, 'sessions')
const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
const workspaceFile = join(home, 'storages', 'workspace.json')

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** Title + cwd live in the projection cache, not in the GUI. */
const metaOf = (id) => {
  const cache = readJson(join(cacheDir, `${id}.json`))
  const record = cache?.record || {}
  const title = typeof record?.rows?.title?.val === 'string' ? record.rows.title.val : ''
  const cwd = typeof record?.identity?.cwd === 'string' ? record.identity.cwd : ''
  const createdAt = Number(record?.identity?.createdAt) || 0
  return { title, cwd, createdAt }
}

const workspaces = Object.values(readJson(workspaceFile)?.tables?.workspaces || {})
const projectOf = (id) => workspaces.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(id))

const rows = []
if (existsSync(sessionsRoot)) {
  for (const slug of readdirSync(sessionsRoot)) {
    const slugDir = join(sessionsRoot, slug)
    let entries = []
    try {
      if (!statSync(slugDir).isDirectory()) continue
      entries = readdirSync(slugDir)
    } catch {
      continue
    }
    for (const id of entries) {
      const dir = join(slugDir, id)
      let mtime = 0
      try {
        if (!statSync(dir).isDirectory()) continue
        mtime = statSync(dir).mtimeMs
      } catch {
        continue
      }
      const meta = metaOf(id)
      const project = projectOf(id)
      rows.push({
        id,
        title: meta.title,
        cwd: meta.cwd,
        createdAt: meta.createdAt,
        lastActivity: mtime,
        telegram: id.startsWith('msgw-'),
        project: project?.title || '',
        projectPath: project?.path || '',
      })
    }
  }
}

rows.sort((a, b) => b.lastActivity - a.lastActivity)
let out = rows
if (wantedId) out = rows.filter((r) => r.id === wantedId || r.id.startsWith(wantedId))
else if (onlyTelegram) out = rows.filter((r) => r.telegram)
if (limit > 0) out = out.slice(0, limit)

const pad = (text, width) => {
  const s = String(text ?? '')
  return s.length > width ? `${s.slice(0, width - 1)}…` : s.padEnd(width)
}
const when = (ms) => (ms ? new Date(ms).toLocaleString('sv-SE').slice(5, 16) : '?')

if (wantJson) {
  console.log(JSON.stringify({ count: out.length, sessions: out }, null, 2))
} else if (wantedId) {
  if (!out.length) {
    console.log(`找不到 session:${wantedId}`)
    process.exit(1)
  }
  for (const r of out) {
    console.log(`session id : ${r.id}`)
    console.log(`標題       : ${r.title || '(無標題)'}`)
    console.log(`工作區     : ${r.project || '(未歸屬)'}${r.projectPath ? `  ${r.projectPath}` : ''}`)
    console.log(`執行目錄   : ${r.cwd || '?'}`)
    console.log(`最後活動   : ${when(r.lastActivity)}`)
    console.log(`來源       : ${r.telegram ? 'Telegram' : 'GUI / 其他'}`)
  }
} else {
  console.log(`\n共 ${rows.length} 條 session${out.length !== rows.length ? `(顯示 ${out.length} 條)` : ''}\n`)
  console.log(`  ${pad('工作區', 16)}${pad('來源', 10)}${pad('最後活動', 13)}${pad('session id', 42)}標題`)
  console.log(`  ${'-'.repeat(16 + 10 + 13 + 42)}${'-'.repeat(24)}`)
  for (const r of out) {
    console.log(`  ${pad(r.project || '(未歸屬)', 16)}${pad(r.telegram ? 'Telegram' : 'GUI', 10)}${pad(when(r.lastActivity), 13)}${pad(r.id, 42)}${pad(r.title, 30)}`)
  }
  console.log('\n提示:Telegram 內用 /status 可看「你目前所在話題」的 session id;')
  console.log('      帶 --telegram 只列 Telegram 建立的,帶 --json 給程式用,帶 --id <前幾碼> 看單一條。\n')
}

process.exit(0)
