# DSH Telegram Gateway(獨立 fork)維護手冊

> 專案位置:**`C:\Users\DavidYeh\Documents\雜七雜八\dsh-messenger-gateway`**
> GitHub:<https://github.com/tzunghsi-beefamily/dsh-messenger-gateway>
> **本專案已與上游斷開(2026-09-30 起獨立維護,不追蹤上游更新)**
> 起源:`@goodandready/dsh-messenger-gateway@0.4.9`(MIT)
> 執行環境:DSH `0.2.0-rc.2` / Node 24 / Windows
> 最後更新:2026-09-30

---

## 1. 這個 fork 在做什麼

把 **DSH 的工作區(workspace registry)鏡射成 Telegram 論壇話題**,並讓「話題 → 工作區」對應到正確的執行目錄,手機發起的對話可以在 Web GUI 接手。

```
Telegram 話題 ──(workspace-topics.json)──> DSH 工作區路徑
      │
      └──(chat-sessions.json)──> 固定的 DSH session(直到 /new)
```

### 安裝方式(profile 連結,不是複製)

```
~/.dsh/profiles/web/package.json
  dependencies:  "@goodandready/dsh-messenger-gateway": "link:C:/Users/DavidYeh/Documents/雜七雜八/dsh-messenger-gateway"
  dsh.profile.bundles: [..., "@goodandready/dsh-messenger-gateway"]
```

* `link:` 是 **Junction**,所以改這裡的程式碼就是改執行中的外掛。
* 但 **Node module cache 不會重載** → **改完必須重啟 `dsh web`**。
* 設定寫在 `~/.dsh/profiles/web/cordis.patch.yml`(DSH 標準設定路徑,不是 hack)。

### 狀態檔(`~/.dsh/messenger-gateway/`)

| 檔案 | 內容 | 刪掉會怎樣 |
|---|---|---|
| `workspace-topics.json` | `forumChatId` + `工作區 → 話題` 對應 | 下次 `/ws sync` 重建全部話題(會產生孤兒話題) |
| `chat-sessions.json` | `chatId:threadId → { defaultSessionId, attachedSessionId }` | 每則訊息重新開 session |
| `events.log` | session 事件軌跡(上限 200 行,`telegram.debugEvents`) | 只是失去診斷資料 |

---

## 2. 症狀 → 根因 → 修法(七個已修問題)

| # | 症狀 | 根因 | 修法(檔案) |
|---|---|---|---|
| 1 | GUI 卡片存了卻沒生效、token 遺失 | DSH 0.2.0-rc.2 **只持久化 `.volatile()` 標記的欄位**,未標記的欄位被靜默丟棄 | `lib/config.js`:對 `telegram`/`discord`/`slack`/`media`/`tts`/`agent` 加 `.volatile()` |
| 2 | 同名話題一直重複建立 | ①建立話題之間沒有節流 ②**Telegram 沒有「列出話題」API**,無法得知同名話題已存在 | `lib/workspace-topics.js`:`createDelayMs`(1.5s)、429 `retry_after` 重試、`errorDetails` 回報、`autoReconcile` 預設 **false**;`/ws probe` 診斷 |
| 3 | `(no response)`(主要) | **設定一變(volatile 更新)→ `sync()` 重建 Gateway → `stop()` dispose 所有 chat → 進行中的回合被殺**,新 listener 用新的空 `pending` 表 | `lib/index.js`:設定指紋比對,沒實際變更**不重建** |
| 4 | `(no response)`(次要) | `pending`(回合收集器)是**每個 Gateway 一份** | `lib/gateway.js`:`sharedActiveTurns` 模組層共用 |
| 5 | GUI 看不到 Telegram 的 session | 外掛用 `ctx.agents.create()` 直接建 session,**繞過 host 的 session controller**(平常由它負責 `attachSession`) | `lib/gateway.js`:`attachSessionToWorkspace()`(建立後 + 每輪 flush 後各試一次) |
| 6 | 每則訊息都開新 session | 對應只在記憶體(`threadToSession`),重建/閒置回收即失去 | `lib/workspace-store.js`:`createChatSessionStore`;`lib/gateway.js` 建立時一律寫入;只有 `/new` 清除 |
| 7 | 一次傳多則只有第一則有回答 | 原版 **steer** 設計把後續訊息注入當前回合,而**被注入的回合沒有收集器** → 回答不會送回 Telegram | `lib/gateway.js`:`queueWhileBusy`(預設 **true**)排隊 + `drainQueue()`,每則各自一回合、各自回覆 |

### 編號 3 的診斷證據(值得記住的手法)

