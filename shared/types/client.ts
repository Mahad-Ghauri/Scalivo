import type { ClientTag } from '../constants/client-tags.js';

/**
 * A person, global across businesses.
 *
 * Identity is the phone number — but see SPIKE FINDING #1: inbound WhatsApp
 * messages do not carry one. `phone` is therefore nullable, and `lids` is how a
 * client is actually matched when a message arrives.
 */
export interface Client {
  id: string;
  /**
   * E.164 without '+'. Unique when present — the index is SPARSE, because both
   * LID-resolution failures and owner-created walk-ins produce clients without
   * a phone number.
   */
  phone: string | null;
  /**
   * Every WhatsApp linked-identity seen for this person. Always populated for
   * WhatsApp-originated clients even when phone resolution failed, so an
   * unmatched contact still has a stable key and can be merged later.
   */
  lids: string[];
  displayName: string | null;
  createdAt: Date;
}

/**
 * Per-business membership. Tags, spend, and history are per business — being a
 * VIP at one says nothing about another.
 */
export interface ClientBusinessLink {
  clientId: string;
  businessId: string;
  tags: ClientTag[];
  totalVisits: number;
  lifetimeSpendMinor: number;
  /** Rolling mean gap between completed visits. Drives retention timing. */
  averageGapDays: number | null;
  lastVisitAt: Date | null;
  nextExpectedVisitAt: Date | null;
  mostBookedServiceId: string | null;
  preferredStaffId: string | null;
  /** The one manual field in the whole CRM. */
  notes: string;
  /**
   * STOP was received. Excluded from all marketing; transactional confirmations
   * and reminders still send — those are not marketing.
   */
  marketingOptOut: boolean;
  /** Enforces the over-messaging guard across campaigns. */
  lastMarketingMessageAt: Date | null;
}
