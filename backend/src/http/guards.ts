import type { Redis } from 'ioredis';
import type { RequestHandler, Response } from 'express';
import { logger } from '../lib/logger.js';

/**
 * The two wrappers every anonymous route needs.
 *
 * Extracted from public/routes.ts when milestone 3.3 added a second anonymous
 * router. Importing them from there would have made the two files circular, and
 * copying them would have left two rate limiters to keep in step.
 */

/** Express 5 forwards a rejected promise to the error handler; this keeps the body JSON. */
export const safely =
  (handler: RequestHandler): RequestHandler =>
  async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (err) {
      logger.error({ err, path: req.path }, 'public route failed');
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Try again.' });
    }
  };

export const TOO_MANY = 'Too many attempts. Wait a few minutes and try again.';

export const tooMany = (res: Response): void => {
  res.status(429).json({ error: TOO_MANY, reason: 'rate_limited' });
};

/**
 * A fixed-window counter per client IP.
 *
 * The web booking path takes an unverified phone number from a stranger and
 * messages it, so the damage one caller can do has to be bounded somewhere.
 *
 * `req.ip` is the socket address unless the app trusts a proxy. Behind a load
 * balancer every customer shares the proxy's address and this limits all of
 * them together — set `trust proxy` for the real deployment's hop count before
 * relying on it there. It is not set here because trusting a header nobody
 * strips lets any caller pick their own IP.
 */
export function rateLimit(
  redis: Redis,
  bucket: string,
  limit: number,
  windowSeconds: number,
): RequestHandler {
  return async (req, res, next) => {
    const key = `rl:public:${bucket}:${req.ip ?? 'unknown'}`;
    try {
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, windowSeconds);
      if (count > limit) {
        tooMany(res);
        return;
      }
    } catch (err) {
      // Fail open: a Redis blip should not take booking offline. Holds need
      // Redis anyway, so the request will fail on its own if Redis is gone.
      logger.warn({ err }, 'public rate limit unavailable');
    }
    next();
  };
}