```
events.log 顯示:某一輪「全程 collector=no」
  → 但 assistant/message、turn/end 都出現了
  → 表示回合真的跑完,只是收集器看不到事件
  → 加上 gateway.started/gateway.stopped 日誌後確認:Gateway 在回合中被重建
```

**關鍵洞察**:同一輪裡 `pending.set` 記錄 `collector=yes`,緊接著同一 session 的事件卻是 `collector=no`
→ 一定是「**換了一個實例**」而不是「鍵打錯」。

---

## 3. DSH 0.2.0-rc.2 契約重點(踩過的坑)

| 主題 | 事實 |
|---|---|
| 建立 / 續用 session | `ctx.agents.create()` **只能建新的**;續用必須 `ctx.agents.resume({ resumeSessionId })`。把既有 id 傳給 `create()` → `session "…" already exists` |
| session 事件 | `ctx.on('session/event', (session, event) => …)`,事件型別如 `turn/start`、`user/message`、`assistant/message`、`turn/end`;文字在 `event.data.message.content` 的 `{type:'text'}` 區塊 |
| 回合結束的權威訊號 | **`turn/end` 事件**。`agent.whenIdle()` 可能在回合真正開始前就 resolve(競態) |
| 設定寫入 | 只有 `.volatile()` 子樹可從 UI 寫入;未標記 → `Config field "X" is not volatile`;secret 讀取會被遮蔽 |
| 工作區歸屬 | `ctx.workspaceRegistry.list()`(同步)取得 entity,`entity.attachSession(sessionId)` 才會進 GUI 專案 |
| Patch 分層 | Bundle → profile → home(`~/.dsh/cordis.patch.yml`)→ CLI;**patch 是整段取代,不是深層合併** |
| 認證 | 外掛建立 session 不等於 GUI 的建立路徑;兩者行為差異要靠自己補 |

---

## 4. 診斷工具箱

```powershell
# 外掛狀態 / 設定 / 連線測試
Invoke-WebRequest http://127.0.0.1:3080/dsh-messenger-gateway/status  -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:3080/dsh-messenger-gateway/config  -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:3080/dsh-messenger-gateway/smoke -Method POST -UseBasicParsing

# 一鍵健康檢查(檔案 / 語法 / 修正是否還在 / 狀態檔 / 外掛端點 + 離線測試)
node C:\Users\DavidYeh\Documents\雜七雜八\dsh-messenger-gateway\tools\health-check.mjs

# 離線測試(15 項:建/改名/關閉/重開/幂等/持久化/cwd/General/缺目錄/同名/清除/重建)
node C:\Users\DavidYeh\Documents\雜七雜八\dsh-messenger-gateway\test\check-workspace-topics.mjs

# 列出所有 session(含 id / 標題 / 專案 / 來源)—— GUI 只顯示標題,用這個對照
node C:\Users\DavidYeh\Documents\雜七雜八\dsh-messenger-gateway\tools\list-sessions.mjs
#   --telegram 只列 Telegram 的 / --id <前幾碼> 看單一條 / --json 給程式用
#   Telegram 內用 /status 可看「目前所在話題」的 session id

# 讀 DSH session 紀錄(zstd 多 frame,已處理)
node C:\Users\DavidYeh\Documents\雜七雜八\dsh-messenger-gateway\tools\read-session.mjs `
  "$env:USERPROFILE\.dsh\sessions\<workspace>\<session>\session.v4.jsonl.zstd" 20

