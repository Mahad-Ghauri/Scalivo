import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderEvent } from '@scalivo/shared';
import { z } from 'zod';
import { infraReady } from './infra.js';
import { Business } from '../src/models/Business.js';
import { Client } from '../src/models/Client.js';
import { ClientProfile } from '../src/models/ClientProfile.js';
import { User } from '../src/models/User.js';
import { createAuthRouter } from '../src/auth/routes.js';
import { createCrmRouter } from '../src/crm/routes.js';
import { signToken } from '../src/auth/jwt.js';
import { enqueueInbound, startInboundWorker } from '../src/messaging/inbound-queue.js';

const ready = await infraReady({ redis: true });
const redis = new Redis(process.env.REDIS_URL!, { lazyConnect: true, maxRetriesPerRequest: 1 });
const servers: ReturnType<express.Express['listen']>[] = [];
const BIZ = '65a000000000000000000031';

async function request(path: string, userId: string, init?: RequestInit) {
  const app = express();
  app.use('/auth', createAuthRouter(redis));
  app.use('/businesses', createCrmRouter());
  const server = app.listen(0);
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${signToken({ userId, role: 'owner', businessIds: [BIZ] })}`,
    },
    signal: AbortSignal.timeout(5000),
  });
}

afterAll(async () => {
  for (const server of servers) server.close();
  if (redis.status === 'ready') await redis.quit();
  else redis.disconnect();
  await mongoose.disconnect();
});

describe.skipIf(!ready)('audit regressions with isolated infrastructure', () => {
  beforeEach(async () => {
    if (redis.status === 'wait') await redis.connect();
    await redis.flushdb();
    await Promise.all([
      User.deleteMany({ email: { $in: ['a@example.test', 'b@example.test'] } }),
      Business.deleteMany({ slug: 'audit' }),
      Client.deleteMany({ displayName: /^(Audit \d+|Common name)$/ }),
      ClientProfile.deleteMany({ businessId: BIZ }),
    ]);
  });

  it('hides the gateway credential but permits explicit internal lookup', async () => {
    const b = await Business.create({
      slug: 'audit',
      name: 'Audit',
      category: 'salon',
      whatsapp: { apiKeyRef: 'private-test-key' },
    });
    expect(JSON.stringify(await Business.findById(b._id))).not.toContain('private-test-key');
    expect((await Business.findById(b._id).select('whatsapp.apiKeyRef'))?.whatsapp?.apiKeyRef).toBe(
      'private-test-key',
    );
  });

  it('moves a device to the new account and unregisters only the authenticated account', async () => {
    await User.init();
    const a = await User.create({
      email: 'a@example.test',
      passwordHash: 'test',
      role: 'owner',
      fcmTokens: ['device-test'],
    });
    const b = await User.create({ email: 'b@example.test', passwordHash: 'test', role: 'owner' });
    const register = await request('/auth/device', String(b._id), {
      method: 'POST',
      body: JSON.stringify({ fcmToken: 'device-test' }),
    });
    expect(register.status).toBe(204);
    expect((await User.findById(a._id))?.fcmTokens).toEqual([]);
    expect((await User.findById(b._id))?.fcmTokens).toEqual(['device-test']);
    expect(
      (
        await request('/auth/device', String(a._id), {
          method: 'DELETE',
          body: JSON.stringify({ fcmToken: 'device-test' }),
        })
      ).status,
    ).toBe(204);
    expect((await User.findById(b._id))?.fcmTokens).toEqual(['device-test']);
    expect(
      (
        await request('/auth/device', String(b._id), {
          method: 'DELETE',
          body: JSON.stringify({ fcmToken: 'device-test' }),
        })
      ).status,
    ).toBe(204);
    expect((await User.findById(b._id))?.fcmTokens).toEqual([]);
  });

  it('rejects malformed or unbounded device tokens', async () => {
    for (const fcmToken of [null, 5, '', 'x'.repeat(4097), 'invalid token']) {
      expect(
        (
          await request('/auth/device', '65a000000000000000000032', {
            method: 'POST',
            body: JSON.stringify({ fcmToken }),
          })
        ).status,
      ).toBe(400);
    }
  });

  it('filters VIPs before pagination and reports the filtered total', async () => {
    const clients = await Client.insertMany(
      Array.from({ length: 60 }, (_, i) => ({ displayName: `Audit ${i}`, phone: null })),
    );
    await ClientProfile.insertMany(
      clients.map((client, i) => ({
        businessId: BIZ,
        clientId: String(client._id),
        totalVisits: i >= 55 ? 5 : 1,
        lastBookingAt: new Date(Date.now() - i * 1000),
      })),
    );
    const res = await request(`/businesses/${BIZ}/clients?tag=vip&limit=2&skip=2`, 'owner');
    const body = z
      .object({ total: z.number(), clients: z.array(z.object({ tags: z.array(z.string()) })) })
      .parse(await res.json());
    expect(res.status).toBe(200);
    expect(body.total).toBe(5);
    expect(body.clients).toHaveLength(2);
    expect(body.clients.every((c: { tags: string[] }) => c.tags.includes('vip'))).toBe(true);
  });

  it('does not truncate tenant search behind 500 other customers', async () => {
    await Client.insertMany(
      Array.from({ length: 501 }, () => ({ displayName: 'Common name', phone: null })),
    );
    const client = await Client.create({ displayName: 'Common name', phone: null });
    await ClientProfile.create({ businessId: BIZ, clientId: String(client._id) });
    const body = z
      .object({ total: z.number(), clients: z.array(z.object({ id: z.string() })) })
      .parse(await (await request(`/businesses/${BIZ}/clients?q=Common`, 'owner')).json());
    expect(body.total).toBe(1);
    expect(body.clients[0]?.id).toBe(String(client._id));
  });

  it('deduplicates inbound message IDs even when resolved contact metadata changes', async () => {
    const event: ProviderEvent = { kind: 'message', payload: {
      providerMessageId: 'same-message', sessionId: 'dedupe-session', contactPhone: null,
      contactLid: 'test@lid', body: 'hi', type: 'text', receivedAt: new Date(),
      fromMe: false, isGroup: false, displayName: null, hasMedia: false,
    } };
    await enqueueInbound(redis, [event]);
    await enqueueInbound(redis, [{ ...event, payload: { ...event.payload, displayName: 'Resolved name' } }]);
    expect(await redis.llen('webhook:pending')).toBe(1);
    await enqueueInbound(redis, [{ ...event, payload: { ...event.payload, providerMessageId: 'different-message' } }]);
    expect(await redis.llen('webhook:pending')).toBe(2);
  });

  it('stores duplicate verified events once, retries failure, and preserves their Date fields', async () => {
    const event: ProviderEvent = {
      kind: 'session-status',
      payload: { sessionId: 'audit-session', status: 'ready', occurredAt: new Date() },
    };
    await Promise.all([enqueueInbound(redis, [event]), enqueueInbound(redis, [event])]);
    expect(await redis.llen('webhook:pending')).toBe(1);
    const handle = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockImplementation(async (e: ProviderEvent) => {
        if (e.kind === 'session-status') expect(e.payload.occurredAt).toBeInstanceOf(Date);
      });
    const stop = startInboundWorker(redis, handle);
    try {
      await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(2), { timeout: 4000 });
      await vi.waitFor(async () => expect(await redis.llen('webhook:processing')).toBe(0));
    } finally {
      stop();
    }
  });

  it('retains a poison delivery for operator replay and allows later events through', async () => {
    const bad: ProviderEvent = {
      kind: 'session-status',
      payload: { sessionId: 'poison', status: 'ready', occurredAt: new Date() },
    };
    const good: ProviderEvent = {
      kind: 'session-status',
      payload: { sessionId: 'healthy', status: 'ready', occurredAt: new Date() },
    };
    await enqueueInbound(redis, [bad]);
    await enqueueInbound(redis, [good]);
    const handle = vi.fn(async (event: ProviderEvent) => {
      if (event.payload.sessionId === 'poison') throw new Error('permanent failure');
    });
    const stop = startInboundWorker(redis, handle);
    try {
      await vi.waitFor(() => expect(handle).toHaveBeenCalledTimes(6), { timeout: 8000 });
      expect(await redis.llen('webhook:failed')).toBe(1);
      expect(await redis.llen('webhook:pending')).toBe(0);
      expect(await redis.llen('webhook:processing')).toBe(0);
    } finally {
      stop();
    }
  }, 10000);

  it('refuses new inbound deliveries at capacity so the gateway can retry', async () => {
    await redis.lpush('webhook:pending', ...Array.from({ length: 1000 }, () => 'test'));
    await expect(
      enqueueInbound(redis, [
        {
          kind: 'session-status',
          payload: { sessionId: 'full', status: 'ready', occurredAt: new Date() },
        },
      ]),
    ).rejects.toThrow('capacity');
    expect(await redis.llen('webhook:pending')).toBe(1000);
  });
});
