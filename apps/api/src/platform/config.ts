import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  AUTH_MODE: z.enum(['disabled', 'required']).optional(),
  AUTH_JWT_SECRET: z.string().optional(),
  AUTH_ACCESS_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15 * 60),
  AUTH_REFRESH_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 24 * 60 * 60),
  RATE_LIMIT_MAX: z.coerce.number().int().nonnegative().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  RATE_LIMIT_DISABLED: z
    .string()
    .optional()
    .transform((value) => value === '1' || value === 'true'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;

const authMode = env.AUTH_MODE ?? (env.NODE_ENV === 'production' ? 'required' : 'disabled');
if (authMode === 'required' && (!env.AUTH_JWT_SECRET || env.AUTH_JWT_SECRET.length < 32)) {
  throw new Error('AUTH_JWT_SECRET must be set to at least 32 characters when AUTH_MODE=required');
}

export const config = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  databaseUrl: env.DATABASE_URL,
  redisUrl: env.REDIS_URL,
  aiServiceUrl: env.AI_SERVICE_URL,
  authMode,
  authJwtSecret: env.AUTH_JWT_SECRET ?? 'development-only-insecure-secret-change-me',
  authAccessTtlSeconds: env.AUTH_ACCESS_TTL_SECONDS,
  authRefreshTtlSeconds: env.AUTH_REFRESH_TTL_SECONDS,
  rateLimitMax: env.RATE_LIMIT_DISABLED ? 0 : env.RATE_LIMIT_MAX,
  rateLimitWindow: env.RATE_LIMIT_WINDOW,
} as const;

export type AppConfig = typeof config;

export const isProd = config.nodeEnv === 'production';
export const isTest = config.nodeEnv === 'test';
