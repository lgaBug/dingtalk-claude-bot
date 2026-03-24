# DingTalk Claude Bot

Use Claude Code in DingTalk — watch Claude read files, run commands, and edit code in real-time, just like in the terminal.

[中文](./README.md)

## Preview

After sending a message in DingTalk, every step Claude takes is displayed in real-time via interactive cards:

```
---
📖 Read `.../src/index.ts`

     1→import express from 'express';
     2→const app = express();
     ...

---
⚡ Bash
  npm test

  ✓ 12 tests passed

---
✏️ Edit `.../src/index.ts`
  - const port = 3000;
  + const port = parseInt(process.env.PORT || "3000");

✅ The file src/index.ts has been updated successfully.

Changed port configuration to read from environment variable, defaults to 3000.

---
⏱ 4 turns · 12.3s · $0.083
```

## Features

- **Full visibility** — Tool calls (Read, Bash, Edit, Write, Grep, etc.) displayed in real-time
- **Streaming responses** — DingTalk interactive cards update live, no waiting for full response
- **Multi-card pagination** — Long task outputs automatically split across multiple cards
- **Multi-turn conversations** — Context maintained via fixed Session ID, survives bot restarts
- **Proxy architecture** — Claude CLI runs independently; bot restarts don't affect it
- **Image support** — Auto-detects image files produced by Claude tools and sends them to DingTalk
- **Message deduplication** — Handles DingTalk's At-Least-Once delivery semantics
- **Cross-platform** — Supports Windows (Git Bash) and Linux/macOS

## Prerequisites

- Node.js 18+
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- A DingTalk bot application with Stream mode enabled

## Quick Start

```bash
# 1. Clone the repo
git clone https://github.com/Mo-Xian/dingtalk-claude-bot.git
cd dingtalk-claude-bot

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your DingTalk credentials and Claude process name

# 4. Development mode
npm run dev

# Or build and start
npm run build && npm start
```

## Architecture

The bot communicates with an independent Proxy process via Named Pipe. The Proxy manages the Claude CLI lifecycle. The bot can restart freely without affecting the running Claude CLI.

```
                          Named Pipe
┌──────────┐  WebSocket  ┌──────┐ (\\.\pipe\...)  ┌───────┐  stdio   ┌──────────┐
│ DingTalk │ ←─────────→ │ Bot  │ ←────────────→ │ Proxy │ ←──────→ │  Claude  │
│   User   │  Stream API  │      │                │(long-  │          │ Code CLI │
└──────────┘             └──┬───┘                │lived)  │          └──────────┘
                            │                    └───────┘
                 updateCard()                        ↑
                            │                   detached process
                     ┌──────┴──────┐            auto-reconnects
                     │  DingTalk   │            on bot restart
                     │    Card     │
                     └─────────────┘
```

### Event Processing

Claude CLI outputs `stream-json` events. The Proxy relays them to the bot, which parses and formats each event as Markdown for the card:

| CLI Event | Card Display |
|-----------|-------------|
| `assistant` → `tool_use` | 📖 **Read** / ⚡ **Bash** / ✏️ **Edit** + params |
| `user` → `tool_result` | Tool execution result (truncated) |
| `assistant` → `text` | Claude's text response |
| `result` | ⏱ Stats (turns · duration · cost) |

### Project Structure

```
src/
├── index.ts              # Entry point, component wiring, graceful shutdown
├── config.ts             # Environment variables
├── logger.ts             # Structured logging (console + file)
├── server/
│   └── express.ts        # Express health check
├── claude/
│   ├── client.ts         # Proxy connection, event parsing, formatting
│   └── proxy.ts          # Standalone proxy process managing Claude CLI
└── dingtalk/
    ├── bot.ts            # Message routing, session management, dedup, multi-card
    └── client.ts         # WebSocket connection, card create/update, token cache
```

### Key Design Decisions

**Proxy architecture** — Claude CLI is managed by an independent Proxy process, communicating with the bot via Named Pipe (Windows) / Unix Socket. On startup, the bot connects to an existing Proxy or creates one. On shutdown, it disconnects without killing the Proxy or Claude CLI.

**Process name matching** — `CLAUDE_PROCESS_NAME` configures the process identifier. The bot only connects to its matching Proxy. Different bot instances can use different names without interference.

**Auto-restart** — The Proxy automatically restarts Claude CLI on crash (exponential backoff, max 5 retries). Counter resets on successful initialization.

**Multi-card pagination** — When a single card's content exceeds the threshold, the current card is finalized and a new card is created to continue output. No content is lost for long-running tasks.

**Token caching** — Access token cached for 2 hours (refreshed 5 minutes early), preventing rate limits from per-update token requests.

**History cap** — Each conversation retains at most 50 messages to prevent unbounded memory growth. Claude CLI maintains full context via `--session-id`.

## Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `DINGTALK_CLIENT_ID` | DingTalk app Client ID | Yes |
| `DINGTALK_CLIENT_SECRET` | DingTalk app Client Secret | Yes |
| `DINGTALK_CARD_TEMPLATE_ID` | DingTalk card template ID | No |
| `PORT` | Server port (default 3000) | No |
| `CLAUDE_PROCESS_NAME` | Claude CLI process name (default: default) | No |

## Proxy Management

The Proxy runs as an independent detached process. Related files:

| File | Windows Path | Purpose |
|------|-------------|---------|
| PID file | `%TEMP%\claude-proxy-<name>.pid` | Proxy process ID |
| Log file | `%TEMP%\claude-proxy-<name>.log` | Proxy runtime log |
| Named Pipe | `\\.\pipe\claude-bot-<name>` | IPC communication |

```bash
# View Proxy logs
cat "$TEMP/claude-proxy-dingtalk-bot.log"

# Manually stop Proxy (also stops Claude CLI)
kill $(cat "$TEMP/claude-proxy-dingtalk-bot.pid")
```

## License

MIT
