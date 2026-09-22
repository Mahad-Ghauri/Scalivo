/**
 * Revenue and analytics — SPEC §7, milestone 2.4.
 *
 * One rule governs every number in here: **revenue is completed appointments.**
 * Not booked, not confirmed, not invoiced — completed. A dashboard that counts a
 * booking as money the moment it is made reports a great week every time
 * somebody books a great week and then cancels it, and the owner finds out when
 * the bank balance disagrees with the app.
 *
 * The second rule is that every boundary is business-LOCAL (SPEC §0.2). A
 * Karachi salon's Tuesday runs 19:00 Monday to 19:00 Tuesday in UTC, so
 * bucketing on the stored instant silently moves the first five hours of every
 * day into the day before — most visibly on the late evening appointments that
 * make up a salon's best hours.
 */

/** How the series is bucketed. Anything longer than a month is a different page. */
export type Granularity = 'day' | 'week' | 'month';

export interface RevenuePoint {
  /**
   * The bucket, business-local: `2026-09-20`, `2026-W38`, or `2026-09`.
   *
   * A label rather than a Date, because a "week" has no instant and rendering
   * one would mean picking a timezone all over again on the client.
   */
  period: string;
  revenueMinor: number;
  /** Completed appointments in the bucket — the revenue's denominator. */
  completed: number;
}

/**
 * What happened to the appointments in the range.
 *
 * Cancelled and no-show are counted here and excluded from revenue, which is
 * SPEC §7.3's rule: they are real events worth seeing, and they are not money.
 */
export interface VolumeBreakdown {
  total: number;
  completed: number;
  noShow: number;
  cancelled: number;
  /** Still to happen, or waiting on the owner — neither earned nor lost yet. */
  upcoming: number;
}

export interface TopService {
  serviceId: string;
  name: string;
  revenueMinor: number;
  completed: number;
}

export interface TopClient {
  clientId: string;
  name: string;
  /** Lifetime with THIS business, not just the range — SPEC §7.1. */
  lifetimeSpendMinor: number;
  totalVisits: number;
}

export interface AnalyticsReport {
  /** Business-local ISO dates, inclusive, echoed back so a stale render is obvious. */
  range: { from: string; to: string; granularity: Granularity };

  /** Completed appointments in the range. The headline number. */
  revenueMinor: number;
  series: RevenuePoint[];
  volume: VolumeBreakdown;

  /**
   * No-shows over the appointments that actually reached their hour.
   *
   * The denominator excludes cancellations deliberately: an appointment
   * cancelled on Tuesday for Saturday freed its slot and was resold, and
   * counting it as a chance to not-turn-up would dilute the rate that the
   * deposit experiment (SPEC §12) is supposed to move. Null when nothing in
   * the range has reached its hour yet — a rate over zero appointments is not
   * 0%, it is unknown.
   */
  noShowRate: number | null;

  /**
   * No-shows split by whether a deposit was required — SPEC §12.3. Rates are
   * null, not 0, when that side has no appointments that reached their hour.
   */
  depositComparison: {
    withDeposit: DepositSide;
    withoutDeposit: DepositSide;
  };

  topServices: TopService[];
  topClients: TopClient[];

  /**
   * Money already on the books for the future — NOT a projection.
   *
   * It is the sum of appointments that exist and have not happened yet — every
   * booking still to come, counted from now rather than from the range — so it
   * cannot mislead a new business the way a trend-extrapolated forecast would
   * (SPEC §7.3). Two weeks of data produce a real number or an honest zero,
   * never a confident line through two points.
   */
  forecast: { revenueMinor: number; bookings: number };
}

export interface DepositSide {
  /** Completed + no-show: the appointments whose hour came. */
  reached: number;
  noShow: number;
  rate: number | null;
}
