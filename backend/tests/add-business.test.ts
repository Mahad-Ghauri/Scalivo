import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { signToken, verifyToken } from '../src/auth/jwt.js';

/**
 * 3.7, multi-branch: a branch is its own Business, held by the same owner.
 *
 * Every per-business surface already works off `/:businessId` and the token's
 * `businessIds`; what was missing is a way for an owner who already exists to
 * gain a second business. Registration only ever creates the first one,
 * together with the account.
 */

const FIRST = '65a000000000000000000010';
const BRANCH = '65a000000000000000000020';
const OWNER = '65a000000000000000000011';

const { userMock, businessMock } = vi.hoisted(() => ({
  userMock: {
    exists: vi.fn(),
    create: vi.fn(),
    findOne: vi.fn(),
    findById: vi.fn(),
    findByIdAndUpdate: vi.fn(),
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

const branch = { businessName: 'CrossFit DHA', category: 'gym', city: 'Lahore' };

const servers: ReturnType<express.Express['listen']>[] = [];

/** Same in-memory limiter stand-in as register.test.ts, for the same reasons. */
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

const ownerToken = () => signToken({ userId: OWNER, role: 'owner', businessIds: [FIRST] });

async function post(body: unknown, token: string | null = ownerToken()) {
  const { createAuthRouter } = await import('../src/auth/routes.js');
  const app = express();
  app.use('/auth', createAuthRouter(stubRedis()));

  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  return fetch(`http://127.0.0.1:${port}/auth/businesses`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  businessMock.exists.mockResolvedValue(null);
  businessMock.create.mockResolvedValue({ _id: BRANCH });
  businessMock.deleteOne.mockResolvedValue({ deletedCount: 1 });
  userMock.findByIdAndUpdate.mockResolvedValue({
    _id: OWNER,
    role: 'owner',
    businessIds: [FIRST, BRANCH],
  });
});

afterEach(() => {
  servers.forEach((s) => s.close());
  servers.length = 0;
});

describe('adding a branch to an existing owner', () => {
  /**
   * The re-issued token is the point. `businessIds` is a claim, so without a
   * fresh one the new branch 404s on every route until the owner logs out
   * and back in — which reads as "it didn't save".
   */
  it('creates the business and returns a token that names both', async () => {
    const res = await post(branch);
    expect(res.status).toBe(201);

    const body = (await res.json()) as { token: string; businessId: string };
    expect(body.businessId).toBe(BRANCH);
    expect(verifyToken(body.token)).toMatchObject({
      userId: OWNER,
      role: 'owner',
      businessIds: [FIRST, BRANCH],
    });
  });

  it('adds the branch to the owner without replacing the businesses they have', async () => {
    await post(branch);
    // $addToSet, not $set: an owner gaining a branch must never lose the first.
    expect(userMock.findByIdAndUpdate).toHaveBeenCalledWith(
      OWNER,
      { $addToSet: { businessIds: BRANCH } },
      expect.objectContaining({ new: true }),
    );
  });

  it('gives the branch its own slug from its own name', async () => {
    await post(branch);
    expect(businessMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'crossfit-dha', name: 'CrossFit DHA', city: 'Lahore', category: 'gym' }),
    );
  });

  it('suffixes the slug when the branch name is already taken', async () => {
    businessMock.exists.mockResolvedValueOnce({ _id: 'other' }).mockResolvedValueOnce(null);
    await post(branch);
    expect(businessMock.create).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'crossfit-dha-2' }),
    );
  });

  it('refuses an unauthenticated request without creating anything', async () => {
    const res = await post(branch, null);
    expect(res.status).toBe(401);
    expect(businessMock.create).not.toHaveBeenCalled();
  });

  /**
   * Staff accounts have no business of their own to extend, and owner routes
   * already fail closed on them (assertTenantAccess). A staff login that could
   * mint tenants would be a way out of that.
   */
  it('refuses a staff account', async () => {
    const staff = signToken({ userId: OWNER, role: 'staff', businessIds: [FIRST] });
    const res = await post(branch, staff);
    expect(res.status).toBe(403);
    expect(businessMock.create).not.toHaveBeenCalled();
  });

  /**
   * A token outlives its account by up to seven days. Creating a business for
   * a user who no longer exists would strand it — reachable by nobody, and
   * holding its slug forever. Same compensating delete as registration.
   */
  it('rolls the business back when the owner no longer exists', async () => {
    userMock.findByIdAndUpdate.mockResolvedValue(null);

    const res = await post(branch);
    expect(res.status).toBe(401);
    expect(businessMock.deleteOne).toHaveBeenCalledWith({ _id: BRANCH });
  });

  it('rejects a missing name and says which field', async () => {
    const res = await post({ ...branch, businessName: '  ' });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { fields: Record<string, string> };
    expect(body.fields.businessName).toBeTruthy();
    expect(businessMock.create).not.toHaveBeenCalled();
  });

  it('rejects a category the backend does not serve', async () => {
    const res = await post({ ...branch, category: 'restaurant' });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { fields: Record<string, string> };
    expect(body.fields.category).toBeTruthy();
  });
});
