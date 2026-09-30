/**
 * The Telegram command menu (the list you see after typing "/").
 * Curated for this fork: the everyday commands only — the full upstream set
 * (/pair, /sethome, /alert, /role, /cron, /fork, …) still works if typed.
 */
export const DEFAULT_TELEGRAM_COMMANDS = [
  { command: 'help', description: '指令說明' },
  { command: 'new', description: '開新 session(本話題的預設)' },
  { command: 'status', description: '目前 session / 模式 / 工作區' },
  { command: 'sessions', description: '列出本工作區的 session(可接續)' },
  { command: 'attach', description: '接續既有 session:/attach <編號|id|標題>' },
  { command: 'detach', description: '退出接續,回到預設 session' },
  { command: 'stop', description: '中斷目前回合' },
  { command: 'ws', description: '工作區話題:/ws list、/ws sync、/ws reset' },
  { command: 'model', description: '切換模型' },
  { command: 'files', description: '瀏覽工作區檔案:/files [目錄]' },
  { command: 'get', description: '下載檔案:/get <路徑>' },
  { command: 'export', description: '匯出對話為 Markdown' },
  { command: 'skills', description: '可用的工具與技能' },
  { command: 'tools', description: '可用的工具' },
  { command: 'remind', description: '設定提醒:/remind 15m 內容' },
  { command: 'voice', description: '語音回覆:/voice on|off|status' },
  { command: 'tts', description: '本聊天語音:/tts on|off|status' },
  { command: 'top', description: '主機資源使用量' },
  { command: 'whoami', description: '你的 Telegram 使用者 ID' },
  { command: 'update', description: '外掛更新狀態(本 fork 已停用自更新)' },
  { command: 'start', description: '連線並顯示問候' },
]

