# DingTalk Image MCP Tool — Claude Code 使用指南

本文档面向 Claude Code 实例，说明如何通过 `dingtalk_send_image` MCP 工具将图片发送到钉钉聊天。

---

## 工具概述

`dingtalk_send_image` 是一个通过 MCP (Model Context Protocol) 注册的工具，允许你将本地图片文件上传并发送到钉钉的单聊或群聊中。

**支持的图片格式**：PNG、JPG、JPEG、GIF、BMP、WEBP

---

## 前置条件

### 1. 工具已注册

由用户或管理员执行以下命令完成全局注册：

```bash
claude mcp add --global dingtalk-image -- node --import tsx /path/to/src/mcp/dingtalk-image-server.ts
```

注册后，你的工具列表中会出现 `mcp__dingtalk-image__dingtalk_send_image`。

### 2. 环境变量已配置

以下环境变量需要在 MCP Server 运行环境中可用：

| 变量 | 说明 | 必填 |
|------|------|------|
| `DINGTALK_CLIENT_ID` | 钉钉应用 Client ID | 是 |
| `DINGTALK_CLIENT_SECRET` | 钉钉应用 Client Secret | 是 |
| `DINGTALK_ROBOT_CODE` | 钉钉机器人 Code | 是 |
| `DINGTALK_IMAGE_TARGET` | 默认发送目标 | 否 |

---

## 调用方式

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file_path` | string | 是 | 图片文件路径（绝对路径或相对于当前工作目录的相对路径） |
| `target` | string | 否 | 发送目标，格式见下方说明 |

### target 格式

- **单聊**：`user:<staffId>`，例如 `user:012345`
- **群聊**：`group:<openConversationId>`，例如 `group:cidXXXXXXXX`

### target 解析优先级

当 `target` 参数未提供时，工具按以下顺序自动解析发送目标：

1. **`.dingtalk-context.json`**（当前工作目录下） — 由 DingTalk Bot 在收到用户消息时自动写入，包含 `conversationId`、`conversationType`、`senderStaffId`、`robotCode`。如果你是从钉钉 Bot 触发的 Claude Code 会话，这个文件通常已存在，无需手动指定 target。
2. **`DINGTALK_IMAGE_TARGET` 环境变量** — 用户预设的默认目标。
3. **都不存在** — 返回错误，要求显式指定 target。

---

## 调用示例

### 场景 1：从钉钉 Bot 会话中发送（最常见）

Bot 已自动写入 `.dingtalk-context.json`，直接调用即可，无需指定 target：

```
使用 dingtalk_send_image 工具，发送 ./output/chart.png
```

工具调用：
```json
{
  "file_path": "./output/chart.png"
}
```

### 场景 2：指定发送给某个用户

```
使用 dingtalk_send_image 工具，把 /tmp/screenshot.png 发送给用户 012345
```

工具调用：
```json
{
  "file_path": "/tmp/screenshot.png",
  "target": "user:012345"
}
```

### 场景 3：指定发送到某个群聊

```json
{
  "file_path": "./result.png",
  "target": "group:cidAbCdEfGhIjKlMn"
}
```

---

## 典型工作流

以下是一些你可能用到此工具的场景：

### 生成图表后发送

```
1. 用 Bash 工具执行 Python 脚本生成图表
2. 确认图表文件已生成（如 ./output/chart.png）
3. 调用 dingtalk_send_image 发送图片
```

### 截图后发送

```
1. 用 Playwright 等工具截取网页截图
2. 调用 dingtalk_send_image 发送截图文件
```

### 处理图片后发送

```
1. 用 Bash 调用 ImageMagick 等工具处理图片
2. 调用 dingtalk_send_image 发送处理后的图片
```

---

## 返回值

### 成功

```
Image sent successfully to user 012345: chart.png
```

### 失败

工具返回 `isError: true` 以及错误信息，常见错误：

| 错误 | 原因 |
|------|------|
| `DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET environment variables are required` | 环境变量未配置 |
| `DINGTALK_ROBOT_CODE environment variable is required` | 缺少机器人 Code |
| `No target specified` | 未指定 target 且无法自动解析 |
| `File not found: /path/to/file` | 图片文件不存在 |
| `Not an image file (.txt)` | 文件扩展名不是支持的图片格式 |
| `Upload failed: ...` | 钉钉图片上传 API 报错 |
| `Failed to send image: ...` | 钉钉消息发送 API 报错 |

---

## 注意事项

- 文件路径会被 `path.resolve()` 处理，相对路径基于 MCP Server 的工作目录（通常与 Claude Code 的工作目录一致）。
- 图片需要先上传到钉钉的媒体文件服务器获取 `mediaId`，再通过消息 API 发送，因此调用耗时取决于图片大小和网络状况。
- 单次只能发送一张图片。如需发送多张，请多次调用。
- 该工具只负责发送图片，不负责生成图片。请先用其他工具（Bash、Write 等）生成或准备好图片文件。
