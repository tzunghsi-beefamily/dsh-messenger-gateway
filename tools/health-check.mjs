/**
 * One-command health check for this fork.
 *
 *   node tools/health-check.mjs            human readable
 *   node tools/health-check.mjs --json     machine readable
 *
 * It verifies the DSH contracts this fork depends on, runs the offline test
 * suite, and inspects the runtime state files. Run it after every DSH update:
 * a DSH release can break a contract without anything in this repo changing.
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const jsonOut = process.argv.includes('--json')
const results = []

const record = (name, ok, detail = '', level = 'error') => {
  results.push({ name, ok, detail, level })
}

const read = (relPath) => {
  try {
    return readFileSync(join(root, relPath), 'utf8')
  } catch {
    return ''
  }
}

const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const stateDir = join(home, 'messenger-gateway')

/* 1. required files -------------------------------------------------------- */
const required = [
  'package.json',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/gateway.js',
  'lib/gateway-turn.js',
  'lib/workspace-topics.js',
  'lib/workspace-store.js',
  'lib/session-index.js',
  'lib/config.js',
  'lib/client.js',
  'test/check-workspace-topics.mjs',
]
const missing = required.filter((file) => !existsSync(join(root, file)))
record('必要檔案', missing.length === 0, missing.length ? `缺少 ${missing.join(', ')}` : `${required.length} 個都在`)

/* 2. syntax of every lib file --------------------------------------------- */
const walk = (dir) => readdirSync(dir).flatMap((entry) => {
  const full = join(dir, entry)
  if (statSync(full).isDirectory()) return walk(full)
  return entry.endsWith('.js') ? [full] : []
})
const libFiles = existsSync(join(root, 'lib')) ? walk(join(root, 'lib')) : []

const runQuiet = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true })
  child.on('error', () => resolve(-1))
  child.on('exit', (code) => resolve(code ?? -1))
})

const syntaxFailures = []
for (const file of libFiles) {
  const code = await runQuiet(['--check', file])
  if (code !== 0) syntaxFailures.push(file.slice(root.length + 1))
}
record('語法檢查', syntaxFailures.length === 0, syntaxFailures.length ? `失敗: ${syntaxFailures.join(', ')}` : `${libFiles.length} 個檔案`)

/* 3. the local fixes must still be present -------------------------------- */
const fixChecks = [
  ['設定指紋比對(避免無謂重建)', 'lib/index.js', /lastConfigFingerprint/],
  ['回合收集器跨 Gateway 共用', 'lib/gateway.js', /sharedActiveTurns/],
  ['續用 session 用 agents.resume', 'lib/gateway.js', /resumeSessionId/],
  ['訊息排隊(queueWhileBusy)', 'lib/gateway.js', /queueWhileBusy/],
  ['session 歸屬專案(attachSession)', 'lib/gateway.js', /attachSessionToWorkspace/],
  ['持久化話題→session', 'lib/workspace-store.js', /createChatSessionStore/],
  ['預設 + 接續 session 綁定', 'lib/workspace-store.js', /attachedSessionId/],
  ['Telegram session 掛上 agent preset(工具集)', 'lib/gateway.js', /presets\.mount/],
  ['session 索引(/sessions /attach)', 'lib/session-index.js', /listStoredSessions/],
  ['話題節流 + 429 重試', 'lib/workspace-topics.js', /parseRetryAfter/],
  ['話題→session 綁定', 'lib/workspace-store.js', /createWorkspaceTopicsStore/],
]
const missingFixes = fixChecks.filter(([, file, re]) => !re.test(read(file))).map(([label]) => label)
record('本 fork 的修正', missingFixes.length === 0, missingFixes.length ? `不見了: ${missingFixes.join('、')}` : `${fixChecks.length} 項都在`)

/* 4. config contract: the settings card can only persist volatile fields --- */
const configSource = read('lib/config.js')
const volatileCount = (configSource.match(/\.volatile\(\)/g) || []).length
record('設定區塊可寫(volatile)', volatileCount >= 6, `找到 ${volatileCount} 處 .volatile()(應 ≥ 6)`)

/* 5. runtime state files -------------------------------------------------- */
try {
  const topics = JSON.parse(readFileSync(join(stateDir, 'workspace-topics.json'), 'utf8'))
  const bindings = Object.values(topics.bindings || {})
  const closed = bindings.filter((b) => b.closed).length
  record('話題對照表', bindings.length > 0, `${bindings.length} 個話題 / ${closed} 個關閉 / forum=${topics.forumChatId || '(未認養)'}`)
} catch {
  record('話題對照表', false, `${join(stateDir, 'workspace-topics.json')} 讀不到(還沒跑過 /ws sync?)`, 'warn')
}

