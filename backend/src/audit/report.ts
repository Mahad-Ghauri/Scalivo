import { BOOKING_STATUS, DELIVERY_STATUS, SESSION_STATUS } from '@scalivo/shared';
import { DateTime } from 'luxon';
import { isValidObjectId } from 'mongoose';
import { ActivityLog } from '../models/ActivityLog.js';
import { Booking } from '../models/Booking.js';
import { BookingAudit } from '../models/BookingAudit.js';
import { Business } from '../models/Business.js';
import { Campaign } from '../models/Campaign.js';
import { Client } from '../models/Client.js';
import { Notification } from '../models/Notification.js';
import { Review } from '../models/Review.js';
import { Service } from '../models/Service.js';
import { SessionEvent } from '../models/SessionEvent.js';
import { Staff } from '../models/Staff.js';
import { User } from '../models/User.js';

/**
 * The audit report: one timeline of everything that happened in a business over
 * a date range, built from records the system already keeps, plus a summary.
 * The same report feeds the dashboard page, the app screen and the PDF.
 */

export const AUDIT_CATEGORIES = [
  'booking',
  'message',
  'payment',
  'whatsapp',
  'review',
  'marketing',
  'services',
  'staff',
  'customers',
  'calendar',
  'settings',
] as const;
export type AuditCategory = (typeof AUDIT_CATEGORIES)[number];

export interface AuditEvent {
  at: string;
  category: AuditCategory;
  title: string;
  detail: string;
  actor: string;
  /** ok | warning | problem, so every client can colour it the same way. */
  tone: 'ok' | 'warning' | 'problem';
}

export interface AuditReport {
  business: { id: string; name: string; timezone: string };
  range: { from: string; to: string };
  generatedAt: string;
  summary: {
    bookings: number;
    bySource: { whatsapp: number; web: number; owner: number };
    completed: number;
    cancelled: number;
    noShows: number;
    revenueMinor: number;
    messagesSent: number;
    messagesDelivered: number;
    messagesFailed: number;
    deliveryRate: number | null;
    whatsappDisconnects: number;
    reviews: number;
    averageRating: number | null;
    staffActions: number;
  };
  events: AuditEvent[];
  truncated: boolean;
}

const PER_SOURCE = 2000;
const MAX_EVENTS = 5000;

const SOURCE_LABEL: Record<string, string> = {
  whatsapp: 'on WhatsApp',
  web: 'on the website',
  owner: 'by the business',
};
const KIND_LABEL: Record<string, string> = {
  confirmation: 'Booking confirmation',
  reminder: 'Appointment reminder',
  review_request: 'Review request',
  deposit_request: 'Deposit request',
  deposit_expired: 'Deposit expiry notice',
  rebook_nudge: 'Win-back message',
  campaign: 'Broadcast message',
  follow_up: 'Follow-up message',
};
const DELIVERY_LABEL: Record<string, [string, AuditEvent['tone']]> = {
  [DELIVERY_STATUS.QUEUED]: ['waiting to send', 'warning'],
  [DELIVERY_STATUS.ACCEPTED]: ['sent', 'ok'],
  [DELIVERY_STATUS.DELIVERED]: ['delivered', 'ok'],
  [DELIVERY_STATUS.READ]: ['read', 'ok'],
  failed: ['failed', 'problem'],
  skipped: ['not sent', 'warning'],
};
const SESSION_LABEL: Record<string, [string, AuditEvent['tone']]> = {
  [SESSION_STATUS.READY]: ['WhatsApp connected', 'ok'],
  [SESSION_STATUS.DISCONNECTED]: ['WhatsApp disconnected', 'problem'],
  [SESSION_STATUS.ACTION_REQUIRED]: ['WhatsApp needs attention', 'problem'],
  [SESSION_STATUS.FAILED]: ['WhatsApp connection failed', 'problem'],
  [SESSION_STATUS.QR_READY]: ['WhatsApp waiting for QR scan', 'warning'],
};