# 關鍵狀態檔
Get-Content "$env:USERPROFILE\.dsh\messenger-gateway\events.log" -Tail 40
Get-Content "$env:USERPROFILE\.dsh\messenger-gateway\workspace-topics.json" -Raw
Get-Content "$env:USERPROFILE\.dsh\messenger-gateway\chat-sessions.json"  -Raw
```

Telegram 指令:`/ws`、`/ws list`、`/ws sync`、`/ws reset`、`/ws probe`、`/sessions`、`/attach`、`/detach`、`/new`、`/status`。

### session 模型(預設 / 接續)

* 每個聊天/話題有自己的 **default session**(第一則訊息建立,重啟後接續)
* `/sessions [n]` 列出最近 session(含 id、標題、來源);`/attach <編號|id 前幾碼|標題片段>` 接續既有 session
* **子 agent 的 session 預設隱藏**(`delegationDepth > 0`);`/sessions all` 才顯示,`/attach` 會拒絕接續它們
* `/detach`(或 `/back`)退回 default;`/new` 連 default 一起清掉(下一則建立全新的)
* 接續時**不會**覆蓋 default,也不會把該 session 掛到話題的工作區(它本來就在自己的專案裡)
* `/status` 可看目前是 `default` 還是 `attached → <id>`

### 判讀口訣

| 現象 | 意思 |
|---|---|
| 事件連續 `collector=no` 且發生在回合中 | Gateway 被重建(看 `gateway.stopped`)或鍵不匹配 |
| `gateway.stopped > 0`(非重啟) | 又有東西在觸發 `sync()` → 檢查 fingerprint 比對是否被繞過 |
| `assistant/message` 有、Telegram 沒有 | 收集器沒收到 → 對照 `events.log` 的 `collector=` 旗標 |
| Telegram `(no response)` 但 session 有回答 | 同上;後備路徑 `lastAssistantText()` 也會失效(此版 session 物件沒有 `.messages`) |

---

## 5. 維護流程

### A. 改完程式碼

1. `node --check lib/*.js`
2. `npm test`(或 `node test\check-workspace-topics.mjs`,應為 15/15)
3. **重啟 `dsh web`**(Ctrl+C → `npx @deepseek-ai/dsh web`)
4. 在 Telegram 傳一則測試,檢查 `events.log`

### B. 這個專案已獨立(刻意不追蹤上游)

自 2026-09-30 起本專案**與上游斷開**:`upstream` remote 已移除,**不要**合併上游,也**不要**用 `dsh plugin update`
(兩者都會覆蓋掉本專案的修正)。`patches/local-fixes-vs-0.4.9.patch` 只保留作歷史參考,不用於同步。

真正需要留意的是 **DSH 本身的更新** —— 它可能讓 §3 的契約失效(`.volatile()`、`session/event` 簽名、
`agents.resume`、`turn/end`、`attachSession`、patch 分層)。DSH 更新後請照 §5.D 自我檢查。

### C. 版本控制(GitHub)

```powershell
cd C:\Users\DavidYeh\Documents\雜七雜八\dsh-messenger-gateway
git add -A
git commit -m "修正: ..."
git push                      # 第一次是 git push -u origin main,之後直接 git push
```

> 這個 repo 的本機設定(**換電腦或重新 clone 要重設**):
> ```powershell
> git config http.sslBackend openssl     # 這台機器的 schannel 壞掉,不改會出現
>                                        # schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS
> git config credential.helper manager   # 推送時由 GCM 彈出瀏覽器登入
> ```
> ⚠️ DSH 沙盒內**無法** push(git 的憑證流程需要 `sh`,沙盒禁止具名管道 →
> `sh.exe: fatal error - couldn't create signal pipe`)。**push 要在自己的終端機執行。**

### D. 更新 DSH 之後的自我檢查

1. `node --check lib/*.js`(49 個檔案)
2. `npm run health`(一鍵:檔案、語法、每項修正是否還在、狀態檔、外掛端點 + 15 項測試)
3. 在 Telegram 傳一則訊息,確認三件事:
   * 有**正常回覆**(不是 `(no response)`,也不是 `already exists`)
   * `~/.dsh/messenger-gateway/events.log` 沒有出現 `gateway.stopped`(出現 = 設定變更又觸發重建)
   * GUI **沒有多出新的 session**(同一話題應沿用同一個)
4. 若壞掉,對照 §2 的七個根因逐項排查;新症狀請補進 §2(下次就查得快)

### E. 禁忌

* ❌ 不要改 DSH 本體或 `~/.dsh` 的設定檔來繞問題(重啟就壞) —— 修正一律放這個外掛。
* ❌ 不要 `dsh plugin update`,也不要合併上游。
* ⚠️ `profiles/web/node_modules/@goodandready/` 是 Junction,**不要刪**(刪了外掛消失)。

---

## 6. 已知限制(非 bug)

1. **Telegram 沒有「列出話題」API** → 無法自動偵測孤兒話題;`/ws reset` + `/ws sync` 是重建手段。
2. **`autoReconcile` 預設關閉** → 在 GUI 新增工作區後,要手動在群組打一次 `/ws sync`。
3. **同名話題可以存在** → 重建時舊話題不會被刪,需手動整理。
4. **`queueWhileBusy: true` 與上游行為不同**(上游會把訊息併入當前回合且不回覆)。
   要回上游行為:`telegram.queueWhileBusy: false`。
5. **`debugEvents` 預設開啟** → 診斷用,上限 200 行;不需要時設 `telegram.debugEvents: false`。
6. 後備路徑 `lastAssistantText()` 在 DSH 0.2.0-rc.2 上拿不到 session 訊息(無 `.messages`)→ 主要仍依賴事件收集。
