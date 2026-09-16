import type { HydratedDocument, InferSchemaType } from 'mongoose';
import {
  BOOKING_STATUS,
  DELIVERY_STATUS,
  NOTIFICATION_KIND,
  REMINDER_MAX_LATE_MINUTES,
  REMINDER_WAKING_HOURS,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Business } from '../models/Business.js';
import { Notification } from '../models/Notification.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';
import { addMinutes, toBusinessLocal } from '../lib/time.js';
import { isDuplicateKey } from '../lib/mongo.js';
import { logger } from '../lib/logger.js';
import * as copy from '../whatsapp/messages.js';
import { retryPending, sendTracked, type SendDeps } from './send.js';

/**
 * Firing reminders, once each.
 *
 * The naive version of this is a cron that asks "which appointments start
 * exactly one day from now?" and it is wrong in three separate ways that only
 * show up in production:
 *
 * 1. **It skips whatever it was down for.** A tick that looks at a
 *    tick-sized window has no memory, so an hour of downtime is an hour of
 *    appointments that are never reminded and nobody ever finds out.
 * 2. **It double-sends whenever it overlaps itself.** A slow pass still running
 *    when the next one starts reminds everyone twice.
 * 3. **It sends at 4am.** A two-hour lead on a 7am class computes to 5am local,
 *    and the customer's opinion of the business is formed by the notification,
 *    not by the appointment.
 *
 * So the window is wide and the claim is what stops duplicates — the same
 * never-check-then-write discipline the booking grid runs on, with a unique
 * dedupeKey instead of a unique slot. A pass that has been down for six hours
 * catches up on everything it missed and still sends each reminder exactly once;
 * anything too stale to be worth sending is recorded as skipped rather than
 * fired hours out of place.
 *
 * Single instance, like the reconcile job and for the same reason: two of these
 * would not double-send (the index sees to that) but they would double the load
 * and halve the clarity of the logs.
 */

const INTERVAL_MS = 60 * 1000;

/**
 * When a reminder should actually go out.
 *
 * The lead itself is timezone-free — an instant minus minutes is the same
 * instant in Karachi and in New York — so the only business-local thing here is
 * the waking-hours clamp, and it moves in ONE direction. Pulling back to 21:00
 * the evening before is guaranteed still to be before the appointment, because
 * it only ever moves earlier; pushing forward to 08:00 could easily land after
 * it, which is a reminder that is worse than none.
 */
export function reminderDueAt(startsAt: Date, leadMinutes: number, timezone: string): Date {
  const due = addMinutes(startsAt, -leadMinutes);
  const local = toBusinessLocal(due, timezone);

  if (local.hour >= REMINDER_WAKING_HOURS.FROM && local.hour < REMINDER_WAKING_HOURS.UNTIL) {
    return due;
  }

  // Before the morning boundary means the quiet stretch began the previous
  // evening; at or after the evening boundary it began today.
  const eveningOf =
    local.hour < REMINDER_WAKING_HOURS.FROM ? local.minus({ days: 1 }) : local;

  return eveningOf
    .set({ hour: REMINDER_WAKING_HOURS.UNTIL, minute: 0, second: 0, millisecond: 0 })
    .toJSDate();
}

export async function remindersOnce(deps: SendDeps, now = new Date()): Promise<void> {
  // Not filtered on `reminders.enabled` here: remindBusiness checks it, and
  // every business still needs its retry pass — a confirmation owed from an
  // outage is not a reminder, and switching reminders off must not strand it.
  const businesses = await Business.find({});

  for (const business of businesses) {
    try {
      await remindBusiness(deps, business, now);
    } catch (err) {
      // One business's bad data must not stop every other business's reminders.
      logger.error({ err, businessId: String(business._id) }, 'reminder pass failed');
    }
  }
}

/**
 * Spelled out rather than inferred from `findById`, whose `T | null` return
 * collapses under `Awaited<ReturnType<…>>` to `{}` — a type that accepts every
 * field access and catches none of them. Same pattern as toBooking in
 * bookings/create.ts.
 */
type BusinessDoc = HydratedDocument<InferSchemaType<typeof Business.schema>>;

/**
 * One business's due reminders, plus whatever it still owes from an outage.
 *
 * Exported because `remindersOnce` is a loop over every tenant and the tests
 * need one: driving the global pass against a shared database means another
 * suite's bookings come due mid-assertion, and the resulting failures look like
 * duplicate sends rather than the parallelism they are.
 */
