import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyToken } from '../src/auth/jwt.js';

const BIZ = '65a000000000000000000010';
const USER = '65a000000000000000000011';

const { userMock, businessMock } = vi.hoisted(() => ({
  userMock: {
    exists: vi.fn(),
    create: vi.fn(),
    findOne: vi.fn(),
    findById: vi.fn(),
    updateOne: vi.fn(),
  },
  businessMock: {
    exists: vi.fn(),
    create: vi.fn(),
    deleteOne: vi.fn(),
    find: vi.fn(),
    findById: vi.fn(),
  },
}));

vi.mock('../src/models/User.js', () => ({ User: userMock }));
vi.mock('../src/models/Business.js', () => ({ Business: businessMock }));

const valid = {
  businessName: 'Skinare Aesthetics',
  category: 'salon',
  city: 'Multan',
  ownerName: 'Hina Nawaz',
  email: 'Hina@Skinare.pk',
  password: 'hydrafacial2026',
};

const servers: ReturnType<express.Express['listen']>[] = [];

/**
 * Just enough Redis for the rate limiter the auth router now takes (4.2).
 *
 * In-memory rather than a real connection, because every model here is mocked
 * and this suite is deliberately infrastructure-free — adding a container
 * dependency to test slug allocation would be paying for the wrong thing.
 *
 * A fresh counter per server, so registrations in one test never spend another
 * test's budget. Passing `undefined` instead would also have compiled at the
 * call site and "worked", because the limiter fails open on a Redis error —
 * which is precisely the way a rate limit disappears without anybody noticing.
 */
const stubRedis = () => {
  const counts = new Map<string, number>();
  return {
    incr: async (key: string) => {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return next;
    },
    expire: async () => 1,
  } as unknown as import('ioredis').Redis;
};

async function post(body: unknown) {
  const { createAuthRouter } = await import('../src/auth/routes.js');
  const app = express();
  app.use('/auth', createAuthRouter(stubRedis()));

  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;

  return fetch(`http://127.0.0.1:${port}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  userMock.exists.mockResolvedValue(null);
  businessMock.exists.mockResolvedValue(null);
  businessMock.create.mockResolvedValue({ _id: BIZ });
  businessMock.deleteOne.mockResolvedValue({ deletedCount: 1 });
  userMock.create.mockResolvedValue({ _id: USER, role: 'owner', businessIds: [BIZ] });
});

afterEach(() => {
  servers.forEach((s) => s.close());
  servers.length = 0;
});

describe('owner registration', () => {
  it('creates the business and its owner, and returns a scoped token', async () => {
    const res = await post(valid);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { token: string; role: string };

    // The token is the whole point of returning 201 rather than 204: signup
    // lands the owner in the app, not back on the login screen.
    expect(verifyToken(body.token)).toMatchObject({
      userId: USER,
      role: 'owner',
      businessIds: [BIZ],
    });
  });

  it('lowercases the email so login can find the account again', async () => {
    await post(valid);
    expect(userMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'hina@skinare.pk' }),
    );
  });

  it('never stores the password itself', async () => {
    await post(valid);

    const created = userMock.create.mock.calls[0]![0] as { passwordHash: string };
    expect(created.passwordHash).not.toContain(valid.password);
    expect(created.passwordHash.startsWith('$2')).toBe(true);
  });

  it('derives a url-safe slug from the business name', async () => {
    await post(valid);
    expect(businessMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'skinare-aesthetics', city: 'Multan' }),
    );
  });

  it('suffixes the slug when the name is already taken', async () => {
    // First candidate taken, second free.
    businessMock.exists.mockResolvedValueOnce({ _id: 'other' }).mockResolvedValueOnce(null);

    await post(valid);
    expect(businessMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'skinare-aesthetics-2' }),
    );
  });

  it('refuses a known email without creating anything', async () => {
    userMock.exists.mockResolvedValue({ _id: 'someone' });

    const res = await post(valid);
    expect(res.status).toBe(409);
    expect(businessMock.create).not.toHaveBeenCalled();

    const body = (await res.json()) as { fields: Record<string, string> };
    expect(body.fields.email).toBeTruthy();
  });

  /**
   * The compensating delete is the reason registration can skip a transaction.
   * If it ever stops running, a lost race leaves a business no one can log into
   * — invisible in the app, and permanently holding its slug.
   */
  it('rolls the business back when the user insert loses the race', async () => {
    userMock.create.mockRejectedValue(
      Object.assign(new Error('E11000 duplicate key'), { code: 11000 }),
    );

    const res = await post(valid);

    expect(res.status).toBe(409);
    expect(businessMock.deleteOne).toHaveBeenCalledWith({ _id: BIZ });
  });

  it('rejects a short password and says which field', async () => {
    const res = await post({ ...valid, password: 'short' });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { fields: Record<string, string> };
    expect(body.fields.password).toBeTruthy();
    expect(businessMock.create).not.toHaveBeenCalled();
  });

  it('rejects a category the backend does not serve', async () => {
    const res = await post({ ...valid, category: 'restaurant' });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { fields: Record<string, string> };
    expect(body.fields.category).toBeTruthy();
  });

  it('rejects a malformed email', async () => {
    const res = await post({ ...valid, email: 'hina@skinare' });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { fields: Record<string, string> };
    expect(body.fields.email).toBeTruthy();
  });
});
