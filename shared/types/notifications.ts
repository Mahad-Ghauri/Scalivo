import { ACK_STATUS, type AckStatus } from './messaging.js';

/**
 * Messages the system sends because something happened, not because someone
 * replied.
 *
 * Every outbound message before this phase was a REPLY — the inbound webhook
 * carried the address, the FSM produced the text, and nobody ever asked whether
 * it arrived. That is tolerable for a menu prompt, because a customer who does
 * not get one messages again. It is not tolerable for a confirmation or a
 * reminder: nobody re-requests those, so a silent drop is invisible to everyone
 * including us.
 *
 * SPIKE FINDING #3 is why this exists at all. `sendText` returning 200 means
 * ACCEPTED, and under upstream #830 WhatsApp silently discards first contact to
 * a brand-new contact while the API still reports success — which is precisely
 * the customer a business's new dedicated number is full of. So a notification
 * carries a delivery status of its own, and only a `message.ack` moves it past
 * accepted.
 */

export const NOTIFICATION_KIND = {
  /** "You're booked" — sent once, when the appointment is made. */
  CONFIRMATION: 'confirmation',
  /** "You're in tomorrow at 4" — sent once per configured lead time. */
  REMINDER: 'reminder',
  /**
   * "How was it? Reply 1–5" — sent once, a couple of hours after an appointment
   * is marked complete.
   *
   * Tracked like the other two rather than sent as a chat reply, for a reason
   * beyond idempotency: the count of these is the denominator of the capture
   * rate (SPEC §9, "done when"). A request nobody recorded is a review that
   * looks like it was never asked for.
   */
  REVIEW_REQUEST: 'review_request',
  /**
   * "Pay the deposit to secure your slot" — the link, sent instead of the
   * confirmation when the service needs a deposit. Tracked because it is the
   * only way a WhatsApp customer learns they owe anything; a dropped one is a
   * booking that silently expires.
   */
  DEPOSIT_REQUEST: 'deposit_request',
  /** "We didn't receive the deposit, so the slot was released." */
  DEPOSIT_EXPIRED: 'deposit_expired',
} as const;

export type NotificationKind = (typeof NOTIFICATION_KIND)[keyof typeof NOTIFICATION_KIND];

export const DELIVERY_STATUS = {
  /**
   * Claimed and owed, not yet handed over. Either the session is down or the
   * send threw. This is the only non-terminal status, and it is what the retry
   * pass looks for.
   */
  QUEUED: 'queued',
  /** The provider took it. Proves NOTHING about arrival — see FINDING #3. */
  ACCEPTED: 'accepted',
  /** A message.ack said 'delivered'. This, and only this, means sent. */
  DELIVERED: 'delivered',
  /** The customer opened it. Strictly better news than delivered. */
  READ: 'read',
  /** The provider gave up, or we did after repeated attempts. */
  FAILED: 'failed',
  /**
   * Deliberately not sent, and never to be retried: the customer has no
   * WhatsApp address at all, the appointment was cancelled while the message
   * waited, or the moment to send it passed while we were down.
   *
   * Distinct from FAILED on purpose. Failed is something to investigate;
   * skipped is a decision, and lumping them together would bury real delivery
   * problems under a pile of phone-less walk-ins.
   */
  SKIPPED: 'skipped',
} as const;

export type DeliveryStatus = (typeof DELIVERY_STATUS)[keyof typeof DELIVERY_STATUS];

/**
 * Acks are not ordered.
 *
 * They arrive as separate webhook deliveries over a retrying, at-least-once
 * transport, so 'sent' can land after 'delivered' — and a naive write would
 * then downgrade a message we know arrived back to one we only hope did. Every
 * status write compares ranks first and refuses to go backwards.
 *
 * FAILED and SKIPPED sit at the top because they are decisions rather than
 * observations: once we have given up on a message, a late ack for it is
 * history, not instruction.
 */
const RANK: Record<DeliveryStatus, number> = {
  [DELIVERY_STATUS.QUEUED]: 0,
  [DELIVERY_STATUS.ACCEPTED]: 1,
  [DELIVERY_STATUS.DELIVERED]: 2,
  [DELIVERY_STATUS.READ]: 3,
  [DELIVERY_STATUS.FAILED]: 4,
  [DELIVERY_STATUS.SKIPPED]: 4,
};

/** True when `next` is genuine progress on `current` — never a regression. */
export function advancesDelivery(current: DeliveryStatus, next: DeliveryStatus): boolean {
  return RANK[next] > RANK[current];
}

/** Every status at or above `status`, for a `$nin` guard on a conditional write. */
export function deliveryStatusesFrom(status: DeliveryStatus): DeliveryStatus[] {
  return (Object.keys(RANK) as DeliveryStatus[]).filter((s) => RANK[s] >= RANK[status]);
}

/**
 * A provider ack, in our terms.
 *
 * 'pending' and 'sent' are deliberately NOT mapped to a delivery status. Both
 * mean the provider still has it, which is exactly what ACCEPTED already
 * records — writing them would be movement without information, and under the
 * rank rule 'sent' arriving late would be refused anyway.
 */
export function deliveryFromAck(ack: AckStatus): DeliveryStatus | null {
  switch (ack) {
    case ACK_STATUS.DELIVERED:
      return DELIVERY_STATUS.DELIVERED;
    case ACK_STATUS.READ:
      return DELIVERY_STATUS.READ;
    case ACK_STATUS.FAILED:
      return DELIVERY_STATUS.FAILED;
    default:
      return null;
  }
}

/** The public shape of a notification. `text` is included — the owner may need to see what was said. */
export interface Notification {
  id: string;
  businessId: string;
  clientId: string;
  bookingId: string;
  kind: NotificationKind;
  status: DeliveryStatus;
  text: string;
  /** When this was meant to go out. Equal to createdAt for confirmations. */
  scheduledFor: Date;
  acceptedAt: Date | null;
  /** The instant an ack proved arrival. Null means it never has. */
  deliveredAt: Date | null;
}

/**
 * A day before. Long enough to rearrange a Saturday, short enough to still be
 * in mind — and it is the only lead time a salon owner ever asks for first.
 */
export const DEFAULT_REMINDER_LEAD_MINUTES = [24 * 60];

/**
 * Reminders are pulled back INTO waking hours, never pushed forward.
 *
 * A two-hour lead on a 7am class computes to 5am local. Pushing it forward to
 * 8am would deliver it after the class; pulling it back to 9pm the evening
 * before is both inside waking hours and, unavoidably, still before the
 * appointment — which is why the rule moves in one direction only.
 *
 * Hours are business-LOCAL. The lead itself is timezone-free (an instant minus
 * minutes is the same instant everywhere); this is the one part that is not.
 */
export const REMINDER_WAKING_HOURS = { FROM: 8, UNTIL: 21 } as const;

/**
 * How late a reminder may be and still be worth sending.
 *
 * Covers two cases with one rule: a process that was down over the send moment,
 * and a booking made after its own reminder was already due. In both, the
 * reminder is recorded as skipped rather than fired hours out of place — a
 * "tomorrow at 4" that lands the following week is worse than silence.
 */
export const REMINDER_MAX_LATE_MINUTES = 60;
