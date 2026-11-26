import type { HydratedDocument, InferSchemaType } from 'mongoose';
import {
  BOOKING_STATUS,
  FOLLOW_UP_NUDGE_AFTER_DAYS,
  FOLLOW_UP_OFFER_DAYS_BEFORE,
  FOLLOW_UP_STATUS,
  NOTIFICATION_KIND,
  REMINDER_WAKING_HOURS,
} from '@scalivo/shared';
import { Booking } from '../models/Booking.js';
import { Business } from '../models/Business.js';
import { Client } from '../models/Client.js';
import { ClientProfile } from '../models/ClientProfile.js';
import { Service } from '../models/Service.js';
import { Staff } from '../models/Staff.js';
import { nextAvailable } from '../bookings/availability.js';
import { sendTracked, type SendDeps } from '../notifications/send.js';
import { PUSH_CHANNEL, pushToOwners } from '../push/fcm.js';
import { toBusinessLocal } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import * as copy from '../whatsapp/messages.js';
import { writePendingPrompt } from '../whatsapp/state.js';

/**
 * Walking each follow-up forward.
 *
 *   scheduled ──(visit completed, due in ≤3 days)──▶ offered
 *   offered   ──(3 days silent)──▶ nudged ──(3 days silent)──▶ lapsed
 *   any open  ──(customer has a later booking for that service)──▶ booked
 *   scheduled ──(visit cancelled / no-show)──▶ cancelled
 *
 * Every transition is a conditional update on the current status, so two
 * overlapping ticks cannot both send: the loser's update matches nothing. The
 * message itself is also a Notification claim with a unique dedupeKey.
 */

const INTERVAL_MS = 5 * 60 * 1000;
const DAY = 86_400_000;
const OPEN = [FOLLOW_UP_STATUS.SCHEDULED, FOLLOW_UP_STATUS.OFFERED, FOLLOW_UP_STATUS.NUDGED];

type BookingDoc = HydratedDocument<InferSchemaType<typeof Booking.schema>>;
type BusinessDoc = HydratedDocument<InferSchemaType<typeof Business.schema>>;

export async function followUpsOnce(deps: SendDeps, now = new Date()): Promise<void> {
  const businessIds: string[] = await Booking.distinct('businessId', {
    'followUp.status': { $in: OPEN },
  });
  for (const businessId of businessIds) {
    try {
      await followUpsForBusiness(deps, businessId, now);
    } catch (err) {
      logger.error({ err, businessId }, 'follow-up pass failed');
    }
  }
}

export async function followUpsForBusiness(
  deps: SendDeps,
  businessId: string,
  now: Date,
): Promise<void> {
  const business = await Business.findById(businessId);
  if (!business) return;

  const rows = await Booking.find({ businessId, 'followUp.status': { $in: OPEN } }).limit(500);
  for (const booking of rows) {
    await step(deps, business, booking, now);
  }
}

async function step(deps: SendDeps, business: BusinessDoc, booking: BookingDoc, now: Date) {
  const f = booking.followUp!;
  const status = f.status;

  // 1. The visit never happened.
  if (booking.status === BOOKING_STATUS.CANCELLED || booking.status === BOOKING_STATUS.NO_SHOW) {
    await move(booking, status, { status: FOLLOW_UP_STATUS.CANCELLED, closedAt: now });
    return;
  }

  // 2. Already booked — by WhatsApp, the web, or the owner. Checked first so
  //    nobody is offered a slot for something already in their calendar.
  const later = await Booking.findOne({
    businessId: booking.businessId,
    clientId: booking.clientId,
    serviceId: f.serviceId,
    _id: { $ne: booking._id },
    startsAt: { $gt: booking.startsAt },
    status: { $nin: [BOOKING_STATUS.CANCELLED, BOOKING_STATUS.NO_SHOW] },
  }).select('_id');
  if (later) {
    await move(booking, status, {
      status: FOLLOW_UP_STATUS.BOOKED,
      closedAt: now,
      bookedBookingId: String(later._id),
    });
    return;
  }

  // The owner's book: a follow-up only goes out about a visit that happened.
  if (booking.status !== BOOKING_STATUS.COMPLETED) {
    // Never marked complete long after it was due: hand it to the owner.
    if (now.getTime() > f.dueAt.getTime() + 7 * DAY) {
      await lapse(business, booking, status, 'visit_not_marked_complete', now);
    }
    return;
  }

  if (status === FOLLOW_UP_STATUS.SCHEDULED) {
    if (now.getTime() < f.dueAt.getTime() - FOLLOW_UP_OFFER_DAYS_BEFORE * DAY) return;
    await contact(deps, business, booking, 'offer', now);
    return;
  }

  const since = (status === FOLLOW_UP_STATUS.OFFERED ? f.offeredAt : f.nudgedAt) ?? now;
  if (now.getTime() - since.getTime() < FOLLOW_UP_NUDGE_AFTER_DAYS * DAY) return;

  if (status === FOLLOW_UP_STATUS.OFFERED) {
    await contact(deps, business, booking, 'nudge', now);
  } else {
    await lapse(business, booking, status, 'no_reply', now);
  }
}

