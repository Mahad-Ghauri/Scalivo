import { z } from 'zod';

/**
 * Fail fast and loudly. A backend that boots with a missing OPENWA_WEBHOOK_SECRET
 * will happily accept unsigned webhooks, which is worse than not booting.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * How many reverse proxies sit in front of the API (nginx, a load balancer).
   * Every per-IP rate limit reads req.ip, which is only the customer's address
   * when Express trusts exactly that many X-Forwarded-For hops. 0 (the default)
   * trusts none — right when the API is exposed directly. Too low and every
   * customer shares the proxy's bucket; too high and callers can pick their IP.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),
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

  /**
   * Where Google/Apple Calendar can reach the iCal feed. Must be reachable from
   * the public internet — unlike PUBLIC_URL, which only the gateway needs to
   * reach and may be an internal host. Falls back to PUBLIC_URL.
   */
  CALENDAR_FEED_BASE_URL: z.string().url().optional(),

  JWT_SECRET: z.string().min(32),

  /**
   * Comma-separated origins allowed to call /public from a browser — the
   * marketplace site, e.g. `https://scalivo.app`. Only the booking steps need
   * it: the site's pages read /public from its own server, where CORS does not
   * apply. Loopback origins are already allowed in development.
   */
  WEB_ORIGINS: z
    .string()
    .default('')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),

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

  /**
   * Where the marketplace site lives. Payment links point here (/pay/:token),
   * and the gateway sends the customer's browser back here after paying.
   */
  WEB_URL: z.string().url().default('http://localhost:3001'),

  /**
   * Deposits gateway (SPEC §12). `simulated` is a stand-in checkout page served
   * by this backend, for development and tests; it is refused in production
   * below, because a simulated gateway in production confirms bookings nobody
   * paid for.
   */
  PAYMENT_PROVIDER: z.enum(['simulated', 'jazzcash']).default('simulated'),

  /**
   * Gemini, for the agent's phrasing (SPEC §11). OPTIONAL, and meant to be.
   *
   * Without it every briefing still goes out, written from the templates in
   * agent/templates.ts — the LLM only rewrites prose that was already correct, so
   * a missing key costs wording and nothing else. Keeping it optional is what
   * makes that claim testable rather than aspirational: the whole agent runs, and
   * is demonstrated, with no credential at all.
   */
  GEMINI_API_KEY: z.string().optional(),

  /**
   * Flash rather than Pro: the task is a one-paragraph rewrite on a deadline.
   *
   * The default is a moving target — Google retires model ids and answers a
   * retired one with a 404, which `generate()` swallows into a null. That reads
   * as "no key configured" and degrades silently to the templates, so a stale
   * default here looks exactly like the feature being switched off.
   */
  GEMINI_MODEL: z.string().default('gemini-3.8-flash'),

  /** JazzCash merchant portal → Integration. Sandbox values until a live account exists. */
  JAZZCASH_MERCHANT_ID: z.string().optional(),
  JAZZCASH_PASSWORD: z.string().optional(),
  JAZZCASH_INTEGRITY_SALT: z.string().optional(),
  JAZZCASH_BASE_URL: z.string().url().default('https://sandbox.jazzcash.com.pk'),

  /**
   * Image storage — any S3-compatible bucket (Cloudflare R2 in practice).
   * All six or none: unset, uploads answer 503 and nothing else is affected.
   * STORAGE_ENDPOINT is the signed API host (never sent to clients);
   * STORAGE_PUBLIC_URL is what browsers load images from.
   */
  STORAGE_ENDPOINT: z.string().url().optional(),
  STORAGE_REGION: z.string().min(1).optional(),
  STORAGE_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'a valid bucket name')
    .optional(),
  STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  STORAGE_PUBLIC_URL: z.string().url().optional(),
}).superRefine((value, ctx) => {
  const storage = [
    'STORAGE_ENDPOINT',
    'STORAGE_REGION',
    'STORAGE_BUCKET',
    'STORAGE_ACCESS_KEY_ID',
    'STORAGE_SECRET_ACCESS_KEY',
    'STORAGE_PUBLIC_URL',
  ] as const;
  const set = storage.filter((k) => value[k]);
  if (set.length > 0 && set.length < storage.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STORAGE_ENDPOINT'],
      message: `image storage is half-configured; missing ${storage.filter((k) => !value[k]).join(', ')}`,
    });
  }
  if (value.STORAGE_PUBLIC_URL && value.STORAGE_ENDPOINT) {
    // The mix-up this catches happened during setup: the API host as the public URL.
    if (new URL(value.STORAGE_PUBLIC_URL).host === new URL(value.STORAGE_ENDPOINT).host) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['STORAGE_PUBLIC_URL'],
        message: 'STORAGE_PUBLIC_URL must be the public bucket address, not the signed API endpoint',
      });
    }
  }
  if (value.NODE_ENV === 'production' && value.STORAGE_PUBLIC_URL?.startsWith('http://')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['STORAGE_PUBLIC_URL'],
      message: 'images must be served over https in production',
    });
  }
  if (value.NODE_ENV === 'production' && value.PAYMENT_PROVIDER === 'simulated') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PAYMENT_PROVIDER'],
      message: 'the simulated gateway confirms unpaid bookings and cannot run in production',
    });
  }
  if (
    value.PAYMENT_PROVIDER === 'jazzcash' &&
    !(value.JAZZCASH_MERCHANT_ID && value.JAZZCASH_PASSWORD && value.JAZZCASH_INTEGRITY_SALT)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['PAYMENT_PROVIDER'],
      message: 'jazzcash needs JAZZCASH_MERCHANT_ID, JAZZCASH_PASSWORD and JAZZCASH_INTEGRITY_SALT',
    });
  }
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
