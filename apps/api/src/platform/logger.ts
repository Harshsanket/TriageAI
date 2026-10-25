import { pino } from 'pino';

import { config, isProd } from './config.js';

/** Correlation ids plus secrecy: credentials never reach a log sink (FR-11.4). */
export const logger = pino({
  level: config.logLevel,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      'refreshToken',
      'accessToken',
      '*.password',
      '*.refreshToken',
      '*.accessToken',
      '*.secret',
      '*.apiKey',
      '*.token',
      'AUTH_JWT_SECRET',
      'GITHUB_TOKEN',
      'GITHUB_WEBHOOK_SECRET',
      'SLACK_WEBHOOK_URL',
    ],
    censor: '[redacted]',
  },
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
        },
      }),
});
