import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_STATUS, type MessagingProvider } from '@scalivo/shared';
import { Business } from '../src/models/Business.js';
import { VERIFICATION_BUSINESS_LIMITS, beginVerification } from '../src/public/verification.js';
import { infraReady } from './infra.js';

/**
 * Phase 4.2 review: web verification messages a stranger's number from the
 * business's own WhatsApp. Per-IP and per-number limits stop one caller; this
 * cap stops many callers, each with fresh numbers, from getting the business's
 * number reported as spam.
 */

const ready = await infraReady({ redis: true });

describe.skipIf(!ready)('verification: per-business send cap', () => {
  let redis: Redis;
  let businessId: string;
  let otherId: string;
  let sent = 0;
  const provider = {
    sendText: async () => {
      sent += 1;
      return { providerMessageId: 'x', acceptedAt: new Date() };
    },
    getSessionStatus: async () => SESSION_STATUS.READY,
  } as unknown as MessagingProvider;

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL!, { db: 11 });
    await redis.flushdb();
    const stamp = Date.now();
    const [a, b] = await Business.create([
      {
        name: 'Cap A',
        slug: `cap-a-${stamp}`,
        category: 'salon',
        whatsapp: { sessionId: 'cap-a' },
      },
      {
        name: 'Cap B',
        slug: `cap-b-${stamp}`,
        category: 'salon',
        whatsapp: { sessionId: 'cap-b' },
      },
    ]);
    businessId = String(a!._id);
    otherId = String(b!._id);
  });

  afterAll(async () => {
    await Business.deleteMany({ _id: { $in: [businessId, otherId] } });
    await Promise.all([mongoose.disconnect(), redis.quit()]);
  });

  it('stops after the hourly cap even with a fresh number every time, per business', async () => {
    const phone = (i: number) => `92301${String(i).padStart(7, '0')}`;
    const results = [];
    for (let i = 0; i <= VERIFICATION_BUSINESS_LIMITS.perHour; i++) {
      results.push(await beginVerification(redis, provider, businessId, phone(i)));
    }
    expect(results.slice(0, -1).every((r) => r.ok)).toBe(true);
    expect(results.at(-1)).toEqual({ ok: false, reason: 'rate_limited' });
    expect(sent).toBe(VERIFICATION_BUSINESS_LIMITS.perHour);

    // Another business is unaffected.
    expect((await beginVerification(redis, provider, otherId, phone(999))).ok).toBe(true);
  });
});
