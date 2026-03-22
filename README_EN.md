# DingTalk Claude Bot

A DingTalk bot powered by Claude Code CLI. Receives messages via DingTalk's streaming API and responds using Claude Code in real-time.

[中文](./README.md)

## Features

- Real-time streaming responses via DingTalk interactive cards
- Persistent conversation history within sessions (multi-turn dialogue support)
- WebSocket long-lived connection for receiving DingTalk messages
- Support for multiple concurrent conversations (each session has its own Claude process)
- Message deduplication (handling DingTalk's At-Least-Once delivery semantics)

## Prerequisites

- Node.js 18+
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- A DingTalk bot application with streaming API enabled

## Quick Start

1. **Clone the repository**
   ```bash
   git clone <your-repo-url>
   cd dingtalk-claude-bot
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   # Edit .env with your DingTalk credentials:
   # DINGTALK_CLIENT_ID=your_client_id
   # DINGTALK_CLIENT_SECRET=your_client_secret
   ```

4. **Build the project**
   ```bash
   npm run build
   ```

5. **Start the bot**
   ```bash
   npm start
   ```

## How It Works

### Architecture Overview

```
┌─────────────┐     WebSocket      ┌─────────────┐
│   DingTalk   │ ←──────────────→  │  DingTalk   │
│    Client    │   Stream API       │   Client    │
└─────────────┘                    └──────┬──────┘
                                          │
                                          │ handleMessage()
                                          ▼
┌─────────────┐     stdin/stdout    ┌──────┴──────┐
│   Claude    │ ←───────────────→  │  DingTalk   │
│   Code CLI  │   Streaming JSON    │     Bot     │
│  (subprocess)│                    └──────┬──────┘
└─────────────┘                          │
                                          │ updateCard()
                                          ▼
┌─────────────┐     PUT /v1.0/    ┌─────────────┐
│  DingTalk   │ ←──────────────  │ Card Stream │
│   Server    │   streaming       │   Update    │
└─────────────┘                    └─────────────┘
```

### Message Processing Flow

#### 1. DingTalk WebSocket Long Connection

```
Bot starts → DWClient.connect() → Establish WebSocket connection
                                          ↓
                              Listen on /v1.0/im/bot/messages/get
                                          ↓
                            Message received → handleCallback()
```

- Uses `dingtalk-stream` SDK to establish WebSocket connection
- Registers callback listener for bot messages
- Immediately returns `EventAck.SUCCESS` to prevent DingTalk retries

#### 2. Message Deduplication

```typescript
shouldSkipMessage(msgUid, createAt):
  if msgUid exists in processingMessages AND time_diff < 2 minutes:
    return true  // Skip duplicate message
  else:
    add to processingMessages
    return false // Start processing
```

DingTalk uses At-Least-Once semantics - the same message may be delivered multiple times. Deduplication is done via `msgUid`.

#### 3. Session Management

Each `conversationId` maps to a persistent Claude CLI subprocess:

```
conversationId (DingTalk format: cidZShXIFb...)
      ↓ SHA-256 hash
sessionId (Standard UUID format)
      ↓
Claude CLI --session-id={sessionId}
```

Process reuse strategy:
- Generate random shared session ID on startup (avoid conflicts with other Claude processes)
- Create new subprocess on first message for each session
- Reuse existing subprocess for subsequent messages
- Claude CLI maintains conversation context via `--session-id`

#### 4. Claude CLI Integration

```bash
claude -p --output-format stream-json --input-format stream-json \
       --session-id {sessionId} --dangerously-skip-permissions
```

**Process Lifecycle:**
1. On startup, load and kill residual processes from `.claude_sessions` (using `taskkill /T`)
2. Generate random shared session ID (avoid conflicts with other Claude processes)
3. Start new process, wait 5 seconds for initialization
4. Send messages via stdin, receive streaming responses via stdout
5. Monitor stderr for session conflict errors

**Message Protocol:**
```typescript
// Sending
stdin.write(`{"type":"user","message":{"role":"user","content":"${message}"}}\n`);
stdin.write('{"type":"result"}\n');  // result marker after 300ms

// Receiving
{"type":"system","subtype":"init",...}  // Initialization complete
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
{"type":"result",...}  // Response complete
{"type":"error","content":"...",...}  // Error occurred
```

#### 5. Streaming Card Updates

```
User sends message → createStreamCard() → Create interactive card (flowStatus=2 streaming)
                ↓
          Every 5 chunks OR chunk < 50 chars
                ↓
          updateCard(content, isFinal=false) → PUT /v1.0/card/streaming
                ↓
          onComplete()
                ↓
          updateCard(content, isFinal=true) → flowStatus=3 (complete)
```

Card states:
- `flowStatus: 2` = streaming (in progress)
- `flowStatus: 3` = complete (finished)

#### 6. Complete Message Flow

```
1. User sends message to bot in DingTalk
2. WebSocket receives message → shouldSkipMessage() deduplication check
3. DingTalkBot.handleMessage():
   a. Create/get Conversation (saves conversation history)
   b. Call dingtalk.createStreamCard() to create streaming card
   c. Call claude.streamMessage() to send message
4. ClaudeClient.streamMessage():
   a. Get or create Claude CLI subprocess
   b. Send message and result marker via stdin
   c. Parse JSON streaming events from stdout
5. Receive Claude chunk → dingtalk.updateCard() to update card in real-time
6. Response complete → updateCard(isFinal=true) to mark card as finished
7. On shutdown: Mark all sessions as stopping → Wait for processes to exit (3s timeout) → Update file status → Close connections
```

### Project Structure

```
src/
├── index.ts              # Entry point, server startup and initialization
├── config.ts             # Environment variables configuration
├── logger.ts             # Structured logging
├── server/
│   └── express.ts        # HTTP server (health check endpoint)
├── claude/
│   └── client.ts         # Claude CLI subprocess management, streaming parser
└── dingtalk/
    ├── bot.ts            # Message routing, conversation state, deduplication
    ├── client.ts         # WebSocket connection, card API
    └── card.ts           # Card message templates
```

### Key Design Decisions

#### Process Isolation
- Each session has its own Claude CLI subprocess
- Exit code 1 + stderr containing "already in use" = Session conflict
- Automatically creates new process on conflict

#### Conversation History
- `DingTalkBot.conversations: Map<conversationId, Conversation>`
- Each message appends user/assistant records
- Full history sent to Claude for maintaining context

#### Graceful Shutdown
1. Receive SIGTERM/SIGINT
2. Mark all sessions as stopping
3. Kill Claude process trees using `taskkill /T` (includes child processes)
4. Wait for processes to exit
5. Update `.claude_sessions` status to stopped
6. Close DingTalk WebSocket connection
7. Close HTTP server

## Configuration

| Variable | Description | Required |
|----------|-------------|----------|
| `DINGTALK_CLIENT_ID` | DingTalk app client ID | Yes |
| `DINGTALK_CLIENT_SECRET` | DingTalk app client secret | Yes |
| `DINGTALK_CARD_TEMPLATE_ID` | DingTalk card template ID | No |
| `PORT` | Server port (default 3000) | No |

## Development

```bash
npm run dev  # Run with hot-reload using tsx watch
```

## License

MIT