export function normalizeTelegramCommands(commands) {
  const source = Array.isArray(commands) && commands.length ? commands : DEFAULT_TELEGRAM_COMMANDS
  const out = []
  const seen = new Set()
  for (const raw of source) {
    if (!raw || typeof raw !== 'object') continue
    let command = String(raw.command || '').trim().replace(/^\//, '')
    const description = String(raw.description || '').trim()
    if (!command || !description) continue
    command = command.slice(0, 32).toLowerCase()
    if (seen.has(command)) continue
    seen.add(command)
    out.push({ command, description: description.slice(0, 256) })
  }
  return out.length ? out : [...DEFAULT_TELEGRAM_COMMANDS]
}

export function mergeDynamicCommands(baseCommands = DEFAULT_TELEGRAM_COMMANDS, dynamicCommands = [], maxTotal = 100) {
  const normalizedBase = normalizeTelegramCommands(baseCommands)
  const out = [...normalizedBase]
  const seen = new Set(out.map((c) => c.command))

  for (const item of dynamicCommands || []) {
    if (out.length >= maxTotal) break
    if (!item || typeof item !== 'object') continue
    let command = String(item.command || item.name || '').trim().replace(/^\//, '').toLowerCase()
    // Telegram format: lowercase alphanumeric and underscore only, 1-32 chars
    command = command.replace(/[^a-z0-9_]/g, '_').slice(0, 32)
    if (!command || seen.has(command)) continue
    let description = String(item.description || item.title || `Skill ${command}`).trim()
    if (!description) description = `Skill ${command}`
    description = description.slice(0, 256)
    seen.add(command)
    out.push({ command, description })
  }

  return out.slice(0, maxTotal)
}

export function buildQuickActionsKeyboard() {
  return {
    keyboard: [
      [{ text: '🔄 /new' }, { text: '🛑 /stop' }],
      [{ text: '📋 /sessions' }, { text: '↩️ /detach' }],
      [{ text: '🎙️ /voice' }, { text: '📊 /status' }],
    ],
    resize_keyboard: true,
  }
}

export const REMOVE_REPLY_KEYBOARD = { remove_keyboard: true }

export const HELP_TEXT = [
  '📖 <b>Messenger Gateway Help:</b>',
  '',
  '💬 <b>Session & Chat:</b>',
  '• /help — show this command reference',
  '• /new — start fresh session',
  '• /sessions [n] — list recent sessions with their ids',
  '• /attach <n|id|title> — continue an existing (e.g. GUI) session here',
  '• /detach — leave the attached session and go back to the default one',
  '• /stop — interrupt current response',
  '• /model — interactive model selector (/model list)',
  '• /role [name] — switch persona or role (/role list)',
  '• /bind [role] — bind persona to topic / chat',
  '• /preset [name] — bind preset to topic / chat',
  '• /lang [en|zh] — switch user language',
  '• /rewind [N] — rewind last N turns',
  '• /fork — fork session into new branch',
  '• /export — export history to Markdown',
  '',
  '🛠️ <b>Tools, Files & Cron:</b>',
  '• /skills / /tools — list active tools & skills',
  '• /files [dir] — workspace file explorer',
  '• /get <path> — download file from workspace',
  '• /remind <time> <text> — set reminder (/remind 10m check deploy)',
  '• /cron <interval> <prompt> — recurring autonomous task',
  '',
  '🗂 <b>Workspace topics:</b>',
  '• /ws — show the workspace bound to this topic',
  '• /ws list — list workspaces and their topics',
  '• /ws sync — adopt this supergroup and re-sync topics',
  '',
  '⚙️ <b>Settings & Stats:</b>',
  '• /status — gateway and active model status',
  '• /top — system resource usage (RAM, uptime)',
  '• /keyboard on|off — quick action keyboard',
  '• /voice on|off|status — voice replies preference',
  '• /tts on|off|status — speech synthesis in this chat',
  '• /mute / /unmute — mute notifications in this chat',
  '',
  '🔒 <b>Access & Channels:</b>',
  '• /whoami — your messenger user ID',
  '• /pair CODE — approve pairing code',
  '• /sethome [name] — set home notification channel',
  '• /setalert — set alert channel',
].join('\n')

/** Chinese help for this fork (the everyday commands and the fork-only features). */
export const HELP_TEXT_ZH = [
  '📖 <b>Messenger Gateway 指令說明</b>',
  '',
  '💬 <b>Session</b>',
  '• /help — 這份說明',
  '• /new — 開一個全新的預設 session(本話題)',
  '• /status — 目前 session、模式(default / attached)、工作區',
  '• /sessions [n] [all] [sub] — 列出 session(預設只列本工作區)',
  '• /attach &lt;編號|id 前幾碼|標題片段&gt; — 接續既有 session(例如 GUI 開的)',
  '• /detach — 退出接續,回到預設 session',
  '• /stop — 中斷目前回合',
  '• /model — 切換模型',
  '• /export — 匯出對話為 Markdown',
  '',
  '🗂 <b>工作區話題</b>',
  '• /ws — 顯示這個話題對應的工作區',
  '• /ws list — 工作區 ↔ 話題對照表',
  '• /ws sync — 依 DSH 工作區清單同步話題(GUI 新增工作區後打一次)',
  '• /ws reset — 清空對照表(話題被刪、或「話題」功能被關掉後使用)',
  '• /ws probe — 建一個測試話題並回報 API 原始結果(診斷用)',
  '',
  '🛠️ <b>檔案與工具</b>',
  '• /files [目錄] — 瀏覽工作區檔案',
  '• /get &lt;路徑&gt; — 把工作區的檔案傳到 Telegram',
  '• /skills、/tools — 目前可用的工具與技能',
  '',
  '⚙️ <b>其他</b>',
  '• /voice on|off|status — 語音回覆偏好',
  '• /tts on|off|status — 本聊天的語音',
  '• /remind 15m 內容 — 設定提醒',
  '• /top — 主機資源使用量',
  '• /whoami — 你的 Telegram 使用者 ID',
  '',
  '🔒 本 fork 已停用外掛自更新,/update 只會顯示狀態;更新請在插件目錄執行 git pull。',
  'ℹ️ 其他上游指令(/pair、/sethome、/alert、/role、/fork、/cron…)仍可直接輸入使用。',
].join('\n')



