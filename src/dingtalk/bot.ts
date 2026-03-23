import type { DingTalkClient } from './client.js';
import type { ClaudeClient } from '../claude/client.js';
import { logger } from '../logger.js';

const MAX_HISTORY_MESSAGES = 50; // 每个会话最多保留的消息数
const DEDUP_CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 分钟清理一次去重 Map
const DEDUP_TTL = 2 * 60 * 1000; // 消息去重有效期 2 分钟

interface Message {
  role: 'user' | 'assistant';
  content: string;
  sender?: string;
  timestamp: number;
}

interface Conversation {
  id: string;
  messages: Message[];
  cardId?: string;
  outTrackId?: string;
}

export class DingTalkBot {
  private dingtalk: DingTalkClient;
  private claude: ClaudeClient;
  private conversations: Map<string, Conversation> = new Map();
  private processingMessages: Map<string, number> = new Map(); // msgUid -> timestamp
  private initialized: boolean = false;
  private dedupCleanupTimer?: ReturnType<typeof setInterval>;

  constructor(dingtalk: DingTalkClient, claude: ClaudeClient) {
    this.dingtalk = dingtalk;
    this.claude = claude;

    // 定期清理过期的去重记录
    this.dedupCleanupTimer = setInterval(() => {
      this.cleanupProcessingMessages();
    }, DEDUP_CLEANUP_INTERVAL);
  }

  // 清理过期的去重记录
  private cleanupProcessingMessages(): void {
    const now = Date.now();
    let cleaned = 0;
    for (const [msgUid, timestamp] of this.processingMessages) {
      if (now - timestamp > DEDUP_TTL) {
        this.processingMessages.delete(msgUid);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug('DingTalk-Bot', 'Cleaned up dedup entries', { cleaned, remaining: this.processingMessages.size });
    }
  }

  destroy(): void {
    if (this.dedupCleanupTimer) {
      clearInterval(this.dedupCleanupTimer);
    }
  }

  async preInitializeClaude(): Promise<boolean> {
    if (this.initialized) return true;

    logger.info('DingTalk-Bot', 'Pre-initializing Claude CLI...');

    const success = await this.claude.createSharedProcess();

    if (success) {
      this.initialized = true;
      logger.info('DingTalk-Bot', 'Claude CLI pre-initialization complete');
    } else {
      logger.error('DingTalk-Bot', 'Claude CLI pre-initialization failed');
    }

    return success;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  async handleMessage(
    conversationId: string,
    senderNick: string,
    text: string,
    msgUid?: string,
    senderStaffId?: string,
    sessionWebhook?: string,
    robotCode?: string
  ) {
    logger.info('DingTalk-Bot', '=== New Message Received ===', {
      conversationId,
      senderNick,
      msgUid,
      senderStaffId,
      textLength: text.length,
      textPreview: text.substring(0, 100),
    });

    try {
      let conversation = this.conversations.get(conversationId);
      if (!conversation) {
        logger.info('DingTalk-Bot', 'Creating new conversation', { conversationId });
        conversation = {
          id: conversationId,
          messages: [],
        };
        this.conversations.set(conversationId, conversation);
      }

      const userMessage: Message = {
        role: 'user',
        content: text,
        sender: senderNick,
        timestamp: Date.now(),
      };

      conversation.messages.push(userMessage);

      // 限制会话历史长度
      if (conversation.messages.length > MAX_HISTORY_MESSAGES) {
        conversation.messages = conversation.messages.slice(-MAX_HISTORY_MESSAGES);
      }

      // 创建流式 AI 卡片
      let outTrackId: string | undefined = undefined;
      if (senderStaffId && robotCode) {
        logger.info('DingTalk-Bot', 'Creating stream card', { conversationId, senderStaffId });
        const newOutTrackId = await this.dingtalk.createStreamCard(conversationId, robotCode, senderStaffId, text);
        if (newOutTrackId) {
          outTrackId = newOutTrackId;
          conversation.outTrackId = newOutTrackId;
          logger.info('DingTalk-Bot', 'Stream card created', { conversationId, outTrackId });
        }
      }

      logger.info('DingTalk-Bot', '>>> Calling Claude Code', {
        conversationId,
        messageCount: conversation.messages.length,
        latestMessage: text.substring(0, 100),
      });

      let fullResponse = '';
      let chunkCount = 0;
      let isComplete = false;

      // Claude CLI 通过 session-id 维护上下文，只发送最新消息
      await this.claude.streamMessage({
        messages: [{ role: 'user', content: text }],
        onChunk: async (chunk: string) => {
          if (isComplete) return;

          chunkCount++;
          fullResponse += chunk;

          logger.debug('DingTalk-Bot', '<<< Claude chunk', {
            conversationId,
            chunkNumber: chunkCount,
            chunkLength: chunk.length,
            totalResponseLength: fullResponse.length,
          });

          if (outTrackId) {
            await this.dingtalk.updateCard(conversationId, fullResponse, false);
          }
        },
        onComplete: async () => {
          if (isComplete) return;
          isComplete = true;

          logger.info('DingTalk-Bot', '>>> Claude Code streaming completed', {
            conversationId,
            totalChunks: chunkCount,
            totalResponseLength: fullResponse.length,
            responsePreview: fullResponse.substring(0, 100),
          });

          conversation!.messages.push({
            role: 'assistant',
            content: fullResponse,
            timestamp: Date.now(),
          });

          // 限制会话历史长度
          if (conversation!.messages.length > MAX_HISTORY_MESSAGES) {
            conversation!.messages = conversation!.messages.slice(-MAX_HISTORY_MESSAGES);
          }

          if (outTrackId) {
            await this.dingtalk.updateCard(conversationId, fullResponse, true);
          }
        },
        onError: async (error: Error) => {
          logger.error('DingTalk-Bot', 'Claude Code streaming error', {
            conversationId,
            error: error.message,
          });

          const errorContent = `抱歉，发生了错误: ${error.message}`;
          if (outTrackId) {
            await this.dingtalk.updateCard(conversationId, errorContent, true);
          }
        },
      }, conversationId);
    } finally {
      // 基于时间去重，不删除 msgUid
    }
  }

  clearConversation(conversationId: string) {
    logger.info('DingTalk-Bot', 'Clearing conversation', { conversationId });
    this.conversations.delete(conversationId);
  }

  shouldSkipMessage(msgUid: string, createAt: number): boolean {
    if (!msgUid) return false;
    const now = Date.now();
    const last = this.processingMessages.get(msgUid);
    if (last && (now - last) < DEDUP_TTL) {
      return true;
    }
    this.processingMessages.set(msgUid, now);
    return false;
  }

  getConversationStats(conversationId: string) {
    const conv = this.conversations.get(conversationId);
    if (!conv) return null;
    return {
      conversationId,
      messageCount: conv.messages.length,
      cardId: conv.outTrackId,
    };
  }
}
