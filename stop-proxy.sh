#!/bin/bash

# 优雅停止 Claude Proxy 和 Claude CLI
# 支持指定 process name，默认使用 .env 中的配置

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

# 默认 process name
DEFAULT_PROCESS_NAME="default"

# 从 .env 文件读取 CLAUDE_PROCESS_NAME
if [ -f "$ENV_FILE" ]; then
  PROCES_NAME_FROM_ENV=$(grep "^CLAUDE_PROCESS_NAME=" "$ENV_FILE" | cut -d'=' -f2 | tr -d '"' | tr -d "'")
  if [ -n "$PROCES_NAME_FROM_ENV" ]; then
    DEFAULT_PROCESS_NAME="$PROCES_NAME_FROM_ENV"
  fi
fi

# 支持命令行参数覆盖
PROCESS_NAME="${1:-$DEFAULT_PROCESS_NAME}"

echo "======================================"
echo "  Claude Proxy 停止脚本"
echo "======================================"
echo "Process Name: $PROCESS_NAME"

# 计算 PID 文件和 Socket 路径
TMP_DIR=$(mktemp -d 2>/dev/null || echo "/tmp")
PID_FILE="$TMP_DIR/claude-proxy-${PROCESS_NAME}.pid"
SOCKET_FILE="$TMP_DIR/claude-bot-${PROCESS_NAME}.sock"

# 在 macOS 上，使用实际的 /tmp 目录
if [[ "$OSTYPE" == "darwin"* ]]; then
  PID_FILE="/tmp/claude-proxy-${PROCESS_NAME}.pid"
  SOCKET_FILE="/tmp/claude-bot-${PROCESS_NAME}.sock"
fi

echo "PID File: $PID_FILE"
echo "Socket: $SOCKET_FILE"
echo ""

# 1. 查找并停止 Proxy 进程
STOPPED=false

if [ -f "$PID_FILE" ]; then
  PROXY_PID=$(cat "$PID_FILE" 2>/dev/null)
  if [ -n "$PROXY_PID" ] && ps -p "$PROXY_PID" > /dev/null 2>&1; then
    echo "[1/3] 正在停止 Proxy 进程 (PID: $PROXY_PID)..."
    kill -SIGTERM "$PROXY_PID" 2>/dev/null

    # 等待进程退出（最多 5 秒）
    for i in {1..5}; do
      if ! ps -p "$PROXY_PID" > /dev/null 2>&1; then
        break
      fi
      sleep 1
    done

    # 如果还在运行，强制杀死
    if ps -p "$PROXY_PID" > /dev/null 2>&1; then
      echo "      Proxy 未响应 SIGTERM，发送 SIGKILL..."
      kill -SIGKILL "$PROXY_PID" 2>/dev/null
    else
      echo "      Proxy 已停止"
    fi

    rm -f "$PID_FILE"
    STOPPED=true
  fi
fi

# 2. 如果 PID 文件不存在或无效，尝试通过进程名查找
if [ "$STOPPED" = false ]; then
  echo "[1/3] 未找到 PID 文件，尝试通过进程名查找..."

  # 查找匹配的 proxy 进程
  PROXY_PIDS=$(ps aux | grep "claude.*proxy" | grep "$PROCESS_NAME" | grep -v grep | awk '{print $2}')

  if [ -n "$PROXY_PIDS" ]; then
    echo "      找到 Proxy 进程：$PROXY_PIDS"
    for pid in $PROXY_PIDS; do
      echo "      正在停止 PID: $pid"
      kill -SIGTERM "$pid" 2>/dev/null
    done

    sleep 2

    # 检查是否还有残留
    REMAINING=$(ps aux | grep "claude.*proxy" | grep "$PROCESS_NAME" | grep -v grep | awk '{print $2}')
    if [ -n "$REMAINING" ]; then
      echo "      部分进程未退出，发送 SIGKILL..."
      for pid in $REMAINING; do
        kill -SIGKILL "$pid" 2>/dev/null
      done
    fi

    STOPPED=true
  else
    echo "      未找到运行中的 Proxy 进程"
  fi
fi

# 3. 清理 Socket 文件
echo "[2/3] 清理 Socket 文件..."
if [ -S "$SOCKET_FILE" ]; then
  rm -f "$SOCKET_FILE"
  echo "      已删除：$SOCKET_FILE"
else
  echo "      Socket 文件不存在或已删除"
fi

# 4. 查找并停止 Claude CLI 进程（如果有残留）
echo "[3/3] 检查 Claude CLI 进程..."
CLAUDE_PIDS=$(ps aux | grep "claude" | grep -v grep | grep -v "claude-code" | awk '{print $2}')

if [ -n "$CLAUDE_PIDS" ]; then
  # 更精确地匹配 Claude CLI 进程（由 proxy 启动的）
  for pid in $CLAUDE_PIDS; do
    CMD=$(ps -p "$pid" -o command= 2>/dev/null)
    if [[ "$CMD" == *"session"* ]] || [[ "$CMD" == *"claude"* ]]; then
      echo "      发现 Claude 进程 (PID: $pid): $CMD"
    fi
  done
else
  echo "      未发现需要清理的 Claude CLI 进程"
fi

echo ""
echo "======================================"
if [ "$STOPPED" = true ]; then
  echo "  Proxy 已停止 ✅"
else
  echo "  未找到运行中的 Proxy"
fi
echo "======================================"