/** The offer and the nudge: one message, a suggested slot, and the 1/2/3 prompt. */
async function contact(
  deps: SendDeps,
  business: BusinessDoc,
  booking: BookingDoc,
  kind: 'offer' | 'nudge',
  now: Date,
) {
  const f = booking.followUp!;
  const from = f.status;
  const businessId = String(business._id);

  // Quiet hours: wait for morning rather than message at night. The next tick
  // inside waking hours picks it up.
  const hour = toBusinessLocal(now, business.timezone).hour;
  if (hour < REMINDER_WAKING_HOURS.FROM || hour >= REMINDER_WAKING_HOURS.UNTIL) return;

  const [client, profile] = await Promise.all([
    Client.findById(booking.clientId).select('marketingOptOut'),
    ClientProfile.findOne({ businessId, clientId: booking.clientId }).select('marketingOptOut'),
  ]);
  if (client?.marketingOptOut || profile?.marketingOptOut) {
    await lapse(business, booking, from, 'opted_out', now);
    return;
  }

  const service = await Service.findOne({ _id: f.serviceId, businessId, active: true }).select(
    'name',
  );
  if (!service) {
    await lapse(business, booking, from, 'service_retired', now);
    return;
  }

  // Suggest the first free slot on or after the due day — or from now, if the
  // due day has already passed (a nudge after the date).
  const dueDayStart = toBusinessLocal(f.dueAt, business.timezone).startOf('day').toJSDate();
  const searchFrom = dueDayStart > now ? dueDayStart : now;
  let [slot] = f.staffId
    ? await nextAvailable(deps.redis, businessId, f.serviceId, {
        from: searchFrom,
        staffId: f.staffId,
        limit: 1,
      })
    : [];
  if (!slot)
    [slot] = await nextAvailable(deps.redis, businessId, f.serviceId, {
      from: searchFrom,
      limit: 1,
    });
  const staff = slot ? await Staff.findById(slot.staffId).select('name') : null;

  // Claim the transition BEFORE sending: a lost race sends nothing.
  const stamp = kind === 'offer' ? { offeredAt: now } : { nudgedAt: now };
  const next = kind === 'offer' ? FOLLOW_UP_STATUS.OFFERED : FOLLOW_UP_STATUS.NUDGED;
  if (!(await move(booking, from, { status: next, ...stamp }))) return;

  const text = copy.followUpOffer({
    businessName: business.name,
    serviceName: service.name,
    note: f.note ?? null,
    dueAt: f.dueAt,
    timezone: business.timezone,
    slot: slot ? { startsAt: slot.startsAt, staffName: staff?.name ?? 'our team' } : null,
    nudge: kind === 'nudge',
  });

  const sent = await sendTracked(deps, {
    businessId,
    clientId: booking.clientId,
    bookingId: String(booking._id),
    kind: NOTIFICATION_KIND.FOLLOW_UP,
    dedupeKey: `${String(booking._id)}:followup:${kind}`,
    text,
    scheduledFor: now,
  });

  if (!sent.ok) {
    if (sent.reason === 'no_address') {
      await lapse(business, booking, next, 'unreachable', now);
    }
    return;
  }

  await writePendingPrompt(
    deps.redis,
    businessId,
    booking.clientId,
    {
      kind: 'followup',
      bookingId: String(booking._id),
      ...(slot ? { slotStart: slot.startsAt.toISOString(), staffId: slot.staffId } : {}),
    },
    FOLLOW_UP_NUDGE_AFTER_DAYS * 86_400,
  );
  logger.info({ businessId, bookingId: String(booking._id), kind }, 'follow-up sent');
}

/** Hand it to the owner: on the list, and one push. */
async function lapse(
  business: BusinessDoc,
  booking: BookingDoc,
  from: string,
  reason: string,
  now: Date,
) {
  const moved = await move(booking, from, {
    status: FOLLOW_UP_STATUS.LAPSED,
    lapsedReason: reason,
    closedAt: now,
  });
  if (!moved) return;
  const [client, service] = await Promise.all([
    Client.findById(booking.clientId).select('displayName phone').lean(),
    Service.findById(booking.followUp!.serviceId).select('name').lean(),
  ]);
  const who = booking.appointmentHolderName ?? client?.displayName ?? client?.phone ?? 'A customer';
  await pushToOwners(String(business._id), {
    title: `Follow-up: contact ${who}`,
    body: `${service?.name ?? 'Their follow-up'} is due and isn't booked. ${REASON[reason] ?? ''}`.trim(),
    channel: PUSH_CHANNEL.BOOKINGS,
    route: '/follow-ups',
  });
}

const REASON: Record<string, string> = {
  no_reply: "They didn't reply.",
  opted_out: 'They opted out of WhatsApp messages.',
  unreachable: 'No WhatsApp number on file.',
  service_retired: 'That service is no longer active.',
  visit_not_marked_complete: 'The visit was never marked complete.',
};

/** Conditional transition. Returns false if another tick got there first. */
async function move(booking: BookingDoc, from: string, set: Record<string, unknown>) {
  const $set = Object.fromEntries(Object.entries(set).map(([k, v]) => [`followUp.${k}`, v]));
  const r = await Booking.updateOne({ _id: booking._id, 'followUp.status': from }, { $set });
  return r.modifiedCount === 1;
}

/** Customer replied "3 / not now" to the offer. */
export async function declineFollowUp(businessId: string, bookingId: string, now = new Date()) {
  await Booking.updateOne(
    {
      _id: bookingId,
      businessId,
      'followUp.status': { $in: [FOLLOW_UP_STATUS.OFFERED, FOLLOW_UP_STATUS.NUDGED] },
    },
    { $set: { 'followUp.status': FOLLOW_UP_STATUS.DECLINED, 'followUp.closedAt': now } },
  );
}

export function startFollowUpJob(deps: SendDeps): () => void {
  const run = () => {
    followUpsOnce(deps).catch((err) => logger.error({ err }, 'follow-up tick failed'));
  };
  const timer = setInterval(run, INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
