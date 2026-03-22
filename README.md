# DingTalk Claude Bot

基于 Claude Code CLI 的钉钉机器人。通过钉钉流式 API 接收消息，并实时流式响应。

[English](./README_EN.md)

## 功能特性

- 通过钉钉互动卡片实时流式响应
- 会话内持久化对话历史（多轮对话支持）
- WebSocket 长连接接收钉钉消息
- 支持多并发对话（每个会话独立 Claude 进程）
- 消息去重（应对钉钉 At-Least-Once 语义）

## 环境要求

- Node.js 18+
- Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)
- 已启用流式 API 的钉钉机器人应用

## 快速开始

1. **克隆仓库**
   ```bash
   git clone <你的仓库地址>
   cd dingtalk-claude-bot
   ```

2. **安装依赖**
   ```bash
   npm install
   ```

3. **配置环境变量**
   ```bash
   cp .env.example .env
   # 编辑 .env 填入你的钉钉凭证：
   # DINGTALK_CLIENT_ID=你的_client_id
   # DINGTALK_CLIENT_SECRET=你的_client_secret
   ```

4. **构建项目**
   ```bash
   npm run build
   ```

5. **启动机器人**
   ```bash
   npm start
   ```

## 工作原理

### 整体架构

```
┌─────────────┐     WebSocket      ┌─────────────┐
│   钉钉客户端   │ ←──────────────→  │  DingTalk   │
│  (用户消息)   │   Stream API       │   Client    │
└─────────────┘                    └──────┬──────┘
                                          │
                                          │ handleMessage()
                                          ▼
┌─────────────┐     stdin/stdout    ┌──────┴──────┐
│   Claude    │ ←───────────────→  │  DingTalk   │
│   Code CLI  │   流式 JSON         │     Bot     │
│  (子进程)    │                    └──────┬──────┘
└─────────────┘                          │
                                          │ updateCard()
                                          ▼
┌─────────────┐     PUT /v1.0/    ┌─────────────┐
│   钉钉服务端   │ ←──────────────  │ Card Stream │
│  (互动卡片)   │   streaming      │   Update    │
└─────────────┘                    └─────────────┘
```

### 消息处理流程

#### 1. 钉钉 WebSocket 长连接

```
机器人启动 → DWClient.connect() → 建立 WebSocket 长连接
                                        ↓
                            监听 /v1.0/im/bot/messages/get
                                        ↓
                              收到消息 → handleCallback()
```

- 使用 `dingtalk-stream` SDK 建立 WebSocket 连接
- 注册回调监听机器人消息
- 立即返回 `EventAck.SUCCESS` 防止钉钉重试

#### 2. 消息去重

```typescript
shouldSkipMessage(msgUid, createAt):
  if msgUid 在 processingMessages 中且时间差 < 2分钟:
    return true  // 跳过重复消息
  else:
    添加到 processingMessages
    return false // 开始处理
```

钉钉使用 At-Least-Once 语义，同一条消息可能投递多次，通过 `msgUid` 去重。

#### 3. 会话管理

每个 `conversationId` 对应一个持久化的 Claude CLI 进程：

```
conversationId (钉钉格式如 cidZShXIFb...)
      ↓ SHA-256 哈希
sessionId (标准 UUID 格式)
      ↓
Claude CLI --session-id={sessionId}
```

进程复用策略：
- 启动时随机生成共享 session ID（避免与其他 Claude 进程冲突）
- 每个会话首次消息时创建新进程
- 后续消息复用已有进程
- 进程通过 `session-id` 保持对话上下文

#### 4. Claude CLI 集成

```bash
claude -p --output-format stream-json --input-format stream-json \
       --session-id {sessionId} --dangerously-skip-permissions
```

**进程生命周期：**
1. 启动时从 `.claude_sessions` 加载并杀死残留进程（使用 `taskkill /T` 杀进程树）
2. 随机生成共享 session ID（避免与其他 Claude 进程冲突）
3. 启动新进程，等待 5 秒初始化完成
4. 通过 stdin 发送消息，stdout 接收流式响应
5. 监听 stderr 检测 session 冲突错误

