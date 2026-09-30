/**
 * Offline verification of the workspace -> Telegram topic mirror.
 *
 * Uses a fake workspace registry and a fake Telegram adapter, so it exercises
 * the real WorkspaceTopics code without touching a bot, a profile, or the
 * user's DSH host.
 *
 *   node test/check-workspace-topics.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkspaceTopics } from '../lib/workspace-topics.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = join(here, 'fixtures')
rmSync(fixtureRoot, { recursive: true, force: true })
for (const name of ['EFT-ADMIN', '雜七雜八', 'Report']) mkdirSync(join(fixtureRoot, name), { recursive: true })
const storeFile = join(here, 'store-test.json')
rmSync(storeFile, { force: true })

const FORUM = '-1001234567890'

let projects = [
  { id: 'w1', title: 'EFT-ADMIN', path: join(fixtureRoot, 'EFT-ADMIN') },
  { id: 'w2', title: '雜七雜八', path: join(fixtureRoot, '雜七雜八') },
  { id: 'w3', title: 'NSA價格上傳', path: join(fixtureRoot, 'Report') },
]

const warnings = []
const calls = []
const topicsByName = new Map()
const closedTopics = new Set()
let nextThread = 100

const adapter = {
  async createForumTopic(chatId, name) {
    const threadId = nextThread++
    calls.push({ op: 'create', chatId, name, threadId })
    topicsByName.set(threadId, name)
    return { message_thread_id: threadId }
  },
  async editForumTopic(chatId, threadId, name) {
    calls.push({ op: 'edit', threadId, name })
    if (!topicsByName.has(threadId)) throw new Error('Bad Request: message thread not found')
    topicsByName.set(threadId, name)
  },
  async closeForumTopic(chatId, threadId) {
    calls.push({ op: 'close', threadId })
    closedTopics.add(threadId)
  },
  async reopenForumTopic(chatId, threadId) {
    calls.push({ op: 'reopen', threadId })
    if (!topicsByName.has(threadId)) throw new Error('Bad Request: message thread not found')
    closedTopics.delete(threadId)
  },
}

const makeGw = () => ({
  config: {
    telegram: {
      workspaceTopics: { enabled: true, forumChatId: FORUM, reconcileIntervalMs: 60_000, closeOnRemove: true },
    },
  },
  logger: { info() {}, debug() {}, warn: (...a) => warnings.push(a.map(String).join(' ')) },
  ctx: { get: (name) => (name === 'workspaceRegistry' ? { list: () => projects } : undefined) },
  getAdapter: (p) => (p === 'telegram' ? adapter : null),
})

const results = []
const check = async (label, fn) => {
  try {
    await fn()
    results.push(['PASS', label])
  } catch (err) {
    results.push(['FAIL', label, err?.message || String(err)])
  }
}

const wt = new WorkspaceTopics(makeGw(), { filePath: storeFile })

// 1. first pass creates one topic per workspace
let s = await wt.reconcile()
await check('初次同步:3 個工作區 → 建立 3 個話題', () => {
  assert.equal(s.created, 3)
  assert.equal(s.total, 3)
  assert.equal(s.errors, 0)
  assert.equal(wt.store.size(), 3)
})
await check('話題名稱等於工作區 title', () => {
  assert.deepEqual([...topicsByName.values()].sort(), ['EFT-ADMIN', '雜七雜八', 'NSA價格上傳'].sort())
})

// 2. idempotent
const callsBefore = calls.length
s = await wt.reconcile()
await check('重複同步幂等:不再呼叫 Telegram', () => {
  assert.equal(calls.length, callsBefore)
  assert.equal(s.created + s.renamed + s.closed + s.reopened, 0)
})

// 3. rename
projects = projects.map((p) => (p.id === 'w3' ? { ...p, title: '標準化格式' } : p))
s = await wt.reconcile()
await check('title 改變 → 話題自動改名', () => {
  assert.equal(s.renamed, 1)
  const rec = wt.store.byWorkspace('w3')
  assert.equal(rec.title, '標準化格式')
  assert.equal(topicsByName.get(rec.threadId), '標準化格式')
})

// 4. remove -> close (never delete)
projects = projects.filter((p) => p.id !== 'w2')
s = await wt.reconcile()
await check('移除工作區 → 關閉話題,話題本身保留', () => {
  assert.equal(s.closed, 1)
  const rec = wt.store.byWorkspace('w2')
  assert.equal(rec.closed, true)
  assert.ok(closedTopics.has(rec.threadId))
  assert.ok(topicsByName.has(rec.threadId), '話題不應被刪除')
})

// 5. restore -> reopen the same topic
projects = [...projects, { id: 'w2', title: '雜七雜八', path: join(fixtureRoot, '雜七雜八') }]
s = await wt.reconcile()
await check('工作區回來 → 重開同一個話題', () => {
  assert.equal(s.reopened, 1)
  const rec = wt.store.byWorkspace('w2')
  assert.equal(rec.closed, false)
  assert.ok(!closedTopics.has(rec.threadId))
})

// 6. cwd resolution
const recW1 = wt.store.byWorkspace('w1')
await check('cwdForChat → 該話題對應的工作區路徑', () => {
  assert.equal(wt.cwdForChat({ chatId: FORUM, threadId: recW1.threadId }), join(fixtureRoot, 'EFT-ADMIN'))
})
await check('General 話題(無 threadId)不綁定', () => {
  assert.equal(wt.cwdForChat({ chatId: FORUM, threadId: 0 }), undefined)
})
await check('其他群組的相同 threadId 不會誤綁', () => {
  assert.equal(wt.cwdForChat({ chatId: '-999999', threadId: recW1.threadId }), undefined)
})

// 7. missing directory falls back and warns
projects = [...projects, { id: 'w9', title: '已刪除的資料夾', path: join(fixtureRoot, 'does-not-exist') }]
await wt.reconcile()
const recW9 = wt.store.byWorkspace('w9')
await check('資料夾不存在 → 退回 undefined 並留下警告', () => {
  assert.equal(wt.cwdForChat({ chatId: FORUM, threadId: recW9.threadId }), undefined)
  assert.ok(warnings.some((w) => w.includes('does-not-exist')), '應有缺路徑警告')
})

// 8. duplicate title gets a suffix (defensive; DSH itself enforces unique titles)
projects = [...projects, { id: 'w10', title: 'EFT-ADMIN', path: join(fixtureRoot, '雜七雜八') }]
s = await wt.reconcile()
await check('同名 title → 加尾綴避免 Telegram 衝突', () => {
  const rec = wt.store.byWorkspace('w10')
  assert.equal(topicsByName.get(rec.threadId), 'EFT-ADMIN (2)')
})

// 9. durability across instances (host restart)
const wt2 = new WorkspaceTopics(makeGw(), { filePath: storeFile })
await check('對照表持久化:新實例(模擬重啟)讀得到', () => {
  assert.equal(wt2.store.size(), wt.store.size())
  assert.equal(wt2.store.byWorkspace('w1').path, join(fixtureRoot, 'EFT-ADMIN'))
  assert.equal(wt2.cwdForChat({ chatId: FORUM, threadId: recW1.threadId }), join(fixtureRoot, 'EFT-ADMIN'))
})

// 10. topic deleted by hand -> binding pruned, then rebuilt
topicsByName.delete(recW1.threadId)
projects = projects.map((p) => (p.id === 'w1' ? { ...p, title: 'EFT-ADMIN 改名' } : p))
s = await wt.reconcile()
await check('話題被人手動刪除 → 清掉綁定', () => {
  assert.equal(wt.store.byWorkspace('w1'), null)
})
s = await wt.reconcile()
await check('下一輪自動重建該話題', () => {
  assert.equal(s.created, 1)
  assert.ok(wt.store.byWorkspace('w1')?.threadId, '應重新綁定')
})

// 11. human-facing descriptions never throw
await check('/ws 與 /ws list 的文字輸出可用', () => {
  const one = wt.describeTopic(FORUM, wt.store.byWorkspace('w2').threadId)
  const all = wt.describeAll()
  assert.ok(one.includes('雜七雜八'))
  assert.ok(all.includes('工作區'))
  assert.ok(!one.includes('undefined'))
})

// report
console.log('\n=== 結果 ===')
for (const [status, label, detail] of results) {
  console.log(`${status === 'PASS' ? '✅' : '❌'} ${label}${detail ? `  → ${detail}` : ''}`)
}
const failed = results.filter((r) => r[0] === 'FAIL').length
console.log(`\n${results.length - failed}/${results.length} 通過`)
console.log('\n=== Telegram API 呼叫序列 ===')
for (const c of calls) console.log('  ', JSON.stringify(c))
if (warnings.length) {
  console.log('\n=== 警告 ===')
  for (const w of warnings) console.log('  ', w)
}
process.exitCode = failed ? 1 : 0
