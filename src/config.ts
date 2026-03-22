import dotenv from 'dotenv';

dotenv.config();

export const config = {
  dingtalk: {
    clientId: process.env.DINGTALK_CLIENT_ID || '',
    clientSecret: process.env.DINGTALK_CLIENT_SECRET || '',
  },
  port: parseInt(process.env.PORT || '3000', 10),
};
