import { spawn, ChildProcess } from 'child_process';
import { randomUUID, createHash } from 'crypto';
import { logger } from '../logger.js';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_FILE = path.join(process.cwd(), '.claude_sessions');

interface SessionInfo {
  sessionId: string;
  pid: number;
  status: 'running' | 'stopping' | 'stopped';
}

// 从字符串生成一个有效的 UUID
function generateUUIDFromString(str: string): string {
  const hash = createHash('sha256').update(str).digest('hex');
  return `${hash.substring(0, 8)}-${hash.substring(8, 12)}-4${hash.substring(13, 16)}-${hash.substring(16, 20)}-${hash.substring(20, 32)}`;
}

interface StreamMessageOptions {
  messages: { role: string; content: string }[];
  onChunk: (chunk: string) => Promise<void>;
  onComplete: () => Promise<void>;
  onError?: (error: Error) => Promise<void>;
}

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
  content?: string;
  text?: string;
  is_error?: boolean;
}

interface PendingRequest {
  resolve: () => void;
  reject: (err: Error) => void;
  onChunk: (chunk: string) => Promise<void>;
  onComplete: () => Promise<void>;
  onError?: (error: Error) => Promise<void>;
}

export class ClaudeClient {
  private processes: Map<string, ChildProcess> = new Map();
  private buffers: Map<string, string> = new Map();
  private pendingRequests: Map<string, PendingRequest | null> = new Map();
  private sessionErrors: Map<string, string> = new Map();
  private sessionPids: Map<string, number> = new Map();

  private saveSessions(): void {
    const sessions: SessionInfo[] = [];
    for (const [sessionId, pid] of this.sessionPids) {
      sessions.push({
        sessionId,
        pid,
        status: 'running'
      });
    }
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
  }

