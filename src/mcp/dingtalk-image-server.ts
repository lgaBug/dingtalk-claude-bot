/**
 * DingTalk Image MCP Server
 *
 * 提供 dingtalk_send_image 工具，让 Claude Code 能直接发送图片到钉钉。
 *
 * 注册方式（全局）：
 *   claude mcp add --global dingtalk-image -- node --import tsx /path/to/src/mcp/dingtalk-image-server.ts
 *
 * 环境变量：
 *   DINGTALK_CLIENT_ID     - 钉钉应用 Client ID（必填）
 *   DINGTALK_CLIENT_SECRET - 钉钉应用 Client Secret（必填）
 *   DINGTALK_ROBOT_CODE    - 钉钉机器人 Code（必填）
 *   DINGTALK_IMAGE_TARGET  - 默认发送目标，格式 "user:<staffId>" 或 "group:<conversationId>"（可选）
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';

// ==================== 钉钉 API ====================

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) {
    return cachedToken;
  }

  const response = await axios.get('https://oapi.dingtalk.com/gettoken', {
    params: { appkey: clientId, appsecret: clientSecret },
  });

  if (!response.data.access_token) {
    throw new Error(`Failed to get access token: ${JSON.stringify(response.data)}`);
  }

  cachedToken = response.data.access_token;
  const expiresIn = (response.data.expires_in || 7200) - 300;
  tokenExpiresAt = now + expiresIn * 1000;
  return cachedToken!;
}

async function uploadImage(filePath: string, robotCode: string, accessToken: string): Promise<string> {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`File not found: ${absolutePath}`);
  }

  const ext = path.extname(absolutePath).toLowerCase();
  const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);
  if (!imageExts.has(ext)) {
    throw new Error(`Not an image file (${ext}). Supported: ${[...imageExts].join(', ')}`);
  }

  const form = new FormData();
  form.append('file', fs.createReadStream(absolutePath), {
    filename: path.basename(absolutePath),
  });

  const response = await axios.post(
    `https://api.dingtalk.com/v1.0/robot/messageFiles/upload?robotCode=${encodeURIComponent(robotCode)}&type=image`,
    form,
    {
      headers: {
        ...form.getHeaders(),
        'x-acs-dingtalk-access-token': accessToken,
      },
    }
  );

  const mediaId = response.data.mediaId;
  if (!mediaId) {
    throw new Error(`Upload failed: ${JSON.stringify(response.data)}`);
  }
  return mediaId;
}

async function sendImageMessage(
  mediaId: string,
  robotCode: string,
  targetType: 'user' | 'group',
  targetId: string,
  accessToken: string
): Promise<void> {
  const msgParam = JSON.stringify({ photoURL: mediaId });

  if (targetType === 'user') {
    await axios.post(
      'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend',
      {
        robotCode,
        userIds: [targetId],
        msgKey: 'sampleImageMsg',
        msgParam,
      },
      {
        headers: {
          'x-acs-dingtalk-access-token': accessToken,
          'Content-Type': 'application/json',
        },
      }
    );
  } else {
    await axios.post(
      'https://api.dingtalk.com/v1.0/robot/groupMessages/send',
      {
        robotCode,
        openConversationId: targetId,
        msgKey: 'sampleImageMsg',
        msgParam,
      },
      {
        headers: {
          'x-acs-dingtalk-access-token': accessToken,
          'Content-Type': 'application/json',
        },
      }
    );
  }
}

// ==================== 上下文文件 ====================

interface DingTalkContext {
  conversationId: string;
  conversationType: string; // "1" = 1:1, "2" = group
  senderStaffId: string;
  robotCode: string;
}

function readContextFile(): DingTalkContext | null {
  const contextPath = path.join(process.cwd(), '.dingtalk-context.json');
  try {
    if (fs.existsSync(contextPath)) {
      return JSON.parse(fs.readFileSync(contextPath, 'utf-8'));
    }
  } catch { /* ignore */ }
  return null;
}

