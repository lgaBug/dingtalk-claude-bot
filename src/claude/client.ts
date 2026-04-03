import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { logger } from '../logger.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 工具结果截断配置
const MAX_RESULT_LINES = 25;
const MAX_RESULT_CHARS = 1500;

// 不需要展示结果的工具
const QUIET_TOOLS = new Set([
  'ToolSearch', 'EnterPlanMode', 'ExitPlanMode', 'EnterWorktree', 'ExitWorktree',
  'Skill', 'TodoWrite', 'CronCreate', 'CronDelete', 'CronList',
]);

// 工具图标
const TOOL_ICONS: Record<string, string> = {
  Read: '📖', Bash: '⚡', Edit: '✏️', Write: '📝',
  Glob: '🔍', Grep: '🔍', WebFetch: '🌐', WebSearch: '🔎',
  Agent: '🤖', ToolSearch: '🔧', NotebookEdit: '📓',
  TaskCreate: '📋', TaskUpdate: '📋', TaskGet: '📋', TaskList: '📋',
};

function generateUUIDFromString(str: string): string {
  const hash = createHash('sha256').update(str).digest('hex');
  return `${hash.substring(0, 8)}-${hash.substring(8, 12)}-4${hash.substring(13, 16)}-${hash.substring(16, 20)}-${hash.substring(20, 32)}`;
}

interface StreamMessageOptions {
  messages: { role: string; content: string }[];
  onChunk: (chunk: string) => Promise<void>;
  onComplete: () => Promise<void>;
  onError?: (error: Error) => Promise<void>;
  onImage?: (filePath: string) => Promise<void>;
}

interface ClaudeStreamEvent {
  type: string;
  subtype?: string;
  message?: {
    content?: Array<{
      type: string;
      id?: string;
      text?: string;
      name?: string;
      input?: Record<string, any>;
      tool_use_id?: string;
      content?: any;
      is_error?: boolean;
      caller?: any;
    }>;
  };
  tool_use_result?: any;
  content?: string;
  text?: string;
  is_error?: boolean;
  // result event fields
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
}

// 图片文件扩展名
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

interface PendingRequest {
  resolve: () => void;
  reject: (err: Error) => void;
  onChunk: (chunk: string) => Promise<void>;
  onComplete: () => Promise<void>;
  onError?: (error: Error) => Promise<void>;
  onImage?: (filePath: string) => Promise<void>;
}

interface ToolUseInfo {
  name: string;
  input: Record<string, any>;
}

export class ClaudeClient {
  private processName: string;
  private sessionId: string;
  private socket: net.Socket | null = null;
  private buffer: string = '';
  private pendingRequest: PendingRequest | null = null;
  private connected: boolean = false;
  private toolUseMap: Map<string, ToolUseInfo> = new Map();

  constructor(processName: string = 'default') {
    this.processName = processName;
    this.sessionId = generateUUIDFromString(processName);
    logger.info('Claude-Code', 'ClaudeClient created', {
      processName,
      sessionId: this.sessionId,
    });
  }

  private get pipePath(): string {
    return os.platform() === 'win32'
      ? `\\\\.\\pipe\\claude-bot-${this.processName}`
      : path.join(os.tmpdir(), `claude-bot-${this.processName}.sock`);
  }

  private get pidFile(): string {
    return path.join(os.tmpdir(), `claude-proxy-${this.processName}.pid`);
  }

  // ==================== 格式化方法 ====================

  private shortenPath(filePath: string): string {
    if (!filePath) return '';
    const parts = filePath.replace(/\\/g, '/').split('/');
    if (parts.length <= 3) return parts.join('/');
    return '.../' + parts.slice(-3).join('/');
  }