  private updateSessionStatus(sessionId: string, status: 'running' | 'stopping' | 'stopped'): void {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        const sessions: SessionInfo[] = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        const idx = sessions.findIndex(s => s.sessionId === sessionId);
        if (idx >= 0) {
          sessions[idx].status = status;
          fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
        }
      }
    } catch (e) {
      logger.error('Claude-Code', 'Failed to update session status', { sessionId, error: e });
    }
  }

  // 创建一个共享的 Claude CLI 进程，用于所有消息
  async createSharedProcess(): Promise<void> {
    // 使用固定的 UUID 作为 shared sessionId
    const sharedSessId = '00000000-0000-4000-8000-000000000000';
    logger.info('Claude-Code', 'Creating shared Claude process', { sessionId: sharedSessId });

    const proc = this.createProcess(sharedSessId);
    this.processes.set(sharedSessId, proc);
    this.buffers.set(sharedSessId, '');
    this.pendingRequests.set(sharedSessId, null);
    this.sessionPids.set(sharedSessId, proc.pid!);
    this.saveSessions();

    // 等待初始化完成
    await new Promise<void>((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      }, 5000);

      if (proc.stderr) {
        proc.stderr.on('data', (data: Buffer) => {
          const content = data.toString();
          if (content.includes('already in use')) {
            logger.warn('Claude-Code', 'Shared session conflict during init', { sessionId: sharedSessId });
            if (!resolved) {
              resolved = true;
              this.sessionErrors.set(sharedSessId, content);
              resolve();
            }
          }
        });
      }
    });

    logger.info('Claude-Code', 'Shared Claude process ready', { sessionId: sharedSessId });
  }

  async streamMessage(options: StreamMessageOptions, sessionId?: string) {
    const { messages, onChunk, onComplete, onError } = options;

    const userMessage = messages[messages.length - 1]?.content || '';
    const conversationHistory = messages.slice(0, -1);

    logger.info('Claude-Code', '========================================');
    logger.info('Claude-Code', 'User message', { message: userMessage.substring(0, 100) });
    logger.debug('Claude-Code', 'Conversation history', { historyLength: conversationHistory.length });

    // 优先使用固定的 shared sessionId（如果存在且没有错误）
    const sharedSessId = '00000000-0000-4000-8000-000000000000';
    let currentSessId = sharedSessId;
    const sharedProc = this.processes.get(sharedSessId);
    const sharedError = this.sessionErrors.get(sharedSessId);

    if (!sharedProc || sharedError) {
      // shared 进程不存在或有问题，使用 conversationId 生成 sessionId
      currentSessId = sessionId ? generateUUIDFromString(sessionId) : randomUUID();
      logger.info('Claude-Code', 'Using conversation-based sessionId', { sessionId: currentSessId });
    } else {
      logger.info('Claude-Code', 'Using shared Claude process', { sessionId: currentSessId });
    }

    const fixedSessId = currentSessId;

    logger.info('Claude-Code', 'Session ID', { sessionId: currentSessId });

    // 获取或创建持久进程
    let proc = this.processes.get(currentSessId);
    let isNewProcess = false;

    if (!proc) {
      logger.info('Claude-Code', 'Creating new persistent Claude process', { sessionId: currentSessId });
      proc = this.createProcess(currentSessId);
      this.processes.set(currentSessId, proc);
      this.buffers.set(currentSessId, '');
      this.pendingRequests.set(currentSessId, null);
      this.sessionPids.set(currentSessId, proc.pid!);
      this.saveSessions();
      isNewProcess = true;
    } else {
      logger.info('Claude-Code', 'Reusing existing Claude process', { sessionId: currentSessId });
    }

    // 如果是新进程，等待 Claude 初始化完成（约5秒）
    // 同时监听 stderr 检测 session 冲突错误
    if (isNewProcess) {
      await new Promise<void>((resolve) => {
        let resolved = false;
        const timeout = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            resolve();
          }
        }, 5000);

        // 监听 stderr 检测冲突错误
        if (proc && proc.stderr) {
          proc.stderr.on('data', (data: Buffer) => {
            const content = data.toString();
            if (content.includes('already in use')) {
              logger.warn('Claude-Code', 'Session conflict detected during init', { sessionId: currentSessId });
              if (!resolved) {
                resolved = true;
                this.sessionErrors.set(currentSessId, content);
                resolve();
              }
            }
          });
        }
      });

      // 检查是否有冲突错误
      if (this.sessionErrors.has(currentSessId)) {
        logger.warn('Claude-Code', 'Session conflict detected, switching to new session', { sessionId: currentSessId });
        this.closeSession(currentSessId);
        currentSessId = randomUUID();
        logger.info('Claude-Code', 'New Session ID', { sessionId: currentSessId });
        const retryProc = this.createProcess(currentSessId);
        this.processes.set(currentSessId, retryProc);
        this.buffers.set(currentSessId, '');
        this.pendingRequests.set(currentSessId, null);
        this.sessionPids.set(currentSessId, retryProc.pid!);
        this.saveSessions();
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    // 发送消息并等待响应
    await this.sendMessage(currentSessId, userMessage, onChunk, onComplete, onError);
  }

  private createProcess(sessId: string): ChildProcess {
    const bashPath = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
    const proc: ChildProcess = spawn(bashPath, ['-c',
      `claude -p --output-format stream-json --input-format stream-json --verbose --session-id ${sessId} --dangerously-skip-permissions`
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (data: Buffer) => {
      this.handleData(sessId, data.toString());
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const content = data.toString();
      if (content.toLowerCase().includes('error')) {
        logger.error('Claude-Code', 'stderr error', { content: content.substring(0, 300) });
        this.sessionErrors.set(sessId, content);
      }
    });

    proc.on('error', (err) => {
      logger.error('Claude-Code', 'Process error', { sessionId: sessId, error: err.message });
    });

    proc.on('close', (code) => {
      logger.info('Claude-Code', 'Process closed', { sessionId: sessId, exitCode: code, pid: proc.pid });
      const error = this.sessionErrors.get(sessId) || '';
      const isSessionConflict = code === 1 && error.includes('already in use');
      const pending = this.pendingRequests.get(sessId);
      if (pending) {
        if (isSessionConflict) {
          pending.reject(new Error('Session conflict: ' + error.trim()));
        } else if (code !== 0) {
          pending.reject(new Error(`Process exited with code ${code}`));
        }
        this.pendingRequests.set(sessId, null);
      }
      this.processes.delete(sessId);
      this.buffers.delete(sessId);
      this.sessionErrors.delete(sessId);
      this.sessionPids.delete(sessId);
      this.updateSessionStatus(sessId, 'stopped');
      this.saveSessions();
    });

    return proc;
  }

  private handleData(sessId: string, rawData: string) {
    const buffer = this.buffers.get(sessId) || '';
    this.buffers.set(sessId, buffer + rawData);

    const fullBuffer = this.buffers.get(sessId) || '';
    const lines = fullBuffer.split('\n');
    this.buffers.set(sessId, lines.pop() || '');

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const msg: ClaudeStreamEvent = JSON.parse(line);
        logger.debug('Claude-Code', 'Event type', { sessionId: sessId, type: msg.type, subtype: msg.subtype });

        const pending = this.pendingRequests.get(sessId);

        if (msg.type === 'system' && msg.subtype === 'init') {
          logger.info('Claude-Code', 'Claude initialized', { sessionId: sessId });
        } else if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              logger.debug('Claude-Code', 'Assistant text chunk', {
                sessionId: sessId,
                textLength: block.text.length,
                textPreview: block.text.substring(0, 50),
              });
              if (pending?.onChunk) {
                pending.onChunk(block.text);
              }
            }
          }
        } else if (msg.type === 'result') {
          logger.info('Claude-Code', 'Response complete', { sessionId: sessId });
          if (pending) {
            if (pending.onComplete) pending.onComplete();
            pending.resolve();
            this.pendingRequests.set(sessId, null);
          }
        } else if (msg.type === 'error' || msg.is_error === true) {
          const errorMsg = msg.content || msg.text || 'Unknown error';
          logger.error('Claude-Code', 'Claude error', { sessionId: sessId, error: errorMsg });
          if (pending) {
            if (pending.onError) pending.onError(new Error(errorMsg));
            pending.reject(new Error(errorMsg));
            this.pendingRequests.set(sessId, null);
          }
        }
      } catch (e) {
        // Ignore parse errors for non-JSON lines
      }
    }
  }

  private sendMessage(
    sessId: string,
    content: string,
    onChunk: (chunk: string) => Promise<void>,
    onComplete: () => Promise<void>,
    onError?: (error: Error) => Promise<void>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = this.processes.get(sessId);
      if (!proc || !proc.stdin) {
        reject(new Error('Process not available'));
        return;
      }

      let isSessionConflict = false;
      const stderrHandler = (data: Buffer) => {
        const errContent = data.toString();
        if (errContent.includes('already in use')) {
          isSessionConflict = true;
          logger.warn('Claude-Code', 'Session conflict detected, rejecting immediately', { sessionId: sessId });
          const pending = this.pendingRequests.get(sessId);
          if (pending) {
            pending.reject(new Error('Session conflict: ' + errContent.trim()));
            this.pendingRequests.set(sessId, null);
          }
        }
      };
      proc.stderr?.on('data', stderrHandler);

      this.pendingRequests.set(sessId, {
        resolve,
        reject,
        onChunk,
        onComplete,
        onError,
      });

      const escapedContent = content.replace(/"/g, '\\"');
      logger.debug('Claude-Code', 'Sending message', { sessionId: sessId, content: content.substring(0, 50) });

      proc.stdin.write(`{"type":"user","message":{"role":"user","content":"${escapedContent}"}}\n`);

      setTimeout(() => {
        if (proc.stdin) {
          proc.stdin.write('{"type":"result"}\n');
        }
      }, 300);

      setTimeout(() => {
        const pending = this.pendingRequests.get(sessId);
        if (pending) {
          logger.debug('Claude-Code', 'Waiting for response...', { sessionId: sessId });
        }
      }, 5000);

      setTimeout(() => {
        proc.stderr?.removeListener('data', stderrHandler);
        const pending = this.pendingRequests.get(sessId);
        if (pending) {
          if (isSessionConflict) {
            logger.warn('Claude-Code', 'Response timeout due to session conflict', { sessionId: sessId });
            pending.reject(new Error('Session conflict: already in use'));
          } else {
            logger.warn('Claude-Code', 'Response timeout, completing', { sessionId: sessId });
            if (pending.onComplete) pending.onComplete();
            pending.resolve();
          }
          this.pendingRequests.set(sessId, null);
        }
      }, 60000);
    });
  }

  // 关闭指定会话的进程
  closeSession(sessId: string) {
    const proc = this.processes.get(sessId);
    if (proc) {
      this.updateSessionStatus(sessId, 'stopping');
      proc.kill();
      this.processes.delete(sessId);
      this.buffers.delete(sessId);
      this.pendingRequests.delete(sessId);
      this.sessionPids.delete(sessId);
      logger.info('Claude-Code', 'Session closed', { sessionId: sessId });
      this.saveSessions();
    }
  }

  // 标记所有会话为 stopping 状态
  markAllSessionsStopping() {
    for (const [sessId] of this.processes) {
      this.updateSessionStatus(sessId, 'stopping');
    }
  }

  // 关闭所有会话
  closeAll() {
    for (const [sessId] of this.processes) {
      this.closeSession(sessId);
    }
  }
}