try {
  const sessions = JSON.parse(readFileSync(join(stateDir, 'chat-sessions.json'), 'utf8'))
  const n = Object.keys(sessions.bindings || {}).length
  record('話題→session 綁定', n > 0, `${n} 筆(每則訊息應沿用同一個 session)`, n > 0 ? 'error' : 'warn')
} catch {
  record('話題→session 綁定', false, '還沒有綁定檔(傳一則訊息後會產生)', 'warn')
}

try {
  const log = readFileSync(join(stateDir, 'events.log'), 'utf8').split('\n').filter(Boolean)
  const stopped = log.filter((l) => l.includes('gateway.stopped')).length
  const collectorYes = log.filter((l) => l.includes('collector=yes')).length
  record(
    '事件日誌',
    stopped === 0,
    stopped === 0
      ? `${log.length} 行 / collector=yes ${collectorYes} 行 / 沒有 gateway.stopped`
      : `出現 ${stopped} 次 gateway.stopped(設定變更又觸發重建?)`,
    stopped === 0 ? 'error' : 'warn',
  )
} catch {
  record('事件日誌', false, '還沒有 events.log(外掛啟動後才會有)', 'warn')
}

/* 6. live gateway (best effort) ------------------------------------------ */
const base = process.env.DSH_BASE_URL || 'http://127.0.0.1:3080'
try {
  const status = await (await fetch(`${base}/dsh-messenger-gateway/status`, { signal: AbortSignal.timeout(5000) })).json()
  record('外掛狀態', true, `uptime ${status.uptimeSec ?? '?'}s / activeChats ${status.activeChats ?? '?'} / sent ${status.stats?.sent ?? '?'} / errors ${status.stats?.errors ?? '?'}`)
} catch {
  record('外掛狀態', false, `連不上 ${base}/dsh-messenger-gateway/status(DSH 沒開?)`, 'warn')
}
try {
  const cfg = await (await fetch(`${base}/dsh-messenger-gateway/config`, { signal: AbortSignal.timeout(5000) })).json()
  const tg = cfg.config?.telegram || {}
  record(
    '設定',
    tg.enabled === true && tg.botTokenConfigured !== false,
    `telegram=${tg.enabled} botToken=${tg.botTokenConfigured ?? '?'} groups=${tg.groupsEnabled} requireMention=${tg.groupRequireMention} queueWhileBusy=${tg.queueWhileBusy ?? '(預設 true)'} autoReconcile=${tg.workspaceTopics?.autoReconcile}`,
  )
} catch {
  record('設定', false, '讀不到 /config', 'warn')
}

/* 7. offline test suite (inherits stdio so you can see its table) --------- */
const testFiles = ['test/check-workspace-topics.mjs', 'test/check-session-binding.mjs', 'test/check-telegram-format.mjs']
  .map((rel) => join(root, rel))
  .filter((file) => existsSync(file))
let testCode = 0
const testRan = []
for (const testFile of testFiles) {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [testFile], { stdio: 'inherit', windowsHide: true })
    child.on('error', () => resolve(-1))
    child.on('exit', (value) => resolve(value ?? -1))
  })
  testRan.push(`${testFile.slice(root.length + 1)}${code === 0 ? '' : ` (exit ${code})`}`)
  if (code !== 0) testCode = code
}
record('離線測試', testCode === 0 && testRan.length > 0, testRan.join(' + ') || '找不到測試檔')

/* report ------------------------------------------------------------------ */
const bad = results.filter((r) => !r.ok && r.level === 'error')
const warn = results.filter((r) => !r.ok && r.level === 'warn')

if (jsonOut) {
  console.log(JSON.stringify({ ok: bad.length === 0, results }, null, 2))
} else {
  console.log('\n=== DSH Telegram Gateway 健康檢查 ===\n')
  for (const r of results) {
    const icon = r.ok ? '✅' : r.level === 'warn' ? '⚠️ ' : '❌'
    console.log(`${icon} ${r.name}${r.detail ? `  — ${r.detail}` : ''}`)
  }
  console.log('')
  if (bad.length === 0 && warn.length === 0) console.log('結論:全部正常 ✅')
  else if (bad.length === 0) console.log(`結論:大體正常,但有 ${warn.length} 項提醒 ⚠️`)
  else console.log(`結論:有 ${bad.length} 項失敗,請看上面 ❌(對照 LOCAL-FIXES.md §2 的根因)`)
  console.log('')
}

process.exit(bad.length === 0 ? 0 : 1)
