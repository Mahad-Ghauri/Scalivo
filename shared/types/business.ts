import type { SessionIntent, SessionStatus } from '../constants/session-status.js';

export type UserRole = 'customer' | 'staff' | 'owner' | 'admin';

export interface Business {
  id: string;
  slug: string;
  name: string;
  category: string;
  /** IANA zone, default 'Asia/Karachi'. Every displayed time converts through this. */
  timezone: string;
  slotIncrementMinutes: number;
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
  priceMinor: number;
  depositRequired: boolean;
  depositAmountMinor: number | null;
  displayOrder: number;
}

export interface Staff {
  id: string;
  businessId: string;
  name: string;
  serviceIds: string[];
  workingHours: WorkingHours[];
  active: boolean;
}
