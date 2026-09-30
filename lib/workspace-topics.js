import { existsSync } from 'node:fs'
import { isTopicGoneError } from './telegram-errors.js'
import { createWorkspaceTopicsStore } from './workspace-store.js'

/** Telegram's own limit for forum topic names. */
const MAX_TOPIC_NAME = 128

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Telegram flood control reports `retry_after` (seconds) — honor it instead of hammering. */
function parseRetryAfter(err) {
  const m = String(err?.message || '').match(/retry[_ ]?after['":\s]+(\d+)/i)
  const seconds = m ? Number(m[1]) : NaN
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 120) : 0
}

function truncateName(title, suffix = '') {
  const base = String(title ?? '').trim() || 'workspace'
  const room = Math.max(0, MAX_TOPIC_NAME - suffix.length)
  return (base.length > room ? base.slice(0, room) : base) + suffix
}

/**
 * Mirrors the DSH workspace registry into Telegram forum topics.
 *
 * One workspace ⇄ one topic in a single forum supergroup. The topic's recorded
 * directory becomes the working directory of every session created inside that
 * topic, so the DSH session lands in the project it belongs to and shows up
 * under that project in the Web GUI.
 *
 * The registry is the single source of truth (workspaces are registered in the
 * GUI); this class never registers or removes a workspace. It only reconciles
 * the Telegram side: create a topic for a new workspace, rename it when the
 * title changes, close it when the workspace is removed, reopen it when the
 * same workspace comes back.
 */
export class WorkspaceTopics {
  constructor(gw, { filePath, logger } = {}) {
    this.gw = gw
    this.logger = logger || gw?.logger || console
    this.store = createWorkspaceTopicsStore(filePath, { logger: this.logger })
    this.timer = undefined
    this.running = false
    this.warnedNoRegistry = false
    this.warnedMissingPaths = new Set()
    this.stats = { created: 0, renamed: 0, closed: 0, reopened: 0, errors: 0, lastRun: 0 }
    this.lastSummary = null
  }

  get config() {
    return this.gw?.config?.telegram?.workspaceTopics || {}
  }

  get enabled() {
    return this.config.enabled === true
  }

  /** Configured forum wins over the adopted one, so a deployment can pin it. */
  forumChatId() {
    const fromConfig = String(this.config.forumChatId ?? '').trim()
    if (fromConfig) {
      this.store.setForumChatId(fromConfig)
      return fromConfig
    }
    return this.store.getForumChatId()
  }

  registry() {
    const ctx = this.gw?.ctx
    return ctx?.get?.('workspaceRegistry') || ctx?.workspaceRegistry || null
  }

  adapter() {
    return this.gw?.getAdapter?.('telegram') || null
  }

  async start() {
    if (!this.enabled) {
      this.logger?.info?.('dsh-messenger-gateway: workspace topic mirror disabled')
      return
    }
    const chatId = this.forumChatId()
    if (!chatId) {
      this.logger?.warn?.(
        'dsh-messenger-gateway: telegram.workspaceTopics.enabled is true but no forum is adopted yet — ' +
        'run /ws sync inside the topics-enabled supergroup to adopt it',
      )
      return
    }
    await this.reconcile().catch((err) => {
      this.logger?.warn?.(`dsh-messenger-gateway: workspace reconcile failed: ${err?.message || err}`)
    })
    const raw = Number(this.config.reconcileIntervalMs)
    const ms = Number.isFinite(raw) && raw >= 5000 ? raw : 60_000
    if (this.config.autoReconcile === true) {
      this.timer = setInterval(() => {
        this.reconcile().catch((err) => {
          this.logger?.warn?.(`dsh-messenger-gateway: workspace reconcile failed: ${err?.message || err}`)
        })
      }, ms)
      this.timer.unref?.()
    } else {
      this.logger?.info?.('dsh-messenger-gateway: periodic workspace sync is off (workspaceTopics.autoReconcile=false) — run /ws sync after changing workspaces')
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /**
   * Working directory for a session created from this chat/topic.
   * Returns undefined when the topic carries no live workspace binding, so the
   * caller falls back to the configured default.
   */
  cwdForChat(input) {
    if (!this.enabled || !input) return undefined
    const rec = this.store.byThread(input.chatId, input.threadId)
    if (!rec?.path) return undefined
    if (!existsSync(rec.path)) {
      if (!this.warnedMissingPaths.has(rec.path)) {
        this.warnedMissingPaths.add(rec.path)
        this.logger?.warn?.(
          `dsh-messenger-gateway: workspace directory for topic ${rec.threadId} is missing: ${rec.path} — ` +
          'sessions in that topic fall back to the default working directory',
        )
      }
      return undefined
    }
    return rec.path
  }

  /** Adopt a forum from a chat command; returns true when the forum changed. */
  adoptForum(chatId) {
    return this.store.setForumChatId(chatId)
  }

  describeTopic(chatId, threadId) {
    if (!this.enabled) {
      return '工作區話題同步未啟用。請在 DSH 設定把 <code>telegram.workspaceTopics.enabled</code> 設為 true。'
    }
    const forum = this.forumChatId()
    if (!forum) {
      return '尚未指定論壇。請在「已開啟話題的超級群組」裡打 <code>/ws sync</code>,我會把這個群組認養為工作區論壇。'
    }
    const rec = this.store.byThread(chatId, threadId)
    if (!rec) {
      return [
        '這個話題沒有對應任何工作區。',
        '• 到 Web GUI 新增/開啟工作區後,打 <code>/ws sync</code> 重新同步',
        '• <code>/ws list</code> 看目前所有對應',
      ].join('\n')
    }
    const exists = existsSync(rec.path)
    return [
      `📁 <b>${esc(rec.title)}</b>`,
      `<code>${esc(rec.path)}</code>`,
      `狀態:${rec.closed ? '已關閉' : '啟用中'}${exists ? '' : '(資料夾不存在,會退回預設目錄)'}`,
      '權限:沿用本機 DSH 的 permission 預設。',
    ].join('\n')
  }

  describeAll() {
    if (!this.enabled) return '工作區話題同步未啟用。'
    const bindings = new Map(this.store.all().map((rec) => [rec.workspaceId, rec]))
    let projects = []
    const registry = this.registry()
    if (registry?.list) {
      try {
        projects = registry.list() || []
      } catch (err) {
        return `讀取工作區註冊表失敗:${esc(err?.message || err)}`
      }
    }
    if (!projects.length) return '目前沒有任何已註冊的工作區(請先在 Web GUI 開啟資料夾)。'

    const lines = [`🗂 <b>工作區 → 話題</b>(論壇 <code>${esc(this.forumChatId() || '(未認養)')}</code>)`]
    for (const project of projects.slice(0, 40)) {
      const rec = bindings.get(String(project?.id ?? ''))
      const mark = !rec ? '⬜ 尚未同步' : (rec.closed ? '🔒 已關閉' : `✅ 話題 ${rec.threadId}`)
      lines.push(`• <b>${esc(project?.title || project?.path)}</b> — ${mark}`)
    }
    if (projects.length > 40) lines.push(`…共 ${projects.length} 個工作區`)
    return lines.join('\n')
  }

  /**
   * One reconciliation pass. Idempotent: safe to call at any time, and safe to
   * call concurrently (a second call is a no-op while one is running).
   */
  async reconcile({ force = false } = {}) {
    const summary = { ok: false, reason: '', total: 0, created: 0, renamed: 0, closed: 0, reopened: 0, errors: 0, errorDetails: [] }
    this.lastSummary = summary

    if (!this.enabled && !force) {
      summary.reason = 'disabled'
      return summary
    }
    const chatId = this.forumChatId()
    if (!chatId) {
      summary.reason = 'no-forum'
      return summary
    }
    const adapter = this.adapter()
    if (!adapter?.createForumTopic) {
      summary.reason = 'no-telegram-adapter'
      return summary
    }
    const registry = this.registry()
    if (!registry?.list) {
      if (!this.warnedNoRegistry) {
        this.warnedNoRegistry = true
        this.logger?.warn?.('dsh-messenger-gateway: workspaceRegistry service unavailable — workspace topic mirror idle')
      }
      summary.reason = 'no-workspace-registry'
      return summary
    }
    if (this.running) {
      summary.reason = 'busy'
      return summary
    }

    this.running = true
    try {
      let projects = []
      try {
        projects = registry.list() || []
      } catch (err) {
        summary.reason = 'registry-read-failed'
        summary.errors++
        this.logger?.warn?.(`dsh-messenger-gateway: workspaceRegistry.list failed: ${err?.message || err}`)
        return summary
      }

      const wanted = new Map()
      for (const project of projects) {
        const id = String(project?.id ?? '')
        const path = String(project?.path ?? '')
        if (!id || !path) continue
        wanted.set(id, { title: String(project?.title ?? '').trim() || path, path })
      }
      summary.total = wanted.size

      const usedNames = new Set(
        this.store.all()
          .filter((rec) => !rec.closed && rec.threadId)
          .map((rec) => String(rec.title)),
      )

      for (const [workspaceId, want] of wanted) {
        const rec = this.store.byWorkspace(workspaceId)

        // New workspace -> create its topic.
        if (!rec || !rec.threadId) {
          if (rec) this.store.remove(workspaceId)
          const name = this.uniqueName(want.title, usedNames)
          const delayMs = Number(this.config.createDelayMs)
          if (summary.created > 0 && Number.isFinite(delayMs) && delayMs > 0) await sleep(delayMs)
          try {
            const threadId = await this.createTopic(adapter, chatId, name)
            if (!threadId) throw new Error('createForumTopic returned no message_thread_id — 話題可能已經建好,但回應無法辨識')
            this.store.set(workspaceId, { chatId, threadId, title: name, path: want.path, closed: false })
            usedNames.add(name)
            summary.created++
            this.stats.created++
            this.logger?.info?.(`dsh-messenger-gateway: created topic "${name}" (${threadId}) for ${want.path}`)
          } catch (err) {
            summary.errors++
            this.stats.errors++
            const detail = `「${want.title}」→ ${err?.message || err}`
            if (summary.errorDetails.length < 3) summary.errorDetails.push(detail)
            this.logger?.warn?.(`dsh-messenger-gateway: createForumTopic failed: ${detail}`)
          }
          continue
        }

        // Binding belongs to a different forum (the forum was re-adopted).
        if (String(rec.chatId) !== String(chatId)) {
          this.store.remove(workspaceId)
          continue
        }

        // Workspace came back -> reopen its topic.
        if (rec.closed) {
          try {
            if (typeof adapter.reopenForumTopic === 'function') {
              await adapter.reopenForumTopic(chatId, rec.threadId)
            }
            this.store.markOpen(workspaceId)
            summary.reopened++
            this.stats.reopened++
            this.logger?.info?.(`dsh-messenger-gateway: reopened topic ${rec.threadId} for ${want.path}`)
          } catch (err) {
            if (isTopicGoneError(err)) {
              this.store.remove(workspaceId)
              continue
            }
            summary.errors++
            this.stats.errors++
            this.logger?.warn?.(`dsh-messenger-gateway: reopenForumTopic failed: ${err?.message || err}`)
          }
        }

        // Title changed -> rename the topic.
        if (String(want.title) !== String(rec.title)) {
          const name = this.uniqueName(want.title, usedNames)
          try {
            await adapter.editForumTopic(chatId, rec.threadId, name)
            this.store.set(workspaceId, { chatId, threadId: rec.threadId, title: name, path: want.path, closed: false })
            usedNames.add(name)
            summary.renamed++
            this.stats.renamed++
            this.logger?.info?.(`dsh-messenger-gateway: renamed topic ${rec.threadId} to "${name}"`)
          } catch (err) {
            if (isTopicGoneError(err)) {
              this.store.remove(workspaceId)
              continue
            }
            summary.errors++
            this.stats.errors++
            this.logger?.warn?.(`dsh-messenger-gateway: editForumTopic failed: ${err?.message || err}`)
          }
        } else if (String(want.path) !== String(rec.path)) {
          this.store.set(workspaceId, { chatId, threadId: rec.threadId, title: rec.title, path: want.path, closed: false })
        }
      }

      // Workspaces that no longer exist -> close their topic (never delete it).
      for (const rec of this.store.all()) {
        if (wanted.has(rec.workspaceId)) continue
        if (rec.closed) continue
        if (this.config.closeOnRemove === false) continue
        try {
          await adapter.closeForumTopic(rec.chatId || chatId, rec.threadId)
          this.store.markClosed(rec.workspaceId)
          summary.closed++
          this.stats.closed++
          this.logger?.info?.(`dsh-messenger-gateway: closed topic ${rec.threadId} — workspace removed: ${rec.path}`)
        } catch (err) {
          if (isTopicGoneError(err)) {
            this.store.remove(rec.workspaceId)
            continue
          }
          summary.errors++
          this.stats.errors++
          this.logger?.warn?.(`dsh-messenger-gateway: closeForumTopic failed: ${err?.message || err}`)
        }
      }

      summary.ok = true
      this.stats.lastRun = Date.now()
    } finally {
      this.running = false
    }
    return summary
  }

  /** Create one topic, retrying once after Telegram's own flood-control delay. */
  async createTopic(adapter, chatId, name) {
    try {
      const res = await adapter.createForumTopic(chatId, name)
      return Number(res?.message_thread_id) || 0
    } catch (err) {
      const retryAfter = parseRetryAfter(err)
      if (!retryAfter) throw err
      this.logger?.warn?.(`dsh-messenger-gateway: Telegram flood control — waiting ${retryAfter}s before retrying topic "${name}"`)
      await sleep(retryAfter * 1000)
      const res = await adapter.createForumTopic(chatId, name)
      return Number(res?.message_thread_id) || 0
    }
  }

  /** Diagnostic for /ws probe: create one throwaway topic and report the raw result. */
  async probe() {
    const chatId = this.forumChatId()
    if (!chatId) return { ok: false, error: '尚未認養論壇 — 請先在群組打 /ws sync' }
    const adapter = this.adapter()
    if (!adapter?.createForumTopic) return { ok: false, error: 'telegram adapter 不可用' }
    try {
      const res = await adapter.createForumTopic(chatId, 'dsh-probe (可刪除)')
      const raw = JSON.stringify(res)
      return { ok: true, threadId: Number(res?.message_thread_id) || 0, raw: raw.length > 300 ? `${raw.slice(0, 300)}…` : raw }
    } catch (err) {
      return { ok: false, error: String(err?.message || err).slice(0, 300) }
    }
  }

  /**
   * Forget every workspace -> topic binding while keeping the adopted forum.
   * Needed when the topics were deleted or the group's Topics switch was turned
   * off: the mirror cannot detect that from the Bot API, so the recorded ids
   * must be dropped before a fresh /ws sync.
   */
  reset() {
    return this.store.clear()
  }

  /** Telegram requires unique topic names inside one forum; keep them unique and short. */
  uniqueName(title, usedNames) {
    const base = String(title ?? '').trim() || 'workspace'
    const first = truncateName(base)
    if (!usedNames.has(first)) return first
    for (let i = 2; i < 200; i++) {
      const candidate = truncateName(base, ` (${i})`)
      if (!usedNames.has(candidate)) return candidate
    }
    return truncateName(base, ` (${Date.now() % 100000})`)
  }
}
