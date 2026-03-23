import { config } from './config.js';
import { createServer } from './server/express.js';
import { DingTalkClient } from './dingtalk/client.js';
import { DingTalkBot } from './dingtalk/bot.js';
import { ClaudeClient } from './claude/client.js';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SESSION_FILE = path.join(process.cwd(), '.claude_sessions');

interface SessionInfo {
  sessionId: string;
  pid: number;
  status: 'running' | 'stopping' | 'stopped';
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

  const sessions = readSessions();
  console.log('Previous sessions:', sessions);

  // 清理之前标记为 running 的进程
  const isWindows = os.platform() === 'win32';
  const runningSessions = sessions.filter(s => s.status === 'running');
  for (const session of runningSessions) {
    console.log(`Killing previous Claude process: PID=${session.pid}, sessionId=${session.sessionId}`);
    try {
      if (isWindows) {
        spawn('taskkill', ['/F', '/PID', session.pid.toString()], { shell: true });
      } else {
        process.kill(session.pid, 'SIGKILL');
      }
    } catch (e) {
      console.log('Failed to kill process:', e);
    }
  }

  if (sessions.length > 0) {
    writeSessions(sessions.map(s => ({ ...s, status: 'stopped' as const })));
  }

  await new Promise(resolve => setTimeout(resolve, 1000));

  const claudeClient = new ClaudeClient();

  const dingtalkClient = new DingTalkClient({
    botToken: config.dingtalk.clientId,
    secret: config.dingtalk.clientSecret,
  });

  const bot = new DingTalkBot(dingtalkClient, claudeClient);

  dingtalkClient.setBot(bot);

  await dingtalkClient.startStream();

  console.log('Initializing Claude CLI (this takes ~5 seconds)...');
  const initSuccess = await bot.preInitializeClaude();
  if (!initSuccess) {
    console.log('WARNING: Claude CLI initialization failed, bot may not respond properly');
  } else {
    console.log('Claude CLI initialized, ready to serve requests');
  }

  const app = createServer(bot);

  const server = app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });

  const shutdown = async () => {
    console.log('=== Bot Shutting Down ===');

    claudeClient.markAllSessionsStopping();
    await claudeClient.closeAllAsync();

    const currentSessions = readSessions();
    writeSessions(currentSessions.map(s => ({ ...s, status: 'stopped' as const })));

    dingtalkClient.close();
    bot.destroy();

    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });

    setTimeout(() => {
      console.log('Forced exit after timeout');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(console.error);
