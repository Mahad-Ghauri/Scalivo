import { z } from 'zod';

/**
 * Fail fast and loudly. A backend that boots with a missing OPENWA_WEBHOOK_SECRET
 * will happily accept unsigned webhooks, which is worse than not booting.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(3000),

  MONGO_URI: z.string().url(),
  POSTGRES_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  OPENWA_BASE_URL: z.string().url(),
  /** Header-only auth: `X-API-Key: owa_k1_<64hex>`. The ?apiKey= fallback was removed upstream. */
  OPENWA_API_KEY: z.string().min(1),
  /** HMAC-SHA256 secret for X-OpenWA-Signature, verified over RAW request bytes. */
  OPENWA_WEBHOOK_SECRET: z.string().min(16),

  JWT_SECRET: z.string().min(32),
  /** Business-local default. Every stored timestamp stays UTC regardless. */
  DEFAULT_TIMEZONE: z.string().default('Asia/Karachi'),

  MESSAGING_PROVIDER: z.enum(['openwa', 'meta']).default('openwa'),
});

export type Env = z.infer<typeof schema>;

export const env: Env = (() => {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}\n\nSee backend/.env.example`);
  }
  return parsed.data;
})();
