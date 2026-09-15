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

  /**
   * Where the gateway can reach US. Onboarding registers this as the webhook
   * URL for each new session, so a wrong value produces a session that links
   * fine and then never delivers a single message.
   *
   * Note WEBHOOK_SSRF_PROTECT=true on the gateway: the internal host has to be
   * on its allowlist, or registration is refused.
   */
  PUBLIC_URL: z.string().url().default('http://localhost:3000'),

  JWT_SECRET: z.string().min(32),

  MESSAGING_PROVIDER: z.enum(['openwa', 'meta']).default('openwa'),

  /**
   * Firebase SERVICE ACCOUNT credential — either the JSON itself or a path to
   * it. This is NOT `google-services.json`, which identifies the app; sending a
   * push needs a server key from Firebase Console → Project Settings → Service
   * accounts → Generate new private key.
   *
   * Optional on purpose: without it Session Health still detects outages,
   * queues messages and shows the dashboard banner — only the push tier logs
   * instead of sending. A missing credential must not stop the server booting.
   */
  FIREBASE_SERVICE_ACCOUNT: z.string().optional(),
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
