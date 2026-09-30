/**
 * Offline checks for the chat -> session binding (default vs attached) and for
 * the stored-session index used by /sessions and /attach.
 *
 *   node test/check-session-binding.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { createChatSessionStore } from '../lib/workspace-store.js'
import { baseName, filterByCwd, findStoredSession, listStoredSessions, samePath } from '../lib/session-index.js'

const here = dirname(fileURLToPath(import.meta.url))
const tmp = join(here, 'fixtures-binding')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

let pass = 0
const ok = (label, condition) => {
  if (condition) {
    pass += 1
    console.log(`  ✅ ${label}`)
  } else {
    console.error(`  ❌ ${label}`)
    process.exitCode = 1
  }
}

const KEY = '-100:403'

/* default session --------------------------------------------------------- */
const file = join(tmp, 'chat-sessions.json')
const store = createChatSessionStore(file)
ok('新聊天沒有綁定', store.effective(KEY) === undefined)
store.setDefault(KEY, 'msgw-default')
ok('預設 session 被記住', store.effective(KEY) === 'msgw-default')
ok('沒有 attached', store.attachedOf(KEY) === undefined)

/* attach wins ------------------------------------------------------------- */
store.attach(KEY, 'session-gui-1')
ok('attach 後走 attached', store.effective(KEY) === 'session-gui-1')
ok('預設沒被覆蓋', store.defaultOf(KEY) === 'msgw-default')
store.setDefault(KEY, 'msgw-default-2')
ok('setDefault 不會蓋掉 attached', store.effective(KEY) === 'session-gui-1' && store.defaultOf(KEY) === 'msgw-default-2')

/* detach ------------------------------------------------------------------ */
store.detach(KEY)
ok('detach 後回到預設', store.effective(KEY) === 'msgw-default-2')

/* persistence across restarts --------------------------------------------- */
const reopened = createChatSessionStore(file)
ok('重開後綁定還在', reopened.effective(KEY) === 'msgw-default-2')

/* v1 (bare string) migration --------------------------------------------- */
const legacy = join(tmp, 'legacy.json')
writeFileSync(legacy, JSON.stringify({ version: 1, bindings: { '-100:1': 'msgw-old' } }), 'utf8')
const migrated = createChatSessionStore(legacy)
ok('v1 字串遷移成 default', migrated.defaultOf('-100:1') === 'msgw-old' && migrated.effective('-100:1') === 'msgw-old')
const rewritten = JSON.parse(readFileSync(legacy, 'utf8'))
ok('遷移後寫回 v2', rewritten.version === 2 && rewritten.bindings['-100:1'].defaultSessionId === 'msgw-old')
migrated.remove('-100:1')
ok('remove 清掉整個聊天綁定', migrated.effective('-100:1') === undefined)

/* session index ----------------------------------------------------------- */
const fakeHome = join(tmp, 'dshhome')
mkdirSync(join(fakeHome, 'storages', 'session_projcache', 'sessions'), { recursive: true })
const cache = (id, title) => writeFileSync(
  join(fakeHome, 'storages', 'session_projcache', 'sessions', `${id}.json`),
  JSON.stringify({ record: { rows: { title: { val: title } } } }),
  'utf8',
)
/** A real session log: one zstd frame with the header, plus a second frame. */
const writeLog = (id, { cwd, delegationDepth }) => {
  const dir = join(fakeHome, 'sessions', '--slug--', id)
  mkdirSync(dir, { recursive: true })
  const header = Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id, createdAt: Date.now(), cwd, isSeeded: false, delegationDepth })}\n`, 'utf8')
  const body = Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: 4, data: { turn: 1 } })}\n`, 'utf8')
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([zstdCompressSync(header), zstdCompressSync(body)]))
}

writeLog('msgw-aaa', { cwd: 'C:\\ws', delegationDepth: 0 })
writeLog('session-bbb', { cwd: 'C:\\ws2', delegationDepth: 0 })
writeLog('sub-ccc', { cwd: 'C:\\ws2', delegationDepth: 1 })
cache('msgw-aaa', '我的測試對話')
cache('session-bbb', 'GUI 任務')
cache('sub-ccc', '子 agent 任務')

const list = listStoredSessions({ home: fakeHome })
ok('索引列出 2 個 session(子 agent 隱藏)', list.length === 2)
ok('索引讀到標題(cache)與目錄(log header)', list.some((s) => s.id === 'msgw-aaa' && s.title === '我的測試對話' && s.cwd === 'C:\\ws'))
ok('Telegram 標記正確', list.find((s) => s.id === 'msgw-aaa').telegram === true && list.find((s) => s.id === 'session-bbb').telegram === false)
const withAll = listStoredSessions({ home: fakeHome, includeSubagents: true })
ok('includeSubagents 會列出子 agent', withAll.length === 3 && withAll.find((s) => s.id === 'sub-ccc').subagent === true)
ok('子 agent 的 depth 是 1', withAll.find((s) => s.id === 'sub-ccc').depth === 1)
ok('上層 session 的 depth 是 0', withAll.find((s) => s.id === 'session-bbb').depth === 0 && withAll.find((s) => s.id === 'session-bbb').subagent === false)
ok('可用 id 前幾碼找到', findStoredSession('msgw-a', { home: fakeHome })?.id === 'msgw-aaa')
ok('可用去掉 session- 後的前幾碼找到', findStoredSession('bbb', { home: fakeHome })?.id === 'session-bbb')
ok('可用標題片段找到(不分大小寫)', findStoredSession('gui 任務', { home: fakeHome })?.id === 'session-bbb')
ok('找不到時回 undefined', findStoredSession('nope-nope', { home: fakeHome }) === undefined)
ok('預設找不到子 agent', findStoredSession('sub-ccc', { home: fakeHome }) === undefined)
ok('明確要求才找得到子 agent', findStoredSession('sub-ccc', { home: fakeHome, includeSubagents: true })?.id === 'sub-ccc')

/* workspace scoping: /sessions only shows the topic's own workspace --------- */
ok('同樣路徑(大小寫/斜線/結尾)相等', samePath('C:\\Users\\Me\\WS', 'c:/users/me/ws/'))
ok('不同路徑不相等', !samePath('C:\\a', 'C:\\b'))
ok('空值不相等', !samePath('', 'C:\\a'))
const scopedList = filterByCwd(
  [{ id: 'x', cwd: 'C:\\ws' }, { id: 'y', cwd: 'C:/WS/' }, { id: 'z', cwd: 'C:\\other' }],
  'c:\\ws',
)
ok('filterByCwd 只留同工作區', scopedList.length === 2 && scopedList.every((s) => s.id !== 'z'))
ok('沒有 cwd 時回傳全部', filterByCwd([{ id: 'x' }], undefined).length === 1)
ok('baseName 取最後一段', baseName('C:\\Users\\Me\\雜七雜八') === '雜七雜八')

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} 項通過${process.exitCode ? '(有失敗)' : ''}`)
assert.ok(pass >= 17, 'expected at least 17 checks')
