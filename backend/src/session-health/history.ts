import type { SessionStatus } from '@scalivo/shared';
import { SessionEvent } from '../models/SessionEvent.js';
import { logger } from '../lib/logger.js';

/**
 * The append-only record behind the session uptime metric. See
 * models/SessionEvent.ts for why a single overwritten status field could not
 * produce it.
 */

export interface TransitionInput {
  businessId: string;
  sessionId: string | null | undefined;
  status: SessionStatus;
  /** As stored on the business BEFORE this event was applied. */
  previousStatus: string | null | undefined;
  intent: string;
  source: 'webhook' | 'reconcile';
  occurredAt: Date;
}

/**
 * Write one row, if and only if the status actually changed.
 *
 * Call this BEFORE updating the business document — it needs the old status to
 * decide whether anything happened, and reading it back afterwards would always
 * compare a value against itself.
 *
 * **Never throws.** Every caller is on the path that alerts an owner their
 * business cannot take bookings. A history write failing is a gap in a metric;
 * letting it propagate would turn that into a missed alarm, which is the thing
 * Session Health exists to prevent. The failure is logged loudly instead,
 * because a silently empty collection would not be discovered until someone
 * tried to compute uptime from it months later.
 */
export async function recordTransition(input: TransitionInput): Promise<void> {
  // Nothing changed. The reconcile poll reaches here every five minutes with
  // the same 'ready' it saw last time, and FINDING #2's qr-then-status pair
  // reaches here twice ~4ms apart for one outage.
  if (input.status === input.previousStatus) return;

  // No session to attribute it to. A business that has never linked has no
  // uptime to measure — its downtime is "not set up yet", which the setup
  // checklist covers and which must not be averaged in as an outage.
  if (!input.sessionId) return;

  try {
    await SessionEvent.create({
      businessId: input.businessId,
      sessionId: input.sessionId,
      status: input.status,
      previousStatus: input.previousStatus ?? null,
      intent: input.intent,
      source: input.source,
      occurredAt: input.occurredAt,
    });
  } catch (err) {
    logger.error(
      { err, businessId: input.businessId, status: input.status },
      'could not record a session transition — uptime history now has a gap',
    );
  }
}