export async function remindBusiness(
  deps: SendDeps,
  business: BusinessDoc,
  now: Date,
): Promise<void> {
  const businessId = String(business._id);
  const leads = (business.reminders?.leadMinutes ?? []).filter((m) => Number.isFinite(m) && m > 0);

  /**
   * The retry pass runs for every business on every tick, reminders configured
   * or not. It is the safety net under Session Health's drain-on-recovery: if
   * the `ready` webhook never arrived — the gateway restarted, we were down for
   * the delivery and its retries — a confirmation owed since yesterday would
   * otherwise sit QUEUED forever with nothing scheduled to notice.
   */
  await retryPending(deps, businessId);

  // Checked HERE rather than in the caller's query, so that the setting cannot
  // be bypassed by reaching this function directly. A business that turned
  // reminders off has said something; one caller honouring it is not enough.
  if (business.reminders?.enabled === false) return;

  if (leads.length === 0) return;

  const horizon = addMinutes(now, Math.max(...leads));

  /**
   * Everything that could plausibly be due, in one query.
   *
   * `startsAt > now` is what keeps a catch-up pass from reminding people about
   * appointments that have already happened. The upper bound is the longest
   * configured lead, because a reminder is due once `startsAt - lead <= now` and
   * the clamp only ever moves that earlier.
   */
  const bookings = await Booking.find({
    businessId,
    startsAt: { $gt: now, $lte: horizon },
    status: { $in: [BOOKING_STATUS.PENDING, BOOKING_STATUS.CONFIRMED] },
  }).sort({ startsAt: 1 });

  if (bookings.length === 0) return;

  /**
   * Which of these have already been claimed.
   *
   * Strictly an optimisation — the unique index is the actual guard, and
   * sendTracked handles the collision correctly on its own. Without it, every
   * tick would fire a doomed insert for every booking inside the horizon, which
   * on a busy month is thousands of pointless duplicate-key errors an hour and a
   * log nobody can read.
   */
  const claimed = new Set(
    (
      await Notification.find({
        businessId,
        kind: NOTIFICATION_KIND.REMINDER,
        bookingId: { $in: bookings.map((b) => String(b._id)) },
      }).select('dedupeKey')
    ).map((n) => n.dedupeKey),
  );

  for (const booking of bookings) {
    const bookingId = String(booking._id);

    for (const lead of leads) {
      const dedupeKey = `${bookingId}:reminder:${lead}`;
      if (claimed.has(dedupeKey)) continue;

      const dueAt = reminderDueAt(booking.startsAt, lead, business.timezone);
      if (dueAt > now) continue;

      /**
       * Too late to be useful.
       *
       * Covers two cases with one rule: a process that was down over the send
       * moment, and a booking made after its own reminder was already due — a
       * customer booking tomorrow morning at 11pm tonight has a 24-hour reminder
       * whose moment passed before the appointment existed. Both are recorded as
       * skipped, which is a claim, so neither is reconsidered on the next tick.
       */
      if (now.getTime() - dueAt.getTime() > REMINDER_MAX_LATE_MINUTES * 60_000) {
        try {
          await Notification.create({
            businessId,
            clientId: booking.clientId,
            bookingId,
            kind: NOTIFICATION_KIND.REMINDER,
            dedupeKey,
            // No text: nothing was composed, and writing the message we would
            // have sent would suggest it went out.
            scheduledFor: dueAt,
            status: DELIVERY_STATUS.SKIPPED,
            lastError: 'the moment to send it had passed',
          });
        } catch (err) {
          // Only a concurrent tick getting there first is expected here.
          // A blanket catch would swallow a schema error and leave the reminder
          // silently unclaimed — reconsidered, and refused, once a minute forever.
          if (!isDuplicateKey(err)) throw err;
        }
        continue;
      }

      const [service, staff] = await Promise.all([
        Service.findById(booking.serviceId).select('name'),
        Staff.findById(booking.staffId).select('name'),
      ]);

      const text = copy.reminder({
        businessName: business.name,
        serviceName: service?.name ?? 'your appointment',
        staffName: staff?.name ?? 'our team',
        startsAt: booking.startsAt,
        timezone: business.timezone,
        sameDay:
          toBusinessLocal(booking.startsAt, business.timezone).toISODate() ===
          toBusinessLocal(now, business.timezone).toISODate(),
      });

      await sendTracked(deps, {
        businessId,
        clientId: booking.clientId,
        bookingId,
        kind: NOTIFICATION_KIND.REMINDER,
        dedupeKey,
        text,
        scheduledFor: dueAt,
      });
    }
  }
}

/**
 * Start the loop. Returns a stop function, as the reconcile job does, so tests
 * and shutdown can end it rather than waiting a minute for a timer nobody owns.
 */
export function startReminderJob(deps: SendDeps): () => void {
  const run = () => {
    remindersOnce(deps).catch((err) => logger.error({ err }, 'reminder tick failed'));
  };

  const timer = setInterval(run, INTERVAL_MS);
  // Without unref a finished container lingers for up to a minute on this timer.
  timer.unref();

  return () => clearInterval(timer);
}
