import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ProviderEvent } from '@scalivo/shared';
import { logger } from '../lib/logger.js';

const PENDING = 'webhook:pending';
const PROCESSING = 'webhook:processing';
const FAILED = 'webhook:failed';
const ATTEMPTS = 'webhook:attempts';
const MAX_PENDING = 1000;

/** Store before acknowledging. The single backend worker preserves arrival order. */
export async function enqueueInbound(redis: Redis, events: ProviderEvent[]): Promise<void> {
  if (events.length === 0) return;
  const payload = JSON.stringify(events);
  // Derived from verified provider data, never the unsigned delivery header.
  const identity = JSON.stringify(events.map((event) => event.kind === 'message'
    ? { kind: event.kind, sessionId: event.payload.sessionId, messageId: event.payload.providerMessageId }
    : event));
  const key = `webhook:seen:${createHash('sha256').update(identity).digest('hex')}`;
  const result = await redis.eval(
    `if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
     if redis.call('LLEN', KEYS[1]) + redis.call('LLEN', KEYS[2]) + redis.call('LLEN', KEYS[4]) >= tonumber(ARGV[2]) then return -1 end
     redis.call('LPUSH', KEYS[1], ARGV[1])
     redis.call('SET', KEYS[3], '1', 'EX', 86400)
     return 1`,
    4,
    PENDING,
    PROCESSING,
    key,
    FAILED,
    payload,
    MAX_PENDING,
  );
  if (result === -1) throw new Error('inbound queue capacity reached');
}

/** Same single-instance deployment requirement as the existing reminder jobs. */
export function startInboundWorker(
  redis: Redis,
  onEvent: (event: ProviderEvent) => Promise<void>,
): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    let raw: string | null = null;
    let id: string | undefined;
    try {
      // Leave a failed/crashed turn in place; retry it before newer turns.
      raw = (await redis.lindex(PROCESSING, 0)) ?? (await redis.rpoplpush(PENDING, PROCESSING));
      if (!raw) return;
      id = createHash('sha256').update(raw).digest('hex');
      const events = JSON.parse(raw, (key: string, value: unknown) =>
        (key === 'receivedAt' || key === 'occurredAt') && typeof value === 'string'
          ? new Date(value)
          : value,
      ) as ProviderEvent[];
      for (const event of events) await onEvent(event);
      await redis.multi().lrem(PROCESSING, 1, raw).hdel(ATTEMPTS, id).exec();
    } catch (err) {
      logger.error({ err, id }, 'inbound turn retained for retry');
      if (raw && id) {
        try {
          if ((await redis.hincrby(ATTEMPTS, id, 1)) >= 5) {
            // Retain poison deliveries for investigation; do not block every tenant.
            await redis
              .multi()
              .rpush(FAILED, raw)
              .lrem(PROCESSING, 1, raw)
              .hdel(ATTEMPTS, id)
              .exec();
            logger.error({ id }, 'inbound turn requires operator replay from webhook:failed');
          }
        } catch (retryError) {
          logger.error({ err: retryError, id }, 'could not record inbound retry');
        }
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), 1000);
  timer.unref();
  return () => clearInterval(timer);
}
