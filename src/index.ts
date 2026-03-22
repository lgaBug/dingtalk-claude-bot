import { config } from './config.js';
import { createServer } from './server/express.js';
import { DingTalkClient } from './dingtalk/client.js';
import { DingTalkBot } from './dingtalk/bot.js';
import { ClaudeClient } from './claude/client.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_FILE = path.join(process.cwd(), '.claude_sessions');

interface SessionInfo {
  sessionId: string;
  pid: number;
  status: 'running' | 'stopped';
}

function readSessions(): SessionInfo[] {
  if (fs.existsSync(SESSION_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
    } catch {
      return [];
    }
  }
  return [];
}

function writeSessions(sessions: SessionInfo[]): void {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
}

async function main() {
  console.log('=== Bot Starting ===');

  // 读取之前记录的 session
  const sessions = readSessions();
  console.log('Previous sessions:', sessions);

  // 清理之前标记为 running 的进程
  const runningSessions = sessions.filter(s => s.status === 'running');
  for (const session of runningSessions) {
    console.log(`Killing previous Claude process: PID=${session.pid}, sessionId=${session.sessionId}`);
    try {
      spawn('taskkill', ['/F', '/PID', session.pid.toString()], { shell: true });
    } catch (e) {
      console.log('Failed to kill process:', e);
    }
  }

  // 更新所有 session 状态为 stopped
  if (sessions.length > 0) {
    writeSessions(sessions.map(s => ({ ...s, status: 'stopped' })));
  }

  // 等待进程清理
  await new Promise(resolve => setTimeout(resolve, 1000));

  const claudeClient = new ClaudeClient();

  const dingtalkClient = new DingTalkClient({
    botToken: config.dingtalk.clientId,
    secret: config.dingtalk.clientSecret,
  });

  const bot = new DingTalkBot(dingtalkClient, claudeClient);

  dingtalkClient.setBot(bot);

  await dingtalkClient.startStream();

  // Bot 启动后初始化 Claude CLI 进程
  console.log('Initializing Claude CLI (this takes ~5 seconds)...');
  await bot.preInitializeClaude();
  console.log('Claude CLI initialized, ready to serve requests');

  const app = createServer(bot);

  const server = app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });

  // 优雅关闭
  const shutdown = async () => {
    console.log('=== Bot Shutting Down ===');

    // 更新 session 状态并关闭
    claudeClient.markAllSessionsStopping();

    // 等待一小段时间让进程处理
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 关闭所有 Claude 进程
    claudeClient.closeAll();

    // 读取当前 session 并标记为 stopped
    const currentSessions = readSessions();
    writeSessions(currentSessions.map(s => ({ ...s, status: 'stopped' })));

    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });

    // 强制退出
    setTimeout(() => process.exit(1), 5000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(console.error);
