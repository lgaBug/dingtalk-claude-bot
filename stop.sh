#!/bin/bash

# 优雅停止 DingTalk Bot

echo "正在查找 bot 进程..."
PIDS=$(pgrep -f "tsx.*src/index.ts" | tr '\n' ' ')

if [ -z "$PIDS" ]; then
  echo "未找到运行中的 bot 进程"
  exit 0
fi

echo "找到进程：$PIDS"
echo "正在发送 SIGTERM 信号..."
kill $PIDS 2>/dev/null

sleep 2

# 检查是否还有残留进程
REMAINING=$(pgrep -f "tsx.*src/index.ts")
if [ -n "$REMAINING" ]; then
  echo "部分进程未退出，发送 SIGKILL..."
  kill -9 $REMAINING 2>/dev/null
fi

echo "Bot 已停止"
