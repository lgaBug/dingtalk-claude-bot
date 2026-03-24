# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

DingTalk bot that integrates with Claude Code CLI. Receives messages via DingTalk's streaming WebSocket API, forwards them to a locally running Claude Code CLI subprocess, and streams back **all events** (tool calls, tool results, text responses) as formatted Markdown in DingTalk interactive cards.

## Commands

```bash
npm run dev    # Development with hot-reload (tsx watch)
npm run build  # Compile TypeScript to dist/
npm start      # Production server from dist/
```

## Architecture

```
src/index.ts              # Entry point - wires up components, graceful shutdown
src/server/express.ts      # Express health check endpoint
src/dingtalk/bot.ts        # DingTalkBot - message routing, conversation state, dedup
src/dingtalk/client.ts      # DingTalkClient - WebSocket stream, card API, token cache
src/claude/client.ts       # ClaudeClient - proxy connection, event parsing, formatting
src/claude/proxy.ts        # Claude Proxy - standalone process managing Claude CLI
src/config.ts              # Environment variables
src/logger.ts              # Structured logger (console + file)
```

## Key Design Patterns

**Proxy Architecture**: Bot communicates with Claude CLI through an independent Proxy process via Named Pipe (Windows) / Unix Socket. This enables:
- Bot restart without killing Claude CLI (Proxy + CLI keep running)
- Process name-based matching (configured via `CLAUDE_PROCESS_NAME`)
- Automatic Proxy startup if not already running
- Automatic Claude CLI restart if it crashes

```
Bot (restartable) ←Named Pipe→ Claude Proxy (long-lived) ←stdio→ Claude CLI (long-lived)
```

**Event Pipeline**: DingTalk WebSocket → DingTalkClient → DingTalkBot → ClaudeClient → Named Pipe → Proxy → Claude CLI → stream-json events → format as Markdown → DingTalk card update

**Full Event Streaming**: All Claude CLI events are processed and displayed:
- `assistant(tool_use)` → formatted tool call with icon + params (Read, Bash, Edit diffs, etc.)
- `user(tool_result)` → tool execution result (truncated at 25 lines / 1500 chars)
- `assistant(text)` → Claude's text response (pass-through)
- `result` → completion stats (turns, duration, cost)

**Token Caching**: DingTalk access token cached for 2 hours (refreshed 5 min early) to avoid rate limiting.

**Session Management**: Claude CLI `--session-id` derived deterministically from `CLAUDE_PROCESS_NAME`. Conversation context persists across bot and proxy restarts.

**Deduplication**: `processingMessages` Map tracks `msgUid` with 2-minute TTL, cleaned up every 5 minutes.

**History Cap**: In-memory conversation history capped at 50 messages per conversation.

## Configuration

Environment variables (see `.env.example`):
- `DINGTALK_CLIENT_ID` - DingTalk app client ID (required)
- `DINGTALK_CLIENT_SECRET` - DingTalk app client secret (required)
- `DINGTALK_CARD_TEMPLATE_ID` - DingTalk card template ID (optional)
- `PORT` - Server port (default 3000)
- `CLAUDE_PROCESS_NAME` - Claude CLI proxy name for process matching (default: 'default')

## Proxy Management

Proxy runs as a detached process, survives bot restarts. Useful commands:
- Proxy PID file: `%TEMP%/claude-proxy-<name>.pid`
- Proxy log: `%TEMP%/claude-proxy-<name>.log`
- Named pipe: `\\.\pipe\claude-bot-<name>` (Windows)
- To manually stop proxy: kill the PID from the PID file
