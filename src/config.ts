import dotenv from 'dotenv';

dotenv.config();

export const config = {
  dingtalk: {
    clientId: process.env.DINGTALK_CLIENT_ID || '',
    clientSecret: process.env.DINGTALK_CLIENT_SECRET || '',
  },
  claude: {
    processName: process.env.CLAUDE_PROCESS_NAME || 'default',
  },
  port: parseInt(process.env.PORT || '3000', 10),
};
