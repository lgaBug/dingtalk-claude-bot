import { spawn, ChildProcess } from 'child_process';
import { randomUUID, createHash } from 'crypto';
import { logger } from '../logger.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SESSION_FILE = path.join(process.cwd(), '.claude_sessions');

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

interface SessionInfo {
  sessionId: string;
  pid: number;
  status: 'running' | 'stopping' | 'stopped';
}

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

interface PendingRequest {
  resolve: () => void;
  reject: (err: Error) => void;
  onChunk: (chunk: string) => Promise<void>;
  onComplete: () => Promise<void>;
  onError?: (error: Error) => Promise<void>;
}

interface ToolUseInfo {
  name: string;
  input: Record<string, any>;
}

export class ClaudeClient {
  private processes: Map<string, ChildProcess> = new Map();
  private buffers: Map<string, string> = new Map();
  private pendingRequests: Map<string, PendingRequest | null> = new Map();
  private sessionConflicts: Set<string> = new Set();
  private sessionPids: Map<string, number> = new Map();
  private sharedSessionId?: string;
  // 跟踪每个 session 的 tool_use_id → tool info 映射
  private toolUseMap: Map<string, Map<string, ToolUseInfo>> = new Map();

  // ==================== 格式化方法 ====================

  private shortenPath(filePath: string): string {
    if (!filePath) return '';
    // 只保留最后 3 层路径
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
        // 显示第一个有意义的参数
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
    // 安静工具只显示完成标记
    if (QUIET_TOOLS.has(toolName)) {
      return '';  // 不显示任何结果
    }

    // 处理不同的 content 类型
    if (content == null) {
      return '\n✅ Done\n';
    }

    if (Array.isArray(content)) {
      // 例如 tool_reference 数组
      const refs = content.filter((c: any) => c.type === 'tool_reference');
      if (refs.length > 0) {
        return '';  // ToolSearch 加载工具，不需要显示
      }
      return '\n✅ Done\n';
    }

    if (typeof content !== 'string') {
      content = JSON.stringify(content, null, 2);
    }

    // 空结果
    if (!content.trim()) {
      return '\n✅ Done\n';
    }

    // 截断过长的结果
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

    // Edit/Write 成功结果通常很短
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

  private getSessionToolMap(sessId: string): Map<string, ToolUseInfo> {
    let map = this.toolUseMap.get(sessId);
    if (!map) {
      map = new Map();
      this.toolUseMap.set(sessId, map);
    }
    return map;
  }

  // ==================== Session 文件管理 ====================

  private loadSessionsFromFile(): void {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        const sessions: SessionInfo[] = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        this.sessionPids.clear();
        for (const session of sessions) {
          if (session.status === 'running' || session.status === 'stopping') {
            this.sessionPids.set(session.sessionId, session.pid);
          }
        }
        logger.info('Claude-Code', 'Loaded sessions from file', { count: this.sessionPids.size });
      }
    } catch (e) {
      logger.error('Claude-Code', 'Failed to load sessions from file', { error: e });
    }
  }

  private saveSessions(): void {
    const sessions: SessionInfo[] = [];
    for (const [sessionId, pid] of this.sessionPids) {
      sessions.push({ sessionId, pid, status: 'running' });
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

  // ==================== 进程管理 ====================

  async createSharedProcess(): Promise<boolean> {
    const sharedSessId = randomUUID();
    this.sharedSessionId = sharedSessId;
    logger.info('Claude-Code', 'Creating shared Claude process', { sessionId: sharedSessId });

    this.loadSessionsFromFile();
    this.killStoredProcesses();

    if (this.sharedSessionId && this.sharedSessionId !== sharedSessId) {
      this.closeSession(this.sharedSessionId);
    }

    const proc = this.createProcess(sharedSessId);
    this.processes.set(sharedSessId, proc);
    this.buffers.set(sharedSessId, '');
    this.pendingRequests.set(sharedSessId, null);
    this.sessionPids.set(sharedSessId, proc.pid!);
    this.saveSessions();

    const hasConflict = await new Promise<boolean>((resolve) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(this.sessionConflicts.has(sharedSessId));
        }
      }, 5000);

      proc.on('close', (code) => {
        if (code !== 0 && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(true);
        }
      });
    });

    if (hasConflict) {
      this.closeSession(sharedSessId);
      logger.error('Claude-Code', 'Shared Claude process failed to initialize');
      return false;
    }

    logger.info('Claude-Code', 'Shared Claude process ready', { sessionId: sharedSessId });
    return true;
  }

  async streamMessage(options: StreamMessageOptions, sessionId?: string) {
    const { messages, onChunk, onComplete, onError } = options;
    const userMessage = messages[messages.length - 1]?.content || '';

    logger.info('Claude-Code', '========================================');
    logger.info('Claude-Code', 'User message', { message: userMessage.substring(0, 100) });

    const sharedSessId = this.sharedSessionId;
    let currentSessId = sharedSessId || '';
    const sharedProc = this.processes.get(currentSessId);
    const hasConflict = this.sessionConflicts.has(currentSessId);

    if (!sharedProc || hasConflict) {
      currentSessId = sessionId ? generateUUIDFromString(sessionId) : randomUUID();
      logger.info('Claude-Code', 'Using conversation-based sessionId', { sessionId: currentSessId });
    } else {
      logger.info('Claude-Code', 'Using shared Claude process', { sessionId: currentSessId });
    }

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
    }

    if (isNewProcess) {
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 5000);
        proc!.on('close', () => { clearTimeout(timeout); resolve(); });
      });

      if (this.sessionConflicts.has(currentSessId)) {
        logger.warn('Claude-Code', 'Session conflict, switching', { sessionId: currentSessId });
        this.closeSession(currentSessId);
        currentSessId = randomUUID();
        const retryProc = this.createProcess(currentSessId);
        this.processes.set(currentSessId, retryProc);
        this.buffers.set(currentSessId, '');
        this.pendingRequests.set(currentSessId, null);
        this.sessionPids.set(currentSessId, retryProc.pid!);
        this.saveSessions();
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }

    // 清空该 session 的 tool map（新一轮对话）
    this.toolUseMap.delete(currentSessId);

    await this.sendMessage(currentSessId, userMessage, onChunk, onComplete, onError);
  }

  private createProcess(sessId: string): ChildProcess {
    const isWindows = os.platform() === 'win32';
    let proc: ChildProcess;

    const claudeArgs = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json',
      '--verbose', '--session-id', sessId, '--dangerously-skip-permissions'];

    if (isWindows) {
      const bashPath = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
      if (fs.existsSync(bashPath)) {
        proc = spawn(bashPath, ['-c', `claude ${claudeArgs.join(' ')}`], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        proc = spawn('claude', claudeArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true,
        });
      }
    } else {
      proc = spawn('claude', claudeArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    proc.stdout?.on('data', (data: Buffer) => {
      this.handleData(sessId, data.toString());
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const content = data.toString();
      logger.debug('Claude-Code', 'stderr', { sessionId: sessId, content: content.substring(0, 300) });
      if (content.includes('already in use')) {
        logger.warn('Claude-Code', 'Session conflict detected', { sessionId: sessId });
        this.sessionConflicts.add(sessId);
      }
    });

    proc.on('error', (err) => {
      logger.error('Claude-Code', 'Process error', { sessionId: sessId, error: err.message });
    });

    proc.on('close', (code) => {
      logger.info('Claude-Code', 'Process closed', { sessionId: sessId, exitCode: code, pid: proc.pid });
      const isSessionConflict = this.sessionConflicts.has(sessId);
      const pending = this.pendingRequests.get(sessId);
      if (pending) {
        if (isSessionConflict) {
          pending.reject(new Error('Session conflict: already in use'));
        } else if (code !== 0) {
          pending.reject(new Error(`Process exited with code ${code}`));
        }
        this.pendingRequests.set(sessId, null);
      }
      this.processes.delete(sessId);
      this.buffers.delete(sessId);
      this.sessionConflicts.delete(sessId);
      this.sessionPids.delete(sessId);
      this.toolUseMap.delete(sessId);
      this.updateSessionStatus(sessId, 'stopped');
      this.saveSessions();
    });

    return proc;
  }

  // ==================== 核心：事件处理与格式化 ====================

  private handleData(sessId: string, rawData: string) {
    const buffer = this.buffers.get(sessId) || '';
    this.buffers.set(sessId, buffer + rawData);

    const fullBuffer = this.buffers.get(sessId) || '';
    const lines = fullBuffer.split('\n');
    this.buffers.set(sessId, lines.pop() || '');

    for (const line of lines) {
      if (!line.trim()) continue;

      let msg: ClaudeStreamEvent;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        continue; // 非 JSON 行忽略
      }

      logger.debug('Claude-Code', 'Event', { sessionId: sessId, type: msg.type, subtype: msg.subtype });

      const pending = this.pendingRequests.get(sessId);

      switch (msg.type) {
        case 'system':
          // init 事件，记录日志即可
          if (msg.subtype === 'init') {
            logger.info('Claude-Code', 'Claude initialized', { sessionId: sessId });
          }
          break;

        case 'assistant':
          if (!msg.message?.content) break;
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              // Claude 的文字回复 - 直接传递
              logger.debug('Claude-Code', 'Text chunk', {
                sessionId: sessId,
                textLength: block.text.length,
              });
              if (pending?.onChunk) {
                pending.onChunk(block.text);
              }
            } else if (block.type === 'tool_use' && block.name) {
              // Claude 调用工具 - 格式化后传递
              logger.info('Claude-Code', 'Tool call', {
                sessionId: sessId,
                tool: block.name,
                toolUseId: block.id,
              });

              // 记录 tool_use_id → info 映射
              if (block.id) {
                this.getSessionToolMap(sessId).set(block.id, {
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
          // 工具执行结果
          if (!msg.message?.content) break;
          for (const block of msg.message.content) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const toolInfo = this.getSessionToolMap(sessId).get(block.tool_use_id);
              const toolName = toolInfo?.name || 'unknown';

              logger.info('Claude-Code', 'Tool result', {
                sessionId: sessId,
                tool: toolName,
                toolUseId: block.tool_use_id,
                isError: block.is_error,
              });

              // 错误结果特殊处理
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
            }
          }
          break;

        case 'result':
          logger.info('Claude-Code', 'Response complete', { sessionId: sessId });
          if (pending) {
            // 先输出统计信息
            const stats = this.formatResultStats(msg);
            if (stats && pending.onChunk) {
              pending.onChunk(stats);
            }
            if (pending.onComplete) pending.onComplete();
            pending.resolve();
            this.pendingRequests.set(sessId, null);
          }
          break;

        case 'error':
          const errorMsg = msg.content || msg.text || 'Unknown error';
          logger.error('Claude-Code', 'Claude error', { sessionId: sessId, error: errorMsg });
          if (pending) {
            if (pending.onError) pending.onError(new Error(errorMsg));
            pending.reject(new Error(errorMsg));
            this.pendingRequests.set(sessId, null);
          }
          break;

        case 'rate_limit_event':
          // 跳过，不需要展示
          break;

        default:
          logger.debug('Claude-Code', 'Unknown event type', { sessionId: sessId, type: msg.type });
      }
    }
  }

  // ==================== 消息发送 ====================

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

      this.pendingRequests.set(sessId, {
        resolve,
        reject,
        onChunk,
        onComplete,
        onError,
      });

      const payload = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: content }
      });
      logger.debug('Claude-Code', 'Sending message', { sessionId: sessId, content: content.substring(0, 50) });

      proc.stdin.write(payload + '\n');

      setTimeout(() => {
        if (proc.stdin) {
          proc.stdin.write('{"type":"result"}\n');
        }
      }, 300);

      // 5 分钟超时
      setTimeout(() => {
        const pending = this.pendingRequests.get(sessId);
        if (pending) {
          logger.warn('Claude-Code', 'Response timeout (5min)', { sessionId: sessId });
          if (pending.onError) pending.onError(new Error('Response timeout after 5 minutes'));
          if (pending.onComplete) pending.onComplete();
          pending.resolve();
          this.pendingRequests.set(sessId, null);
        }
      }, 300000);
    });
  }

  // ==================== 进程清理 ====================

  private killStoredProcesses(): void {
    try {
      if (fs.existsSync(SESSION_FILE)) {
        const sessions: SessionInfo[] = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
        const isWindows = os.platform() === 'win32';
        for (const session of sessions) {
          if (session.status === 'running' || session.status === 'stopping') {
            logger.info('Claude-Code', 'Killing stored process tree', { sessionId: session.sessionId, pid: session.pid });
            try {
              if (isWindows) {
                spawn('taskkill', ['/F', '/T', '/PID', session.pid.toString()], { shell: true });
              } else {
                process.kill(-session.pid, 'SIGKILL');
              }
            } catch (e) { /* ignore */ }
          }
        }
      }
    } catch (e) {
      logger.error('Claude-Code', 'Failed to kill stored processes', { error: e });
    }
  }

  private killProcess(pid: number): void {
    const isWindows = os.platform() === 'win32';
    if (isWindows) {
      spawn('taskkill', ['/F', '/T', '/PID', pid.toString()], { shell: true });
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch (e) { /* ignore */ }
    }
  }

  closeSession(sessId: string) {
    const proc = this.processes.get(sessId);
    if (proc) {
      this.updateSessionStatus(sessId, 'stopping');
      this.killProcess(proc.pid!);
      this.processes.delete(sessId);
      this.buffers.delete(sessId);
      this.pendingRequests.delete(sessId);
      this.sessionPids.delete(sessId);
      this.toolUseMap.delete(sessId);
      logger.info('Claude-Code', 'Session closed', { sessionId: sessId });
      this.saveSessions();
    }
  }

  async closeSessionAsync(sessId: string): Promise<void> {
    const proc = this.processes.get(sessId);
    if (proc) {
      this.updateSessionStatus(sessId, 'stopping');
      return new Promise<void>((resolve) => {
        const pid = proc.pid;
        if (!pid) { resolve(); return; }
        this.killProcess(pid);
        const timeout = setTimeout(() => {
          logger.warn('Claude-Code', 'Process did not exit in time', { sessionId: sessId, pid });
          this.killProcess(pid);
          this.cleanupSession(sessId);
          resolve();
        }, 3000);
        proc.on('exit', () => {
          clearTimeout(timeout);
          this.cleanupSession(sessId);
          logger.info('Claude-Code', 'Session closed', { sessionId: sessId });
          resolve();
        });
      });
    }
  }

  private cleanupSession(sessId: string): void {
    this.processes.delete(sessId);
    this.buffers.delete(sessId);
    this.pendingRequests.delete(sessId);
    this.sessionPids.delete(sessId);
    this.toolUseMap.delete(sessId);
    this.saveSessions();
  }

  markAllSessionsStopping() {
    for (const [sessId] of this.processes) {
      this.updateSessionStatus(sessId, 'stopping');
    }
  }

  async closeAllAsync(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const [sessId] of this.processes) {
      closePromises.push(this.closeSessionAsync(sessId));
    }
    await Promise.all(closePromises);
  }
}
