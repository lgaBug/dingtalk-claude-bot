import express, { Request, Response } from 'express';
import type { DingTalkBot } from '../dingtalk/bot.js';

export function createServer(bot: DingTalkBot): express.Application {
  const app = express();

  app.use(express.json());

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  app.post('/webhook', async (req: Request, res: Response) => {
    try {
      const { conversationId, senderNick, text } = req.body;
      await bot.handleMessage(conversationId, senderNick, text);
      res.json({ success: true });
    } catch (error) {
      console.error('Webhook error:', error);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return app;
}
