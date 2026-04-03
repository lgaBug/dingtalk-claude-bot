# CLAUDE.md

本文档为 Claude Code (claude.ai/code) 在此仓库中工作提供指导。

## 项目概述

钉钉机器人，集成 Claude Code CLI。通过钉钉流式 WebSocket API 接收消息，转发给本地运行的 Claude Code CLI 子进程，并将**所有事件**（工具调用、工具结果、文本回复）以格式化 Markdown 形式实时回传到钉钉互动卡片。

## 常用命令

```bash
npm run dev       # 开发模式，热重载 (tsx watch)
npm run dev:watch # 开发模式，监听模式
npm run build     # 编译 TypeScript 到 dist/
npm start         # 生产环境，从 dist/ 启动
```

**前置要求**: 必须全局安装 Claude Code CLI (`npm install -g @anthropic-ai/claude-code`)。

## 架构概览

```
src/index.ts              # 入口 - 组装组件、优雅停机
src/server/express.ts     # Express 健康检查端点
src/dingtalk/bot.ts       # DingTalkBot - 消息路由、会话状态、去重
src/dingtalk/client.ts    # DingTalkClient - WebSocket 流、卡片 API、Token 缓存
src/claude/client.ts      # ClaudeClient - Proxy 连接、事件解析、格式化
src/claude/proxy.ts       # Claude Proxy - 独立进程，管理 Claude CLI 生命周期
src/config.ts             # 环境变量配置
src/logger.ts             # 结构化日志（控制台 + 文件）
src/mcp/dingtalk-image-server.ts  # MCP 工具服务：发送图片到钉钉
```

## 核心设计模式

**Proxy 架构**: Bot 通过 Named Pipe（Windows）/ Unix Socket 与独立的 Proxy 进程通信，Proxy 管理 Claude CLI。优势：
- Bot 重启不影响 Claude CLI（Proxy + CLI 持续运行）
- 基于进程名匹配（通过 `CLAUDE_PROCESS_NAME` 配置）
- Proxy 未运行时自动启动
- Claude CLI 崩溃后自动重启

```
Bot (可重启) ←Named Pipe→ Claude Proxy (长驻) ←stdio→ Claude CLI (长驻)
```

**事件流水线**: 钉钉 WebSocket → DingTalkClient → DingTalkBot → ClaudeClient → Named Pipe → Proxy → Claude CLI → stream-json 事件 → 格式化为 Markdown → 钉钉卡片更新

**事件格式化** (`claude/client.ts`):
- `assistant(tool_use)` → `📖 Read`、`⚡ Bash`、`✏️ Edit` + 格式化参数
- `user(tool_result)` → 截断展示结果（最多 25 行 / 1500 字符）；静默工具不展示
- `assistant(text)` → 透传文本
- `result` → `⏱ turns · duration · cost` 统计
- 图片检测：自动发送 `Write`/`Bash` 工具创建的 `.png/.jpg/.gif/.webp` 文件

**多卡片分页**: 响应超过 6000 字符时，自动 finalize 当前卡片并创建新卡片。卡片显示 `(Part N)` 标签和续接提示。

**Token 缓存**: 钉钉 access token 缓存 2 小时（提前 5 分钟刷新），避免频率限制。

**会话管理**: Claude CLI `--session-id` 由 `CLAUDE_PROCESS_NAME` 确定性生成（SHA256 哈希）。会话上下文在 Bot 和 Proxy 重启后持久化。

**去重机制**: `processingMessages` Map 跟踪 `msgUid`，TTL 2 分钟，每 5 分钟清理一次。

**历史上限**: 每个会话内存中最多保留 50 条消息。

**卡片更新防抖**: 500ms 间隔避免频率限制；内容未变化时跳过更新。

## 配置项

环境变量（见 `.env.example`）：
- `DINGTALK_CLIENT_ID` - 钉钉应用 Client ID（必填）
- `DINGTALK_CLIENT_SECRET` - 钉钉应用 Client Secret（必填）
- `DINGTALK_CARD_TEMPLATE_ID` - 钉钉卡片模板 ID（可选，默认：`ed5262bd-f1d2-4def-ae1e-249c6cb5643a.schema`）
- `PORT` - 服务器端口（默认：3000）
- `CLAUDE_PROCESS_NAME` - Claude CLI Proxy 进程名，用于进程匹配（默认：'default'）
- `CLAUDE_WORKING_DIRECTORY` - Claude CLI 工作目录（可选，默认：Bot 启动目录）
- `DINGTALK_ROBOT_CODE` - 钉钉机器人 Code，MCP 图片工具和群聊支持必填

## Proxy 管理

Proxy 作为独立进程运行，Bot 重启后依然存活。有用命令：
- Proxy PID 文件：`%TEMP%/claude-proxy-<name>.pid`（Windows）或 `/tmp/claude-proxy-<name>.pid`（Unix）
- Proxy 日志：`%TEMP%/claude-proxy-<name>.log` 或 `/tmp/claude-proxy-<name>.log`
- Named Pipe：`\\.\pipe\claude-bot-<name>`（Windows）或 `/tmp/claude-bot-<name>.sock`（Unix）
- 手动停止 Proxy：`kill $(cat <pidfile>)`（会同时停止 Claude CLI）

**自动重启**: Claude CLI 崩溃后，Proxy 以指数退避重启（3s、6s、12s、24s、48s），最多 5 次。成功初始化后（60s 正常运行）重置计数器。

## MCP 图片工具

独立的 MCP 工具服务（`dingtalk_send_image`），用于发送图片到钉钉。任何 Claude Code 实例均可使用。

全局注册：
```bash
claude mcp add --global dingtalk-image -- node --import tsx /path/to/src/mcp/dingtalk-image-server.ts
```

需要环境变量：`DINGTALK_CLIENT_ID`、`DINGTALK_CLIENT_SECRET`、`DINGTALK_ROBOT_CODE`。

当通过 Bot 触发时，`.dingtalk-context.json` 自动提供发送目标：
```json
{
  "conversationId": "...",
  "conversationType": "1" | "2",
  "senderStaffId": "...",
  "robotCode": "..."
}
```

**自动检测**: `ClaudeClient` 自动检测 `Write` 或 `Bash` 工具创建的图片文件（`.png/.jpg/.jpeg/.gif/.bmp/.webp`）并触发 `onImage` 回调。
