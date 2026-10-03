import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import express, { type Router } from 'express';
import { z } from 'zod';
import type { Redis } from 'ioredis';
import type { UserRole } from '@scalivo/shared';
import { User } from '../models/User.js';
import { Business } from '../models/Business.js';
import { signToken } from './jwt.js';
import { requireAuth, getAuth } from './middleware.js';
import { rateLimit } from '../http/guards.js';
import { logger } from '../lib/logger.js';

const credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

/**
 * Mirrors the Create Account screen field for field. Password is 8 here and 1 on
 * login deliberately — tightening the rule must never lock out an owner who
 * registered under an older one.
 */
const registration = z.object({
  businessName: z.string().trim().min(1),
  category: z.enum(['salon', 'gym', 'clinic']),
  city: z.string().trim().min(1),
  ownerName: z.string().trim().min(1),
  email: z.string().email(),
  password: z.string().min(8),
});

const deviceToken = z.object({
  fcmToken: z.string().min(1),
});

export const hashPassword = (plain: string) => bcrypt.hash(plain, 10);

/**
 * A real bcrypt hash of a value nobody knows, compared against when the email
 * matches no account.
 *
 * Without it, `/login` answers a nonexistent email in microseconds and a real
 * email with a wrong password in however long bcrypt takes — tens of
 * milliseconds, far above network jitter and trivially measurable. The identical
 * 401 body below would still be a perfect account oracle. Comparing against this
 * makes both paths do the same work, which is what the body's promise actually
 * requires.
 *
 * Generated at module load from random bytes rather than hard-coded, so this is
 * not a password anybody could ever supply.
 */
const ABSENT_USER_HASH = bcrypt.hashSync(crypto.randomUUID(), 10);

/**
 * A URL-safe stem from the business name, with a numeric suffix when taken.
 *
 * The loop is bounded because an unbounded one is a denial-of-service against
 * our own signup: a pathological name should fail fast, not spin.
 */
/**
 * The site's own top-level routes. A business profile lives at /<slug>, and a
 * static route beats a dynamic one — so a salon called "Pay" would get a
 * profile URL that the payment page answers instead, and nobody would ever
 * reach it. Such a name gets the numeric suffix like any taken slug.
 */
const RESERVED_SLUGS = new Set([
  'pay', 'search', 'login', 'register', 'signup', 'dashboard', 'api', 'admin',
  'robots.txt', 'sitemap.xml', 'business', 'businesses',
  // 'me' is the customer's own page (3.3). It does not collide at the path
  // level — that page is always /me/<token> — but a business living at /me
  // while its customers' pages live under /me/ is a trap nobody needs.
  'me',
  // Reserved for the same reason before anything claims them.
  'icons', 'sw.js', 'manifest.webmanifest',
]);

