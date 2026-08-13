import { z } from 'zod';

const booleanString = z.enum(['true', 'false']);
const schema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    DATABASE_URL: z.string().min(1),
    JWT_ACCESS_SECRET: z.string().min(32),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    FRONTEND_URL: z.string().url(),
    ADMIN_PUBLIC_URL: z.string().url().optional().or(z.literal('')),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    AUTH_COOKIE_NAME: z.string().min(1).default('zapis_admin_refresh'),
    AUTH_COOKIE_SECURE: booleanString.default('false'),
    AUTH_REFRESH_GRACE_SECONDS: z.coerce
      .number()
      .int()
      .min(1)
      .max(60)
      .default(10),
    AUTOMATION_WORKER_ENABLED: booleanString.default('true'),
    AUTOMATION_WORKER_POLL_MS: z.coerce.number().int().min(100).default(1000),
    AUTOMATION_WORKER_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3),
    AUTOMATION_JOB_STALE_LOCK_SECONDS: z.coerce
      .number()
      .int()
      .min(30)
      .default(300),
    OPENAI_MOCK_MODE: booleanString.default('false'),
    OPENAI_API_KEY: z.string().optional(),
    TELEGRAM_ENABLED: booleanString.default('false'),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    TELEGRAM_BOT_USERNAME: z.string().optional(),
    WHATSAPP_ENABLED: booleanString.default('false'),
    WHATSAPP_CLIENT_ID: z.string().optional(),
    WHATSAPP_SESSION_PATH: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    const requireValue = (condition: boolean, key: keyof typeof env) => {
      if (condition && !env[key])
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: 'is required by enabled configuration',
        });
    };
    requireValue(env.OPENAI_MOCK_MODE === 'false', 'OPENAI_API_KEY');
    requireValue(env.TELEGRAM_ENABLED === 'true', 'TELEGRAM_BOT_TOKEN');
    requireValue(env.TELEGRAM_ENABLED === 'true', 'TELEGRAM_BOT_USERNAME');
    requireValue(env.WHATSAPP_ENABLED === 'true', 'WHATSAPP_CLIENT_ID');
    requireValue(env.WHATSAPP_ENABLED === 'true', 'WHATSAPP_SESSION_PATH');
    if (env.NODE_ENV === 'production' && env.AUTH_COOKIE_SECURE !== 'true') {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_COOKIE_SECURE'],
        message: 'must be true in production',
      });
    }
  });

export function validateEnvironment() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const fields = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${fields}`);
  }
  return result.data;
}

export function allowedOrigins() {
  return [process.env.FRONTEND_URL, process.env.ADMIN_PUBLIC_URL]
    .filter((value): value is string => Boolean(value))
    .map((value) => new URL(value).origin);
}
