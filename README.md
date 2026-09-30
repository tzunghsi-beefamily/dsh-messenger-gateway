# 📦 @goodandready/dsh-messenger-gateway

> ## 🔱 Independent fork
>
> This repository is an **independent fork** of
> [`GooDAnDReaDY/dsh-messenger-gateway`](https://github.com/GooDAnDReaDY/dsh-messenger-gateway) (MIT),
> based on release **0.4.9** and developed against **DeepSeek Harness `0.2.0-rc.2`**.
>
> * It **does not track upstream** — no merges, and the built-in npm self-updater is **disabled on purpose**:
>   installing the upstream release would replace this checkout and silently revert every local fix.
>   Update with `git pull` in the plugin directory.
> * Added on top of 0.4.9: **workspace topics mirror**, **one durable session per chat/topic**,
>   **queued turns (every message gets its own reply)**, and six DSH 0.2.0-rc.2 compatibility fixes.
> * Symptom → cause → fix notes, diagnostics and the maintenance workflow: **[LOCAL-FIXES.md](LOCAL-FIXES.md)**.
>
> ```bash
> git clone https://github.com/tzunghsi-beefamily/dsh-messenger-gateway
> dsh plugin --profile web add /path/to/dsh-messenger-gateway
> ```
>
> Original plugin and design by [GooDAnDReaDY](https://github.com/GooDAnDReaDY) — MIT licensed, see [LICENSE](LICENSE).

<div align="center">

<h3>Telegram Messenger Bridge with Interactive Buttons, Forum Topics & Voice Notes for DeepSeek Harness</h3>

<p align="center">
  <a href="https://github.com/tzunghsi-beefamily/dsh-messenger-gateway"><img src="https://img.shields.io/badge/GitHub-independent_fork-6366f1.svg?style=for-the-badge&labelColor=1e1b4b" alt="independent fork"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-10b981.svg?style=for-the-badge&color=10b981&labelColor=064e3b" alt="license"></a>
  <a href="https://github.com/topics/dsh-plugin"><img src="https://img.shields.io/badge/DSH-Plugin-8b5cf6.svg?style=for-the-badge&labelColor=2e1065" alt="DSH Plugin"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node-20%2B-f59e0b.svg?style=for-the-badge&labelColor=451a03" alt="Node version"></a>
</p>

<p align="center">
  <a href="https://goodandready.app/"><img src="https://img.shields.io/badge/All_Author_Projects-goodandready.app-ff4500.svg?style=for-the-badge&logo=rocket&logoColor=white&labelColor=1a1a2e" alt="All Author Projects"></a>
</p>

<p align="center">
  <a href="README.md"><b>🇬🇧 English</b></a> •
  <a href="README.ru.md"><b>🇷🇺 Русский</b></a> •
  <a href="README.zh.md"><b>🇨🇳 中文说明</b></a>
</p>

<table align="center">
  <tr>
    <td align="center">
      🐛 <strong>Found a bug in this fork?</strong> Open an issue on
      <a href="https://github.com/tzunghsi-beefamily/dsh-messenger-gateway/issues">this repository</a>.
      <br><br>
      🙏 <strong>Upstream project:</strong> this fork exists because the original plugin is excellent —
      please also star <a href="https://github.com/GooDAnDReaDY/dsh-messenger-gateway">GooDAnDReaDY/dsh-messenger-gateway</a>.
    </td>
  </tr>
</table>

</div>

---

## ⚡ Overview

**`dsh-messenger-gateway`** provides an enterprise-grade, multi-transport messaging gateway for **DeepSeek Harness** agents.
Talk to your Harness agent directly from Telegram: interactive keyboard buttons, forum topic sessions, private user workspaces, pairing codes, and optional spoken voice replies.

Talk to your Harness agent from Telegram: text, voice, photos, documents, inline buttons, named homes, and optional spoken replies.

## Features

- Long-poll or webhook Telegram bot
- Multi-transport support: Telegram, Discord (Webhooks & Bot API), and Slack (Webhooks & Bot API)
- Allowlist + pairing codes
- Per-user or per-chat sessions (`sessionScope`)
- Forum topics as separate sessions
- Quick actions reply keyboard (`/keyboard on|off`)
- Multi-select interactive ask forms with checkboxes and pagination (`messenger_ask`)
- Artifact & Mermaid diagram rendering (SVG cards) and monospace table formatting
- Agent roles & personas (`/role coder`, `/role architect`, `@role` tags in group chats)
- Agent tools & skills inspection (`/skills`, `/tools`)
- Session management: dialogue history export to Markdown (`/export`), turn rewind (`/rewind`), session branching (`/fork`)
- Workspace file manager (`/files [dir]`) and file download (`/get <path>`) with directory traversal protection
- Admin alert channel for pairing requests, model errors and monitoring (`/setalert`, `/alert`)
- Persistent scheduled reminders (`/remind <time> <text>`, `/remind list`, `/remind cancel`)
- Inbound webhook event dispatcher (`POST /dsh-messenger-gateway/events`) for CI/CD and external alerts
- Steer (opt-in): follow-up messages while the agent is busy (instead of aborting). **This fork queues by default**
  (`telegram.queueWhileBusy`), so every message gets its own turn and its own reply
- `/stop`, `/new`, `/model`, `/status`, `/voice`, `/sethome`, `/home`
- Agent tool `messenger_ask` (inline keyboard answers return to the agent)
- Named homes for outbound notify / `messenger.send`
- Optional notify bridge: web session events → Telegram home (excludes messenger sessions)
- Inbound voice → STT (`dsh-voice`), photos → vision (`dsh-vision-bridge`)
- Optional TTS replies (`dsh-tts`); mp3 is converted to OGG/Opus via `ffmpeg` for Telegram voice notes

Discord and Slack adapters are available as outbound transports (Webhooks or Bot REST APIs).

## 🔱 Fork-only: workspace topics

This fork mirrors the **DSH workspace registry** into Telegram forum topics — one topic per workspace — so a
message sent in a topic runs in that workspace's directory, and the session it creates shows up under that
project in the Web GUI (phone → desktop hand-off).

| Command | Description |
|---------|-------------|
| `/ws sync` | Create / rename / close topics so they match the registry (1.5 s apart, 429 retried once) |
| `/ws list` | Show the workspace ↔ topic map |
| `/ws probe` | Create one throwaway topic and print the raw Bot API result (diagnostics) |
| `/ws reset` | Forget the workspace ↔ topic map but keep the forum (use after deleting topics, or after turning Topics off) |
| `/ws` | Describe the workspace bound to the topic you are in |

Setup: use a **supergroup with Topics enabled**, add the bot as an admin with **Manage Topics**, then run
`/ws sync` once in `General`. Workspaces added later need another `/ws sync` (background reconcile is off by
default). Config lives in `telegram.workspaceTopics`: `enabled`, `forumChatId`, `closeOnRemove`,
`autoReconcile` (default `false`), `createDelayMs` (default `1500`).

Each chat/topic keeps **one session** until you send `/new` (binding file
`~/.dsh/messenger-gateway/chat-sessions.json`). While a turn is running, incoming messages are **queued** and
answered one by one — set `telegram.queueWhileBusy: false` to get the upstream steer behaviour instead.

### Default session vs attached session

Every chat/topic owns a **default session**: created on its first Telegram message and resumed across host
restarts. On top of that you can **jump into any existing session** — for example one you started in the Web GUI —
and keep working on it from Telegram:

| Command | What it does |
|---------|--------------|
| `/sessions [n] [all] [sub]` | Sessions of **this topic's workspace** with their ids (`all` = every workspace, `sub` = include subagents) |
| `/attach <n\|id\|title>` | Continue that session here; this chat's default session is remembered |
| `/detach` (aliases `/back`, `/default`) | Leave the attached session and go back to the default one |
| `/new` | Forget both: the next message starts a brand-new default session |

`/status` shows `mode: default` or `mode: attached → <session id>`. In the binding file a chat is stored as
`{"defaultSessionId": "msgw-…", "attachedSessionId": "session-…"}` (v1 files that stored a bare id are migrated
automatically).

**`/sessions` is scoped to the workspace.** In a topic bound to a workspace (say `雜七雜八`) it only lists sessions
that ran in that directory, so conversations from other projects never mix in; use `/sessions all` to look across
workspaces. `/attach <id>` can still reach a session from another workspace when you pass its id explicitly.

**Subagent sessions are hidden.** When an agent spawns subagents, their sessions are stored too
(`delegationDepth > 0`) but they are activity of a parent session, so `/sessions`, `npm run sessions` and
`/attach` skip them. `/sessions sub` (or `--all`) shows them; `/attach` refuses to continue one.

## 🩺 Health check & tests

```bash
npm test        # offline workspace-topics test — 15 checks, no bot, no DSH host needed
npm run health  # one-command health check — run this after every DSH update
```

`tools/health-check.mjs` checks the files, the syntax of every `lib/` module, that each local fix is still
present, the runtime state files (`workspace-topics.json`, `chat-sessions.json`, `events.log`) and the live
gateway endpoints, then runs the test suite. `tools/read-session.mjs <session.v4.jsonl.zstd>` prints a DSH
session log (zstd, multi-frame aware).

### 🔎 How to find a session id

The Web GUI shows session **titles**, not ids. Two ways to get the id:

* **In Telegram:** `/status` prints the session id of the topic you are in, plus the bound session and workspace.
* **Anywhere:**

```bash
npm run sessions                                  # every DSH session: id, title, project, last activity
node tools/list-sessions.mjs --telegram           # only messenger sessions (msgw-…)
node tools/list-sessions.mjs --id msgw-6d972543   # details for one session
node tools/list-sessions.mjs --json               # machine readable
```

On disk the session id is simply the session directory name:
`~/.dsh/sessions/<workspace-slug>/<session-id>/`.

### 🗑️ Deleting a session

DSH itself only **archives** sessions: the Web GUI exposes archive/unarchive (`delete` exists for workspaces
only) and the JSONL persistence backend has no purge. A session is just a directory, so this fork ships a safe
tool for it:

```bash
npm run session:delete -- --id 48c35e00 --dry-run        # show what would happen
npm run session:delete -- --id 48c35e00                  # move to ~/.dsh/session-trash (restorable)
npm run session:delete -- --id 48c35e00 --purge --yes    # delete permanently
```

It moves `~/.dsh/sessions/<workspace-slug>/<id>/` together with the projection-cache file, warns when DSH is
running or when Telegram is still bound to that session, and refuses ambiguous matches (pass a longer id
prefix). The stale id left in `workspace.json` is harmless — the registry filters ids whose session path no
longer exists, so the session also disappears from the GUI.

## 🧯 Troubleshooting

The full symptom → cause → fix table is in **[LOCAL-FIXES.md](LOCAL-FIXES.md)**. The short version:

| Symptom | Likely cause |
|---------|--------------|
| Telegram says `(no response)` although the GUI shows an answer | the reply was collected after the turn ended, or the gateway was rebuilt mid-turn (look for `gateway.stopped` in `events.log`) |
| `Internal error: session "…" already exists` | a persisted session was passed to `agents.create()` instead of `agents.resume()` |
| Every message opens a new session | the chat → session binding file is missing or was cleared |
| Replies land in an unexpected conversation | `/status` shows `mode: attached` — send `/detach` to go back to the default session || Settings card saves nothing / token disappears | a config section lost its `.volatile()` marker (DSH 0.2.0-rc.2 only persists volatile fields) |
| Duplicate topic names | `/ws sync` was run again after a partial failure — `/ws reset` then one `/ws sync` |

## Install

```bash
dsh plugin --profile web add @goodandready/dsh-messenger-gateway
```

Then open **Settings → Plugins → Messenger gateway**:

1. Enable Telegram
2. Paste the BotFather token (write-only; leave blank to keep the current token)
3. Set allowed Telegram user IDs (or use pairing)

### Optional companion plugins (same profile)

| Plugin | Role |
|--------|------|
| `@goodandready/dsh-voice` | Transcribe inbound voice messages |
| `@goodandready/dsh-tts` | Speak agent replies |
| `@goodandready/dsh-vision-bridge` | Describe inbound photos |

They are **not** npm dependencies of this package — install them separately if you want those features.

### Voice notes

Spoken replies use Telegram `sendVoice`. If TTS returns MP3 (or other non-Opus audio), the gateway runs `ffmpeg` (`libopus`) to produce OGG. If `ffmpeg` is missing or conversion fails, the audio is sent as a regular audio file instead of a voice note.

## Commands (Telegram)

| Command | Description |
|---------|-------------|
| `/start` `/help` | Help |
| `/whoami` | Your Telegram user id |
| `/new` | New agent session |
| `/stop` | Abort the current turn |
| `/model` | Interactive 2-step model picker (providers → models) or `/model <prov> <mod>` |
| `/status` | Gateway status and session counters |
| `/top` | Live server resources: RSS/Heap memory, uptime, active chats, reminders |
| `/topic <name>` | Create a new Telegram forum topic in supergroups and start an isolated session |
| `/ws [list\|sync\|reset\|probe]` | Workspace ↔ forum-topic mirror (**fork feature**, see above) |
| `/sessions [n]` | List recent sessions with their ids (**fork feature**) |
| `/attach <n\|id\|title>` | Continue an existing (e.g. GUI) session from here (**fork feature**) |
| `/detach` | Back to this chat's default session (**fork feature**) |
| `/role [name]` | Switch agent persona (`coder`, `architect`, `reviewer`, `writer`, `translator`, `concise`) |
| `/skills` `/tools` | List active agent tools and capabilities |
| `/fork` | Fork current session into a new independent session |
| `/export` | Export session dialogue history to Markdown |
| `/rewind [N]` | Rewind last N conversation turns |
| `/files [dir]` | Workspace file manager |
| `/get <path>` | Download file from workspace |
| `/remind <time> <text>` | Set a reminder (e.g. `/remind 15m Call client`) |
| `/setalert` `/alert` | Configure admin alert channel and send test alert |
| `/keyboard on\|off` | Toggle quick actions reply keyboard |
| `/voice on\|off` | Per-user spoken replies |
| `/tts on\|off\|status` | Per-chat spoken replies |
| `/sethome [name]` | Bind current chat/topic as a named home |
| `/home` | List homes |

## Multi-Transport Support (Discord & Slack)

In addition to Telegram, outbound messages can be dispatched to Discord and Slack via Webhooks or Bot APIs:
- **Discord:** set `discord.enabled: true`, provide either `webhookUrl` or `botToken`. Target channels via `chatId: "<channel_id>"`.
- **Slack:** set `slack.enabled: true`, provide either `webhookUrl` or `botToken`. Target channels via `chatId: "<channel_id>"` or threads via `threadId: "<thread_ts>"`.

## Agent tools & HTTP

- Tool: `messenger_ask` — ask the user with inline buttons; choice is fed back into the turn
- HTTP (when enabled): `/messenger/send`, `/messenger/ask`, `/messenger/progress`
- Cordis service: `ctx.messenger` for other plugins

## Configuration notes

- `sessionScope`: `user` (default) or `chat` — how group chats isolate sessions
- `telegram.workspaceTopics`: workspace → forum topic mirror (**fork feature**, see above)
- `telegram.queueWhileBusy`: `true` (default) — queue messages while a turn runs so each gets its own reply
- `telegram.debugEvents`: `true` (default) — append session events to `~/.dsh/messenger-gateway/events.log` (bounded to 200 lines)
- The built-in npm **self-updater is disabled in this fork** — `/update` and the settings card both say so; use `git pull`
- `voiceMode`: `mirror` / `always` / `off` — when to speak replies (also `/voice`)
- `tts.enabled` / `tts.maxChars` — TTS gate and length cap
- `notifyBridge` — forward non-messenger web session events to a home
- Bot token is a DSH secret field — never commit it

## Client UI & Settings Card

- Mounted into `settings.plugin.item` on the Plugins tab (`key: dsh-messenger-gateway`).
- Configuration is managed reactively via `settingsScope.bind({ namespace: 'dsh-messenger-gateway' })` with snapshot status checking (`loading`, `unavailable`, `ready`).
- Protected dictionary registration: duplicate registration attempts on page reload are safely caught with non-fatal warnings, ensuring the settings card never fails to mount.

## Requirements

- DeepSeek Harness web (or compatible) profile
- Node.js matching your Harness install
- For voice notes from non-Opus TTS: `ffmpeg` on the host `PATH`

## License

MIT
