import { BOOKING_STATUS } from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { setBookingOutcome } from './outcome.js';
import { notifyClient, type NotifyDeps } from '../calendar/notify.js';
import { logger } from '../lib/logger.js';

export async function expireApprovalRequests(deps: NotifyDeps, now = new Date()): Promise<number> {
  const due = await Booking.find({
    status: BOOKING_STATUS.AWAITING_APPROVAL,
    approvalExpiresAt: { $lte: now },
  })
    .select('_id businessId clientId')
    .sort({ approvalExpiresAt: 1 })
    .limit(100)
    .lean()
    .maxTimeMS(5000);
  let expired = 0;
  for (const booking of due) {
    const result = await setBookingOutcome(
      String(booking._id),
      booking.businessId,
      BOOKING_STATUS.CANCELLED,
      { expectStatus: BOOKING_STATUS.AWAITING_APPROVAL, approvalDueBefore: now },
    );
    if (!result.ok) continue;
    expired++;
    await notifyClient(
      deps,
      booking.businessId,
      booking.clientId,
      'Your appointment request expired before approval. No appointment is confirmed. Please choose another time.',
    ).catch((err) =>
      logger.error({ err, bookingId: String(booking._id) }, 'could not notify approval expiry'),
    );
  }
  return expired;
}

export function startApprovalExpiryJob(deps: NotifyDeps): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    expireApprovalRequests(deps)
      .catch((err) => logger.error({ err }, 'approval expiry pass failed'))
      .finally(() => {
        running = false;
      });
  }, 60000);
  timer.unref();
  return () => clearInterval(timer);
}
