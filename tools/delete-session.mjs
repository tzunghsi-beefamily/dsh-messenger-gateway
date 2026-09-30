/**
 * Delete a stored DSH session (the Web GUI only archives, the Host has no delete
 * API). By default the session is MOVED to a trash folder so it can be restored;
 * --purge deletes it permanently.
 *
 *   node tools/delete-session.mjs --id msgw-6d972543 --dry-run
 *   node tools/delete-session.mjs --id 48c35e00 --yes
 *   node tools/delete-session.mjs --id 48c35e00 --purge --yes
 *
 * What it touches (nothing else):
 *   ~/.dsh/sessions/<workspace-slug>/<session-id>/          -> moved / removed
 *   ~/.dsh/storages/session_projcache/sessions/<id>.json    -> moved / removed
 * The stale id left in workspace.json is harmless: the registry filters ids whose
 * session path no longer exists, so the session disappears from the GUI too.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, listStoredSessions } from '../lib/session-index.js'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args[i + 1]
}
const wantJson = flag('--json')
const dryRun = flag('--dry-run')
const purge = flag('--purge')
const confirmed = flag('--yes')

const query = value('--id') ?? args.find((a) => !a.startsWith('--'))
const home = dshHome()

const out = (line) => console.log(line)
if (!query) {
  out('用法:node tools/delete-session.mjs --id <session-id|前幾碼|標題片段> [--purge] [--dry-run] [--yes]')
  out('  預設把 session 移到 ~/.dsh/session-trash/(可還原),--purge 才是永久刪除。')
  process.exit(2)
}

const all = listStoredSessions({ home, includeSubagents: true })
const lower = String(query).toLowerCase()
const matches = all.filter((s) => s.id === query)
  .concat(all.filter((s) => s.id !== query && s.id.startsWith(String(query))))
  .concat(all.filter((s) => !s.id.startsWith(String(query)) && (s.title || '').toLowerCase().includes(lower)))

if (!matches.length) {
  out(`找不到符合「${query}」的 session。`)
  process.exit(1)
}
if (matches.length > 1) {
  out(`「${query}」符合 ${matches.length} 條,請用更精確的 id 前幾碼:`)
  for (const m of matches) out(`  ${m.id}  ${m.title || '(無標題)'}${m.subagent ? '  ↳子agent' : ''}`)
  process.exit(1)
}

const target = matches[0]
const sessionDir = findSessionDir(home, target.id)
const cacheFile = join(home, 'storages', 'session_projcache', 'sessions', `${target.id}.json`)
const trashRoot = join(home, 'session-trash')

/** Locate the session directory (workspace slug is not part of the id). */
function findSessionDir(homeDir, id) {
  const root = join(homeDir, 'sessions')
  if (!existsSync(root)) return undefined
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug, id)
    try {
      if (statSync(dir).isDirectory()) return dir
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

/** Is the messenger gateway still bound to this session? */
function telegramBound() {
  try {
    const raw = JSON.parse(readFileSync(join(home, 'messenger-gateway', 'chat-sessions.json'), 'utf8'))
    return Object.entries(raw?.bindings || {})
      .filter(([, rec]) => rec?.defaultSessionId === target.id || rec?.attachedSessionId === target.id)
      .map(([key]) => key)
  } catch {
    return []
  }
}

const plan = {
  session: { id: target.id, title: target.title, cwd: target.cwd, subagent: target.subagent, depth: target.depth },
  dir: sessionDir,
  cacheFile: existsSync(cacheFile) ? cacheFile : undefined,
  mode: purge ? 'purge' : 'trash',
  dryRun,
  warnings: [],
}

if (!sessionDir) plan.warnings.push('找不到 session 資料夾(可能已刪除)')
for (const key of telegramBound()) plan.warnings.push(`Telegram 綁定 ${key} 仍指向這條 session(刪除後會退回預設/新建)`)
if (target.subagent) plan.warnings.push(`這是子 agent 的 session(depth ${target.depth})`)
try {
  const res = await fetch('http://127.0.0.1:3080/dsh-messenger-gateway/status', { signal: AbortSignal.timeout(2500) })
  if (res.ok) plan.warnings.push('DSH 正在執行:若這條 session 正在使用,請先關掉它(重啟後再刪)')
} catch {
  /* DSH not running: ideal */
}

if (dryRun) {
  if (wantJson) console.log(JSON.stringify({ ...plan, applied: false, dryRun: true }, null, 2))
  else {
    out('🔎 dry-run:只顯示會做什麼,不會動任何檔案')
    out(`  session : ${target.id}`)
    out(`  標題    : ${target.title || '(無標題)'}`)
    out(`  模式    : ${purge ? '永久刪除 --purge' : '移到 ~/.dsh/session-trash(可還原)'}`)
    out(`  資料夾  : ${sessionDir || '(不存在)'}`)
    out(`  投影快取: ${plan.cacheFile || '(無)'}`)
    for (const w of plan.warnings) out(`  ⚠️ ${w}`)
  }
  process.exit(0)
}

if (!confirmed) {
  if (wantJson) console.log(JSON.stringify({ ...plan, applied: false, needsYes: true }, null, 2))
  else {
    out('將執行以下動作(加 --yes 才會真的做):')
    out(`  session : ${target.id}`)
    out(`  標題    : ${target.title || '(無標題)'}`)
    out(`  模式    : ${purge ? '永久刪除 --purge' : '移到 ~/.dsh/session-trash(可還原)'}`)
    out(`  資料夾  : ${sessionDir || '(不存在)'}`)
    for (const w of plan.warnings) out(`  ⚠️ ${w}`)
  }
  process.exit(3)
}

// apply --------------------------------------------------------------------
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
let movedTo
if (sessionDir) {
  if (purge) rmSync(sessionDir, { recursive: true, force: true })
  else {
    const dest = join(trashRoot, stamp, target.id)
    mkdirSync(join(trashRoot, stamp), { recursive: true })
    renameSync(sessionDir, dest)
    movedTo = dest
  }
}
let cacheMoved
if (plan.cacheFile) {
  if (purge) rmSync(plan.cacheFile, { force: true })
  else {
    const dest = join(trashRoot, stamp, `projcache-${target.id}.json`)
    mkdirSync(join(trashRoot, stamp), { recursive: true })
    renameSync(plan.cacheFile, dest)
    cacheMoved = dest
  }
}

if (wantJson) {
  console.log(JSON.stringify({ ...plan, applied: true, movedTo, cacheMoved }, null, 2))
} else {
  out(purge ? '🗑️ 已永久刪除:' : '📦 已移到回收區(可還原):')
  out(`  ${target.id}  ${target.title || '(無標題)'}`)
  if (movedTo) out(`  ${movedTo}`)
  if (cacheMoved) out(`  ${cacheMoved}`)
  if (!purge) out(`\n要還原:把 ${movedTo} 搬回 ${sessionDir}`)
  out('提示:GUI 清單若還顯示它,重啟一次 DSH 就會乾淨。')
}
