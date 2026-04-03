import { config } from './config.js';
import { createServer } from './server/express.js';
import { DingTalkClient } from './dingtalk/client.js';
import { DingTalkBot } from './dingtalk/bot.js';
import { ClaudeClient } from './claude/client.js';

async function main() {
  console.log('=== Bot Starting ===');

  const claudeClient = new ClaudeClient(
    config.claude.processName,
    config.claude.workingDirectory
  );

  const dingtalkClient = new DingTalkClient({
    botToken: config.dingtalk.clientId,
    secret: config.dingtalk.clientSecret,
  });

  const bot = new DingTalkBot(dingtalkClient, claudeClient);

  dingtalkClient.setBot(bot);

  await dingtalkClient.startStream();

  console.log(`Connecting to Claude proxy (name: ${config.claude.processName})...`);
  const initSuccess = await bot.preInitializeClaude();
  if (!initSuccess) {
    console.log('WARNING: Claude proxy connection failed, bot may not respond properly');
  } else {
    console.log('Claude proxy connected, ready to serve requests');
  }

  const app = createServer(bot);

  const server = app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });

  const shutdown = async () => {
    console.log('=== Bot Shutting Down ===');

    // Disconnect from proxy (proxy and Claude CLI keep running)
    claudeClient.disconnect();

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