async function uniqueSlug(name: string): Promise<string> {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'business';

  for (let n = 0; n < 25; n += 1) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`;
    if (RESERVED_SLUGS.has(candidate)) continue;
    if (!(await Business.exists({ slug: candidate }))) return candidate;
  }
  throw new Error('could not allocate a slug');
}

export function createAuthRouter(redis: Redis): Router {
  const router = express.Router();

  /**
   * Brute-force ceiling on the two unauthenticated endpoints here (4.2).
   *
   * Every rate limiter in this codebase used to sit on the public booking
   * surface, and none on the endpoint that guards owner accounts — so the
   * password check was the only thing standing between a wordlist and a tenant.
   * bcrypt at cost 10 slows an attacker down; it does not stop one, and it makes
   * an unlimited login endpoint a CPU exhaustion vector besides.
   *
   * Per IP, which is the same coarse bucket the public limiter uses and carries
   * the same caveat about `trust proxy` — see http/guards.ts. Per-account
   * lockout is deliberately NOT used: it lets anyone lock an owner out of their
   * own business by guessing at their email, which turns a nuisance into an
   * outage on a Saturday.
   */
  const loginLimit = rateLimit(redis, 'login', 20, 15 * 60);
  const registerLimit = rateLimit(redis, 'register', 5, 60 * 60);

  router.post('/login', loginLimit, express.json(), async (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'email and password required' });
      return;
    }

    const user = await User.findOne({ email: parsed.data.email.toLowerCase() });

    /**
     * Same response AND the same work whether the email is unknown or the
     * password is wrong — otherwise this endpoint enumerates which owners have
     * accounts. The identical body was already here; the identical work was not,
     * and a response that returns in 1 ms for a stranger and 60 ms for a real
     * owner answers the question just as clearly.
     */
    const ok = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? ABSENT_USER_HASH);
    if (!user || !ok) {
      // The attempted email, deliberately: knowing WHICH account is being
      // hammered is the whole value of this line. It is the one piece of
      // personal data in the general log, and docs/data-handling.md says so.
      logger.warn({ email: parsed.data.email }, 'failed login');
      res.status(401).json({ error: 'invalid credentials' });
      return;
    }

    res.json({
      token: signToken({
        userId: String(user._id),
        role: user.role as UserRole,
        businessIds: user.businessIds,
      }),
      role: user.role,
    });
  });

  /**
   * Creates the business and its owner together, and returns a token — signup
   * lands the owner straight in the app rather than back on the login screen.
   *
   * There is no transaction here on purpose. Registration spans two collections
   * and would need a replica set, but the only failure that can strand a
   * business is the user insert, so it compensates by deleting what it just
   * created. Booking writes are the ones that genuinely need atomicity.
   */
  router.post('/register', registerLimit, express.json(), async (req, res) => {
    const parsed = registration.safeParse(req.body);
    if (!parsed.success) {
      // Field-keyed so the app can underline the offending input rather than
      // showing one generic banner. The Create Account screen is designed for it.
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key === 'string' && !fields[key]) fields[key] = issue.message;
      }
      res.status(400).json({ error: 'invalid registration', fields });
      return;
    }

    const email = parsed.data.email.toLowerCase();
    if (await User.exists({ email })) {
      res.status(409).json({ error: 'email already registered', fields: { email: 'Email already registered' } });
      return;
    }

    const business = await Business.create({
      slug: await uniqueSlug(parsed.data.businessName),
      name: parsed.data.businessName,
      category: parsed.data.category,
      city: parsed.data.city,
    });

    let user;
    try {
      user = await User.create({
        email,
        passwordHash: await hashPassword(parsed.data.password),
        name: parsed.data.ownerName,
        role: 'owner',
        businessIds: [String(business._id)],
      });
    } catch (err) {
      // Losing the race on the unique email index lands here. Roll the business
      // back rather than leaving an unreachable tenant behind.
      await Business.deleteOne({ _id: business._id });
      logger.warn({ err, email }, 'registration rolled back');
      res.status(409).json({ error: 'email already registered', fields: { email: 'Email already registered' } });
      return;
    }

    logger.info({ businessId: String(business._id), email }, 'business registered');

    res.status(201).json({
      token: signToken({
        userId: String(user._id),
        role: user.role as UserRole,
        businessIds: user.businessIds,
      }),
      role: user.role,
    });
  });

  /**
   * What the app needs on every cold start: who is logged in, and what state
   * their WhatsApp is in.
   *
   * The session banner reads from here, so a 401 doubles as "your token expired,
   * go to login" — one round trip settles both questions.
   */
  router.get('/me', requireAuth, async (_req, res) => {
    const auth = getAuth(res);
    const user = await User.findById(auth.userId);
    if (!user) {
      res.status(401).json({ error: 'invalid token' });
      return;
    }

    const businesses = await Business.find({ _id: { $in: user.businessIds } });

    res.json({
      user: { id: String(user._id), name: user.name, email: user.email, role: user.role },
      businesses: businesses.map((b) => ({
        id: String(b._id),
        name: b.name,
        category: b.category,
        timezone: b.timezone,
        whatsapp: {
          status: b.whatsapp?.status ?? null,
          intent: b.whatsapp?.intent ?? null,
          lastStatusChange: b.whatsapp?.lastStatusChange ?? null,
        },
      })),
    });
  });

  /**
   * Registers this device for push. Called on every login and whenever FCM
   * rotates the token, so it must be idempotent — $addToSet, not $push.
   */
  router.post('/device', requireAuth, express.json(), async (req, res) => {
    const parsed = deviceToken.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'fcmToken required' });
      return;
    }

    const auth = getAuth(res);
    await User.updateOne({ _id: auth.userId }, { $addToSet: { fcmTokens: parsed.data.fcmToken } });
    res.status(204).end();
  });

  return router;
}
