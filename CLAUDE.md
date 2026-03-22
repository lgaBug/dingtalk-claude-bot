# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a DingTalk (钉钉) bot that integrates with Claude Code. It receives messages via DingTalk's streaming API and responds using Claude Code CLI, displaying responses in real-time via DingTalk interactive cards.

## Commands

```bash
npm run dev    # Run development server with hot-reload (tsx watch)
npm run build  # Compile TypeScript to dist/
npm start      # Run production server from dist/
```

## Architecture

```
src/index.ts              # Entry point - wires up all components
src/server/express.ts      # Express server (health check + webhook)
src/dingtalk/bot.ts        # DingTalkBot - message routing & conversation state
src/dingtalk/client.ts      # DingTalkClient - stream connection & card API
src/dingtalk/card.ts       # CardMessage - card payload templates
src/claude/client.ts       # ClaudeClient - spawns claude CLI with streaming
src/config.ts              # Environment variables (DINGTALK_CLIENT_ID, etc.)
src/logger.ts              # Structured logger with level filtering
```

## Key Design Patterns

**Message Flow**: DingTalk → DingTalkClient → DingTalkBot → ClaudeClient → Claude CLI → streaming response → DingTalk card update

**Conversation State**: `DingTalkBot` maintains in-memory `Map<string, Conversation>` keyed by `conversationId`. Each conversation stores message history for context.

**Claude Integration**: `ClaudeClient.streamMessage()` spawns `claude -p --output-format stream-json` as a child process, parses streaming JSON events, and calls callbacks for each text chunk.

**Card Streaming**: Uses DingTalk's `card/instances/createAndDeliver` API with `callbackType: STREAM`. Updates via `PUT /v1.0/im/interactiveCards` as chunks arrive. `flowStatus: 2` = streaming, `flowStatus: 3` = complete.

**Duplicate Prevention**: `processingMessages` Set tracks `msgUid` to skip duplicate deliveries from DingTalk's at-least-once semantics.

## Configuration

Environment variables (see `.env.example`):
- `DINGTALK_CLIENT_ID` - DingTalk app client ID
- `DINGTALK_CLIENT_SECRET` - DingTalk app client secret
- `PORT` - Server port (default 3000)
