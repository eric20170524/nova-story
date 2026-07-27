import pino from 'pino';
import path from 'path';
import fs from 'fs';

const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Create a Pino logger instance
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: {
    targets: [
      {
        target: 'pino-pretty', // Console output
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
        },
      },
      {
        target: 'pino/file', // File output
        options: {
          destination: path.join(logDir, 'novastory.log'),
        },
      },
    ],
  },
});
