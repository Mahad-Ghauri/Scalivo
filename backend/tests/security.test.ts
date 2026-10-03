import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env.js';
import { signToken, verifyToken } from '../src/auth/jwt.js';
import { securityHeaders } from '../src/http/headers.js';
import { createAuthRouter, hashPassword } from '../src/auth/routes.js';
import { Business } from '../src/models/Business.js';
import { User } from '../src/models/User.js';
import { infraReady } from './infra.js';

/**
 * The hardening from milestone 4.2, and specifically the parts that were NOT
 * true before it.
 *
 * Each test here corresponds to a finding from the review rather than to a
 * feature, so the header on each says what was wrong. That matters more than
 * usual: a security fix with no test is a fix that silently reverts, and every
 * one of these was invisible in ordinary use — the login endpoint worked, the
 * tokens verified, the API answered. None of it looked broken.
 */

/**
 * Counts password comparisons, and passes every call through to the real
 * bcrypt so hashing and verification still work.
 *
 * The enumeration test below is about WORK DONE, not about the answer, and
 * timing cannot assert that here: the first version of it measured the request
 * and asserted a floor, which the HTTP round trip and the Mongo lookup clear on
 * their own — so it passed with the fix reverted and proved nothing. Counting
 * the call is the property itself, and it cannot be satisfied by a slow laptop.
 */
const { compareCalls } = vi.hoisted(() => ({ compareCalls: { count: 0 } }));

vi.mock('bcryptjs', async (importOriginal) => {
  const actual = (await importOriginal()) as { default: typeof import('bcryptjs') };
  const real = actual.default;
  return {
    default: {
      ...real,
      compare: (data: string, hash: string) => {
        compareCalls.count += 1;
        return real.compare(data, hash);
      },
    },
  };
});

/**
 * One disconnect for the whole file, after every suite in it.
 *
 * Not per-suite: `infraReady` opens ONE mongoose connection and the suites here
 * share it, so the first suite to disconnect takes the database away from the
 * next one — which fails as a 500 from a route that is in fact fine, and sends
 * you looking for a bug in the wrong place. It did exactly that once.
 */
afterAll(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
});

