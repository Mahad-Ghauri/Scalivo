import mongoose from 'mongoose';
import { Redis } from 'ioredis';

/**
 * Shared scaffolding for the infrastructure-backed suites.
 *
 * These tests need real MongoDB and Redis — `docker compose up -d mongo redis`
 * from the repo root. Without them a suite SKIPS rather than fails, so
 * `pnpm test` still runs on a laptop with nothing booted. A skip is not a pass,
 * and CI fails rather than skipping when required infrastructure is unavailable.
 */

export interface InfraNeeds {
  /**
   * The suite opens a transaction, so a standalone `mongod` is not enough.
   *
   * Checked explicitly rather than discovered at the first write, because a
   * standalone rejects transactions with an error that reads like a bug in the
   * booking code rather than a missing replica set.
   */
  replicaSet?: boolean;
  /** The suite uses holds, conversation state, or the outbound queue. */
  redis?: boolean;
  /** The suite touches the payments ledger. */
  postgres?: boolean;
}

/**
 * Is the infrastructure this suite actually needs available?
 *
 * Parameterised rather than one-size-fits-all, because the requirements really
 * do differ and collapsing them costs coverage in both directions: a CRM suite
 * that skips because Redis is down loses tests that never touch Redis, and a
 * concurrency suite that runs without a replica set fails confusingly instead
 * of skipping. Each caller states what it needs.
 */
export async function infraReady(needs: InfraNeeds = {}): Promise<boolean> {
  try {
    await mongoose.connect(process.env.MONGO_URI!, { serverSelectionTimeoutMS: 2000 });

    if (needs.replicaSet) {
      const info = (await mongoose.connection.db
        ?.admin()
        .command({ hello: 1, maxTimeMS: 2000 })) as {
        setName?: string;
      };
      if (!info?.setName) throw new Error('MongoDB replica set required');
    }

    if (needs.redis) {
      const probe = new Redis(process.env.REDIS_URL!, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        connectTimeout: 2000,
        commandTimeout: 2000,
        retryStrategy: () => null,
      });
      try {
        await probe.connect();
        await probe.ping();
      } finally {
        probe.disconnect();
      }
    }

    if (needs.postgres) {
      const { Client } = await import('pg');
      const probe = new Client({
        connectionString: process.env.POSTGRES_URL,
        connectionTimeoutMillis: 2000,
        query_timeout: 2000,
      });
      try {
        await probe.connect();
        await probe.query('SELECT 1');
      } finally {
        await probe.end();
      }
    }

    return true;
  } catch {
    if (process.env.CI === 'true')
      throw new Error(
        'Required test infrastructure is unavailable. Start MongoDB (replica set), Redis and PostgreSQL before running CI tests.',
      );
    return false;
  }
}

/**
 * Narrow a result instead of casting it.
 *
 * The casts these replace (`result as { hold: { token: string } }`) silently
 * asserted a shape the type never had — and one of them was wrong: it read
 * `booking._id`, which the shared Booking contract does not have. A cast cannot
 * fail, so the mismatch survived until the tests were typechecked at all.
 */
export function assertOk<T extends { ok: boolean }>(
  result: T,
  what: string,
): asserts result is Extract<T, { ok: true }> {
  if (!result.ok) throw new Error(`expected ${what} to succeed, got ${JSON.stringify(result)}`);
}

export function assertFailed<T extends { ok: boolean }>(
  result: T,
  what: string,
): asserts result is Extract<T, { ok: false }> {
  if (result.ok) throw new Error(`expected ${what} to fail, but it succeeded`);
}
