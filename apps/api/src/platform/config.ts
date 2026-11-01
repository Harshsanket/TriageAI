import { z } from 'zod';

const emptyToUndefined = (value: unknown) => (value === '' ? undefined : value);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().url(),
  AI_SERVICE_URL: z.string().url().default('http://localhost:8000'),
  // Compose passes empty strings for unset values; treat '' as "not set".
  AUTH_MODE: z.preprocess(emptyToUndefined, z.enum(['disabled', 'required']).optional()),
  AUTH_JWT_SECRET: z.preprocess(emptyToUndefined, z.string().optional()),
  TRIAGEAI_SECRET_KEY: z.preprocess(emptyToUndefined, z.string().min(32).optional()),
  TRIAGEAI_SETUP: z.preprocess(emptyToUndefined, z.enum(['auto', 'off']).default('auto')),
  TRIAGEAI_RESTART_ON_APPLY: z
    .string()
    .optional()
    .transform((value) => value === '1' || value === 'true'),
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
  CORS_ORIGINS: z.string().default('http://localhost:5173,http://127.0.0.1:5173'),
  // Compose passes an empty string when unset; treat that as "no token".
  METRICS_TOKEN: z
    .string()
    .optional()
    .transform((value) => value || undefined)
    .refine((value) => value === undefined || value.length >= 16, {
      message: 'METRICS_TOKEN must be at least 16 characters',
    }),
  RATE_LIMIT_MAX: z.coerce.number().int().nonnegative().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  RATE_LIMIT_DISABLED: z
    .string()
    .optional()
    .transform((value) => value === '1' || value === 'true'),
  TRIAGEAI_PLUGINS_DIR: z.string().optional(),
  TRIAGEAI_PLUGIN_REGISTRY: z.string().optional(),
  TRIAGEAI_PLUGIN_PUBLIC_KEYS: z.string().optional(),
  TRIAGEAI_SKILLS_DIR: z.string().optional(),
  TRIAGEAI_TRUST_PROXY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;

export const config = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  databaseUrl: env.DATABASE_URL,
  aiServiceUrl: env.AI_SERVICE_URL,
  /**
   * Explicit `AUTH_MODE`, if any. The effective mode is resolved at boot
   * (env → /config setting → default) and checked there (setup/boot.ts).
   */
  authModeEnv: env.AUTH_MODE,
  authJwtSecretEnv: env.AUTH_JWT_SECRET,
  /** Env secret or the dev fallback; tests sign tokens with it. */
  authJwtSecret: env.AUTH_JWT_SECRET ?? 'development-only-insecure-secret-change-me',
  secretKey: env.TRIAGEAI_SECRET_KEY,
  setupEnabled: env.TRIAGEAI_SETUP !== 'off',
  restartOnApply: env.TRIAGEAI_RESTART_ON_APPLY,
  /** Fastify trustProxy: false, true, or a comma-separated CIDR list. */
  trustProxy:
    env.TRIAGEAI_TRUST_PROXY === undefined || env.TRIAGEAI_TRUST_PROXY === ''
      ? false
      : env.TRIAGEAI_TRUST_PROXY === '1' || env.TRIAGEAI_TRUST_PROXY === 'true'
        ? true
        : env.TRIAGEAI_TRUST_PROXY,
  authAccessTtlSeconds: env.AUTH_ACCESS_TTL_SECONDS,
  authRefreshTtlSeconds: env.AUTH_REFRESH_TTL_SECONDS,
  /** Explicit browser origins; `*` opts back into reflecting any origin. */
  corsOrigins: env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  metricsToken: env.METRICS_TOKEN,
  rateLimitMax: env.RATE_LIMIT_DISABLED ? 0 : env.RATE_LIMIT_MAX,
  rateLimitWindow: env.RATE_LIMIT_WINDOW,
  /** Phase 12: plugin volume, registry URL/`off`, and pinned ed25519 keys. */
  pluginsRoot: env.TRIAGEAI_PLUGINS_DIR ?? '.triageai-plugins',
  pluginRegistryUrl: env.TRIAGEAI_PLUGIN_REGISTRY ?? 'off',
  pluginPublicKeys: env.TRIAGEAI_PLUGIN_PUBLIC_KEYS,
  skillsRoot: env.TRIAGEAI_SKILLS_DIR ?? '.triageai-skills',
} as const;

export type AppConfig = typeof config;

export const isProd = config.nodeEnv === 'production';
export const isTest = config.nodeEnv === 'test';