  private formatToolCall(name: string, input: Record<string, any>): string {
    const icon = TOOL_ICONS[name] || '🔧';
    let paramStr = '';

    switch (name) {
      case 'Read':
        paramStr = ` \`${this.shortenPath(input.file_path)}\``;
        if (input.limit) paramStr += ` (lines ${input.offset || 1}-${(input.offset || 1) + input.limit})`;
        break;

      case 'Bash': {
        const cmd = (input.command || '').substring(0, 300);
        paramStr = `\n\`\`\`bash\n${cmd}\n\`\`\``;
        break;
      }

      case 'Edit': {
        const fp = this.shortenPath(input.file_path);
        paramStr = ` \`${fp}\``;
        if (input.old_string && input.new_string) {
          const oldLines = input.old_string.split('\n').slice(0, 8);
          const newLines = input.new_string.split('\n').slice(0, 8);
          const oldStr = oldLines.map((l: string) => `- ${l}`).join('\n');
          const newStr = newLines.map((l: string) => `+ ${l}`).join('\n');
          const oldTrunc = input.old_string.split('\n').length > 8 ? '\n  ...' : '';
          const newTrunc = input.new_string.split('\n').length > 8 ? '\n  ...' : '';
          paramStr += `\n\`\`\`diff\n${oldStr}${oldTrunc}\n${newStr}${newTrunc}\n\`\`\``;
        }
        break;
      }

      case 'Write':
        paramStr = ` \`${this.shortenPath(input.file_path)}\``;
        break;

      case 'Glob':
        paramStr = ` \`${input.pattern}\``;
        if (input.path) paramStr += ` in \`${this.shortenPath(input.path)}\``;
        break;

      case 'Grep':
        paramStr = ` \`${input.pattern}\``;
        if (input.path) paramStr += ` in \`${this.shortenPath(input.path)}\``;
        break;

      case 'WebFetch':
        paramStr = ` \`${(input.url || '').substring(0, 100)}\``;
        break;

      case 'WebSearch':
        paramStr = ` "${(input.query || '').substring(0, 80)}"`;
        break;

      case 'Agent':
        paramStr = input.prompt ? ` "${(input.prompt || '').substring(0, 80)}"` : '';
        break;

      case 'ToolSearch':
        paramStr = ` \`${input.query || ''}\``;
        break;

      default: {
        const entries = Object.entries(input);
        if (entries.length > 0) {
          const [key, val] = entries[0];
          if (typeof val === 'string' && val.length < 100) {
            paramStr = ` \`${val}\``;
          }
        }
      }
    }

    return `\n\n---\n\n${icon} **${name}**${paramStr}\n`;
  }

  private formatToolResult(toolName: string, content: any): string {
    if (QUIET_TOOLS.has(toolName)) {
      return '';
    }

    if (content == null) {
      return '\n✅ Done\n';
    }

    if (Array.isArray(content)) {
      const refs = content.filter((c: any) => c.type === 'tool_reference');
      if (refs.length > 0) {
        return '';
      }
      return '\n✅ Done\n';
    }

    if (typeof content !== 'string') {
      content = JSON.stringify(content, null, 2);
    }

    if (!content.trim()) {
      return '\n✅ Done\n';
    }

    let resultStr = content as string;
    let truncated = false;

    const lines = resultStr.split('\n');
    if (lines.length > MAX_RESULT_LINES) {
      resultStr = lines.slice(0, MAX_RESULT_LINES).join('\n');
      truncated = true;
    }
    if (resultStr.length > MAX_RESULT_CHARS) {
      resultStr = resultStr.substring(0, MAX_RESULT_CHARS);
      truncated = true;
    }

    const suffix = truncated ? `\n... (${lines.length} lines total)` : '';

    if (toolName === 'Edit' || toolName === 'Write') {
      if (resultStr.includes('successfully') || resultStr.includes('updated') || resultStr.includes('created')) {
        return `\n✅ ${resultStr.trim()}\n`;
      }
    }

    return `\n\`\`\`\n${resultStr}${suffix}\n\`\`\`\n`;
  }

  private formatResultStats(event: ClaudeStreamEvent): string {
    const parts: string[] = [];
    if (event.num_turns) parts.push(`${event.num_turns} turns`);
    if (event.duration_ms) parts.push(`${(event.duration_ms / 1000).toFixed(1)}s`);
    if (event.total_cost_usd) parts.push(`$${event.total_cost_usd.toFixed(4)}`);

    if (parts.length === 0) return '';
    return `\n\n---\n*⏱ ${parts.join(' · ')}*\n`;
  }

  // ==================== Proxy 连接管理 ====================

  private isProxyAlive(): boolean {
    try {
      if (!fs.existsSync(this.pidFile)) return false;
      const pid = parseInt(fs.readFileSync(this.pidFile, 'utf-8').trim());
      if (isNaN(pid)) return false;
      // Check if process is alive
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private startProxy(): void {
    if (this.isProxyAlive()) {
      logger.info('Claude-Code', 'Proxy already running', { processName: this.processName });
      return;
    }

    logger.info('Claude-Code', 'Starting Claude proxy...', {
      processName: this.processName,
      sessionId: this.sessionId,
    });

    // Determine proxy script path (support both dev and prod)
    const tsProxy = path.join(__dirname, 'proxy.ts');
    const jsProxy = path.join(__dirname, 'proxy.js');

    let args: string[];

    if (fs.existsSync(tsProxy)) {
      // Dev mode: use node --import tsx to run TypeScript directly
      args = ['--import', 'tsx', tsProxy, this.processName, this.sessionId];
    } else if (fs.existsSync(jsProxy)) {
      // Prod mode: compiled JS
      args = [jsProxy, this.processName, this.sessionId];
    } else {
      logger.error('Claude-Code', 'Proxy script not found', { tsProxy, jsProxy });
      throw new Error('Proxy script not found');
    }

    // Use node directly (not npx/shell) for reliable detach on Windows
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
      cwd: process.cwd(),
      windowsHide: true,
    });
    child.unref();

    logger.info('Claude-Code', 'Proxy process spawned', { pid: child.pid, processName: this.processName });
  }