function parseTarget(target: string): { type: 'user' | 'group'; id: string } {
  if (target.startsWith('user:')) {
    return { type: 'user', id: target.substring(5) };
  }
  if (target.startsWith('group:')) {
    return { type: 'group', id: target.substring(6) };
  }
  // 默认当作 userId
  return { type: 'user', id: target };
}

// ==================== MCP Server ====================

const server = new McpServer({
  name: 'dingtalk-image',
  version: '1.0.0',
});

server.tool(
  'dingtalk_send_image',
  'Send an image file to a DingTalk chat. Supports PNG, JPG, JPEG, GIF, BMP, WEBP. ' +
  'The image is uploaded to DingTalk and sent as a message to the specified target. ' +
  'If no target is specified, it reads from .dingtalk-context.json (set by the bot) or DINGTALK_IMAGE_TARGET env var.',
  {
    file_path: z.string().describe('Absolute or relative path to the image file'),
    target: z.string().optional().describe(
      'Send target. Format: "user:<staffId>" for 1:1 chat, "group:<conversationId>" for group chat. ' +
      'If omitted, uses context file or DINGTALK_IMAGE_TARGET env var.'
    ),
  },
  async ({ file_path, target }) => {
    // Validate config
    const clientId = process.env.DINGTALK_CLIENT_ID;
    const clientSecret = process.env.DINGTALK_CLIENT_SECRET;
    const robotCode = process.env.DINGTALK_ROBOT_CODE;

    if (!clientId || !clientSecret) {
      return {
        content: [{
          type: 'text',
          text: 'Error: DINGTALK_CLIENT_ID and DINGTALK_CLIENT_SECRET environment variables are required.',
        }],
        isError: true,
      };
    }

    // Resolve target
    let targetType: 'user' | 'group';
    let targetId: string;
    let resolvedRobotCode = robotCode || '';

    if (target) {
      const parsed = parseTarget(target);
      targetType = parsed.type;
      targetId = parsed.id;
    } else {
      // Try context file first (set by bot)
      const ctx = readContextFile();
      if (ctx) {
        targetType = ctx.conversationType === '2' ? 'group' : 'user';
        targetId = ctx.conversationType === '2' ? ctx.conversationId : ctx.senderStaffId;
        resolvedRobotCode = resolvedRobotCode || ctx.robotCode;
      } else if (process.env.DINGTALK_IMAGE_TARGET) {
        const parsed = parseTarget(process.env.DINGTALK_IMAGE_TARGET);
        targetType = parsed.type;
        targetId = parsed.id;
      } else {
        return {
          content: [{
            type: 'text',
            text: 'Error: No target specified. Provide a target parameter, set DINGTALK_IMAGE_TARGET env var, ' +
              'or ensure .dingtalk-context.json exists in the working directory.',
          }],
          isError: true,
        };
      }
    }

    if (!resolvedRobotCode) {
      return {
        content: [{
          type: 'text',
          text: 'Error: DINGTALK_ROBOT_CODE environment variable is required.',
        }],
        isError: true,
      };
    }

    try {
      // 1. Get access token
      const accessToken = await getAccessToken(clientId, clientSecret);

      // 2. Upload image
      const absolutePath = path.resolve(file_path);
      const mediaId = await uploadImage(absolutePath, resolvedRobotCode, accessToken);

      // 3. Send image message
      await sendImageMessage(mediaId, resolvedRobotCode, targetType, targetId, accessToken);

      const targetLabel = targetType === 'user' ? `user ${targetId}` : `group ${targetId}`;
      return {
        content: [{
          type: 'text',
          text: `Image sent successfully to ${targetLabel}: ${path.basename(file_path)}`,
        }],
      };
    } catch (error: any) {
      const errMsg = error.response?.data
        ? JSON.stringify(error.response.data)
        : error.message;
      return {
        content: [{
          type: 'text',
          text: `Failed to send image: ${errMsg}`,
        }],
        isError: true,
      };
    }
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
