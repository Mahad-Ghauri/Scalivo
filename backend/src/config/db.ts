import mongoose from 'mongoose';
import { Redis } from 'ioredis';
import { Pool } from 'pg';
import { env } from './env.js';
import { logger } from '../lib/logger.js';
import { CapacityOccupancy } from '../models/CapacityOccupancy.js';
import { Resource } from '../models/Resource.js';
import { AppointmentHolder } from '../models/AppointmentHolder.js';
import { Booking } from '../models/Booking.js';
import { BlockedTime } from '../models/BlockedTime.js';
import { BookingAudit } from '../models/BookingAudit.js';
import { ActivityLog } from '../models/ActivityLog.js';

mongoose.set('maxTimeMS', 10000);

export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: 2,
  connectTimeout: 5000,
  commandTimeout: 10000,
  lazyConnect: true,
});

export const postgres = new Pool({
  connectionString: env.POSTGRES_URL,
  connectionTimeoutMillis: 5000,
  query_timeout: 10000,
  statement_timeout: 10000,
  max: 10,
});

export async function connectAll(): Promise<void> {
  await Promise.all([
    mongoose.connect(env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 15000,
      maxPoolSize: 20,
    }),
    redis.connect(),
    postgres.query('SELECT 1'),
  ]);
  await assertReplicaSet();
  // Additive index creation; reservations must not start without their arbiters.
  await Promise.all([
    CapacityOccupancy.createIndexes(),
    Resource.createIndexes(),
    AppointmentHolder.createIndexes(),
    BookingAudit.createIndexes(),
    ActivityLog.createIndexes(),
    Booking.createIndexes(),
    BlockedTime.createIndexes(),
  ]);
  logger.info('all datastores connected');
}

/**
 * Booking writes span a slotOccupancy insert and a booking insert in one
 * transaction — that transaction IS the overlap arbiter. MongoDB only offers
 * transactions on a replica set, and a standalone mongod fails every booking
 * with "Transaction numbers are only allowed on a replica set".
 *
 * Failing at boot with a clear message beats discovering it when the first
 * customer tries to book. Returns the set name so /health can report it.
 */
export async function assertReplicaSet(): Promise<string> {
  if (mongoose.connection.readyState !== 1) throw new Error('not connected');

  const admin = mongoose.connection.db?.admin();
  if (!admin) throw new Error('Mongo connection not ready');

  const info = (await admin.command({ hello: 1 })) as { setName?: string };
  if (!info.setName) {
    throw new Error(
      'MongoDB is running standalone, not as a replica set. Booking transactions ' +
        'will fail. Use the local docker-compose stack (initiates rs0) or an Atlas cluster.',
    );
  }
  return info.setName;
}

export interface HealthReport {
  ok: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

export async function healthCheck(): Promise<HealthReport> {
  const checks: HealthReport['checks'] = {};

  checks.mongo = await probe(async () => `replicaSet=${await assertReplicaSet()}`);

  checks.redis = await probe(async () => {
    const failed = await redis.llen('webhook:failed');
    if (failed > 0) throw new Error(`${failed} inbound deliveries require operator replay`);
    return await redis.ping();
  });
  checks.postgres = await probe(async () => {
    await postgres.query('SELECT 1');
    return 'ok';
  });

  checks.openwa = await probe(async () => {
    const res = await fetch(new URL('/api/health', env.OPENWA_BASE_URL), {
      headers: { 'X-API-Key': env.OPENWA_API_KEY },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return 'ok';
  });

  return { ok: Object.values(checks).every((c) => c.ok), checks };
}

async function probe(fn: () => Promise<string>): Promise<{ ok: boolean; detail?: string }> {
  try {
    return { ok: true, detail: await fn() };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