  private connectToProxy(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(this.pipePath);
      let resolved = false;

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          socket.destroy();
          reject(new Error('Connection timeout'));
        }
      }, 5000);

      socket.on('connect', () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timeout);

        this.socket = socket;
        this.connected = true;
        this.buffer = '';

        socket.on('data', (data: Buffer) => {
          this.handleData(data.toString());
        });

        socket.on('close', () => {
          logger.warn('Claude-Code', 'Disconnected from Claude proxy');
          this.connected = false;
          this.socket = null;

          // If there's a pending request, reject it
          if (this.pendingRequest) {
            const pending = this.pendingRequest;
            this.pendingRequest = null;
            pending.reject(new Error('Proxy connection lost'));
          }
        });

        socket.on('error', (err) => {
          logger.error('Claude-Code', 'Socket error', { error: err.message });
        });

        logger.info('Claude-Code', 'Connected to Claude proxy', {
          processName: this.processName,
          pipePath: this.pipePath,
        });
        resolve();
      });

      socket.on('error', (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(err);
        }
      });
    });
  }

  /**
   * 连接到 Claude Proxy。如果 Proxy 不存在则启动一个。
   * 替代原来的 createSharedProcess()。
   */
  async connect(): Promise<boolean> {
    // First attempt: try to connect to existing proxy
    try {
      await this.connectToProxy();
      logger.info('Claude-Code', 'Connected to existing proxy');
      return true;
    } catch {
      logger.info('Claude-Code', 'No existing proxy found, starting one...');
    }

    // Start proxy and retry with backoff
    this.startProxy();

    const maxRetries = 5;
    for (let i = 0; i < maxRetries; i++) {
      const delay = 2000 + i * 1000; // 2s, 3s, 4s, 5s, 6s
      await new Promise(resolve => setTimeout(resolve, delay));
      try {
        await this.connectToProxy();
        logger.info('Claude-Code', 'Connected to proxy after starting it');
        return true;
      } catch (e: any) {
        logger.debug('Claude-Code', `Connection attempt ${i + 1}/${maxRetries} failed`, { error: e.message });
      }
    }

    logger.error('Claude-Code', 'Failed to connect to Claude proxy after all retries');
    return false;
  }

  /**
   * 确保已连接到 Proxy，必要时自动重连。
   */
  private async ensureConnected(): Promise<boolean> {
    if (this.connected && this.socket && !this.socket.destroyed) {
      return true;
    }
    logger.info('Claude-Code', 'Connection lost, reconnecting...');
    return this.connect();
  }

  // ==================== 核心：事件处理与格式化 ====================

  private handleData(rawData: string) {
    this.buffer += rawData;

    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      let msg: ClaudeStreamEvent;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }

      logger.debug('Claude-Code', 'Event', { type: msg.type, subtype: msg.subtype });

      const pending = this.pendingRequest;

      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') {
            logger.info('Claude-Code', 'Claude initialized');
          }
          break;

        case 'assistant':
          if (!msg.message?.content) break;
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              logger.debug('Claude-Code', 'Text chunk', { textLength: block.text.length });
              if (pending?.onChunk) {
                pending.onChunk(block.text);
              }
            } else if (block.type === 'tool_use' && block.name) {
              logger.info('Claude-Code', 'Tool call', { tool: block.name, toolUseId: block.id });

              if (block.id) {
                this.toolUseMap.set(block.id, {
                  name: block.name,
                  input: block.input || {},
                });
              }

              const formatted = this.formatToolCall(block.name, block.input || {});
              if (pending?.onChunk) {
                pending.onChunk(formatted);
              }
            }
          }
          break;

        case 'user':
          if (!msg.message?.content) break;
          for (const block of msg.message.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const toolInfo = this.toolUseMap.get(block.tool_use_id);
              const toolName = toolInfo?.name || 'unknown';

              logger.info('Claude-Code', 'Tool result', {
                tool: toolName,
                toolUseId: block.tool_use_id,
                isError: block.is_error,
              });

              if (block.is_error) {
                const errContent = typeof block.content === 'string'
                  ? block.content
                  : JSON.stringify(block.content);
                const formatted = `\n❌ **Error**: ${errContent.substring(0, 500)}\n`;
                if (pending?.onChunk) {
                  pending.onChunk(formatted);
                }
                break;
              }

              const formatted = this.formatToolResult(toolName, block.content);
              if (formatted && pending?.onChunk) {
                pending.onChunk(formatted);
              }

              // 检测工具产生的图片文件
              if (!block.is_error && toolInfo && pending?.onImage) {
                let imagePath: string | null = null;

                if (toolName === 'Write') {
                  const fp = toolInfo.input.file_path || '';
                  const ext = path.extname(fp).toLowerCase();
                  if (IMAGE_EXTENSIONS.has(ext)) imagePath = fp;
                } else if (toolName === 'Bash') {
                  const cmd = toolInfo.input.command || '';
                  const output = typeof block.content === 'string' ? block.content : '';
                  const combined = cmd + '\n' + output;
                  const imgMatch = combined.match(/(?:[A-Za-z]:[\\\/]|\.{0,2}[\\\/])?[\w.\-\\\/]+\.(?:png|jpg|jpeg|gif|bmp|webp)\b/i);
                  if (imgMatch) {
                    const candidate = imgMatch[0].replace(/\\/g, '/');
                    if (candidate.includes('/') || candidate.includes('\\')) {
                      imagePath = imgMatch[0];
                    }
                  }
                } else if (toolName.startsWith('mcp__playwright__browser_take_screenshot')) {
                  const fp = toolInfo.input.path || '';
                  if (fp) imagePath = fp;
                }

                if (imagePath) {
                  logger.info('Claude-Code', 'Image file detected', { tool: toolName, filePath: imagePath });
                  pending.onImage(imagePath).catch(e =>
                    logger.error('Claude-Code', 'onImage callback failed', { error: e.message })
                  );
                }
              }
            }
          }
          break;

        case 'result':
          logger.info('Claude-Code', 'Response complete');
          if (pending) {
            const stats = this.formatResultStats(msg);
            if (stats && pending.onChunk) {
              pending.onChunk(stats);
            }
            if (pending.onComplete) pending.onComplete();
            pending.resolve();
            this.pendingRequest = null;
          }
          break;

        case 'error': {
          const errorMsg = msg.content || msg.text || 'Unknown error';
          logger.error('Claude-Code', 'Claude error', { error: errorMsg });
          if (pending) {
            if (pending.onError) pending.onError(new Error(errorMsg));
            pending.reject(new Error(errorMsg));
            this.pendingRequest = null;
          }
          break;
        }

        case 'rate_limit_event':
          break;

        default:
          logger.debug('Claude-Code', 'Unknown event type', { type: msg.type });
      }
    }
  }

  // ==================== 消息发送 ====================

  async streamMessage(options: StreamMessageOptions, _sessionId?: string) {
    const { messages, onChunk, onComplete, onError, onImage } = options;
    const userMessage = messages[messages.length - 1]?.content || '';

    logger.info('Claude-Code', '========================================');
    logger.info('Claude-Code', 'User message', { message: userMessage.substring(0, 100) });

    // Ensure connected to proxy
    const ok = await this.ensureConnected();
    if (!ok) {
      const err = new Error('Failed to connect to Claude proxy');
      if (onError) await onError(err);
      await onComplete();
      return;
    }

    // Clear tool map for new conversation turn
    this.toolUseMap.clear();

    await this.sendMessage(userMessage, onChunk, onComplete, onError, onImage);
  }

  private sendMessage(
    content: string,
    onChunk: (chunk: string) => Promise<void>,
    onComplete: () => Promise<void>,
    onError?: (error: Error) => Promise<void>,
    onImage?: (filePath: string) => Promise<void>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error('Not connected to proxy'));
        return;
      }

      this.pendingRequest = {
        resolve,
        reject,
        onChunk,
        onComplete,
        onError,
        onImage,
      };

      const payload = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: content }
      });
      logger.debug('Claude-Code', 'Sending message', { content: content.substring(0, 50) });

      this.socket.write(payload + '\n');

      setTimeout(() => {
        if (this.socket && !this.socket.destroyed) {
          this.socket.write('{"type":"result"}\n');
        }
      }, 300);

      // 1 hour timeout
      setTimeout(() => {
        if (this.pendingRequest) {
          logger.warn('Claude-Code', 'Response timeout (60min)');
          if (this.pendingRequest.onError) this.pendingRequest.onError(new Error('Response timeout after 60 minutes'));
          if (this.pendingRequest.onComplete) this.pendingRequest.onComplete();
          this.pendingRequest.resolve();
          this.pendingRequest = null;
        }
      }, 3600000);
    });
  }

  // ==================== 断开连接（不杀 Proxy） ====================

  disconnect() {
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
    this.connected = false;
    this.pendingRequest = null;
    this.toolUseMap.clear();
    logger.info('Claude-Code', 'Disconnected from proxy (proxy still running)');
  }

  isConnected(): boolean {
    return this.connected;
  }

  getProxyInfo(): { processName: string; sessionId: string; connected: boolean; proxyAlive: boolean } {
    return {
      processName: this.processName,
      sessionId: this.sessionId,
      connected: this.connected,
      proxyAlive: this.isProxyAlive(),
    };
  }
}
