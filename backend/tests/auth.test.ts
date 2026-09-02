import type { AddressInfo } from 'node:net';
import express from 'express';
import type { InboundMessage, MessagingProvider } from '@scalivo/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signToken, verifyToken } from '../src/auth/jwt.js';
import { assertTenantAccess, TenantAccessError } from '../src/auth/middleware.js';
import { resolvePhone } from '../src/auth/identity.js';

const BIZ_A = '65a000000000000000000001';
const BIZ_B = '65a000000000000000000002';

describe('tokens', () => {
  it('round-trips role and tenant scope', () => {
    const token = signToken({ userId: 'u1', role: 'owner', businessIds: [BIZ_A] });
    expect(verifyToken(token)).toMatchObject({ userId: 'u1', role: 'owner', businessIds: [BIZ_A] });
  });

  it('rejects a tampered token', () => {
    const token = signToken({ userId: 'u1', role: 'owner', businessIds: [BIZ_A] });
    // Flip the payload segment; the signature no longer covers it.
    const [head, , sig] = token.split('.');
    const forged = `${head}.${Buffer.from('{"userId":"u1","role":"admin"}').toString('base64url')}.${sig}`;

    expect(() => verifyToken(forged)).toThrow();
  });

  it('rejects a token signed with a different secret', () => {
    expect(() => verifyToken('eyJhbGciOiJIUzI1NiJ9.eyJ1c2VySWQiOiJ4In0.nope')).toThrow();
  });
});

describe('tenant scoping', () => {
  const ownerOfA = { userId: 'u1', role: 'owner' as const, businessIds: [BIZ_A] };

  it('allows an owner into their own business', () => {
    expect(() => assertTenantAccess(ownerOfA, BIZ_A)).not.toThrow();
  });

  it('refuses an owner access to another business', () => {
    expect(() => assertTenantAccess(ownerOfA, BIZ_B)).toThrow(TenantAccessError);
  });

  it('lets admins cross tenants by design', () => {
    const admin = { userId: 'a1', role: 'admin' as const, businessIds: [] };
    expect(() => assertTenantAccess(admin, BIZ_B)).not.toThrow();
  });

  it('refuses a token carrying no businesses at all', () => {
    const orphan = { userId: 'u2', role: 'staff' as const, businessIds: [] };
    expect(() => assertTenantAccess(orphan, BIZ_A)).toThrow(TenantAccessError);
  });
});

/**
 * The Phase 0 definition of done: "an owner token for business A cannot read
 * business B's data." Proven end-to-end over HTTP, with the model stubbed to
 * return a business for ANY id — so the only thing that can produce a 403 is
 * the scope check, and the assertion that the model was never called proves the
 * refusal happened before the read, not after.
 */
const findById = vi.fn(async () => ({ _id: BIZ_B, name: 'CrossFit Multan' }));
vi.mock('../src/models/Business.js', () => ({ Business: { findById: () => findById() } }));

/**
 * The router takes a provider for the WhatsApp linking routes. None of these
 * tests reach them — a scope check must refuse before anything downstream runs,
 * which is the whole point — so a bare stub is the honest stand-in here.
 */
const stubProvider = {} as unknown as MessagingProvider;

describe('cross-tenant reads over HTTP', () => {
  const servers: ReturnType<express.Express['listen']>[] = [];
  afterEach(() => {
    servers.forEach((s) => s.close());
    findById.mockClear();
  });

  async function get(businessId: string, token: string) {
    const { createBusinessRouter } = await import('../src/businesses/routes.js');
    const app = express();
    app.use('/businesses', createBusinessRouter(stubProvider));

    const server = app.listen(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    return fetch(`http://127.0.0.1:${port}/businesses/${businessId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  it('serves an owner their own business', async () => {
    const token = signToken({ userId: 'u1', role: 'owner', businessIds: [BIZ_A] });
    const res = await get(BIZ_A, token);

    expect(res.status).toBe(200);
    expect(findById).toHaveBeenCalledOnce();
  });

  it('403s business B for business A\'s owner, without querying', async () => {
    const token = signToken({ userId: 'u1', role: 'owner', businessIds: [BIZ_A] });
    const res = await get(BIZ_B, token);

    expect(res.status).toBe(403);
    expect(findById).not.toHaveBeenCalled();
  });

  it('401s with no token', async () => {
    const app = express();
    const { createBusinessRouter } = await import('../src/businesses/routes.js');
    app.use('/businesses', createBusinessRouter(stubProvider));
    const server = app.listen(0);
    servers.push(server);
    const { port } = server.address() as AddressInfo;

    const res = await fetch(`http://127.0.0.1:${port}/businesses/${BIZ_A}`);
    expect(res.status).toBe(401);
    expect(findById).not.toHaveBeenCalled();
  });
});

describe('LID to phone resolution', () => {
  const message = (over: Partial<InboundMessage> = {}): InboundMessage => ({
    providerMessageId: 'm1',
    sessionId: 's1',
    contactPhone: null,
    contactLid: '1774039625903@lid',
    body: 'hi',
    type: 'text',
    receivedAt: new Date(),
    fromMe: false,
    isGroup: false,
    displayName: 'Ghauri',
    hasMedia: false,
    ...over,
  });

  const fakeProvider = (phone: string | null): MessagingProvider =>
    ({ resolveContactPhone: vi.fn(async () => phone) }) as unknown as MessagingProvider;

  it('uses senderPhone without calling the fallback', async () => {
    const provider = fakeProvider('923000000000');
    const phone = await resolvePhone(provider, message({ contactPhone: '923102027781' }));

    expect(phone).toBe('923102027781');
    expect(provider.resolveContactPhone).not.toHaveBeenCalled();
  });

  it('falls back to the on-demand lookup when senderPhone is absent', async () => {
    // RESOLVE_LID_TO_PHONE off, or a payload that simply lacked it.
    const provider = fakeProvider('923102027781');
    expect(await resolvePhone(provider, message())).toBe('923102027781');
    expect(provider.resolveContactPhone).toHaveBeenCalledWith('s1', '1774039625903@lid');
  });

  it('returns null rather than throwing when both paths fail', async () => {
    // Must degrade to an unmatched contact — never a dropped message.
    expect(await resolvePhone(fakeProvider(null), message())).toBeNull();
  });
});