export async function buildAuditReport(
  businessId: string,
  input: { from: string; to: string; category?: AuditCategory | undefined; search?: string | undefined },
): Promise<AuditReport | null> {
  const business = await Business.findById(businessId).select('name timezone').lean();
  if (!business) return null;
  const timezone = business.timezone ?? 'UTC';
  const start = DateTime.fromISO(input.from, { zone: timezone }).startOf('day').toJSDate();
  const end = DateTime.fromISO(input.to, { zone: timezone }).endOf('day').toJSDate();
  const within = { $gte: start, $lte: end };

  const [bookingsMade, bookingsChanged, corrections, notifications, sessions, reviews, campaigns, activity] =
    await Promise.all([
      Booking.find({ businessId, createdAt: within }).limit(PER_SOURCE).lean(),
      Booking.find({
        businessId,
        updatedAt: within,
        $or: [
          { status: { $in: [BOOKING_STATUS.CANCELLED, BOOKING_STATUS.NO_SHOW, BOOKING_STATUS.COMPLETED] } },
          { depositPaidAt: within },
        ],
      })
        .limit(PER_SOURCE)
        .lean(),
      BookingAudit.find({ businessId, createdAt: within }).limit(PER_SOURCE).lean(),
      Notification.find({ businessId, createdAt: within }).select('-text').limit(PER_SOURCE).lean(),
      SessionEvent.find({ businessId, occurredAt: within }).limit(PER_SOURCE).lean(),
      Review.find({ businessId, createdAt: within }).limit(PER_SOURCE).lean(),
      Campaign.find({ businessId, createdAt: within }).limit(PER_SOURCE).lean(),
      ActivityLog.find({ businessId, createdAt: within }).limit(PER_SOURCE).lean(),
    ]);

  const allBookings = [...bookingsMade, ...bookingsChanged];
  const ids = (key: 'clientId' | 'serviceId' | 'staffId') => [
    ...new Set(
      [...allBookings, ...notifications]
        .map((row) => (row as Record<string, unknown>)[key])
        .filter((id) => isValidObjectId(id)),
    ),
  ];
  // Messages name the person the appointment is for, as the bookings do.
  const messageBookings = await Booking.find({
    businessId,
    _id: { $in: [...new Set(notifications.map((n) => n.bookingId).filter((id) => isValidObjectId(id)))] },
  })
    .select('appointmentHolderName clientId')
    .lean();
  const holderOf = new Map(messageBookings.map((b) => [String(b._id), b.appointmentHolderName]));
  const [clients, services, staff, actors] = await Promise.all([
    Client.find({ businessId, _id: { $in: ids('clientId') } }).select('displayName phone').lean(),
    Service.find({ businessId, _id: { $in: ids('serviceId') } }).select('name').lean(),
    Staff.find({ businessId, _id: { $in: ids('staffId') } }).select('name').lean(),
    User.find({ _id: { $in: [...new Set(corrections.map((c) => c.actorId))].filter((id) => isValidObjectId(id)) } }).select('name email').lean(),
  ]);
  const nameOf = <T extends { _id: unknown }>(rows: T[], pick: (row: T) => string | null | undefined) => {
    const map = new Map(rows.map((row) => [String(row._id), pick(row) ?? null]));
    return (id: unknown) => (id ? (map.get(String(id)) ?? null) : null);
  };
  const client = nameOf(clients, (c) => c.displayName ?? c.phone);
  const service = nameOf(services, (s) => s.name);
  const member = nameOf(staff, (s) => s.name);
  const actor = nameOf(actors, (u) => u.name ?? u.email);

  const when = (d: Date) =>
    DateTime.fromJSDate(d, { zone: timezone }).toFormat('ccc d LLL yyyy, h:mm a');
  const describe = (b: (typeof allBookings)[number]) =>
    `${service(b.serviceId) ?? 'Appointment'} with ${member(b.staffId) ?? 'staff'} for ` +
    `${b.appointmentHolderName ?? client(b.clientId) ?? 'a customer'}, ${when(b.startsAt)}`;

  const events: AuditEvent[] = [];
  const push = (at: Date | null | undefined, event: Omit<AuditEvent, 'at'>) => {
    if (at && at >= start && at <= end) events.push({ at: at.toISOString(), ...event });
  };

  for (const b of bookingsMade)
    push(b.createdAt, {
      category: 'booking',
      title: `Appointment booked ${SOURCE_LABEL[b.source] ?? ''}`.trim(),
      detail: describe(b),
      actor: b.source === 'owner' ? 'Business' : (client(b.clientId) ?? 'Customer'),
      tone: 'ok',
    });

  const seen = new Set<string>();
  for (const b of bookingsChanged) {
    if (seen.has(String(b._id))) continue;
    seen.add(String(b._id));
    if (b.status === BOOKING_STATUS.CANCELLED)
      push(b.updatedAt, { category: 'booking', title: 'Appointment cancelled', detail: describe(b), actor: '', tone: 'warning' });
    if (b.status === BOOKING_STATUS.NO_SHOW)
      push(b.updatedAt, { category: 'booking', title: 'Customer did not show up', detail: describe(b), actor: 'Business', tone: 'problem' });
    if (b.status === BOOKING_STATUS.COMPLETED)
      push(b.completedAt ?? b.updatedAt, { category: 'booking', title: 'Appointment completed', detail: describe(b), actor: 'Business', tone: 'ok' });
    if (b.depositPaidAt)
      push(b.depositPaidAt, {
        category: 'payment',
        title: `Deposit paid (Rs ${Math.round((b.depositMinor ?? 0) / 100).toLocaleString('en-PK')})`,
        detail: describe(b),
        actor: client(b.clientId) ?? 'Customer',
        tone: 'ok',
      });
  }

  for (const c of corrections)
    push(c.createdAt, {
      category: 'booking',
      title: `Appointment changed from ${c.before.replace(/_/g, ' ')} to ${c.after.replace(/_/g, ' ')}`,
      detail: `Reason: ${c.reason}`,
      actor: actor(c.actorId) ?? 'Staff',
      tone: 'warning',
    });

  for (const n of notifications) {
    const [state, tone] = DELIVERY_LABEL[n.status] ?? [n.status, 'ok'];
    push(n.createdAt, {
      category: n.kind === 'deposit_request' || n.kind === 'deposit_expired' ? 'payment' : 'message',
      title: `${KIND_LABEL[n.kind] ?? 'Message'}: ${state}`,
      detail:
        `To ${(n.bookingId && holderOf.get(n.bookingId)) || client(n.clientId) || 'a customer'}` +
        (n.lastError && tone !== 'ok' ? `. Reason: ${n.lastError}` : ''),
      actor: 'System',
      tone,
    });
  }

  for (const s of sessions) {
    const label = SESSION_LABEL[s.status];
    if (label) push(s.occurredAt, { category: 'whatsapp', title: label[0], detail: '', actor: 'System', tone: label[1] });
  }

  for (const r of reviews)
    push(r.createdAt, {
      category: 'review',
      title: `${r.rating}-star review received`,
      detail: [r.serviceName, r.comment].filter(Boolean).join(': '),
      actor: r.authorName,
      tone: r.rating >= 4 ? 'ok' : r.rating === 3 ? 'warning' : 'problem',
    });

  for (const c of campaigns)
    push(c.createdAt, {
      category: 'marketing',
      title: `Broadcast to ${c.recipients} customers (${c.status})`,
      detail: c.message.length > 120 ? `${c.message.slice(0, 117)}...` : c.message,
      actor: 'Business',
      tone: 'ok',
    });

  for (const a of activity)
    push(a.createdAt, {
      category: a.category as AuditCategory,
      title: a.action,
      detail: '',
      actor: a.actorName ?? 'Staff',
      tone: a.category === 'booking' && /cancel|declin/i.test(a.action) ? 'warning' : 'ok',
    });

  // Summary is over everything in range, before the screen's own filter.
  const sent = notifications.filter((n) => n.status !== DELIVERY_STATUS.QUEUED && n.status !== 'skipped');
  const delivered = notifications.filter((n) => n.status === DELIVERY_STATUS.DELIVERED || n.status === DELIVERY_STATUS.READ);
  const completed = [...new Map(bookingsChanged.filter((b) => b.status === BOOKING_STATUS.COMPLETED).map((b) => [String(b._id), b])).values()];
  const summary: AuditReport['summary'] = {
    bookings: bookingsMade.length,
    bySource: {
      whatsapp: bookingsMade.filter((b) => b.source === 'whatsapp').length,
      web: bookingsMade.filter((b) => b.source === 'web').length,
      owner: bookingsMade.filter((b) => b.source === 'owner').length,
    },
    completed: completed.length,
    cancelled: events.filter((e) => e.title === 'Appointment cancelled').length,
    noShows: events.filter((e) => e.title === 'Customer did not show up').length,
    revenueMinor: completed.reduce((sum, b) => sum + (b.priceMinor ?? 0), 0),
    messagesSent: sent.length,
    messagesDelivered: delivered.length,
    messagesFailed: notifications.filter((n) => n.status === 'failed').length,
    deliveryRate: sent.length ? Math.round((delivered.length / sent.length) * 100) : null,
    whatsappDisconnects: sessions.filter((s) => s.status === SESSION_STATUS.DISCONNECTED).length,
    reviews: reviews.length,
    averageRating: reviews.length
      ? Math.round((reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length) * 10) / 10
      : null,
    staffActions: activity.length + corrections.length,
  };

  const search = input.search?.trim().toLowerCase();
  const filtered = events
    .filter((e) => !input.category || e.category === input.category)
    .filter((e) => !search || `${e.title} ${e.detail} ${e.actor}`.toLowerCase().includes(search))
    .sort((a, b) => b.at.localeCompare(a.at));

  return {
    business: { id: businessId, name: business.name, timezone },
    range: { from: input.from, to: input.to },
    generatedAt: new Date().toISOString(),
    summary,
    events: filtered.slice(0, MAX_EVENTS),
    truncated: filtered.length > MAX_EVENTS,
  };
}