describe('token algorithm is pinned', () => {
  const claims = { userId: 'u1', role: 'owner' as const, businessIds: ['65a000000000000000000001'] };

  it('still round-trips a token it signed', () => {
    expect(verifyToken(signToken(claims))).toMatchObject(claims);
  });

  it('signs with HS256 and nothing else', () => {
    const [header] = signToken(claims).split('.');
    const decoded = JSON.parse(Buffer.from(header!, 'base64url').toString()) as { alg: string };
    expect(decoded.alg).toBe('HS256');
  });

  /**
   * The finding: `verify` was called without `algorithms`, so the TOKEN chose
   * how it was checked. Current jsonwebtoken already refuses `alg: none` — the
   * famous version of this bug — but leaving the choice in the attacker's half
   * of the message is the shape of the bug, not that one instance of it.
   */
  it('refuses a token that names a different algorithm', () => {
    const hs512 = jwt.sign(claims, env.JWT_SECRET, { algorithm: 'HS512' });
    expect(() => verifyToken(hs512)).toThrow();
  });

  it('refuses an unsigned token', () => {
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(
      JSON.stringify(claims),
    ).toString('base64url')}.`;
    expect(() => verifyToken(none)).toThrow();
  });
});

describe('security headers', () => {
  let server: Server;
  let base: string;

  beforeAll(() => {
    const app = express();
    app.use(securityHeaders);
    app.get('/anything', (_req, res) => {
      res.json({ ok: true });
    });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('sets the ones that matter on every response', async () => {
    const res = await fetch(`${base}/anything`);

    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    // URLs here carry credentials in the path — a deposit token, a /me token.
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  /**
   * HSTS is a promise a browser holds for a year and will not let you take
   * back. Sent from a dev server it would lock `http://localhost` out for every
   * other project on the machine, so it is production-only — and the test runs
   * outside production, which is exactly the case that must not send it.
   */
  it('withholds HSTS outside production', async () => {
    expect(env.NODE_ENV).not.toBe('production');
    expect((await fetch(`${base}/anything`)).headers.get('strict-transport-security')).toBeNull();
  });
});

const infraUp = await infraReady({ redis: true });

describe.skipIf(!infraUp)('the login endpoint', () => {
  let redis: Redis;
  let server: Server;
  let base: string;
  let email: string;

  const PASSWORD = 'correct-horse-battery';

  const login = (body: unknown) =>
    fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  beforeAll(async () => {
    // db 12 — 1–11 belong to the other infrastructure suites.
    redis = new Redis(process.env.REDIS_URL!, { db: 12 });

    const app = express();
    app.use('/auth', createAuthRouter(redis));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    email = `sec-${crypto.randomUUID()}@example.com`;
    await User.create({
      email,
      passwordHash: await hashPassword(PASSWORD),
      name: 'Security Test Owner',
      role: 'owner',
      businessIds: [],
    });
  });

  afterAll(async () => {
    server.close();
    await User.deleteMany({ email });
    await redis.quit();
  });

  beforeEach(async () => {
    // Every limiter here keys on 127.0.0.1, so one test's attempts would
    // otherwise spend the next test's budget.
    await redis.flushdb();
  });

  it('lets a real owner in', async () => {
    const res = await login({ email, password: PASSWORD });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { token?: string }).token).toBeTruthy();
  });

  /**
   * The finding, and the subtle one. The endpoint always ANSWERED identically —
   * that comment was already in the code — but when the email matched nothing
   * it skipped bcrypt entirely and returned in about a millisecond, while a
   * real account with a wrong password took the full hash comparison. The
   * identical body was a perfect account oracle to anyone holding a stopwatch.
   *
   * Asserted as a floor rather than a ratio: a ratio compares two timings on a
   * machine also running Mongo and Redis, and is the kind of test that fails on
   * a busy laptop for no reason. A floor only has to be true.
   */
  it('does the same work for an unknown email as for a wrong password', async () => {
    compareCalls.count = 0;
    const unknown = await login({ email: `nobody-${crypto.randomUUID()}@example.com`, password: 'x' });
    const forUnknown = compareCalls.count;

    compareCalls.count = 0;
    const wrong = await login({ email, password: 'not-the-password' });
    const forWrong = compareCalls.count;

    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    // The old code skipped bcrypt entirely when the email matched nothing,
    // which is the whole timing side channel in one branch.
    expect(forUnknown).toBe(1);
    expect(forUnknown).toBe(forWrong);
  });

  it('answers an unknown email and a wrong password identically', async () => {
    const unknown = await login({ email: `nobody-${crypto.randomUUID()}@example.com`, password: 'x' });
    const wrong = await login({ email, password: 'not-the-password' });

    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.text()).toBe(await wrong.text());
  });

  /**
   * The finding: every rate limiter in the codebase guarded the public booking
   * surface, and none guarded the endpoint protecting owner accounts. bcrypt
   * slows a wordlist down; it does not stop one, and it makes an unlimited
   * login endpoint a CPU exhaustion vector besides.
   */
  it('stops a wordlist', async () => {
    const attempts = [];
    for (let i = 0; i < 21; i += 1) {
      attempts.push(await login({ email, password: `guess-${i}` }));
    }

    expect(attempts.filter((r) => r.status === 429).length).toBeGreaterThan(0);
    expect(attempts.at(-1)!.status).toBe(429);
  });

  /**
   * And it must keep refusing the RIGHT password while the limit holds —
   * otherwise the limiter is decoration an attacker walks past on the attempt
   * that matters.
   */
  it('refuses even correct credentials while the limit holds', async () => {
    for (let i = 0; i < 21; i += 1) {
      await login({ email, password: `guess-${i}` });
    }

    expect((await login({ email, password: PASSWORD })).status).toBe(429);
  });
});

describe.skipIf(!infraUp)('registration', () => {
  let redis: Redis;
  let server: Server;
  let base: string;
  const made: string[] = [];

  const register = (name: string) =>
    fetch(`${base}/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        businessName: name,
        category: 'salon',
        city: 'Testabad',
        ownerName: 'Owner',
        email: `reg-${crypto.randomUUID()}@example.com`,
        password: 'a-long-enough-password',
      }),
    });

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL!, { db: 12 });
    const app = express();
    app.use('/auth', createAuthRouter(redis));
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.close();
    await Promise.all([
      Business.deleteMany({ slug: { $in: made } }),
      User.deleteMany({ email: /^reg-.*@example\.com$/ }),
    ]);
    await redis.quit();
  });

  beforeEach(async () => {
    await redis.flushdb();
  });

  /**
   * The finding: `/me/<token>` (3.3) added a top-level route and nobody
   * extended the reserved list — which that list's own comment warns about,
   * having been written for exactly this case when `/pay` was added.
   */
  it('never hands a business the slug of one of our own routes', async () => {
    const res = await register('Me');
    expect(res.status).toBe(201);

    const business = await Business.findOne({ name: 'Me' }).sort({ createdAt: -1 });
    made.push(business!.slug);

    expect(business!.slug).not.toBe('me');
    expect(business!.slug).toMatch(/^me-\d+$/);
  });

  /** Unlimited signups are unlimited tenants, each one a database write. */
  it('bounds how many businesses one caller can create', async () => {
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await register(`Rate Limited Salon ${i}`);
      if (res.status === 201) {
        const created = await Business.findOne({ name: `Rate Limited Salon ${i}` });
        if (created) made.push(created.slug);
      }
      results.push(res.status);
    }

    expect(results.at(-1)).toBe(429);
  });
});
