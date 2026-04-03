import dotenv from 'dotenv';

dotenv.config();

export const config = {
  dingtalk: {
    clientId: process.env.DINGTALK_CLIENT_ID || '',
    clientSecret: process.env.DINGTALK_CLIENT_SECRET || '',
    robotCode: process.env.DINGTALK_ROBOT_CODE || '',
  },
  claude: {
    processName: process.env.CLAUDE_PROCESS_NAME || 'default',
    workingDirectory: process.env.CLAUDE_WORKING_DIRECTORY || process.cwd(),
  },
  port: parseInt(process.env.PORT || '3000', 10),
};
