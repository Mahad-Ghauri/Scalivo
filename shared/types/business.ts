import type { SessionIntent, SessionStatus } from '../constants/session-status.js';

export type UserRole = 'customer' | 'staff' | 'owner' | 'admin';

export interface Business {
  id: string;
  slug: string;
  name: string;
  category: string;
  city: string | null;
  /** IANA zone, default 'Asia/Karachi'. Every displayed time converts through this. */
  timezone: string;
  slotIncrementMinutes: number;
  /** Nothing bookable sooner than this from now. */
  minNoticeMinutes: number;
  /** Nothing bookable further ahead than this. */
  bookingHorizonDays: number;
  whatsapp: WhatsAppSession;
  /** Hidden from the marketplace until the minimum profile fields are set. */
  published: boolean;
}

export interface WhatsAppSession {
  sessionId: string;
  status: SessionStatus;
  /**
   * What we believe should be happening. Without it, a qr_ready we caused is
   * indistinguishable from one meaning the session just died — see
   * isSessionAlarm() and SPIKE FINDING #2.
   */
  intent: SessionIntent;
  lastStatusChange: Date;
  /** Soft health signal: silence from a normally-busy business is worth surfacing. */
  lastInboundAt: Date | null;
  reconnectAttempts: number;
  /**
   * One scoped OpenWA key per business (allowedSessions), never a shared admin
   * key. Stored as a reference to the secret, not the secret.
   */
  apiKeyRef: string;
}

/** Local wall-clock, interpreted in the business timezone. Never a UTC instant. */
export interface WorkingHours {
  /** 0 = Sunday. */
  dayOfWeek: number;
  /** 'HH:mm'. */
  opensAt: string;
  closesAt: string;
  breaks: { startsAt: string; endsAt: string }[];
}

export interface Service {
  id: string;
  businessId: string;
  name: string;
  durationMinutes: number;
  /**
   * Turnaround after the service — cleaning a room, resetting a machine. It
   * extends the OCCUPANCY the booking writes, but not the service itself: a
   * treatment may finish at closing time, its buffer may run past it.
   */
  bufferMinutes: number;
  priceMinor: number;
  resourceRequirements?: { anyOfResourceIds: string[] }[];
  requiresOwnerApproval?: boolean;
  approvalWindowMinutes?: number;
  depositRequired: boolean;
  depositAmountMinor: number | null;
  displayOrder: number;
  /** Default follow-up ("session 2 in 21 days"); the owner confirms per booking. */
  followUpDays?: number | null;
  followUpNote?: string | null;
  /** Uploaded service photo (1200px WebP), or null. */
  imageUrl?: string | null;
  /**
   * Retired services stop being offered but keep their history. There is no
   * hard delete: bookings reference a serviceId, and removing the row turns
   * every past appointment into an unnamed one.
   */
  active: boolean;
}

export interface Staff {
  id: string;
  businessId: string;
  name: string;
  role: string | null;
  serviceIds: string[];
  workingHours: WorkingHours[];
  active: boolean;
}

/**
 * What still stands between a freshly registered business and a real booking.
 *
 * This exists because every one of these gaps fails SILENTLY. A business with
 * services but no staff, or staff with no hours, or a service nobody is
 * qualified for, returns an empty availability list — indistinguishable from
 * "fully booked". The owner sees a working app and no bookings, and nothing
 * anywhere says why.
 */
export const SETUP_STEP = {
  SERVICES: 'services',
  STAFF: 'staff',
  HOURS: 'hours',
  /** Every offered service has someone who can actually perform it. */
  COVERAGE: 'coverage',
  WHATSAPP: 'whatsapp',
} as const;

export type SetupStepId = (typeof SETUP_STEP)[keyof typeof SETUP_STEP];

export interface SetupStep {
  id: SetupStepId;
  done: boolean;
  /** What the owner has to do about it, or null when there is nothing to do. */
  detail: string | null;
}

export interface SetupChecklist {
  /** Can this business take a booking right now? True only if every step is done. */
  bookable: boolean;
  steps: SetupStep[];
}

export interface Resource {
  id: string;
  name: string;
  kind: 'room' | 'bed' | 'chair' | 'equipment';
  quantity?: number;
  active: boolean;
  fixedRoomId: string | null;
}
