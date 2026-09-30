/**
 * List DSH sessions with their ids, titles and project, so a GUI title can be
 * matched to the session id Telegram uses.
 *
 *   node tools/list-sessions.mjs                 sessions (subagent ones hidden)
 *   node tools/list-sessions.mjs --all           include subagent sessions
 *   node tools/list-sessions.mjs --telegram      only messenger sessions (msgw-…)
 *   node tools/list-sessions.mjs --id <session>  details for one session
 *   node tools/list-sessions.mjs --json          machine readable
 *
 * Sessions created by subagents (`delegationDepth > 0`) are activity of a parent
 * session, so they are hidden unless --all is given.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, listStoredSessions, shortWhen } from '../lib/session-index.js'

const args = process.argv.slice(2)
const wantJson = args.includes('--json')
const includeSubagents = args.includes('--all')
const onlyTelegram = args.includes('--telegram')
const idIndex = args.indexOf('--id')
const wantedId = idIndex === -1 ? undefined : args[idIndex + 1]
const limitIndex = args.indexOf('--limit')
const limit = limitIndex === -1 ? 0 : Number(args[limitIndex + 1]) || 0

const home = dshHome()

/** project title per session id, from the workspace registry */
const projects = (() => {
  try {
    const raw = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
    const out = new Map()
    for (const w of Object.values(raw?.tables?.workspaces || {})) {
      for (const id of w.sessionIds || []) out.set(id, { title: w.title, path: w.path })
    }
    return out
  } catch {
    return new Map()
  }
})()

const all = listStoredSessions({ home, includeSubagents: true })
let out = all
if (wantedId) out = all.filter((r) => r.id === wantedId || r.id.startsWith(wantedId))
else {
  out = includeSubagents ? all : all.filter((r) => !r.subagent)
  if (onlyTelegram) out = out.filter((r) => r.telegram)
}
if (limit > 0) out = out.slice(0, limit)

const pad = (text, width) => {
  const s = String(text ?? '')
  return s.length > width ? `${s.slice(0, width - 1)}…` : s.padEnd(width)
}
const source = (r) => (r.telegram ? 'Telegram' : r.subagent ? '↳ 子agent' : 'GUI')

if (wantJson) {
  console.log(JSON.stringify({ count: out.length, sessions: out.map((r) => ({ ...r, project: projects.get(r.id)?.title || '' })) }, null, 2))
} else if (wantedId) {
  if (!out.length) {
    console.log(`找不到 session:${wantedId}`)
    process.exit(1)
  }
  for (const r of out) {
    console.log(`session id : ${r.id}`)
    console.log(`標題       : ${r.title || '(無標題)'}`)
    console.log(`工作區     : ${projects.get(r.id)?.title || '(未歸屬)'}${projects.get(r.id)?.path ? `  ${projects.get(r.id).path}` : ''}`)
    console.log(`執行目錄   : ${r.cwd || '?'}`)
    console.log(`最後活動   : ${shortWhen(r.lastActivity)}`)
    console.log(`來源       : ${source(r)}${r.subagent ? `(depth ${r.depth},屬於上層 session)` : ''}`)
  }
} else {
  const hidden = all.filter((r) => r.subagent).length
  console.log(`\n共 ${all.length} 條 session${includeSubagents ? '' : `,已隱藏 ${hidden} 條子 agent 的(用 --all 顯示)`}${out.length !== all.length ? `,顯示 ${out.length} 條` : ''}\n`)
  console.log(`  ${pad('工作區', 16)}${pad('來源', 12)}${pad('最後活動', 13)}${pad('session id', 42)}標題`)
  console.log(`  ${'-'.repeat(83)}${'-'.repeat(24)}`)
  for (const r of out) {
    console.log(`  ${pad(projects.get(r.id)?.title || '(未歸屬)', 16)}${pad(source(r), 12)}${pad(shortWhen(r.lastActivity), 13)}${pad(r.id, 42)}${pad(r.title, 30)}`)
  }
  console.log('\n提示:Telegram 內用 /status 看目前所在話題的 session id,/sessions 列出可接續的;')
  console.log('      --telegram 只列 Telegram 的,--all 含子 agent,--json 給程式用。\n')
}

process.exit(0)
