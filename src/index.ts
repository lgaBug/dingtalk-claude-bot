import { config } from './config.js';
import { createServer } from './server/express.js';
import { DingTalkClient } from './dingtalk/client.js';
import { DingTalkBot } from './dingtalk/bot.js';

async function main() {
  console.log('=== Bot Starting ===');

  const dingtalkClient = new DingTalkClient({
    botToken: config.dingtalk.clientId,
    secret: config.dingtalk.clientSecret,
  });

  const bot = new DingTalkBot(dingtalkClient, config.claude.processName);

  dingtalkClient.setBot(bot);

  await dingtalkClient.startStream();

  console.log(`Bot ready (base process name: ${config.claude.processName}, per-conversation isolation enabled)`);

  const app = createServer(bot);

  const server = app.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
  });

  const shutdown = async () => {
    console.log('=== Bot Shutting Down ===');

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