**消息格式：**
```typescript
// 发送
stdin.write(`{"type":"user","message":{"role":"user","content":"${message}"}}\n`);
stdin.write('{"type":"result"}\n');  // 发送后 300ms 发送 result 标记

// 接收
{"type":"system","subtype":"init",...}  // 初始化完成
{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
{"type":"result",...}  // 响应结束
{"type":"error","content":"...",...}  // 错误
```

#### 5. 流式卡片更新

```
用户发消息 → createStreamCard() → 创建互动卡片 (flowStatus=2 streaming)
                ↓
          每收到 5 个 chunk 或 chunk < 50 字符
                ↓
          updateCard(content, isFinal=false) → PUT /v1.0/card/streaming
                ↓
          onComplete()
                ↓
          updateCard(content, isFinal=true) → flowStatus=3 (完成)
```

卡片状态：
- `flowStatus: 2` = streaming（流式进行中）
- `flowStatus: 3` = complete（完成）

#### 6. 完整消息流程

```
1. 用户在钉钉向机器人发送消息
2. WebSocket 收到消息 → shouldSkipMessage() 去重检查
3. DingTalkBot.handleMessage():
   a. 创建/获取 Conversation（保存对话历史）
   b. 调用 dingtalk.createStreamCard() 创建流式卡片
   c. 调用 claude.streamMessage() 发送消息
4. ClaudeClient.streamMessage():
   a. 获取或创建 Claude CLI 进程
   b. 通过 stdin 发送消息和 result 标记
   c. 监听 stdout 解析 JSON 流事件
5. 收到 Claude chunk → dingtalk.updateCard() 实时更新卡片
6. 响应完成 → updateCard(isFinal=true) 标记卡片结束
7. 关闭时：标记所有进程为 stopping → 等待进程退出（最多3秒超时） → 更新文件状态 → 关闭连接
```

### 项目结构

```
src/
├── index.ts              # 入口点，启动服务器和初始化
├── config.ts             # 环境变量配置
├── logger.ts             # 结构化日志
├── server/
│   └── express.ts        # HTTP 服务器（健康检查）
├── claude/
│   └── client.ts         # Claude CLI 进程管理、流式解析
└── dingtalk/
    ├── bot.ts            # 消息路由、会话状态、去重逻辑
    ├── client.ts         # WebSocket 连接、卡片 API
    └── card.ts           # 卡片消息模板
```

### 关键设计

#### 进程隔离
- 每个会话独立 Claude CLI 进程
- 进程退出码 1 + stderr 含 "already in use" = Session 冲突
- 冲突时自动创建新进程

#### 对话历史
- `DingTalkBot.conversations: Map<conversationId, Conversation>`
- 每次消息追加 user/assistant 两条记录
- Claude 请求时发送完整历史以保持上下文

#### 优雅关闭
1. 接收 SIGTERM/SIGINT
2. 标记所有会话为 stopping
3. 使用 `taskkill /T` 杀死 Claude 进程树（包括子进程）
4. 等待进程真正退出
5. 更新 `.claude_sessions` 状态为 stopped
6. 关闭 DingTalk WebSocket 连接
7. 关闭 HTTP 服务器

## 配置项

| 变量 | 描述 | 必填 |
|------|------|------|
| `DINGTALK_CLIENT_ID` | 钉钉应用 Client ID | 是 |
| `DINGTALK_CLIENT_SECRET` | 钉钉应用 Client Secret | 是 |
| `DINGTALK_CARD_TEMPLATE_ID` | 钉钉卡片模板 ID | 否 |
| `PORT` | 服务器端口（默认 3000） | 否 |

## 开发模式

```bash
npm run dev  # 使用 tsx watch 热重载
```

## 开源协议

MIT
