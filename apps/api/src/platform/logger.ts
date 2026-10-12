import { pino } from 'pino';

import { config, isProd } from './config.js';

export const logger = pino({
  level: config.logLevel,
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }),
});
