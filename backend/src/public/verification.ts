import { createHmac, randomInt, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { MessagingProvider } from '@scalivo/shared';
import { z } from 'zod';
import { env } from '../config/env.js';
import { Business } from '../models/Business.js';
import { normalisePhone } from '../lib/phone.js';

const TTL = 300;
function parseStored(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
const digest = (value: string) => createHmac('sha256', env.JWT_SECRET).update(value).digest('hex');
const challengeSchema = z.object({
  businessId: z.string(),
  phone: z.string(),
  clientId: z.string().optional(),
  hash: z.string(),
  verified: z.boolean(),
});
const ATTEMPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local challenge = cjson.decode(raw)
if challenge.businessId ~= ARGV[1] then return 0 end
local attempts = redis.call('INCR', KEYS[2])
if attempts == 1 then redis.call('EXPIRE', KEYS[2], 300) end
if attempts > 5 then redis.call('DEL', KEYS[1]); return 0 end
if challenge.hash ~= ARGV[2] then return 0 end
challenge.verified = true
redis.call('SET', KEYS[1], cjson.encode(challenge), 'KEEPTTL')
return 1
`;

export async function beginVerification(
  redis: Redis,
  provider: MessagingProvider,
  businessId: string,
  rawPhone: string | null,
  identity?: { clientId: string; lid: string | null },
) {
  const phone = normalisePhone(rawPhone ?? '');
  if (!phone && !identity?.lid) return { ok: false as const, reason: 'invalid_phone' };
  const business = await Business.findById(businessId)
    .select('whatsapp.sessionId whatsapp.phone')
    .lean()
    .maxTimeMS(5000);
  const sessionId = business?.whatsapp?.sessionId;
  if (!sessionId) return { ok: false as const, reason: 'unavailable' };
  const phoneKey = digest(`${businessId}:${phone ?? identity!.clientId}`);
  if (!(await redis.set(`verification:cooldown:${phoneKey}`, '1', 'EX', 60, 'NX')))
    return { ok: false as const, reason: 'rate_limited' };
  const count = await redis.eval(
    `local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], 3600) end; return n`,
    1,
    `verification:limit:${phoneKey}`,
  );
  if (typeof count !== 'number' || count > 5) return { ok: false as const, reason: 'rate_limited' };
  const challengeId = randomUUID();
  const code = String(randomInt(100000, 1000000));
  await redis.set(
    `verification:challenge:${challengeId}`,
    JSON.stringify({
      businessId,
      phone: phone ?? '',
      ...(identity ? { clientId: identity.clientId } : {}),
      hash: digest(`${challengeId}:${code}`),
      verified: false,
    }),
    'EX',
    TTL,
  );
  let accepted = false;
  try {
    await provider.sendText(
      sessionId,
      identity?.lid ?? phone!,
      `Your Scalivo verification code is ${code}. It expires in 5 minutes. Do not share it. If you did not request this, ignore it.`,
    );
    accepted = true;
  } catch {
    /* Cold-contact delivery is uncertain; the initiation link proves inbound ownership. */
  }
  return {
    ok: true as const,
    challengeId,
    expiresInSeconds: TTL,
    accepted,
    whatsappUrl: business?.whatsapp?.phone
      ? `https://wa.me/${business.whatsapp.phone}?text=${encodeURIComponent(`VERIFY ${challengeId}`)}`
      : null,
  };
}

export async function finishVerification(
  redis: Redis,
  businessId: string,
  challengeId: string,
  code?: string,
) {
  const key = `verification:challenge:${challengeId}`;
  if (code)
    await redis.eval(
      ATTEMPT,
      2,
      key,
      `${key}:attempts`,
      businessId,
      digest(`${challengeId}:${code}`),
    );
  const raw = await redis.get(key);
  if (!raw) return null;
  const parsed = challengeSchema.safeParse(parseStored(raw));
  if (!parsed.success || parsed.data.businessId !== businessId || !parsed.data.verified)
    return null;
  const proof = createHmac('sha256', env.JWT_SECRET)
    .update(`proof:${challengeId}`)
    .digest('base64url')
    .slice(0, 32);
  await redis.set(
    `verification:proof:${proof}`,
    JSON.stringify({
      businessId,
      phone: parsed.data.phone,
      ...(parsed.data.clientId ? { clientId: parsed.data.clientId } : {}),
    }),
    'EX',
    900,
  );
  return proof;
}

/** Called only after the signed webhook has resolved the actual sender identity. */
export async function verifyInboundChallenge(
  redis: Redis,
  businessId: string,
  phone: string | null,
  body: string,
  clientId?: string,
): Promise<boolean> {
  const match = /^VERIFY ([a-f\d-]{36})$/i.exec(body.trim());
  if (!match) return false;
  const key = `verification:challenge:${match[1]}`;
  const raw = await redis.get(key);
  if (!raw) return true;
  const challenge = challengeSchema.safeParse(parseStored(raw));
  if (
    !challenge.success ||
    challenge.data.businessId !== businessId ||
    (challenge.data.clientId
      ? challenge.data.clientId !== clientId
      : !phone || challenge.data.phone !== normalisePhone(phone))
  )
    return true;
  // Compare-and-set preserves expiry and prevents recreation after expiration.
  await redis.eval(
    `local raw = redis.call('GET', KEYS[1]); if raw ~= ARGV[1] then return 0 end; local c = cjson.decode(raw); c.verified = true; redis.call('SET', KEYS[1], cjson.encode(c), 'KEEPTTL'); return 1`,
    1,
    key,
    raw,
  );
  return true;
}

export async function verifiedPhone(
  redis: Redis,
  businessId: string,
  proof: string,
): Promise<string | null> {
  return (await verifiedContact(redis, businessId, proof))?.phone || null;
}

export async function verifiedContact(redis: Redis, businessId: string, proof: string) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(proof)) return null;
  const raw = await redis.get(`verification:proof:${proof}`);
  if (!raw) return null;
  const parsed = z
    .object({ businessId: z.string(), phone: z.string(), clientId: z.string().optional() })
    .safeParse(parseStored(raw));
  return parsed.success && parsed.data.businessId === businessId ? parsed.data : null;
}
